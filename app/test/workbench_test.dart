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
      case '/api/sessions':
        res.write(jsonEncode([
          {'id': 's-${req.uri.queryParameters['id']}', 'title': 'only'},
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
  tasksTest();
  filesTest();

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
        '/api/sessions' => '[{"id":"s1","title":"only"}]',
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

  // A conversation holds several sessions. The screen asks for one session's
  // history, a new session is nothing until its first message (the chat asks
  // for 'new' and the server names it), and a search hit opens its session.
  test('sessions: new one starts empty, the server names it, a hit opens its session', () async {
    final asked = <String>[];
    String? chatSession;
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      final res = req.response..headers.contentType = ContentType.json;
      asked.add('${req.uri.path}?${req.uri.query}');
      switch (req.uri.path) {
        case '/api/conversations':
          res.write(jsonEncode([{'kind': 'agent', 'id': 'a', 'name': 'A', 'members': ['a']}]));
        case '/api/bots':
          res.write(jsonEncode([{'id': 'a', 'name': 'A', 'persona': 'x'}]));
        case '/api/sessions':
          res.write(jsonEncode([
            {'id': 's2', 'title': 'latest', 'count': 1},
            {'id': 's1', 'title': 'older', 'count': 1},
          ]));
        case '/api/dm/a':
          final ses = req.uri.queryParameters['session'];
          res.write(jsonEncode([{'id': ses == 's1' ? 11 : 22, 'role': 'user', 'content': 'in $ses'}]));
        case '/api/chat':
          chatSession = (jsonDecode(await utf8.decoder.bind(req).join()) as Map)['session'] as String?;
          res.headers.contentType = ContentType('text', 'event-stream', charset: 'utf-8');
          res.write('event: session\ndata: {"id":"s3"}\n\n');
          res.write('event: delta\ndata: {"botId":"a","text":"hi"}\n\n');
          res.write('event: done\ndata: {}\n\n');
        default:
          res.write('[]');
      }
      await res.close();
    });
    final bench = Workbench(Settings(baseUrl: 'http://127.0.0.1:${server.port}', token: 't'));
    await bench.refresh();
    await bench.open(bench.conversations.first);
    expect(bench.session, 's2', reason: 'opens on the most recent session');
    expect((bench.entries.single as Said).text, 'in s2');

    await bench.openSession('s1', jumpTo: 11);
    expect((bench.entries.single as Said).text, 'in s1');
    expect(bench.entries.single.id, 11, reason: 'history rows keep their id, so a hit can find its message');
    expect(bench.jumpTo, 11);

    await bench.newSession();
    expect(bench.session, isNull);
    expect(bench.entries, isEmpty, reason: 'nothing from the other sessions carries over');
    await bench.send('fresh');
    expect(chatSession, 'new', reason: 'the session is created by its first message');
    expect(bench.session, 's3', reason: 'the id the server named it');
    expect(asked.where((a) => a.startsWith('/api/dm/a')), everyElement(contains('session=')));

    bench.dispose();
    await server.close(force: true);
  });

  // Auto mode: a run outlives the app that started it. The app has to see it
  // (so it can say "still working") and stop it; and a plan card reads as progress.
  test('a run started elsewhere shows as running and Stop stops it', () async {
    var running = true;
    Map<String, Object?>? stopped;
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      final res = req.response..headers.contentType = ContentType.json;
      switch (req.uri.path) {
        case '/api/conversations':
          res.write(jsonEncode([{'kind': 'agent', 'id': 'a', 'name': 'A', 'members': ['a']}]));
        case '/api/bots':
          res.write(jsonEncode([{'id': 'a', 'name': 'A', 'persona': 'x'}]));
        case '/api/sessions':
          res.write(jsonEncode([{'id': 's1', 'title': 'one'}]));
        case '/api/dm/a':
          res.write(jsonEncode([
            {'id': 1, 'role': 'tool', 'name': 'update_plan', 'output': 'Plan saved',
              'args': {'plan': [{'step': 'x', 'status': 'completed'}, {'step': 'y', 'status': 'in_progress'}]}},
          ]));
        case '/api/runs':
          res.write(jsonEncode(running ? [{'kind': 'agent', 'id': 'a', 'session': 's1', 'speaker': 'a', 'started_at': 0}] : []));
        case '/api/runs/stop':
          stopped = jsonDecode(await utf8.decoder.bind(req).join()) as Map<String, Object?>;
          running = false;
          res.write('{"stopped":1}');
        default:
          res.write('[]');
      }
      await res.close();
    });
    final bench = Workbench(Settings(baseUrl: 'http://127.0.0.1:${server.port}', token: 't'));
    await bench.refresh();
    await bench.open(bench.conversations.first);
    await bench.loadRuns();
    expect(bench.backgroundRun(bench.current)?.session, 's1');
    expect(bench.isRunning(bench.current!), isTrue);
    expect((bench.entries.single as Ran).label, contains('1/2'), reason: 'a plan card says how far along it is');

    await bench.stop();
    expect(stopped, {'kind': 'agent', 'id': 'a'});
    expect(bench.backgroundRun(bench.current), isNull);
    bench.dispose();
    await server.close(force: true);
  });
}

