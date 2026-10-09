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

/// A backup model: tried, in order, when the agent's own keeps failing.
/// [providerId] '' = the default upstream.
class Fallback {
  const Fallback({this.providerId = '', required this.model});
  final String providerId;
  final String model;

  Map<String, Object?> toJson() => {'provider_id': providerId, 'model': model};

  static Fallback fromJson(Map<String, Object?> j) =>
      Fallback(providerId: (j['provider_id'] as String?) ?? '', model: (j['model'] as String?) ?? '');
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
    this.autonomy = '',
    this.dailyCapMicro,
    this.fallbacks = const [],
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

  /// How far it goes on its own: '' (follow the platform) / auto / manual.
  final String autonomy;

  /// Daily spend cap in micro-dollars. null = no cap of its own, so the
  /// platform default applies.
  final int? dailyCapMicro;

  /// Backup models, in the order they are tried.
  final List<Fallback> fallbacks;

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
    autonomy: (j['autonomy'] as String?) ?? '',
    dailyCapMicro: (j['daily_cap_micro'] as num?)?.toInt(),
    fallbacks: [
      for (final f in (j['fallbacks'] as List?) ?? const [])
        if (f is Map<String, Object?>) Fallback.fromJson(f),
    ],
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
    this.id,
    this.event,
    this.files = const [],
    this.file,
  });

  /// The server's row id — a search hit names the message it found by this.
  final int? id;
  final bool mine;
  final String speaker;
  final String text;
  final int at;
  final String? tool;
  final Map<Object?, Object?> args;

  /// Set for news about a background task (it asked, finished, failed…):
  /// `{task, kind, agent, agent_id, title, text, by?, approval?, files?}`.
  final Map<String, Object?>? event;

  /// What the message carries: the person's attachments, or none.
  final List<Attachment> files;

  /// On a `send_file` tool row: the file the agent sent.
  final Attachment? file;
}

/// A file someone sent — the person, or an agent with send_file. The bytes
/// stay on the server; this is what a screen needs to draw and fetch it.
class Attachment {
  const Attachment({required this.id, required this.name, required this.mime, required this.size, required this.kind});

  factory Attachment.fromJson(Map<String, Object?> j) => Attachment(
    id: '${j['id'] ?? ''}',
    name: (j['name'] as String?) ?? '',
    mime: (j['mime'] as String?) ?? 'application/octet-stream',
    size: (j['size'] as num?)?.toInt() ?? 0,
    kind: (j['kind'] as String?) ?? 'other',
  );

  /// A list of them from whatever the server put in a field; anything else is none.
  static List<Attachment> listOf(Object? v) => [
    for (final f in v is List ? v : const [])
      if (f is Map) Attachment.fromJson(f.cast<String, Object?>()),
  ];

  static Attachment? maybe(Object? v) => v is Map ? Attachment.fromJson(v.cast<String, Object?>()) : null;

  final String id;
  final String name;
  final String mime;
  final int size;

  /// image / video / audio / pdf / markdown / text / other — decided by the server.
  final String kind;

  bool get isImage => kind == 'image';
}

/// A size as a person reads it.
String sizeText(int n) => n < 1024
    ? '$n B'
    : n < 1024 * 1024
    ? '${(n / 1024).toStringAsFixed(1)} KB'
    : '${(n / (1024 * 1024)).toStringAsFixed(1)} MB';

/// The type to declare when uploading. The server decides again from the name
/// when this says nothing useful, so the list only needs the common ones.
String mimeForName(String name) {
  final dot = name.lastIndexOf('.');
  final ext = dot < 0 ? '' : name.substring(dot + 1).toLowerCase();
  return const {
        'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'gif': 'image/gif', 'webp': 'image/webp',
        'svg': 'image/svg+xml', 'bmp': 'image/bmp', 'heic': 'image/heic',
        'mp4': 'video/mp4', 'm4v': 'video/mp4', 'mov': 'video/quicktime', 'webm': 'video/webm',
        'mp3': 'audio/mpeg', 'm4a': 'audio/mp4', 'wav': 'audio/wav', 'ogg': 'audio/ogg',
        'pdf': 'application/pdf', 'md': 'text/markdown', 'markdown': 'text/markdown',
        'txt': 'text/plain', 'log': 'text/plain', 'csv': 'text/csv', 'json': 'application/json',
        'zip': 'application/zip',
      }[ext] ??
      'application/octet-stream';
}

