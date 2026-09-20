/// The server, as much of it as this window needs.
///
/// Same HTTP surface the web UI uses — the desktop client is another view of
/// one server, not a second product. Nothing is cached locally on purpose:
/// two people can have the same server open, and a client that trusted its
/// own copy would quietly show a stale roster.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import '../l10n.dart';
import 'mjpeg.dart';
import 'settings.dart';
import 'sse.dart';

/// A row in the left column. Groups and one-to-ones are mixed and sorted by
/// recency — the server decides the order, the client does not re-sort.
class Conversation {
  const Conversation({
    required this.kind,
    required this.id,
    required this.name,
    required this.tag,
    required this.preview,
    required this.at,
    required this.members,
    required this.color,
    required this.colors,
    this.lead = '',
  });

  final String kind; // 'agent' | 'group'
  final String id;
  final String name;
  final String tag;
  final String preview;
  final int at;
  final List<String> members;
  final String color;
  final List<String> colors;

  /// A group's lead: answers first when nobody is @-mentioned. '' = not set.
  final String lead;

  bool get isGroup => kind == 'group';

  static Conversation fromJson(Map<String, Object?> j) => Conversation(
    kind: (j['kind'] as String?) ?? 'agent',
    id: (j['id'] as String?) ?? '',
    name: (j['name'] as String?) ?? '',
    tag: (j['tag'] as String?) ?? '',
    preview: (j['preview'] as String?) ?? '',
    at: (j['at'] as num?)?.toInt() ?? 0,
    members: ((j['members'] as List?) ?? const []).cast<String>(),
    color: (j['color'] as String?) ?? '',
    colors: ((j['colors'] as List?) ?? const []).cast<String>(),
    lead: (j['lead'] as String?) ?? '',
  );
}

class Agent {
  const Agent({
    required this.id,
    required this.name,
    required this.description,
    required this.persona,
    required this.color,
    this.providerId = '',
    this.model = '',
    this.effort = '',
    this.approval = '',
    this.dailyCapMicro,
  });

  final String id;
  final String name;
  final String description;
  final String persona;
  final String color;

  /// Empty = the default upstream / that upstream's own model.
  final String providerId;
  final String model;

  /// How hard the model should think: '' (send nothing) / low / medium / high.
  final String effort;

  /// When this one has to ask first: '' (follow the platform) / off / match / all.
  final String approval;

  /// Daily spend cap in micro-dollars. null = no cap of its own, so the
  /// platform default applies.
  final int? dailyCapMicro;

  static Agent fromJson(Map<String, Object?> j) => Agent(
    id: (j['id'] as String?) ?? '',
    name: (j['name'] as String?) ?? '',
    description: (j['description'] as String?) ?? '',
    persona: (j['persona'] as String?) ?? '',
    color: (j['color'] as String?) ?? '',
    providerId: (j['provider_id'] as String?) ?? '',
    model: (j['model'] as String?) ?? '',
    effort: (j['effort'] as String?) ?? '',
    approval: (j['approval'] as String?) ?? '',
    dailyCapMicro: (j['daily_cap_micro'] as num?)?.toInt(),
  );
}

/// One line in the transcript. [speaker] is empty for the person using the
/// app; in a group it is the Agent's display name.
///
/// A stored tool call is a line too ([tool] set): the label is built where the
/// rest of the tool labels are built, so history and the live stream read alike.
class Message {
  const Message({
    required this.mine,
    required this.speaker,
    required this.text,
    required this.at,
    this.tool,
    this.args = const {},
  });

  final bool mine;
  final String speaker;
  final String text;
  final int at;
  final String? tool;
  final Map<Object?, Object?> args;
}

/// The platform-wide answer to "when does an Agent have to ask first".
class ApprovalPolicy {
  const ApprovalPolicy({this.mode = 'match', this.patterns = const []});

  final String mode;
  final List<String> patterns;

