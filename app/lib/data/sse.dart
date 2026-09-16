/// The chat endpoint's wire format, parsed.
///
/// `/api/chat` answers with Server-Sent Events: a stream of `event:` / `data:`
/// pairs separated by a blank line. This is pure — bytes in, events out, no
/// sockets — because the interesting failures live here (a frame split across
/// two TCP reads, a `\r\n` server, a half-written JSON payload) and a test
/// that needs a live upstream to reach them is a test nobody runs.
library;

import 'dart:convert';

/// One event off the wire. `name` is the SSE event name; the rest is whatever
/// the server put in `data`, already decoded.
class ChatEvent {
  const ChatEvent(this.name, this.data);

  final String name;
  final Map<String, Object?> data;

  String get botId => (data['botId'] as String?) ?? '';
  String get text => (data['text'] as String?) ?? '';

  @override
  String toString() => 'ChatEvent($name, $data)';
}

/// Feeds bytes in, gets whole events out.
///
/// Keeps a buffer across calls: an event can — and in practice does — arrive
/// split across reads, and dropping the tail loses exactly the token the user
/// is watching appear.
class SseParser {
  String _buffer = '';

  /// Parses everything complete in [chunk]; the remainder waits for the next
  /// call. Frames that are not valid JSON are skipped rather than thrown:
  /// one malformed frame should not kill a reply that is otherwise arriving.
  List<ChatEvent> add(String chunk) {
    _buffer += chunk;
    final out = <ChatEvent>[];

    // A blank line ends an event. Servers and proxies disagree about newlines,
    // so normalise first — a CRLF proxy in front of the server would otherwise
    // make every frame look incomplete and nothing would ever render.
    _buffer = _buffer.replaceAll('\r\n', '\n');

    while (true) {
      final cut = _buffer.indexOf('\n\n');
      if (cut < 0) break;
      final frame = _buffer.substring(0, cut);
      _buffer = _buffer.substring(cut + 2);

      String? name;
      final payload = StringBuffer();
      for (final line in frame.split('\n')) {
        if (line.startsWith('event:')) {
          name = line.substring(6).trim();
        } else if (line.startsWith('data:')) {
          // Multiple data: lines in one frame concatenate with newlines — that
          // is the spec, and our own server relies on it for nothing today,
          // but a proxy is free to re-chunk into that shape.
          if (payload.isNotEmpty) payload.write('\n');
          payload.write(line.substring(5).trimLeft());
        }
      }
      if (name == null) continue;

      Object? decoded;
      try {
        decoded = jsonDecode(payload.toString());
      } catch (_) {
        continue;
      }
      out.add(ChatEvent(name, decoded is Map<String, Object?> ? decoded : const {}));
    }
    return out;
  }
}