/// Background tasks: a stored event row comes back as task news, the panel's
/// list loads beside it, and a reply from the card goes to the task's own
/// endpoint — not into the conversation — after which the history is redrawn.
void tasksTest() {
  test('task news, the task list, and answering a task from its card', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    var status = 'waiting';
    String? answered;
    var historyReads = 0;
    server.listen((req) async {
      final res = req.response..headers.contentType = ContentType.json;
      switch (req.uri.path) {
        case '/api/conversations':
          res.write(jsonEncode([{'kind': 'agent', 'id': 'a', 'name': 'A', 'members': ['a']}]));
        case '/api/bots':
          res.write(jsonEncode([{'id': 'a', 'name': 'A', 'persona': 'x'}]));
        case '/api/sessions':
          res.write(jsonEncode([{'id': 's1', 'title': 'only'}]));
        case '/api/runs':
          res.write('[]');
        case '/api/dm/a':
          historyReads++;
          res.write(jsonEncode([
            {'id': 1, 'role': 'user', 'content': 'count the files'},
            {
              'id': 2,
              'role': 'event',
              'speaker': 'A',
              'event': {'task': 7, 'kind': 'asked', 'agent': 'A', 'agent_id': 'a', 'title': 'Count', 'text': 'Which folder?'},
            },
          ]));
        case '/api/tasks':
          res.write(jsonEncode([
            {
              'id': 7, 'session': 's1', 'agent_id': 'a', 'by_agent': 'a', 'title': 'Count', 'brief': 'count them',
              'status': status, 'question': status == 'waiting' ? 'Which folder?' : '', 'approval': null,
              'result': '', 'created_at': 1, 'updated_at': status == 'waiting' ? 1 : 2,
            },
          ]));
        case '/api/tasks/7/answer':
          answered = (jsonDecode(await utf8.decoder.bind(req).join()) as Map)['text'] as String?;
          status = 'queued';
          res.write('{"ok":true}');
        default:
          res.write('[]');
      }
      await res.close();
    });
    final bench = Workbench(Settings(baseUrl: 'http://127.0.0.1:${server.port}', token: 't'));
    await bench.refresh();
    await bench.open(bench.conversations.first);
    await bench.loadTasks();

    final news = bench.entries[1] as News;
    expect(news.kind, 'asked');
    expect(news.task, 7);
    expect(news.text, 'Which folder?');
    final task = bench.taskById(7)!;
    expect(task.asking, isTrue, reason: 'a waiting task with a question can be answered');
    expect(task.open, isTrue);

    final reads = historyReads;
    expect(await bench.answerTask(task, '/srv'), isNull);
    expect(answered, '/srv');
    // answerTask reloads the list without waiting; give it a moment
    for (var i = 0; i < 50 && bench.taskById(7)!.status != 'queued'; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 20));
    }
    expect(bench.taskById(7)!.status, 'queued');
    expect(historyReads, greaterThan(reads), reason: 'a task that moved redraws the transcript');
    bench.dispose();
    await server.close(force: true);
  });
}

