/// Everything the window knows, in one listenable.
///
/// No state-management package: there is one screen and one controller, and a
/// dependency-injected graph for that is an abstraction with one
/// implementation. `ChangeNotifier` is in the SDK and does the job.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';

import '../data/api.dart';
import '../data/settings.dart';
import '../l10n.dart';

/// One item in the transcript. Tool calls and task news are entries in their
/// own right rather than text inside a bubble — watching a colleague work is
/// the point of the product, so the work has to be visible as work.
sealed class Entry {
  Entry();

  /// The stored row this came from, when it came from history. A search hit
  /// scrolls to the entry with its id; live entries have none until reloaded.
  int? id;
}

class Said extends Entry {
  Said({required this.mine, required this.speaker, required this.color, this.text = '', this.files = const []});

  final bool mine;
  final String speaker;
  final String color;
  String text;
  bool streaming = false;

  /// What was attached to it (the person's message carries them).
  final List<Attachment> files;
}

/// A file an agent sent with send_file. It stands where the call was made —
/// live and after a reload — and reads as the agent handing something over,
/// not as a command card.
class SentFile extends Entry {
  SentFile({required this.speaker, required this.color, required this.file});

  final String speaker;
  final String color;
  final Attachment file;
}

class Ran extends Entry {
  Ran({required this.speaker, required this.color, required this.label});

  final String speaker;
  final String color;
  final String label;
  String output = '';
  bool running = true;

  /// A browser screenshot, when the tool took one. Only lives for this reply —
  /// history stores text, so reopening the conversation shows the card without it.
  Uint8List? image;

  /// Set while the card is waiting for a person to allow or refuse it. The id is
  /// only good for as long as the stream that asked is open.
  String? approvalId;

  /// What "always allow" would cover (risky patterns, '' = the whole tool). Empty = not offered.
  List<String> always = const [];

  /// What the person answered, once they have. Shown instead of the buttons.
  bool? approved;

  /// They answered "always allow".
  bool alwaysAllowed = false;
}

class Note extends Entry {
  Note(this.text);
  final String text;
}

/// News about a background task: it asked something, finished, failed, was
/// stopped. Whether it can still be answered is read from [Workbench.tasks].
class News extends Entry {
  News(this.event);
  final Map<String, Object?> event;

  int get task => (event['task'] as num?)?.toInt() ?? 0;
  String get kind => (event['kind'] as String?) ?? '';
  String get agentId => (event['agent_id'] as String?) ?? '';
  String get agent => (event['agent'] as String?) ?? '';
  String get title => (event['title'] as String?) ?? '';
  String get text => (event['text'] as String?) ?? '';
  String get by => (event['by'] as String?) ?? '';
  String? get approval => event['approval'] as String?;

  /// Files a finished task sent the person; they come back with its report.
  List<Attachment> get files => Attachment.listOf(event['files']);
}

/// A file picked to go with the next message. It uploads at once; the message
/// can be sent when every one has its [attachment] (or was removed).
class Pending {
  Pending({required this.path, required this.name, required this.size});

  final String path;
  final String name;
  final int size;
  int sent = 0;

  /// Set when the upload finished.
  Attachment? attachment;

  /// Set when it failed; it is not sent, and stays until removed so the person sees why.
  String? error;

  bool get uploading => attachment == null && error == null;
  double get progress => size <= 0 ? 0 : (sent / size).clamp(0, 1).toDouble();
}

class Workbench extends ChangeNotifier {
  Workbench(Settings settings) : api = Api(settings) {
    // Scheduled tasks write into conversations while nobody is typing, so look
    // again every so often: left-list previews, task states, and the open
    // conversation's history when something new landed in it.
    _poller = Timer.periodic(const Duration(seconds: 15), (_) => poll());
  }

  late final Timer _poller;
  List<Routine> routines = const [];

  /// The open conversation's background tasks, newest first.
  List<Task> tasks = const [];
  String _taskSig = '';
  Timer? _taskTimer;

  Task? taskById(int id) => tasks.where((x) => x.id == id).firstOrNull;

  /// What everyone has spent. Reloaded with the conversation list, so the
  /// sidebar total and the panel never disagree about which moment they show.
  Usage usage = const Usage();