  static ApprovalPolicy fromJson(Map<String, Object?> j) => ApprovalPolicy(
    mode: (j['mode'] as String?) ?? 'match',
    patterns: ((j['patterns'] as List?) ?? const []).map((e) => '$e').toList(),
  );
}

/// A skill: how to do one kind of job. Same shape as a SKILL.md file.
class Skill {
  const Skill({
    required this.id,
    required this.name,
    required this.description,
    required this.body,
    required this.agents,
    required this.source,
  });

  final String id;
  final String name;

  /// When to use it — the only thing an Agent sees until he decides to read it.
  final String description;
  final String body;

  /// Agent ids it is installed on.
  final List<String> agents;

  /// `human`, or `agent:<id>` when an Agent saved it himself.
  final String source;

  String? get savedBy => source.startsWith('agent:') ? source.substring(6) : null;

  static Skill fromJson(Map<String, Object?> j) => Skill(
    id: (j['id'] as String?) ?? '',
    name: (j['name'] as String?) ?? '',
    description: (j['description'] as String?) ?? '',
    body: (j['body'] as String?) ?? '',
    agents: [for (final a in (j['agents'] as List?) ?? const []) if (a is String) a],
    source: (j['source'] as String?) ?? 'human',
  );
}

/// A scheduled task: at its time the server posts [prompt] into the target
/// conversation as if someone typed it. Schedule semantics live server-side
/// (web/schedule.mjs); the client only renders them.
class Routine {
  const Routine({
    required this.id,
    required this.name,
    required this.targetKind,
    required this.targetId,
    required this.prompt,
    required this.kind,
    required this.everyMinutes,
    required this.atTime,
    required this.weekdays,
    required this.runAt,
    required this.tz,
    required this.enabled,
    required this.nextRunAt,
    required this.lastRunAt,
    required this.lastStatus,
    required this.lastError,
    required this.running,
  });

  final String id;
  final String name;
  final String targetKind;
  final String targetId;
  final String prompt;

  /// `daily` / `interval` / `once`.
  final String kind;
  final int everyMinutes;
  final String atTime;
  final List<int> weekdays;
  final int? runAt;
  final String tz;
  final bool enabled;
  final int? nextRunAt;
  final int? lastRunAt;
  final String lastStatus;
  final String lastError;
  final bool running;

  static Routine fromJson(Map<String, Object?> j) => Routine(
    id: (j['id'] as String?) ?? '',
    name: (j['name'] as String?) ?? '',
    targetKind: (j['target_kind'] as String?) ?? 'agent',
    targetId: (j['target_id'] as String?) ?? '',
    prompt: (j['prompt'] as String?) ?? '',
    kind: (j['kind'] as String?) ?? 'daily',
    everyMinutes: (j['every_minutes'] as num?)?.toInt() ?? 0,
    atTime: (j['at_time'] as String?) ?? '',
    weekdays: [for (final d in (j['weekdays'] as List?) ?? const []) if (d is num) d.toInt()],
    runAt: (j['run_at'] as num?)?.toInt(),
    tz: (j['tz'] as String?) ?? '',
    enabled: (j['enabled'] as bool?) ?? true,
    nextRunAt: (j['next_run_at'] as num?)?.toInt(),
    lastRunAt: (j['last_run_at'] as num?)?.toInt(),
    lastStatus: (j['last_status'] as String?) ?? '',
    lastError: (j['last_error'] as String?) ?? '',
    running: (j['running'] as bool?) ?? false,
  );
}

class Provider {
  const Provider({
    required this.id,
    required this.name,
    required this.baseUrl,
    required this.protocol,
    required this.contextTokens,
    required this.autoContext,
    required this.ctxSource,
    required this.isDefault,
    required this.keyHint,
    this.priceInMicro,
    this.priceOutMicro,
  });

  final String id;
  final String name;
  final String baseUrl;