/// Files: a stored message brings its attachments, a stored send_file call
/// comes back as the file (not a command card), a live one replaces its card
/// where it stood, and a message can be only files.
void filesTest() {
  test('attachments in history, send_file live and stored, and a files-only message', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    Map<String, Object?>? chatBody;
    final uploaded = <String>[];
    server.listen((req) async {
      final res = req.response..headers.contentType = ContentType.json;
      switch (req.uri.path) {
        case '/api/conversations':
          res.write(jsonEncode([{'kind': 'agent', 'id': 'a', 'name': 'A', 'members': ['a']}]));
        case '/api/bots':
          res.write(jsonEncode([{'id': 'a', 'name': 'A', 'persona': 'x', 'color': '#336699'}]));
        case '/api/sessions':
          res.write(jsonEncode([{'id': 's1', 'title': 'only'}]));
        case '/api/dm/a':
          res.write(jsonEncode([
            {
              'id': 1, 'role': 'user', 'content': 'look',
              'files': [{'id': 'f1', 'name': 'shot.png', 'mime': 'image/png', 'size': 10, 'kind': 'image'}],
            },
            {
              'id': 2, 'role': 'tool', 'speaker': 'A', 'name': 'send_file', 'args': {'path': '/work/r.md'},
              'output': 'Sent r.md', 'file': {'id': 'f2', 'name': 'r.md', 'mime': 'text/markdown', 'size': 5, 'kind': 'markdown'},
            },
            {'id': 3, 'role': 'assistant', 'content': 'done', 'files': []},
          ]));
        case '/api/files':
          await req.drain<void>();
          final name = req.uri.queryParameters['name']!;
          uploaded.add(name);
          res.write(jsonEncode({'id': 'up-$name', 'name': name, 'mime': 'text/plain', 'size': 3, 'kind': 'text'}));
        case '/api/chat':
          chatBody = jsonDecode(await utf8.decoder.bind(req).join()) as Map<String, Object?>;
          res.headers.contentType = ContentType('text', 'event-stream', charset: 'utf-8');
          void ev(String name, Map<String, Object?> d) => res.write('event: $name\ndata: ${jsonEncode(d)}\n\n');
          ev('session', {'id': 's1'});
          ev('start', {'botId': 'a'});
          ev('tool', {'botId': 'a', 'phase': 'run', 'name': 'send_file', 'args': {'path': 'out.pdf'}});
          ev('tool', {
            'botId': 'a', 'phase': 'done', 'name': 'send_file', 'args': {'path': 'out.pdf'}, 'output': 'Sent out.pdf',
            'file': {'id': 'f9', 'name': 'out.pdf', 'mime': 'application/pdf', 'size': 99, 'kind': 'pdf'},
          });
          ev('delta', {'botId': 'a', 'text': 'here you go'});
          ev('end', {'botId': 'a'});
          ev('done', {});
        default:
          res.write('[]');
      }
      await res.close();
    });
    final bench = Workbench(Settings(baseUrl: 'http://127.0.0.1:${server.port}', token: 't'));
    await bench.refresh();
    await bench.open(bench.conversations.first);

    final said = bench.entries[0] as Said;
    expect(said.files.single.name, 'shot.png');
    final sent = bench.entries[1] as SentFile;
    expect(sent.file.kind, 'markdown');
    expect(sent.speaker, 'A');

    // Pick a file, then send with no text: a message that is only files.
    final dir = await Directory.systemTemp.createTemp('wb-files');
    final f = File('${dir.path}/a.txt')..writeAsStringSync('abc');
    await bench.attach([f.path]);
    expect(uploaded, ['a.txt']);
    expect(bench.pending.single.attachment?.id, 'up-a.txt');
    expect(bench.uploading, isFalse);
    final before = bench.entries.length;
    await bench.send('');
    expect(chatBody?['files'], ['up-a.txt']);
    expect(bench.pending, isEmpty, reason: 'they went with the message');
    final mine = bench.entries[before] as Said;
    expect(mine.mine, isTrue);
    expect(mine.files.single.name, 'a.txt');
    // The live send_file card was replaced by the file, where the card stood: before the reply text.
    final live = bench.entries[before + 1];
    expect(live, isA<SentFile>());
    expect((live as SentFile).file.name, 'out.pdf');
    expect((bench.entries[before + 2] as Said).text, 'here you go');

    bench.dispose();
    await server.close(force: true);
    await dir.delete(recursive: true);
  });
}