  /// Skills installed on the open Agent (empty for groups — skills live on people).
  List<Skill> skills = const [];

  final Api api;

  List<Conversation> conversations = const [];
  List<Agent> agents = const [];
  Conversation? current;
  final List<Entry> entries = [];

  /// The open conversation's sessions, most recent first.
  List<Session> sessions = const [];

  /// The session on screen. null = a new one that only exists here until its
  /// first message, so an unused "New session" leaves nothing behind.
  String? session;

  /// Which session each conversation was left on, so coming back lands there.
  final Map<String, String?> _lastSession = {};
  static String _key(Conversation c) => '${c.kind}:${c.id}';

  /// A message to scroll to and outline, set by [openSession] from a search
  /// hit. The page consumes it once the transcript is drawn.
  int? jumpTo;

  Session? get currentSession => sessions.where((x) => x.id == session).firstOrNull;

  /// The open conversation's memory, and which conversation it belongs to —
  /// the page copies it into its text box only when that id changes.
  String memory = '';
  String? memoryFor;

  /// The open Agent's self-notes — the memory he writes himself. Empty and
  /// null for a group: only a person writes a group's memory.
  String selfMemory = '';
  String? selfMemoryFor;
  bool loading = true;
  bool busy = false;

  /// Messages still being worked on, anywhere. In auto mode a run outlives the
  /// stream that started it (the app was closed, or it started elsewhere).
  List<Run> runs = const [];

  /// The conversation this app is streaming a reply for right now.
  Conversation? _streaming;
  Timer? _runTimer;

  /// The run in [c] that isn't being streamed here — shown as "still working", with Stop.
  Run? backgroundRun(Conversation? c) {
    if (c == null || (busy && _streaming?.id == c.id && _streaming?.kind == c.kind)) return null;
    return runs.where((r) => r.isFor(c)).firstOrNull;
  }

  bool isRunning(Conversation c) => runs.any((r) => r.isFor(c));

  /// This app is streaming a reply for the open conversation right now.
  bool get busyHere => busy && _streaming?.id == current?.id && _streaming?.kind == current?.kind;

  /// The open conversation is at work — streamed here or running elsewhere — so a message sent now
  /// goes into that turn (interject) instead of starting one.
  bool get atWork => busyHere || (!busy && current != null && isRunning(current!));

  /// Look at what is running, and follow the open conversation closely while it
  /// runs: its history is redrawn as the work lands, and once more when it ends.
  Future<void> loadRuns() async {
    final c = current;
    final was = c != null && isRunning(c);
    try {
      runs = await api.runs();
    } on ApiException catch (_) {
      return;
    }
    notifyListeners();
    final now = c != null && isRunning(c);
    if (c != null && !busy && (now || was) && c.id == current?.id) {
      final ticket = _shown;
      if (!now) await _loadSessions(c);
      if (ticket == _shown) await _drawHistory(c, ticket);
    }
    _runTimer?.cancel();
    if (runs.isNotEmpty) _runTimer = Timer(const Duration(seconds: 4), () => unawaited(loadRuns()));
  }

  /// Stop: the reply being streamed here, or else whatever runs in the open conversation.
  Future<void> stop() async {
    final c = (busy ? _streaming : null) ?? current;
    if (c == null) return;
    await api.stopRun(c);
    await loadRuns();
  }
  String? error;

  List<String> get agentNames => agents.map((a) => a.name).toList();

  Agent? agentById(String id) {
    for (final a in agents) {
      if (a.id == id) return a;
    }
    return null;
  }

  Agent? agentByName(String name) {
    for (final a in agents) {
      if (a.name == name) return a;
    }
    return null;
  }

  Future<void> refresh({bool keepSelection = true}) async {
    try {
      final results = await Future.wait([api.conversations(), api.agents()]);
      conversations = results[0] as List<Conversation>;
      agents = results[1] as List<Agent>;
      error = null;
      // Best effort: a spend panel that failed to load must not take the
      // conversation list down with it.
      try {
        usage = await api.usage();
      } on ApiException catch (_) {}

      final id = current?.id;
      if (keepSelection && id != null) {
        // The row object is replaced on every refresh (new preview, new
        // timestamp), so re-find by id or the selection silently drops.
        current = conversations.where((c) => c.id == id).firstOrNull ?? current;
      }
    } on ApiException catch (e) {
      error = e.message;
    } catch (e) {
      error = '$e';
    }
    loading = false;
    notifyListeners();
  }