  /// `chat` / `responses` / `messages` — which wire format the upstream speaks.
  final String protocol;
  final int contextTokens;
  final bool autoContext;
  final String ctxSource;
  final bool isDefault;
  final String keyHint;

  /// Price per million tokens, in micro-dollars. null = never set, so calls on
  /// this upstream are counted in tokens but have no cost — and no cap can
  /// hold them.
  final int? priceInMicro;
  final int? priceOutMicro;

  bool get priced => priceInMicro != null && priceOutMicro != null;

  static Provider fromJson(Map<String, Object?> j) => Provider(
    id: (j['id'] as String?) ?? '',
    name: (j['name'] as String?) ?? '',
    baseUrl: (j['base_url'] as String?) ?? '',
    protocol: (j['protocol'] as String?) ?? 'chat',
    contextTokens: (j['context_tokens'] as num?)?.toInt() ?? 0,
    autoContext: (j['auto_context'] as bool?) ?? true,
    ctxSource: (j['ctx_source'] as String?) ?? '',
    isDefault: (j['is_default'] as bool?) ?? false,
    keyHint: (j['key_hint'] as String?) ?? '',
    priceInMicro: (j['price_in_micro'] as num?)?.toInt(),
    priceOutMicro: (j['price_out_micro'] as num?)?.toInt(),
  );
}

/// What one agent has spent over a period. [costMicro] is null when the
/// upstream has no prices: unknown, which is not the same as free.
class Spend {
  const Spend({this.tokens = 0, this.costMicro, this.calls = 0, this.unpriced = 0});

  final int tokens;
  final int? costMicro;
  final int calls;
  final int unpriced;

  static Spend fromJson(Map<String, Object?>? j) => j == null
      ? const Spend()
      : Spend(
          tokens: (j['tokens'] as num?)?.toInt() ?? 0,
          costMicro: (j['cost_micro'] as num?)?.toInt(),
          calls: (j['calls'] as num?)?.toInt() ?? 0,
          unpriced: (j['unpriced'] as num?)?.toInt() ?? 0,
        );
}

class AgentSpend {
  const AgentSpend({
    required this.id,
    required this.name,
    required this.day,
    required this.month,
    required this.capMicro,
    required this.ownCap,
    required this.priced,
  });

  final String id;
  final String name;
  final Spend day;
  final Spend month;

  /// The cap in force — the agent's own, or the platform default. null = none.
  final int? capMicro;
  final bool ownCap;

  /// Whether this agent's upstream has prices. Without them nothing here can
  /// be costed, so no cap applies either.
  final bool priced;

  static AgentSpend fromJson(Map<String, Object?> j) => AgentSpend(
    id: (j['id'] as String?) ?? '',
    name: (j['name'] as String?) ?? '',
    day: Spend.fromJson(j['day'] as Map<String, Object?>?),
    month: Spend.fromJson(j['month'] as Map<String, Object?>?),
    capMicro: (j['cap_micro'] as num?)?.toInt(),
    ownCap: (j['own_cap'] as bool?) ?? false,
    priced: (j['priced'] as bool?) ?? false,
  );
}

class Usage {
  const Usage({this.agents = const [], this.day = const Spend(), this.month = const Spend(), this.defaultCapMicro});

  final List<AgentSpend> agents;
  final Spend day;
  final Spend month;
  final int? defaultCapMicro;

  AgentSpend? of(String id) {
    for (final a in agents) {
      if (a.id == id) return a;
    }
    return null;
  }

  static Usage fromJson(Map<String, Object?> j) => Usage(
    agents: [
      for (final a in (j['agents'] as List?) ?? const [])
        if (a is Map<String, Object?>) AgentSpend.fromJson(a),
    ],
    day: Spend.fromJson(j['day'] as Map<String, Object?>?),
    month: Spend.fromJson(j['month'] as Map<String, Object?>?),
    defaultCapMicro: (j['default_cap_micro'] as num?)?.toInt(),
  );
}

