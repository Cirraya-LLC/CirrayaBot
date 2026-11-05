import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:multi_agent/data/settings.dart';
import 'package:multi_agent/state/workbench.dart';

/// Tidying an Agent's own notes, undoing it, and importing another assistant's memories.
void main() {
  test('tidy, undo and import go to the right places and show the new text', () async {
    final puts = <String, Object?>{};
    var notes = 'a\na again\nb';
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
        case '/api/memory/agent/a':
          if (req.method == 'PUT') puts['memory'] = (jsonDecode(body) as Map)['text'];
          res.write(jsonEncode({'text': 'Likes tea'}));
        case '/api/memory/agent/a/self':
          res.write(jsonEncode({'text': notes}));
        case '/api/memory/agent/a/self/tidy':
          final before = notes;
          notes = 'a\nb';
          res.write(jsonEncode({'text': notes, 'before': before, 'changed': true}));
        case '/api/memory/agent/a/self/undo':
          notes = 'a\na again\nb';
          res.write(jsonEncode({'text': notes}));
        default:
          res.write('{}');
      }
      await res.close();
    });
    final bench = Workbench(Settings(baseUrl: 'http://127.0.0.1:${server.port}', token: 't'));
    await bench.refresh();
    await bench.open(bench.conversations.single);
    for (var i = 0; i < 50 && bench.selfMemory.isEmpty; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 20));
    }
    final shown = bench.selfMemoryFor;
    expect(await bench.tidySelfMemory(), isTrue);
    expect(bench.selfMemory, 'a\nb');
    expect(bench.selfMemoryFor, isNot(shown), reason: 'the page is told to show the new text');
    await bench.undoTidy();
    expect(bench.selfMemory, 'a\na again\nb');

    for (var i = 0; i < 50 && bench.memory.isEmpty; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 20));
    }
    await bench.importMemory('Lives in Lisbon\nWorks at night', 'Imported on 1/1:');
    expect(puts['memory'], 'Likes tea\n\nImported on 1/1:\nLives in Lisbon\nWorks at night');
    bench.dispose();
    await server.close(force: true);
  });
}