  /// After creating, editing or deleting an Agent or group: reload the lists
  /// and land on [id] if given (the thing just made), otherwise stay put —
  /// or fall back to the first conversation when the current one is gone.
  Future<void> reload({String? id}) async {
    await refresh(keepSelection: false);
    final want = id ?? current?.id;
    final next = conversations.where((c) => c.id == want).firstOrNull ?? conversations.firstOrNull;
    if (next == null) {
      current = null;
      entries.clear();
      notifyListeners();
    } else if (next.id != current?.id || id != null) {
      await open(next);
    } else {
      current = next;
      notifyListeners();
    }
  }

  /// Bumped on every [open]. Anything async that started under an older
  /// value belongs to a conversation that is no longer on screen: a history
  /// that arrives late, or a reply still streaming after the user clicked away.
  int _shown = 0;

  Future<void> open(Conversation c) async {
    final ticket = ++_shown;
    // Files picked for another conversation can't go here: take them back.
    if (_pendingFor != null && _pendingFor != _key(c)) clearPending();
    current = c;
    entries.clear();
    memory = '';
    memoryFor = null;
    selfMemory = '';
    selfMemoryFor = null;
    routines = const [];
    skills = const [];
    tasks = const [];
    _taskSig = '';
    sessions = const [];
    session = null;
    jumpTo = null;
    notifyListeners();
    unawaited(_loadMemory(c, ticket));
    unawaited(loadRoutines());
    unawaited(loadSkills());
    unawaited(loadTasks());
    await _loadSessions(c);
    if (ticket != _shown) return;
    // Back to the session this conversation was last left on (a fresh "New
    // session" included); otherwise the most recent one.
    final key = _key(c);
    final last = _lastSession[key];
    session = _lastSession.containsKey(key) && (last == null || sessions.any((x) => x.id == last))
        ? last
        : sessions.firstOrNull?.id;
    await _drawHistory(c, ticket);
    unawaited(loadRuns());
  }

  Future<void> _loadSessions(Conversation c) async {
    try {
      final list = await api.sessions(c);
      if (current?.id != c.id || current?.kind != c.kind) return;
      sessions = list;
    } on ApiException catch (e) {
      error = e.message;
    }
    notifyListeners();
  }

  /// Show another session of the open conversation, optionally landing on one message.
  Future<void> openSession(String? id, {int? jumpTo}) async {
    final c = current;
    if (c == null) return;
    final ticket = ++_shown;
    session = id;
    _lastSession[_key(c)] = id;
    this.jumpTo = jumpTo;
    entries.clear();
    notifyListeners();
    await _drawHistory(c, ticket);
  }

  /// Start a new session. Nothing is created until the first message is sent.
  Future<void> newSession() async {
    if (current == null || session == null) return;
    await openSession(null);
  }

  Future<void> renameSession(Session x, String title) async {
    final c = current;
    if (c == null) return;
    await api.renameSession(x.id, title);
    await _loadSessions(c);
  }

  /// Delete a session and everything said in it. The open one gives way to the
  /// most recent that is left, or to a new one.
  Future<void> deleteSession(Session x) async {
    final c = current;
    if (c == null) return;
    await api.deleteSession(x.id);
    await _loadSessions(c);
    if (x.id == session) await openSession(sessions.firstOrNull?.id);
    await refresh();
  }

  Future<List<SearchHit>> search(String q) async {
    final c = current;
    if (c == null || q.trim().isEmpty) return const [];
    return api.search(c, q.trim());
  }

  /// Replace [entries] with [c]'s stored history, unless the user has moved on.
  Future<void> _drawHistory(Conversation c, int ticket) async {
    final s = session;
    if (s == null) {
      // A new session: nothing to fetch, and nothing from the others carries over.
      entries.clear();
      notifyListeners();
      return;
    }
    try {
      final history = await api.history(c, s);
      if (ticket != _shown) return; // two quick clicks: the older answer loses
      entries
        ..clear()
        ..addAll(history.map((m) => _entryOf(m, c)));
      error = null;
    } on ApiException catch (e) {
      error = e.message;
    }
    notifyListeners();
  }