/// One dollar in micro-dollars — money is an integer everywhere but the screen.
const micro = 1000000;

/// Money as a person reads it. Small amounts need four decimals or every
/// conversation reads as $0.00; null is unknown, which must not look like zero.
String moneyText(int? m) => m == null
    ? '\u2014'
    : '\$${(m / micro).toStringAsFixed(m.abs() < 10000 ? 4 : 2)}';

/// A dollars field as typed: '' keeps "unset", a bad number is null.
/// Returns (ok, micro) — ok false means the text is not a number.
({bool ok, int? value}) parseDollars(String text) {
  final t = text.trim();
  if (t.isEmpty) return (ok: true, value: null);
  final n = double.tryParse(t);
  if (n == null || n < 0) return (ok: false, value: null);
  return (ok: true, value: (n * micro).round());
}

/// A cap or price for a text box: micro-dollars back to a plain number.
/// Trailing `.0` is dropped — a price box that reads "10.0" invites someone to
/// wonder whether it means something different from the "10" they typed.
String dollarsText(int? m) {
  if (m == null) return '';
  final s = (m / micro).toString();
  return s.endsWith('.0') ? s.substring(0, s.length - 2) : s;
}

/// How the server names the person using the app in stored transcripts.
/// A wire value, not interface text — never translate it.
const userSpeaker = 'User';

/// Why a call did not work, in the terms a screen has to explain it.
enum ApiFailure { unreachable, unauthorized, server }

class ApiException implements Exception {
  const ApiException(this.failure, [this.detail = '']);
  final ApiFailure failure;
  final String detail;

  /// Read at display time, so it follows the current language. [detail] from
  /// the server is already in the language we asked for (X-Lang).
  String get message => switch (failure) {
    ApiFailure.unreachable => detail.isEmpty ? tr('api.unreachable') : tr('api.unreachableDetail', {'detail': detail}),
    ApiFailure.unauthorized => tr('api.unauthorized'),
    ApiFailure.server => detail.isEmpty ? tr('api.server') : tr('api.serverDetail', {'detail': detail}),
  };

  @override
  String toString() => 'ApiException($failure, $detail)';
}

class Api {
  Api(this.settings, {HttpClient? client}) : _client = client ?? HttpClient() {
    // idleTimeout is how long an *idle* pooled connection is kept for reuse —
    // it never touches a response that is still streaming. It must stay below
    // the server's keep-alive (Node closes idle sockets after 5s by default):
    // longer, and the next request goes out on a socket the server already
    // closed and fails with "Connection closed before full header was received".
    _client.idleTimeout = const Duration(seconds: 3);
    _client.connectionTimeout = const Duration(seconds: 15);
  }

  final Settings settings;
  final HttpClient _client;

  void close() => _client.close(force: true);

  /// Every URL carries `lang=` too: the browser stream, screenshot and input
  /// socket cannot always send headers, and the server answers in it.
  Uri _uri(String path) {
    final u = Uri.parse('${settings.baseUrl}$path');
    return u.replace(queryParameters: {
      ...u.queryParameters,
      if (settings.token.isNotEmpty) 'k': settings.token,
      'lang': currentLang.value.code,
    });
  }