/// Work a conversation handed out to run in the background. It reports back
/// into the conversation; this is the row the right panel lists.
class Task {
  const Task({
    required this.id,
    required this.session,
    required this.agentId,
    required this.byAgent,
    required this.title,
    required this.brief,
    required this.status,
    required this.question,
    required this.approvalId,
    this.approvalAlways = const [],
    required this.approvalSubject,
    required this.result,
    required this.createdAt,
    required this.updatedAt,
  });

  factory Task.fromJson(Map<String, Object?> j) {
    final a = j['approval'] as Map?;
    return Task(
      id: (j['id'] as num?)?.toInt() ?? 0,
      session: (j['session'] as String?) ?? '',
      agentId: (j['agent_id'] as String?) ?? '',
      byAgent: (j['by_agent'] as String?) ?? '',
      title: (j['title'] as String?) ?? '',
      brief: (j['brief'] as String?) ?? '',
      status: (j['status'] as String?) ?? 'queued',
      question: (j['question'] as String?) ?? '',
      approvalId: a?['id'] as String?,
      approvalSubject: (a?['subject'] as String?) ?? '',
      approvalAlways: [for (final p in (a?['always'] as List?) ?? const []) '$p'],
      result: (j['result'] as String?) ?? '',
      createdAt: (j['created_at'] as num?)?.toInt() ?? 0,
      updatedAt: (j['updated_at'] as num?)?.toInt() ?? 0,
    );
  }

  final int id;
  final String session;
  final String agentId;
  final String byAgent;
  final String title;
  final String brief;

  /// queued / running / waiting / done / failed / stopped.
  final String status;

  /// What it asked, while it waits for an answer.
  final String question;

  /// Set while it waits for a command to be allowed.
  final String? approvalId;
  final String approvalSubject;

  /// What "always allow" would cover: risky patterns, or '' for the whole tool. Empty = not offered.
  final List<String> approvalAlways;
  final String result;
  final int createdAt;
  final int updatedAt;

  bool get open => status == 'queued' || status == 'running' || status == 'waiting';
  bool get asking => status == 'waiting' && question.isNotEmpty;
}

/// One thing a task ran, for the expanded row.
class TaskStep {
  const TaskStep({required this.name, required this.args, required this.output});
  final String name;
  final Map<Object?, Object?> args;
  final String output;
}

/// One thread of a conversation. A conversation (a DM, a group) holds several;
/// the model only ever sees the one on screen.
class Session {
  const Session({required this.id, this.title = '', this.named = false, this.count = 0, this.updatedAt = 0});

  factory Session.fromJson(Map<String, Object?> j) => Session(
    id: (j['id'] as String?) ?? '',
    title: (j['title'] as String?) ?? '',
    named: j['named'] == true,
    count: (j['count'] as num?)?.toInt() ?? 0,
    updatedAt: (j['updated_at'] as num?)?.toInt() ?? 0,
  );

  final String id;

  /// The name given, or the start of the first thing the person said. '' when
  /// neither exists yet — the screen says "New session".
  final String title;

  /// Whether [title] was given by someone, rather than derived.
  final bool named;
  final int count;
  final int updatedAt;
}

/// A message that matched a search, and where it lives.
class SearchHit {
  const SearchHit({
    required this.id,
    required this.session,
    required this.mine,
    required this.speaker,
    required this.snippet,
    required this.at,
  });

  factory SearchHit.fromJson(Map<String, Object?> j) => SearchHit(
    id: (j['id'] as num?)?.toInt() ?? 0,
    session: (j['session'] as String?) ?? '',
    mine: j['role'] == 'user',
    speaker: (j['speaker'] as String?) ?? '',
    snippet: (j['snippet'] as String?) ?? '',
    at: (j['at'] as num?)?.toInt() ?? 0,
  );