  /// Look at the open conversation's tasks, and keep looking while any is open.
  /// When one moves, its news may have landed in the transcript (and the front
  /// thread may be waking up to tell about it), so the history is redrawn —
  /// unless a reply is streaming here.
  Future<void> loadTasks() async {
    final c = current;
    if (c == null) return;
    final List<Task> list;
    try {
      list = await api.tasks(c);
    } on ApiException catch (_) {
      return; // best effort, like routines
    }
    if (current?.id != c.id || current?.kind != c.kind) return;
    final sig = '${_key(c)}|${list.map((x) => '${x.id}:${x.status}:${x.updatedAt}').join(',')}';
    final moved = _taskSig.startsWith('${_key(c)}|') && sig != _taskSig;
    tasks = list;
    _taskSig = sig;
    notifyListeners();
    if (moved && !busy) {
      final ticket = _shown;
      await _drawHistory(c, ticket);
      unawaited(loadRuns());
    }
    _taskTimer?.cancel();
    if (list.any((x) => x.open)) _taskTimer = Timer(const Duration(seconds: 4), () => unawaited(loadTasks()));
  }

  /// Answer a task's question straight from its card or row.
  Future<String?> answerTask(Task x, String text) async {
    try {
      await api.answerTask(x.id, text);
      return null;
    } on ApiException catch (e) {
      return e.message;
    } finally {
      unawaited(loadTasks());
    }
  }

  Future<void> stopTask(Task x) async {
    try {
      await api.stopTask(x.id);
    } on ApiException catch (_) {
      // Already over: the reload shows how it ended.
    }
    await loadTasks();
  }

  /// Allow or refuse the command a task is waiting on.
  Future<void> answerTaskApproval(Task x, bool ok, [bool always = false]) async {
    final id = x.approvalId;
    if (id == null) return;
    try {
      await api.answerApproval(id, ok, always: always);
    } on ApiException catch (e) {
      error = e.message;
    }
    await loadTasks();
  }

  Future<void> loadRoutines() async {
    final c = current;
    if (c == null) return;
    try {
      final list = await api.routines(c);
      if (current?.id != c.id) return;
      routines = list;
      notifyListeners();
    } on ApiException catch (_) {
      // Best effort, like memory: the panel keeps what it had.
    }
  }

  Future<void> loadSkills() async {
    final c = current;
    if (c == null || c.isGroup) return;
    try {
      final all = await api.skills();
      if (current?.id != c.id) return;
      skills = all.where((k) => k.agents.contains(c.id)).toList();
      notifyListeners();
    } on ApiException catch (_) {
      // Best effort, like memory.
    }
  }

  /// One look at the server. Skipped while a reply is streaming — that
  /// transcript is being drawn live and a redraw would wipe the tool cards.
  Future<void> poll() async {
    if (busy || loading) return;
    final before = current?.at;
    final ticket = _shown;
    await refresh();
    final c = current;
    if (c == null || busy || ticket != _shown) return;
    unawaited(loadRoutines());
    if (runs.isEmpty) unawaited(loadRuns()); // started elsewhere (another device, a scheduled task)
    if (c.at != before) {
      // A scheduled task may have written into a session of its own
      await _loadSessions(c);
      if (ticket == _shown) await _drawHistory(c, ticket);
    }
  }

  Future<void> _loadMemory(Conversation c, int ticket) async {
    try {
      final text = await api.memory(c);
      if (ticket != _shown) return;
      memory = text;
      memoryFor = c.id;
      notifyListeners();
    } on ApiException catch (_) {
      // Best effort. A memory panel that failed to load is not a reason to
      // block the conversation next to it.
    }
    if (c.isGroup || ticket != _shown) return;
    try {
      final text = await api.selfMemory(c.id);
      if (ticket != _shown) return;
      selfMemory = text;
      selfMemoryFor = c.id;
      notifyListeners();
    } on ApiException catch (_) {
      // Best effort, as above.
    }
  }

