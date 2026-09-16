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

import '../l10n.dart';
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
  });

  final String id;
  final String name;
  final String description;
  final String persona;
  final String color;

  /// Empty = the default upstream / that upstream's own model.
  final String providerId;
  final String model;

  static Agent fromJson(Map<String, Object?> j) => Agent(
    id: (j['id'] as String?) ?? '',
    name: (j['name'] as String?) ?? '',
    description: (j['description'] as String?) ?? '',
    persona: (j['persona'] as String?) ?? '',
    color: (j['color'] as String?) ?? '',
    providerId: (j['provider_id'] as String?) ?? '',
    model: (j['model'] as String?) ?? '',
  );
}

/// One line in the transcript. [speaker] is empty for the person using the
/// app; in a group it is the Agent's display name.
class Message {
  const Message({required this.mine, required this.speaker, required this.text, required this.at});

  final bool mine;
  final String speaker;
  final String text;
  final int at;
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
  );
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

  /// Every URL carries `lang=` too, so a request that cannot set the header
  /// still gets its answer in the right language.
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
      res = await _attempt(method, path, body);
    } on HttpException catch (e) {
      // A pooled socket the server closed a moment ago: the request never
      // reached it, so sending once more on a fresh connection is safe.
      if (!e.message.contains('Connection closed')) {
        throw ApiException(ApiFailure.unreachable, e.message);
      }
      try {
        res = await _attempt(method, path, body);
      } on HttpException catch (e) {
        throw ApiException(ApiFailure.unreachable, e.message);
      } on SocketException catch (e) {
        throw ApiException(ApiFailure.unreachable, e.osError?.message ?? e.message);
      }
    } on SocketException catch (e) {
      throw ApiException(ApiFailure.unreachable, e.osError?.message ?? e.message);
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

  // ---- Agents & groups ----
  // Same endpoints the web page uses; the server generates the id for a
  // Chinese name that has no ASCII slug, so the client never asks for one.

  Future<String> createAgent(Map<String, Object?> body) async {
    final j = await _map('POST', '/api/bots', body);
    return (j['id'] as String?) ?? '';
  }

  Future<void> updateAgent(String id, Map<String, Object?> body) => _json('PATCH', '/api/bots/$id', body);

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
