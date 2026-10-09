import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:multi_agent/data/settings.dart';
import 'package:multi_agent/state/workbench.dart';

/// A server whose reply stops at an approval card offering "always allow", and records the answer.
void main() {
  test('"always allow" is offered with what it covers, and sent as such', () async {
    final answered = Completer<Map<String, Object?>>();
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
        case '/api/approvals/ap1':
          answered.complete(jsonDecode(body) as Map<String, Object?>);
          res.write('{"ok":true}');
        case '/api/chat':
          res.headers.contentType = ContentType('text', 'event-stream', charset: 'utf-8');
          res.bufferOutput = false;
          void ev(String name, Map<String, Object?> d) => res.write('event: $name\ndata: ${jsonEncode(d)}\n\n');
          const args = {'command': 'git push origin main'};
          ev('start', {'botId': 'a'});
          ev('tool', {'botId': 'a', 'phase': 'run', 'name': 'bash', 'args': args});
          ev('tool', {'botId': 'a', 'phase': 'ask', 'name': 'bash', 'args': args, 'id': 'ap1', 'always': [r'\bgit\s+push\b']});
          await res.flush();
          await answered.future;
          ev('tool', {'botId': 'a', 'phase': 'answered', 'name': 'bash', 'args': args, 'id': 'ap1', 'ok': true});
          ev('tool', {'botId': 'a', 'phase': 'done', 'name': 'bash', 'args': args, 'output': 'pushed'});
          ev('delta', {'botId': 'a', 'text': 'done'});
          ev('end', {'botId': 'a'});
          ev('done', {});
        default:
          res.write('{}');
      }
      await res.close();
    });
    final bench = Workbench(Settings(baseUrl: 'http://127.0.0.1:${server.port}', token: 't'));
    await bench.refresh();
    await bench.open(bench.conversations.single);
    final sending = bench.send('push it');
    Ran? card;
    for (var i = 0; i < 50 && card?.approvalId == null; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 20));
      card = bench.entries.whereType<Ran>().firstOrNull;
    }
    expect(card?.approvalId, 'ap1');
    expect(card!.always, [r'\bgit\s+push\b'], reason: 'the card knows what "always" would cover');
    await bench.answer(card, true, true);
    expect(await answered.future, {'ok': true, 'always': true});
    await sending;
    expect(card.approved, isTrue);
    expect(card.alwaysAllowed, isTrue);
    expect(card.output, 'pushed');
    bench.dispose();
    await server.close(force: true);
  });
}