  Future<void> saveMemory(String text) async {
    final c = current;
    if (c == null) return;
    await api.saveMemory(c, text);
    memory = text;
  }

  Future<void> saveSelfMemory(String text) async {
    final c = current;
    if (c == null || c.isGroup) return;
    await api.saveSelfMemory(c.id, text);
    selfMemory = text;
  }

  // ---- Attachments for the next message ----
  final List<Pending> pending = [];
  String? _pendingFor;

  /// Whether a picked file is still on its way up — sending waits for it.
  bool get uploading => pending.any((p) => p.uploading);

  /// Pick files for the next message. Each uploads at once, in parallel.
  Future<void> attach(List<String> paths) async {
    final c = current;
    if (c == null || paths.isEmpty) return;
    _pendingFor = _key(c);
    final added = <Pending>[];
    for (final path in paths) {
      var size = 0;
      try {
        size = await File(path).length();
      } on FileSystemException catch (_) {}
      final p = Pending(path: path, name: path.split(RegExp(r'[\\/]')).last, size: size);
      pending.add(p);
      added.add(p);
    }
    notifyListeners();
    await Future.wait(added.map((p) => _upload(c, p)));
  }

  Future<void> _upload(Conversation c, Pending p) async {
    try {
      final a = await api.uploadFile(
        c,
        p.path,
        name: p.name,
        onProgress: (sent, _) {
          p.sent = sent;
          notifyListeners();
        },
      );
      // Removed (or the conversation changed) while it was uploading: take it back.
      if (!pending.contains(p)) {
        unawaited(api.deleteUpload(a.id).catchError((_) {}));
        return;
      }
      p.attachment = a;
    } on ApiException catch (e) {
      p.error = e.message;
    } on FileSystemException catch (e) {
      p.error = e.osError?.message ?? e.message;
    }
    notifyListeners();
  }

  /// Drop one picked file; if it already uploaded, take it back from the server too.
  void removePending(Pending p) {
    if (!pending.remove(p)) return;
    final a = p.attachment;
    if (a != null) unawaited(api.deleteUpload(a.id).catchError((_) {}));
    notifyListeners();
  }

  void clearPending() {
    for (final p in [...pending]) {
      removePending(p);
    }
    _pendingFor = null;
  }

  /// Say something to the turn at work in the open conversation. Drawn at once like any message;
  /// the server hands it to that turn at its next step (or, if it has just ended, starts one). The
  /// answer arrives through the stream already open here, or the history redraw of a running one.
  Future<void> interject(String text) async {
    final c = current;
    final files = [for (final p in pending) if (p.attachment != null) p.attachment!];
    if (c == null || (text.trim().isEmpty && files.isEmpty) || uploading) return;
    final ticket = _shown;
    void add(Entry e) {
      if (ticket == _shown) entries.add(e);
    }

    add(Said(mine: true, speaker: userSpeaker, color: '', text: text.trim(), files: files));
    pending.removeWhere((p) => p.attachment != null);
    notifyListeners();
    try {
      await for (final ev in api.chat(c, text.trim(), session: session, files: [for (final f in files) f.id], interject: true)) {
        if (ev.name == 'note') add(Note(ev.text));
        if (ev.name == 'error') add(Note('⚠ ${ev.data['message'] ?? ''}'));
      }
    } on ApiException catch (e) {
      add(Note('⚠ ${e.message}'));
    }
    notifyListeners();
    unawaited(loadRuns());
  }

