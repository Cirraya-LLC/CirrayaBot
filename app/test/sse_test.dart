import 'package:flutter_test/flutter_test.dart';
import 'package:multi_agent/data/sse.dart';

void main() {
  // Multi-byte text on purpose: the UTF-8 path is what can break.
  test('a whole frame parses', () {
    final p = SseParser();
    final out = p.add('event: delta\ndata: {"botId":"chief","text":"你好"}\n\n');
    expect(out, hasLength(1));
    expect(out.first.name, 'delta');
    expect(out.first.botId, 'chief');
    expect(out.first.text, '你好');
  });

  // An event split across two TCP reads is normal, not an edge case —
  // dropping the tail drops the very character the user is watching appear.
  test('a frame split across two reads is joined', () {
    final p = SseParser();
    expect(p.add('event: delta\ndata: {"botId":"a","te'), isEmpty);
    final out = p.add('xt":"好"}\n\n');
    expect(out.single.text, '好');
  });

  test('three frames in one read', () {
    final p = SseParser();
    final out = p.add(
      'event: start\ndata: {"botId":"a"}\n\n'
      'event: delta\ndata: {"botId":"a","text":"1"}\n\n'
      'event: end\ndata: {"botId":"a"}\n\n',
    );
    expect(out.map((e) => e.name), ['start', 'delta', 'end']);
  });

  // Behind a CRLF proxy, without normalising every frame looks unfinished:
  // the UI shows nothing at all rather than an error.
  test('CRLF works too', () {
    final p = SseParser();
    final out = p.add('event: note\r\ndata: {"text":"x"}\r\n\r\n');
    expect(out.single.data['text'], 'x');
  });

  test('bad JSON skips that frame only, the stream goes on', () {
    final p = SseParser();
    final out = p.add(
      'event: delta\ndata: {bad\n\n'
      'event: delta\ndata: {"botId":"a","text":"still here"}\n\n',
    );
    expect(out.single.text, 'still here');
  });

  test('frames without event: are ignored (heartbeat comments)', () {
    final p = SseParser();
    expect(p.add(': keep-alive\n\n'), isEmpty);
  });
}