  Future<HttpClientResponse> _send(String method, String path, [Object? body]) async {
    HttpClientResponse res;
    try {
      try {
        res = await _attempt(method, path, body);
      } on HttpException catch (e) {
        // A pooled socket the server closed a moment ago: the request never
        // reached it, so sending once more on a fresh connection is safe.
        // Whatever the retry throws falls through to the one list below —
        // two lists drift, and the shorter one lets failures escape.
        if (!e.message.contains('Connection closed')) rethrow;
        res = await _attempt(method, path, body);
      }
    } on HttpException catch (e) {
      throw ApiException(ApiFailure.unreachable, e.message);
    } on SocketException catch (e) {
      throw ApiException(ApiFailure.unreachable, e.osError?.message ?? e.message);
    } on StateError catch (e) {
      // The client is closed: dispose() ran while a best-effort load (memory,
      // routines, skills) was still in flight. Those callers catch
      // ApiException, so it has to arrive as one or it escapes them all.
      throw ApiException(ApiFailure.unreachable, e.message);
    } on ArgumentError {
      throw ApiException(ApiFailure.unreachable, tr('api.badUrl'));
    } on FormatException {
      throw ApiException(ApiFailure.unreachable, tr('api.badUrl'));
    } on TlsException catch (e) {
      // Most often https:// typed for a plain-http server.
      throw ApiException(ApiFailure.unreachable, tr('api.tls', {'detail': e.message}));
    }
    if (res.statusCode == 401) {
      await res.drain<void>();
      throw const ApiException(ApiFailure.unauthorized);
    }
    return res;
  }

  Future<HttpClientResponse> _attempt(String method, String path, Object? body) async {
    final req = await _client.openUrl(method, _uri(path));
    req.headers.set('X-Lang', currentLang.value.code);
    if (body != null) {
      req.headers.contentType = ContentType.json;
      req.write(jsonEncode(body));
    }
    return req.close();
  }

  Future<Object?> _json(String method, String path, [Object? body]) async {
    final res = await _send(method, path, body);
    final text = await res.transform(utf8.decoder).join();
    if (res.statusCode >= 400) {
      String detail = text;
      try {
        final j = jsonDecode(text);
        if (j is Map && j['error'] is String) detail = j['error'] as String;
      } catch (_) {}
      throw ApiException(ApiFailure.server, detail.trim());
    }
    if (text.isEmpty) return null;
    try {
      return jsonDecode(text);
    } on FormatException {
      throw ApiException(ApiFailure.server, tr('api.notJson'));
    }
  }

  // Shape checks at the edge, so a wrong server answering 200 with the wrong
  // shape is an ApiException the screens already handle — not a TypeError
  // that escapes as "Unhandled Exception".
  Future<List<Object?>> _list(String path) async {
    final j = await _json('GET', path);
    if (j is List) return j;
    throw ApiException(ApiFailure.server, tr('api.badShape'));
  }

  Future<Map<String, Object?>> _map(String method, String path, [Object? body]) async {
    final j = await _json(method, path, body);
    if (j is Map<String, Object?>) return j;
    throw ApiException(ApiFailure.server, tr('api.badShape'));
  }

  Future<List<Conversation>> conversations() async {
    final j = await _list('/api/conversations');
    return j.map((e) => Conversation.fromJson(e as Map<String, Object?>)).toList();
  }

  Future<List<Agent>> agents() async {
    final j = await _list('/api/bots');
    return j.map((e) => Agent.fromJson(e as Map<String, Object?>)).toList();
  }

  /// The transcript, in the shape the screen draws. The two endpoints answer
  /// different field names for the same thing — normalising here keeps that
  /// out of the widgets.
  Future<List<Message>> history(Conversation c) async {
    if (c.isGroup) {
      final j = await _list('/api/groups/${c.id}/messages');
      return j.map((e) {
        final m = e as Map<String, Object?>;
        final speaker = (m['speaker'] as String?) ?? '';
        if (m['role'] == 'tool') return _toolMessage(m, speaker);
        return Message(
          mine: speaker == userSpeaker,
          speaker: speaker,
          text: (m['text'] as String?) ?? '',
          at: (m['at'] as num?)?.toInt() ?? 0,
        );
      }).toList();
    }
    final j = await _list('/api/dm/${c.id}');
    return j.map((e) {
      final m = e as Map<String, Object?>;
      if (m['role'] == 'tool') return _toolMessage(m, c.name);
      return Message(
        mine: m['role'] == 'user',
        speaker: m['role'] == 'user' ? userSpeaker : c.name,
        text: (m['content'] as String?) ?? '',
        at: (m['at'] as num?)?.toInt() ?? 0,
      );
    }).toList();
  }