  /// Sends and streams the reply. Returns when the turn is over.
  Future<void> send(String text) async {
    final c = current;
    // A message may be only files; it waits while any is still uploading.
    final files = [for (final p in pending) if (p.attachment != null) p.attachment!];
    if (c == null || busy || (text.trim().isEmpty && files.isEmpty) || uploading) return;

    busy = true;
    _streaming = c;
    error = null;
    final ticket = _shown;
    // Only while this conversation is still the one on screen — otherwise the
    // rest of the reply would be drawn into whatever the user switched to.
    void add(Entry e) {
      if (ticket == _shown) entries.add(e);
    }

    add(Said(mine: true, speaker: userSpeaker, color: '', text: text.trim(), files: files));
    // They go with this message now; a failed one stays behind for the person to see and remove.
    pending.removeWhere((p) => p.attachment != null);
    notifyListeners();

    // Tool cards are matched run→done by bot+name+args; the server sends the
    // same args back on both phases, so this is the key it already gives us.
    final cards = <String, Ran>{};
    Said? live;

    try {
      await for (final ev in api.chat(c, text.trim(), session: session, files: [for (final f in files) f.id])) {
        if (ev.name == 'session') {
          // Which session this went into — a new one's id, the first time.
          // Remembered even if the person switched away, so coming back lands
          // on the conversation they just had.
          final id = (ev.data['id'] as String?) ?? '';
          _lastSession[_key(c)] = id;
          if (ticket == _shown) {
            session = id;
            unawaited(_loadSessions(c));
          }
          continue;
        }
        final agent = agentById(ev.botId);
        final name = agent?.name ?? c.name;
        final colour = agent?.color ?? c.color;

        switch (ev.name) {
          case 'start':
            // Deliberately NOT creating the bubble here. Tool calls usually
            // come first after start; an early bubble would put the answer
            // above its own evidence. A turn with no delta leaves no empty bubble.
            live = null;
          case 'delta':
            if (live == null) {
              live = Said(mine: false, speaker: name, color: colour)..streaming = true;
              add(live);
            }
            live.text += ev.text;
          case 'end':
            live?.streaming = false;
            live = null;
          case 'note':
            add(Note(ev.text));
          case 'error':
            add(Note('⚠ ${ev.data['message'] ?? ''}'));
            live?.streaming = false;
            live = null;
          case 'tool':
            final phase = (ev.data['phase'] as String?) ?? '';
            if (phase == 'retry') {
              // The failed attempt may have streamed half a sentence already;
              // the retry sends its answer from the start. Keeping both would
              // show the reply twice (the saved history has only the retry's).
              if (live != null) entries.remove(live);
              live = null;
              add(Note(tr('state.retry', {'name': name, 'reason': ev.data['reason'] ?? ''})));
              break;
            }
            if (phase == 'trim') {
              add(Note(tr('state.trimmed', {'n': ev.data['dropped']})));
              break;
            }
            if (phase == 'interject') {
              // What the person said meanwhile reached the model: what it writes next is a
              // new bubble, below that message.
              live?.streaming = false;
              live = null;
              break;
            }
            if (phase == 'nudge') {
              // Stopped with its plan unfinished and was sent back to it: what it
              // says next is a new bubble, not more of the one that asked to stop.
              live?.streaming = false;
              live = null;
              add(Note(tr('state.nudge', {'n': ev.data['open']})));
              break;
            }
            final args = (ev.data['args'] as Map?) ?? const {};
            final key = '${ev.botId}:${ev.data['name']}:$args';
            if (phase == 'run') {
              // A turn can be "say something → run a command → say more". Close
              // the bubble when a tool appears so later text starts a new one —
              // otherwise both parts merge ABOVE the command between them.
              live?.streaming = false;
              live = null;
              final card = Ran(speaker: name, color: colour, label: _label(ev.data['name'], args));
              cards[key] = card;
              add(card);
            } else if (phase == 'ask') {
              cards[key]
                ?..approvalId = ev.data['id'] as String?
                ..always = [for (final p in (ev.data['always'] as List?) ?? const []) '$p'];
            } else if (phase == 'answered') {
              cards[key]
                ?..approvalId = null
                ..approved = ev.data['ok'] == true;
            } else {
              final card = cards.remove(key);
              final sentFile = Attachment.maybe(ev.data['file']);
              if (card != null && sentFile != null && ev.data['name'] == 'send_file') {
                // A file the agent handed over: it takes the card's place, as it will after a reload.
                final at = entries.indexOf(card);
                final entry = SentFile(speaker: name, color: colour, file: sentFile);
                if (at >= 0) {
                  entries[at] = entry;
                } else {
                  add(entry);
                }
              } else {
                card
                  ?..running = false
                  ..output = (ev.data['output'] as String?) ?? ''
                  ..image = _decodeImage(ev.data['image']);
              }
            }
          case 'done':
            break;
        }
        notifyListeners();
      }
    } on ApiException catch (e) {
      add(Note('⚠ ${e.message}'));
    } catch (e) {
      add(Note('⚠ $e'));
    }

    // Anything still marked running lost its `done` — say so rather than
    // leaving a spinner that never resolves.
    for (final card in cards.values) {
      card
        ..running = false
        ..output = tr('state.noResult');
    }
    live?.streaming = false;
    busy = false;
    _streaming = null;
    notifyListeners();
    unawaited(loadRuns());
    unawaited(loadTasks());
    await refresh();
    if (current?.id == c.id && current?.kind == c.kind) await _loadSessions(c);
    // Left and came back while it was answering: what's on screen is the
    // history from before the reply landed. Read it again.
    if (ticket != _shown && current?.id == c.id) await open(current!);
  }

