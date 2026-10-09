import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:multi_agent/data/settings.dart';
import 'package:multi_agent/state/workbench.dart';

/// An agent asks for a credential mid-reply: the card carries what it is for and where it may go, and
/// the answer is posted to the request — never into the chat.
void main() {
  test('a request_secret card is answered with the value, which goes nowhere else', () async {
    final answered = Completer<Map<String, Object?>>();
    final chatBodies = <String>[];
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
        case '/api/bots/a/secrets':
          res.write(answered.isCompleted ? '[{"id":"x1","name":"GH","kind":"header","origin":"https://api.github.com"}]' : '[]');
        case '/api/secrets/requests/sq1':
          answered.complete(jsonDecode(body) as Map<String, Object?>);
          res.write('{"ok":true}');
        case '/api/chat':
          chatBodies.add(body);
          res.headers.contentType = ContentType('text', 'event-stream', charset: 'utf-8');
          res.bufferOutput = false;
          void ev(String name, Map<String, Object?> d) => res.write('event: $name\ndata: ${jsonEncode(d)}\n\n');
          const args = {'name': 'GH', 'purpose': 'read issues', 'origin': 'https://api.github.com'};
          ev('start', {'botId': 'a'});
          ev('tool', {'botId': 'a', 'phase': 'run', 'name': 'request_secret', 'args': args});
          ev('tool', {'botId': 'a', 'phase': 'secret', 'id': 'sq1', 'name': 'GH', 'purpose': 'read issues',
              'origin': 'https://api.github.com', 'kind': 'header'});
          await res.flush();
          await answered.future;
          ev('tool', {'botId': 'a', 'phase': 'secret_done', 'id': 'sq1', 'ok': true});
          ev('tool', {'botId': 'a', 'phase': 'done', 'name': 'request_secret', 'args': args, 'output': 'Saved as GH.'});
          ev('delta', {'botId': 'a', 'text': 'got it'});
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
    final sending = bench.send('read my issues');
    Ran? card;
    for (var i = 0; i < 50 && card?.secretAsk == null; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 20));
      card = bench.entries.whereType<Ran>().firstOrNull;
    }
    expect(card?.secretAsk?['origin'], 'https://api.github.com');
    expect(card!.label, contains('GH'));
    await bench.answerSecret(card, 'ghp_secret');
    expect(await answered.future, {'value': 'ghp_secret'});
    await sending;
    expect(card.secretAsk, isNull);
    expect(card.secretAnswer, 'saved');
    expect(chatBodies.join(), isNot(contains('ghp_secret')), reason: 'the value never rides on a chat message');
    await bench.loadSecrets();
    expect(bench.secrets.single.name, 'GH');
    bench.dispose();
    await server.close(force: true);
  });
}
