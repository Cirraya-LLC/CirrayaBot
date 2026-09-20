/// Everything the window knows, in one listenable.
///
/// No state-management package: there is one screen and one controller, and a
/// dependency-injected graph for that is an abstraction with one
/// implementation. `ChangeNotifier` is in the SDK and does the job.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../data/api.dart';
import '../data/settings.dart';
import '../l10n.dart';

/// One item in the transcript. Tool calls and handoffs are entries in their
/// own right rather than text inside a bubble — watching a colleague work is
/// the point of the product, so the work has to be visible as work.
sealed class Entry {
  Entry();
}

class Said extends Entry {
  Said({required this.mine, required this.speaker, required this.color, this.text = ''});

  final bool mine;
  final String speaker;
  final String color;
  String text;
  bool streaming = false;
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
}

class Note extends Entry {
  Note(this.text);
  final String text;
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
    current = c;
    entries.clear();
    memory = '';
    memoryFor = null;
    selfMemory = '';
    selfMemoryFor = null;
    routines = const [];
    skills = const [];
    notifyListeners();
    unawaited(_loadMemory(c, ticket));
    unawaited(loadRoutines());
    unawaited(loadSkills());
    await _drawHistory(c, ticket);
  }

  /// Replace [entries] with [c]'s stored history, unless the user has moved on.
  Future<void> _drawHistory(Conversation c, int ticket) async {
    try {
      final history = await api.history(c);
      if (ticket != _shown) return; // two quick clicks: the older answer loses
      entries
        ..clear()
        ..addAll(
          history.map(
            (m) => Said(
              mine: m.mine,
              speaker: m.speaker,
              color: m.mine ? '' : (agentByName(m.speaker)?.color ?? c.color),
              text: m.text,
            ),
          ),
        );
      error = null;
    } on ApiException catch (e) {
      error = e.message;
    }
    notifyListeners();
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
    if (c.at != before) await _drawHistory(c, ticket);
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

  /// Sends and streams the reply. Returns when the turn is over.
  Future<void> send(String text) async {
    final c = current;
    if (c == null || busy || text.trim().isEmpty) return;

    busy = true;
    error = null;
    final ticket = _shown;
    // Only while this conversation is still the one on screen — otherwise the
    // rest of the reply would be drawn into whatever the user switched to.
    void add(Entry e) {
      if (ticket == _shown) entries.add(e);
    }

    add(Said(mine: true, speaker: userSpeaker, color: '', text: text.trim()));
    notifyListeners();

    // Tool cards are matched run→done by bot+name+args; the server sends the
    // same args back on both phases, so this is the key it already gives us.
    final pending = <String, Ran>{};
    Said? live;

    try {
      await for (final ev in api.chat(c, text.trim())) {
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
          case 'handoff':
            final from = agentById((ev.data['from'] as String?) ?? '')?.name ?? '';
            final to = agentById((ev.data['to'] as String?) ?? '')?.name ?? '';
            add(Note('$from → @$to'));
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
            final args = (ev.data['args'] as Map?) ?? const {};
            final key = '${ev.botId}:${ev.data['name']}:$args';
            if (phase == 'run') {
              // A turn can be "say something → run a command → say more". Close
              // the bubble when a tool appears so later text starts a new one —
              // otherwise both parts merge ABOVE the command between them.
              live?.streaming = false;
              live = null;
              final card = Ran(speaker: name, color: colour, label: _label(ev.data['name'], args));
              pending[key] = card;
              add(card);
            } else {
              final card = pending.remove(key);
              card
                ?..running = false
                ..output = (ev.data['output'] as String?) ?? ''
                ..image = _decodeImage(ev.data['image']);
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
    for (final card in pending.values) {
      card
        ..running = false
        ..output = tr('state.noResult');
    }
    live?.streaming = false;
    busy = false;
    notifyListeners();
    await refresh();
    // Left and came back while it was answering: what's on screen is the
    // history from before the reply landed. Read it again.
    if (ticket != _shown && current?.id == c.id) await open(current!);
  }

  static String _label(Object? tool, Map args) => switch (tool) {
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

  @override
  void dispose() {
    _poller.cancel();
    api.close();
    super.dispose();
  }
}