  /// Allow or refuse a waiting call. The buttons go the moment we answer, so the
  /// same card can't be answered twice while the request is in flight.
  Future<void> answer(Ran card, bool ok, [bool always = false]) async {
    final id = card.approvalId;
    if (id == null) return;
    card.approvalId = null;
    notifyListeners();
    try {
      await api.answerApproval(id, ok, always: always);
      card.approved = ok;
      card.alwaysAllowed = ok && always;
    } on ApiException catch (e) {
      entries.add(Note('⚠ ${e.message}'));
    }
    notifyListeners();
  }

  /// A stored line becomes a bubble or a finished tool card. A card from history
  /// has no screenshot: only text is stored.
  Entry _entryOf(Message m, Conversation c) {
    if (m.event != null) return News(m.event!)..id = m.id;
    final colour = m.mine ? '' : (agentByName(m.speaker)?.color ?? c.color);
    if (m.tool == null) {
      return Said(mine: m.mine, speaker: m.speaker, color: colour, text: m.text, files: m.files)..id = m.id;
    }
    if (m.tool == 'send_file' && m.file != null) {
      return SentFile(speaker: m.speaker, color: colour, file: m.file!)..id = m.id;
    }
    return Ran(speaker: m.speaker, color: colour, label: _label(m.tool, m.args))
      ..id = m.id
      ..running = false
      ..output = m.text;
  }

  static String _label(Object? tool, Map args) => switch (tool) {
    'update_plan' => _planLabel(args['plan']),
    'bash' => '${args['command'] ?? ''}',
    'read_file' => tr('tool.read', {'path': args['path'] ?? ''}),
    'write_file' => tr('tool.write', {'path': args['path'] ?? ''}),
    'browser' => tr('tool.browser', {'what': _browserLabel(args)}),
    _ => '$tool',
  };

  static Uint8List? _decodeImage(Object? v) {
    if (v is! String || !v.startsWith('data:image/')) return null;
    final comma = v.indexOf(',');
    try {
      return base64Decode(v.substring(comma + 1));
    } catch (_) {
      return null;
    }
  }

  /// Same wording as the web page: "open example.com" beats a JSON blob.
  static String _browserLabel(Map args) {
    final target = args['index'] != null
        ? '#${args['index']}'
        : (args['text'] != null ? tr('tool.b.quoted', {'text': args['text']}) : '');
    return switch (args['action']) {
      'open' => tr('tool.b.open', {'url': args['url'] ?? ''}),
      'read' => tr('tool.b.read'),
      'screenshot' => tr('tool.b.screenshot'),
      'back' => tr('tool.b.back'),
      'click' => tr('tool.b.click', {'target': target}),
      'type' =>
        tr('tool.b.type', {'index': args['index'] ?? '?', 'text': args['text'] ?? ''}) +
            (args['submit'] == true ? tr('tool.b.enter') : ''),
      'press' => tr('tool.b.press', {'key': args['key'] ?? ''}),
      'scroll' => tr('tool.b.scroll'),
      'eval' => tr('tool.b.eval'),
      final other => '$other',
    };
  }

  static String _planLabel(Object? plan) {
    final steps = plan is List ? plan : const [];
    final done = steps.where((x) => x is Map && x['status'] == 'completed').length;
    return tr('tool.plan', {'done': done, 'n': steps.length});
  }

  @override
  void dispose() {
    _poller.cancel();
    _runTimer?.cancel();
    _taskTimer?.cancel();
    api.close();
    super.dispose();
  }
}