  /// A DM's memory is the Agent's own (it follows him into groups too);
  /// a group's is the group's.
  static String _memoryPath(Conversation c) => '/api/memory/${c.isGroup ? 'group' : 'agent'}/${c.id}';

  Future<String> memory(Conversation c) async {
    final j = await _map('GET', _memoryPath(c));
    return (j['text'] as String?) ?? '';
  }

  Future<void> saveMemory(Conversation c, String text) => _json('PUT', _memoryPath(c), {'text': text});

  /// An Agent's self-notes: a second, separate store, the one memory he writes
  /// himself (the `remember` tool). Groups have none.
  static String _selfMemoryPath(String agentId) => '/api/memory/agent/$agentId/self';

  Future<String> selfMemory(String agentId) async {
    final j = await _map('GET', _selfMemoryPath(agentId));
    return (j['text'] as String?) ?? '';
  }

  Future<void> saveSelfMemory(String agentId, String text) =>
      _json('PUT', _selfMemoryPath(agentId), {'text': text});

  // ---- Agents & groups ----
  // Same endpoints the web page uses; the server generates the id for a
  // Chinese name that has no ASCII slug, so the client never asks for one.

  Future<String> createAgent(Map<String, Object?> body) async {
    final j = await _map('POST', '/api/bots', body);
    return (j['id'] as String?) ?? '';
  }

  Future<void> updateAgent(String id, Map<String, Object?> body) => _json('PATCH', '/api/bots/$id', body);

  Message _toolMessage(Map<String, Object?> m, String speaker) => Message(
    mine: false,
    speaker: speaker.isEmpty ? '' : speaker,
    text: (m['output'] as String?) ?? '',
    at: (m['at'] as num?)?.toInt() ?? 0,
    tool: (m['name'] as String?) ?? '',
    args: (m['args'] as Map?) ?? const {},
  );

  // ---- Chat history export / import ----
  // The exported file is exactly what import takes back.
  static String _chatPath(String op, Conversation c) => '/api/$op/${c.isGroup ? 'group' : 'dm'}/${c.id}';

  Future<String> exportChat(Conversation c) async =>
      const JsonEncoder.withIndent('  ').convert(await _map('GET', _chatPath('export', c)));

  /// Returns how many messages were imported.
  Future<int> importChat(Conversation c, String fileText, {required bool replace}) async {
    final Object? doc;
    try {
      doc = jsonDecode(fileText);
    } on FormatException {
      throw ApiException(ApiFailure.server, tr('api.notJsonFile'));
    }
    final j = await _map('POST', _chatPath('import', c), {'doc': doc, 'replace': replace});
    return (j['imported'] as num?)?.toInt() ?? 0;
  }

  Future<void> deleteAgent(String id) => _json('DELETE', '/api/bots/$id');

  Future<String> createGroup(String name, List<String> members, {String lead = ''}) async {
    final j = await _map('POST', '/api/groups', {'name': name, 'members': members, 'lead': lead});
    return (j['id'] as String?) ?? '';
  }

  Future<void> updateGroup(String id, String name, List<String> members, {String lead = ''}) =>
      _json('PATCH', '/api/groups/$id', {'name': name, 'members': members, 'lead': lead});

  Future<void> deleteGroup(String id) => _json('DELETE', '/api/groups/$id');

  Future<List<Provider>> providers() async {
    final j = await _list('/api/providers');
    return j.map((e) => Provider.fromJson(e as Map<String, Object?>)).toList();
  }

  Future<Provider> saveProvider(Map<String, Object?> body, {String? id}) async {
    final j = id == null ? await _map('POST', '/api/providers', body) : await _map('PATCH', '/api/providers/$id', body);
    return Provider.fromJson(j);
  }