  final int id;
  final String session;
  final bool mine;
  final String speaker;
  final String snippet;
  final int at;
}

/// The platform-wide answer to "when does an Agent have to ask first".
/// A message still being worked on. In auto mode it outlives the page that
/// started it, so the app has to be able to see it and stop it.
class Run {
  const Run({required this.kind, required this.id, required this.session, this.speaker = '', this.startedAt = 0});

  factory Run.fromJson(Map<String, Object?> j) => Run(
    kind: (j['kind'] as String?) ?? 'agent',
    id: (j['id'] as String?) ?? '',
    session: (j['session'] as String?) ?? '',
    speaker: (j['speaker'] as String?) ?? '',
    startedAt: (j['started_at'] as num?)?.toInt() ?? 0,
  );

  final String kind;
  final String id;
  final String session;

  /// The Agent working right now (its id).
  final String speaker;
  final int startedAt;

  bool isFor(Conversation c) => c.kind == kind && c.id == id;
}

class ApprovalPolicy {
  const ApprovalPolicy({this.mode = 'match', this.patterns = const [], this.allow = const []});

  final String mode;
  final List<String> patterns;

  /// Everything someone said "always allow" to.
  final List<Allowance> allow;

  static ApprovalPolicy fromJson(Map<String, Object?> j) => ApprovalPolicy(
    mode: (j['mode'] as String?) ?? 'match',
    patterns: ((j['patterns'] as List?) ?? const []).map((e) => '$e').toList(),
    allow: [
      for (final r in (j['allow'] as List?) ?? const [])
        if (r is Map<String, Object?>) Allowance.fromJson(r),
    ],
  );
}

/// One "always allow": this agent may do this without asking. [pattern] null = the whole tool
/// (a risky command still asks).
class Allowance {
  const Allowance({required this.id, required this.agentName, required this.tool, this.pattern, this.example = ''});
  final String id;
  final String agentName;
  final String tool;
  final String? pattern;
  final String example;

