import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:multi_agent/data/settings.dart';
import 'package:multi_agent/state/workbench.dart';

/// A stand-in for the server: two DMs, and a chat reply that is released in
/// two halves so the test can act in between.
Future<(HttpServer, Completer<void>)> fakeServer({String historyB = 'B history', bool toolInHistory = false}) async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  final release = Completer<void>();
  server.listen((req) async {
    final res = req.response..headers.contentType = ContentType.json;
    switch (req.uri.path) {
      case '/api/conversations':
        res.write(jsonEncode([
          {'kind': 'agent', 'id': 'a', 'name': 'A', 'members': ['a']},
          {'kind': 'agent', 'id': 'b', 'name': 'B', 'members': ['b']},
        ]));
      case '/api/bots':
        res.write(jsonEncode([
          {'id': 'a', 'name': 'A', 'persona': 'x'},
          {'id': 'b', 'name': 'B', 'persona': 'x'},
        ]));
      case '/api/dm/a':
        res.write('[]');
      case '/api/dm/b':
        res.write(jsonEncode([
          if (toolInHistory)
            {'role': 'tool', 'speaker': 'B', 'name': 'bash', 'args': {'command': 'uname -a'}, 'output': 'Linux'},
          {'role': 'assistant', 'content': historyB},
        ]));
      case '/api/chat':
        await utf8.decoder.bind(req).join();
        res.headers.contentType = ContentType('text', 'event-stream', charset: 'utf-8');
        res.bufferOutput = false;
        void ev(String name, Map<String, Object?> d) => res.write('event: $name\ndata: ${jsonEncode(d)}\n\n');
        ev('start', {'botId': 'a'});
        ev('delta', {'botId': 'a', 'text': 'first half'});
        await res.flush();
        await release.future;
        // After the switch: a tool run, then more text — each of these adds a
        // new entry, which is what used to land in the other conversation.
        ev('tool', {'botId': 'a', 'phase': 'run', 'name': 'bash', 'args': {'command': 'ls'}});
        ev('tool', {'botId': 'a', 'phase': 'done', 'name': 'bash', 'args': {'command': 'ls'}, 'output': 'x'});
        ev('delta', {'botId': 'a', 'text': 'second half'});
        ev('end', {'botId': 'a'});
        ev('done', {});
    }
    await res.close();
  });
  return (server, release);
}

void main() {
  // Reopening a conversation used to show only the final text: which commands ran was
  // lost with the stream. A stored tool row has to come back as a finished card.
  test('a stored tool call comes back as a finished card', () async {
    final (server, release) = await fakeServer(toolInHistory: true);
    release.complete();
    final bench = Workbench(Settings(baseUrl: 'http://127.0.0.1:${server.port}', token: 't'));
    await bench.refresh();
    await bench.open(bench.conversations[1]); // B

    expect(bench.entries.length, 2);
    final card = bench.entries.first as Ran;
    expect(card.label, 'uname -a');
    expect(card.output, 'Linux');
    expect(card.running, isFalse, reason: 'a card read back from history is never still running');
    expect((bench.entries[1] as Said).text, 'B history');
    bench.dispose();
    await server.close(force: true);
  });

  // What the review caught: open A, send, click B while A is still answering —
  // A's reply kept landing in B's transcript.
  test('a reply still streaming does not land in the conversation switched to', () async {
    final (server, release) = await fakeServer();
    final bench = Workbench(Settings(baseUrl: 'http://127.0.0.1:${server.port}', token: 't'));
    await bench.refresh();
    await bench.open(bench.conversations.first); // A

    final sending = bench.send('hello');
    await Future<void>.delayed(const Duration(milliseconds: 200)); // first half has arrived
    await bench.open(bench.conversations[1]); // switch to B mid-reply
    release.complete();
    await sending;

    expect(bench.current!.id, 'b');
    expect(bench.entries.length, 1, reason: 'only B\'s own history; A\'s tool cards and reply must not land here');
    expect((bench.entries.single as Said).text, 'B history');
    expect(bench.busy, isFalse);
    bench.dispose();
    await server.close(force: true);
  });

  test('switching quickly: the older history does not mix into the newer one', () async {
    final (server, release) = await fakeServer();
    release.complete();
    final bench = Workbench(Settings(baseUrl: 'http://127.0.0.1:${server.port}', token: 't'));
    await bench.refresh();
    final a = bench.conversations.first, b = bench.conversations[1];
    await Future.wait([bench.open(b), bench.open(a)]); // B's request first, A clicked last
    expect(bench.current!.id, 'a');
    expect(bench.entries, isEmpty); // A has no history; B's must not be here
    bench.dispose();
    await server.close(force: true);
  });

  // A scheduled task writes into the open conversation while nobody types:
  // the next poll has to show it, without the user clicking away and back.
  test('poll redraws the open conversation when something new landed in it', () async {
    var at = 1, history = <Map<String, Object?>>[{'role': 'user', 'content': 'old'}];
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      final res = req.response..headers.contentType = ContentType.json;
      res.write(switch (req.uri.path) {
        '/api/conversations' => jsonEncode([{'kind': 'agent', 'id': 'a', 'name': 'A', 'members': ['a'], 'at': at}]),
        '/api/bots' => jsonEncode([{'id': 'a', 'name': 'A', 'persona': 'x'}]),
        '/api/dm/a' => jsonEncode(history),
        '/api/routines' => '[]',
        '/api/memory/agent/a' => '{"text":""}',
        _ => '{}',
      });
      await res.close();
    });
    final bench = Workbench(Settings(baseUrl: 'http://127.0.0.1:${server.port}', token: 't'));
    await bench.refresh();
    await bench.open(bench.conversations.first);
    expect((bench.entries.single as Said).text, 'old');

    history = [...history, {'role': 'assistant', 'content': 'routine result'}];
    at = 2;
    await bench.poll();
    expect(bench.entries.length, 2);
    expect((bench.entries.last as Said).text, 'routine result');

    // Mid-reply the transcript is being drawn live; a poll must leave it alone.
    history = [{'role': 'user', 'content': 'must not appear'}];
    at = 3;
    bench.busy = true;
    await bench.poll();
    expect((bench.entries.last as Said).text, 'routine result');
    bench.dispose();
    await server.close(force: true);
  });
}