  /// The Agent's browser as it is right now. null = he has not opened one
  /// (looking never starts it — only acting does).
  Future<({Uint8List image, String url, String title})?> browserShot(String agentId) async {
    final res = await _send('GET', '/api/browser/${Uri.encodeComponent(agentId)}/shot');
    final bytes = await res.fold<BytesBuilder>(BytesBuilder(copy: false), (b, d) => b..add(d));
    if (res.statusCode == 204) return null;
    if (res.statusCode >= 400) throw ApiException(ApiFailure.server, tr('api.shotFailed', {'code': res.statusCode}));
    String header(String n) => Uri.decodeComponent(res.headers.value(n) ?? '');
    return (image: bytes.takeBytes(), url: header('x-page-url'), title: header('x-page-title'));
  }

  /// The Agent's browser as a live stream (Chromium's screencast, relayed as
  /// MJPEG): a frame each time the page changes. Ends at once, with no frames,
  /// when he has no browser open — callers fall back to [browserShot].
  Stream<({Uint8List image, String url, String title})> browserStream(String agentId) async* {
    final res = await _send('GET', '/api/browser/${Uri.encodeComponent(agentId)}/stream');
    if (res.statusCode != 200) {
      await res.drain<void>();
      if (res.statusCode == 204) return;
      throw ApiException(ApiFailure.server, tr('api.streamFailed', {'code': res.statusCode}));
    }
    final parser = MjpegParser();
    await for (final chunk in res) {
      for (final f in parser.add(chunk)) {
        yield (image: f.image, url: f.header('x-page-url'), title: f.header('x-page-title'));
      }
    }
  }

  /// The live input channel into the Agent's browser: one JSON event per
  /// message (mouse move/down/up/wheel, keydown/keyup/press, text).
  Future<WebSocket> browserInput(String agentId) {
    final u = _uri('/api/browser/${Uri.encodeComponent(agentId)}/input');
    return WebSocket.connect(u.replace(scheme: u.scheme == 'https' ? 'wss' : 'ws').toString())
        .timeout(const Duration(seconds: 20));
  }

  /// A person acting in the Agent's browser: open, back, reload, click_xy,
  /// type_raw, press, wheel. Starts the browser if it is not running.
  Future<void> browserAct(String agentId, Map<String, Object?> action) async {
    final j = await _map('POST', '/api/browser/${Uri.encodeComponent(agentId)}/act', action);
    if (j['ok'] != true) throw ApiException(ApiFailure.server, (j['error'] as String?) ?? tr('api.browserRefused'));
  }

  Future<List<Skill>> skills() async {
    final j = await _list('/api/skills');
    return j.map((e) => Skill.fromJson(e as Map<String, Object?>)).toList();
  }

  Future<Skill> saveSkill(Map<String, Object?> body, {String? id}) async => Skill.fromJson(
    id == null ? await _map('POST', '/api/skills', body) : await _map('PATCH', '/api/skills/$id', body),
  );

  Future<void> deleteSkill(String id) => _json('DELETE', '/api/skills/$id');

  /// The skill as a SKILL.md file.
  Future<String> exportSkill(String id) async {
    final res = await _send('GET', '/api/skills/$id/export');
    final text = await utf8.decoder.bind(res).join();
    if (res.statusCode >= 400) throw ApiException(ApiFailure.server, tr('api.exportFailed', {'code': res.statusCode}));
    return text;
  }

  Future<Skill> importSkill(String text, {required String fallbackName, List<String> agents = const []}) async =>
      Skill.fromJson(await _map('POST', '/api/skills/import', {'text': text, 'name': fallbackName, 'agents': agents}));

  Future<List<Routine>> routines(Conversation c) async {
    final j = await _list('/api/routines?kind=${c.kind}&id=${Uri.encodeQueryComponent(c.id)}');
    return j.map((e) => Routine.fromJson(e as Map<String, Object?>)).toList();
  }