  static Allowance fromJson(Map<String, Object?> j) => Allowance(
    id: (j['id'] as String?) ?? '',
    agentName: (j['agent_name'] as String?) ?? (j['agent'] as String?) ?? '',
    tool: (j['tool'] as String?) ?? '',
    pattern: j['pattern'] as String?,
    example: (j['example'] as String?) ?? '',
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
    this.priceSource = '',
    this.priceInMicro,
    this.priceOutMicro,
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

  /// Where the price comes from: 'upstream' (its model list), 'manual' (typed on the upstream), '' (none).
  final String priceSource;

  /// The price in force, micro-dollars per million tokens.
  final int? priceInMicro;
  final int? priceOutMicro;

  static AgentSpend fromJson(Map<String, Object?> j) => AgentSpend(
    id: (j['id'] as String?) ?? '',
    name: (j['name'] as String?) ?? '',
    day: Spend.fromJson(j['day'] as Map<String, Object?>?),
    month: Spend.fromJson(j['month'] as Map<String, Object?>?),
    capMicro: (j['cap_micro'] as num?)?.toInt(),
    ownCap: (j['own_cap'] as bool?) ?? false,
    priced: (j['priced'] as bool?) ?? false,
    priceSource: (j['price_source'] as String?) ?? '',
    priceInMicro: (j['price_in_micro'] as num?)?.toInt(),
    priceOutMicro: (j['price_out_micro'] as num?)?.toInt(),
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
  Future<List<Message>> history(Conversation c, String session) async {
    final q = '?session=${Uri.encodeQueryComponent(session)}';
    if (c.isGroup) {
      final j = await _list('/api/groups/${c.id}/messages$q');
      return j.map((e) {
        final m = e as Map<String, Object?>;
        final speaker = (m['speaker'] as String?) ?? '';
        if (m['role'] == 'tool') return _toolMessage(m, speaker);
        if (m['role'] == 'event') return _eventMessage(m);
        return Message(
          id: (m['id'] as num?)?.toInt(),
          mine: speaker == userSpeaker,
          speaker: speaker,
          text: (m['text'] as String?) ?? '',
          at: (m['at'] as num?)?.toInt() ?? 0,
          files: Attachment.listOf(m['files']),
        );
      }).toList();
    }
    final j = await _list('/api/dm/${c.id}$q');
    return j.map((e) {
      final m = e as Map<String, Object?>;
      if (m['role'] == 'tool') return _toolMessage(m, c.name);
      if (m['role'] == 'event') return _eventMessage(m);
      return Message(
        id: (m['id'] as num?)?.toInt(),
        mine: m['role'] == 'user',
        speaker: m['role'] == 'user' ? userSpeaker : c.name,
        text: (m['content'] as String?) ?? '',
        at: (m['at'] as num?)?.toInt() ?? 0,
        files: Attachment.listOf(m['files']),
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

  // ---- Sessions & search ----

  Future<List<Session>> sessions(Conversation c) async {
    final j = await _list('/api/sessions?kind=${c.kind}&id=${Uri.encodeQueryComponent(c.id)}');
    return j.map((e) => Session.fromJson(e as Map<String, Object?>)).toList();
  }

  Future<void> renameSession(String id, String title) => _json('PATCH', '/api/sessions/$id', {'title': title});

  Future<void> deleteSession(String id) => _json('DELETE', '/api/sessions/$id');

  /// Everything said in [c], in any of its sessions, that contains [q]. Newest first.
  Future<List<SearchHit>> search(Conversation c, String q) async {
    final j = await _list(
      '/api/search?q=${Uri.encodeQueryComponent(q)}&kind=${c.kind}&id=${Uri.encodeQueryComponent(c.id)}',
    );
    return j.map((e) => SearchHit.fromJson(e as Map<String, Object?>)).toList();
  }

  Message _toolMessage(Map<String, Object?> m, String speaker) => Message(
    id: (m['id'] as num?)?.toInt(),
    mine: false,
    speaker: speaker.isEmpty ? '' : speaker,
    text: (m['output'] as String?) ?? '',
    at: (m['at'] as num?)?.toInt() ?? 0,
    tool: (m['name'] as String?) ?? '',
    args: (m['args'] as Map?) ?? const {},
    file: Attachment.maybe(m['file']),
  );

  Message _eventMessage(Map<String, Object?> m) => Message(
    id: (m['id'] as num?)?.toInt(),
    mine: false,
    speaker: (m['speaker'] as String?) ?? '',
    text: '',
    at: (m['at'] as num?)?.toInt() ?? 0,
    event: (m['event'] as Map?)?.cast<String, Object?>() ?? const {},
  );

  // ---- Background tasks ----
  Future<List<Task>> tasks(Conversation c) async {
    final j = await _list('/api/tasks?kind=${c.kind}&id=${Uri.encodeQueryComponent(c.id)}');
    return j.map((e) => Task.fromJson(e as Map<String, Object?>)).toList();
  }

  Future<List<TaskStep>> taskTrace(int id) async {
    final j = await _map('GET', '/api/tasks/$id');
    return [
      for (final s in (j['trace'] as List?) ?? const [])
        if (s is Map)
          TaskStep(name: '${s['name'] ?? ''}', args: (s['args'] as Map?) ?? const {}, output: '${s['output'] ?? ''}'),
    ];
  }

  /// The answer goes to the task only, not into the conversation — it may be a password.
  Future<void> answerTask(int id, String text) => _json('POST', '/api/tasks/$id/answer', {'text': text});
  Future<void> stopTask(int id) => _json('POST', '/api/tasks/$id/stop');

  // ---- Chat history export / import ----
  // The exported file is exactly what import takes back.
  static String _chatPath(String op, Conversation c) => '/api/$op/${c.isGroup ? 'group' : 'dm'}/${c.id}';

  /// One session — the one on screen.
  Future<String> exportChat(Conversation c, String session) async => const JsonEncoder.withIndent(
    '  ',
  ).convert(await _map('GET', '${_chatPath('export', c)}?session=${Uri.encodeQueryComponent(session)}'));

  /// Imports into a session of its own. Returns how many messages, and that session's id.
  Future<(int, String)> importChat(Conversation c, String fileText) async {
    final Object? doc;
    try {
      doc = jsonDecode(fileText);
    } on FormatException {
      throw ApiException(ApiFailure.server, tr('api.notJsonFile'));
    }
    final j = await _map('POST', _chatPath('import', c), {'doc': doc});
    return ((j['imported'] as num?)?.toInt() ?? 0, (j['session'] as String?) ?? '');
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

  /// The platform-wide reasoning effort, for every Agent that has none of its own.
  Future<String> defaultEffort() async {
    final j = (await _json('GET', '/api/settings/effort')) as Map<String, Object?>;
    return (j['effort'] as String?) ?? '';
  }

  Future<void> setDefaultEffort(String effort) =>
      _json('PUT', '/api/settings/effort', {'effort': effort});

  /// The platform-wide autonomy ('auto' / 'manual'), for every Agent that has none of its own.
  Future<String> defaultAutonomy() async {
    final j = (await _json('GET', '/api/settings/autonomy')) as Map<String, Object?>;
    return (j['autonomy'] as String?) ?? 'auto';
  }

  Future<void> setDefaultAutonomy(String mode) => _json('PUT', '/api/settings/autonomy', {'autonomy': mode});

  // ---- Runs ----

  Future<List<Run>> runs() async {
    final j = await _list('/api/runs');
    return j.map((e) => Run.fromJson(e as Map<String, Object?>)).toList();
  }

  /// Stop whatever is being worked on in [c]. Nothing running is not an error here.
  Future<void> stopRun(Conversation c) async {
    try {
      await _json('POST', '/api/runs/stop', {'kind': c.kind, 'id': c.id});
    } on ApiException catch (_) {}
  }

  // ---- Approvals ----
  Future<ApprovalPolicy> approvalPolicy() async =>
      ApprovalPolicy.fromJson((await _json('GET', '/api/approvals/policy')) as Map<String, Object?>);

  Future<void> setApprovalPolicy(String mode, List<String> patterns) =>
      _json('PUT', '/api/approvals/policy', {'mode': mode, 'patterns': patterns});

  /// Answer one waiting call. The id only exists while the stream that asked is open,
  /// so a late click gets an ApiException rather than a silent yes.
  /// [always]: approve, and stop asking this agent for this kind of call (the server decides how narrow).
  Future<void> answerApproval(String id, bool ok, {bool always = false}) =>
      _json('POST', '/api/approvals/$id', {'ok': ok, 'always': always});

  Future<void> revokeAllowance(String id) => _json('DELETE', '/api/approvals/allow/${Uri.encodeComponent(id)}');

  // ---- Files ----
  // The same network failures _send turns into ApiException, for calls that
  // stream a body or a download and so can't go through it.
  Future<T> _net<T>(Future<T> Function() f) async {
    try {
      return await f();
    } on HttpException catch (e) {
      throw ApiException(ApiFailure.unreachable, e.message);
    } on SocketException catch (e) {
      throw ApiException(ApiFailure.unreachable, e.osError?.message ?? e.message);
    } on StateError catch (e) {
      throw ApiException(ApiFailure.unreachable, e.message);
    } on ArgumentError {
      throw ApiException(ApiFailure.unreachable, tr('api.badUrl'));
    } on TlsException catch (e) {
      throw ApiException(ApiFailure.unreachable, tr('api.tls', {'detail': e.message}));
    }
  }

  /// A non-2xx answer as an ApiException, with the server's own sentence when it sent one.
  Future<Never> _fail(HttpClientResponse res) async {
    if (res.statusCode == 401) {
      await res.drain<void>();
      throw const ApiException(ApiFailure.unauthorized);
    }
    final text = await res.transform(const Utf8Decoder(allowMalformed: true)).join();
    String detail = text;
    try {
      final j = jsonDecode(text);
      if (j is Map && j['error'] is String) detail = j['error'] as String;
    } catch (_) {}
    throw ApiException(ApiFailure.server, detail.trim());
  }

  /// Upload a file to [c] — streamed from disk, so a large one never sits in
  /// memory. It belongs to that conversation and to no message until one is
  /// sent with it. A local file that can't be read throws FileSystemException.
  Future<Attachment> uploadFile(
    Conversation c,
    String path, {
    String? name,
    void Function(int sent, int total)? onProgress,
  }) async {
    final file = File(path);
    final fileName = name ?? path.split(RegExp(r'[\\/]')).last;
    final total = await file.length();
    final res = await _net(() async {
      final req = await _client.openUrl(
        'POST',
        _uri(
          '/api/files?kind=${c.kind}&id=${Uri.encodeQueryComponent(c.id)}&name=${Uri.encodeQueryComponent(fileName)}',
        ),
      );
      req.headers.set('X-Lang', currentLang.value.code);
      req.headers.contentType = ContentType.parse(mimeForName(fileName));
      req.contentLength = total;
      var sent = 0;
      onProgress?.call(0, total);
      await req.addStream(
        file.openRead().map((chunk) {
          sent += chunk.length;
          onProgress?.call(sent, total);
          return chunk;
        }),
      );
      return req.close();
    });
    if (res.statusCode >= 400) await _fail(res);
    final text = await res.transform(utf8.decoder).join();
    try {
      final j = jsonDecode(text);
      if (j is Map<String, Object?>) return Attachment.fromJson(j);
    } on FormatException {
      // fall through
    }
    throw ApiException(ApiFailure.server, tr('api.badShape'));
  }

  /// Take back an upload that was never sent.
  Future<void> deleteUpload(String id) => _json('DELETE', '/api/files/$id');

  /// Where a file is fetched from. The token rides in the query, so this is
  /// usable as-is by Image.network.
  Uri fileUri(String id, {bool download = false}) => _uri('/api/files/$id${download ? '?download=1' : ''}');

  /// The start of a text file, for a preview: at most [maxBytes], and whether
  /// there was more.
  Future<({String text, bool cut})> fileText(String id, {int maxBytes = 1 << 20}) async {
    final res = await _net(() async {
      final req = await _client.openUrl('GET', fileUri(id));
      req.headers.set('X-Lang', currentLang.value.code);
      req.headers.set(HttpHeaders.rangeHeader, 'bytes=0-${maxBytes - 1}');
      return req.close();
    });
    if (res.statusCode >= 400) await _fail(res);
    final bytes = <int>[];
    var cut = false;
    await for (final chunk in res) {
      final room = maxBytes - bytes.length;
      if (chunk.length >= room) {
        bytes.addAll(chunk.take(room));
        cut = cut || chunk.length > room;
        break;
      }
      bytes.addAll(chunk);
    }
    // A 206 says how long the whole file is: "bytes 0-1048575/5242880".
    final range = res.headers.value(HttpHeaders.contentRangeHeader);
    final whole = int.tryParse(range?.split('/').last ?? '');
    if (whole != null && whole > bytes.length) cut = true;
    return (text: const Utf8Decoder(allowMalformed: true).convert(bytes), cut: cut);
  }

  /// Save a file to [toPath].
  Future<void> downloadFile(String id, String toPath) async {
    final res = await _net(() async {
      final req = await _client.openUrl('GET', fileUri(id, download: true));
      req.headers.set('X-Lang', currentLang.value.code);
      return req.close();
    });
    if (res.statusCode >= 400) await _fail(res);
    final sink = File(toPath).openWrite();
    try {
      await _net(() => res.pipe(sink));
    } catch (_) {
      await sink.close().catchError((_) {});
      rethrow;
    }
  }

  /// Sends a message and yields events as they arrive.
  ///
  /// The reply is streamed because the whole point is watching a colleague
  /// work — tool calls, handoffs and text land as they happen, not in one
  /// block at the end.
  /// [session] null starts a new one; the server says which with a `session` event.
  Stream<ChatEvent> chat(Conversation c, String text, {String? session, List<String> files = const []}) async* {
    final res = await _send('POST', '/api/chat', {
      'target': {'type': c.kind, 'id': c.id},
      'text': text,
      'session': session ?? 'new',
      if (files.isNotEmpty) 'files': files,
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
