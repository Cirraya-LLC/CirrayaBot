import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:multi_agent/data/settings.dart';
import 'package:multi_agent/state/workbench.dart';

/// A reply that only goes on once the person has said something more: the second /api/chat (with
/// interject) is answered with a note, and the first stream then carries on with a new bubble.
void main() {
  test('a message sent while a reply streams goes into that turn', () async {
    final interjected = Completer<Map<String, Object?>>();
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      final res = req.response..headers.contentType = ContentType.json;
      final body = await utf8.decoder.bind(req).join();
      switch (req.uri.path) {
        case '/api/conversations':
          res.write(jsonEncode([{'kind': 'agent', 'id': 'a', 'name': 'A', 'members': ['a']}]));
        case '/api/bots':
          res.write(jsonEncode([{'id': 'a', 'name': 'A', 'persona': 'x'}]));
        case '/api/sessions':
          res.write('[{"id":"s1","title":"only"}]');
        case '/api/dm/a':
          res.write('[]');
        case '/api/chat':
          res.headers.contentType = ContentType('text', 'event-stream', charset: 'utf-8');
          res.bufferOutput = false;
          void ev(String name, Map<String, Object?> d) => res.write('event: $name\ndata: ${jsonEncode(d)}\n\n');
          final b = jsonDecode(body) as Map<String, Object?>;
          if (b['interject'] == true) {
            interjected.complete(b);
            ev('session', {'id': 's1'});
            ev('note', {'text': 'Passed on'});
            ev('done', {});
            break;
          }
          ev('session', {'id': 's1'});
          ev('start', {'botId': 'a'});
          ev('delta', {'botId': 'a', 'text': 'counting'});
          await res.flush();
          await interjected.future;
          ev('tool', {'botId': 'a', 'phase': 'interject', 'n': 1});
          ev('delta', {'botId': 'a', 'text': 'files and lines'});
          ev('end', {'botId': 'a'});
          ev('done', {});
        default:
          res.write('[]');
      }
      await res.close();
    });
    final bench = Workbench(Settings(baseUrl: 'http://127.0.0.1:${server.port}', token: 't'));
    await bench.refresh();
    await bench.open(bench.conversations.single);
    final sending = bench.send('count the files');
    for (var i = 0; i < 50 && !bench.entries.any((e) => e is Said && !e.mine); i++) {
      await Future<void>.delayed(const Duration(milliseconds: 20));
    }
    expect(bench.atWork, isTrue, reason: 'the open conversation is streaming here');
    await bench.interject('also the lines');
    expect((await interjected.future)['interject'], true);
    await sending;
    String show(Entry e) => switch (e) {
      Said s => '${s.mine ? 'me' : 'A'}: ${s.text}',
      Note n => 'note: ${n.text}',
      _ => '$e',
    };
    expect(bench.entries.map(show).toList(), [
      'me: count the files',
      'A: counting',
      'me: also the lines',
      'note: Passed on',
      'A: files and lines',
    ], reason: 'what it writes after taking the message in is a new bubble below it');
    expect(bench.busy, isFalse);
    bench.dispose();
    await server.close(force: true);
  });
}