  Future<Routine> saveRoutine(Map<String, Object?> body, {String? id}) async => Routine.fromJson(
    id == null ? await _map('POST', '/api/routines', body) : await _map('PATCH', '/api/routines/$id', body),
  );

  Future<void> deleteRoutine(String id) => _json('DELETE', '/api/routines/$id');
  Future<void> runRoutine(String id) => _json('POST', '/api/routines/$id/run');

  Future<void> deleteProvider(String id) => _json('DELETE', '/api/providers/$id');
  Future<void> makeDefaultProvider(String id) => _json('POST', '/api/providers/$id/default');

  /// What models an upstream offers. [providerId] '' = the default upstream.
  /// An empty list means it would not say (some relays have no /models) —
  /// the editor then falls back to typing the name.
  Future<({List<String> models, String suggested})> models(String providerId) async {
    final j = await _map('POST', '/api/providers/models', {'id': providerId});
    return (
      models: [for (final m in (j['models'] as List?) ?? const []) if (m is String) m],
      suggested: (j['suggested'] as String?) ?? '',
    );
  }

  Future<Map<String, Object?>> testProvider(Map<String, Object?> body) async =>
      _map('POST', '/api/providers/test', body);

  /// What every agent has spent today and this month, plus the totals. One
  /// call feeds both the sidebar footer and the open conversation's panel.
  Future<Usage> usage() async => Usage.fromJson(await _map('GET', '/api/usage'));

  /// The platform-wide daily cap for agents that have none of their own.
  Future<void> setDefaultCap(int? micro) => _json('PUT', '/api/usage/cap', {'daily_cap_micro': micro});

  // ---- Approvals ----
  Future<ApprovalPolicy> approvalPolicy() async =>
      ApprovalPolicy.fromJson((await _json('GET', '/api/approvals/policy')) as Map<String, Object?>);

  Future<void> setApprovalPolicy(String mode, List<String> patterns) =>
      _json('PUT', '/api/approvals/policy', {'mode': mode, 'patterns': patterns});

  /// Answer one waiting call. The id only exists while the stream that asked is open,
  /// so a late click gets an ApiException rather than a silent yes.
  Future<void> answerApproval(String id, bool ok) => _json('POST', '/api/approvals/$id', {'ok': ok});

  /// Sends a message and yields events as they arrive.
  ///
  /// The reply is streamed because the whole point is watching a colleague
  /// work — tool calls, handoffs and text land as they happen, not in one
  /// block at the end.
  Stream<ChatEvent> chat(Conversation c, String text) async* {
    final res = await _send('POST', '/api/chat', {
      'target': {'type': c.kind, 'id': c.id},
      'text': text,
    });
    if (res.statusCode >= 400) {
      final body = await res.transform(utf8.decoder).join();
      String detail = body;
      try {
        final j = jsonDecode(body);
        if (j is Map && j['error'] is String) detail = j['error'] as String;
      } catch (_) {}
      throw ApiException(ApiFailure.server, detail.trim());
    }
    final parser = SseParser();
    // utf8.decoder with allowMalformed: a multi-byte character can straddle
    // two reads, and a hard decode error would abort a reply mid-word.
    // Silence for this long means the connection is gone (laptop slept, NAT
    // dropped it) — without a limit `busy` stays true and the composer is
    // disabled until the app restarts. Tool runs cap at 120s server-side and a
    // slow model call is ~2min, so 5min of nothing is not a slow answer.
    final chunks = res
        .transform(const Utf8Decoder(allowMalformed: true))
        .timeout(
          const Duration(minutes: 5),
          onTimeout: (sink) {
            sink.addError(ApiException(ApiFailure.unreachable, tr('api.silent')));
            sink.close();
          },
        );
    await for (final chunk in chunks) {
      for (final ev in parser.add(chunk)) {
        yield ev;
      }
    }
  }
}
