// Voice on the phone, against a fake server and a fake speech engine: what is read out of a
// streaming reply, dictation, and a call going round listen → send → speak → listen.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' show Locale;

import 'package:flutter_test/flutter_test.dart';
import 'package:multi_agent/data/settings.dart';
import 'package:multi_agent/data/speech.dart';
import 'package:multi_agent/data/voice.dart';
import 'package:multi_agent/state/voice.dart';
import 'package:multi_agent/state/workbench.dart';

const reply = ['Sure. Here is the command:\n```bash\nls', ' -la\n```\nThat lists', ' the files. Anything else?'];
const expected = ['Sure.', 'Here is the command:', '(code)', 'That lists the files.', 'Anything else?'];

class FakeEngine implements VoiceEngine {
  final said = <({String text, double pitch, double rate, String lang})>[];
  final played = <String>[];
  final heard = <String>[];

  /// Errors the next hears fail with, in order (before anything in [heard]).
  final errors = <String>[];
  int hears = 0, records = 0, silences = 0;
  Duration sayTime = const Duration(milliseconds: 5);
  Completer<String>? _hearing;
  String _partial = '';
  void Function(String)? _onPartial;

  bool get hearing => !(_hearing?.isCompleted ?? true);

  /// The recognizer revises what it has heard so far.
  void partial(String text) {
    _partial = text;
    _onPartial?.call(text);
  }

  /// The recognizer settles on what was said.
  void finish(String text) {
    if (hearing) _hearing!.complete(text);
  }
  Completer<void>? _saying;

  @override
  Future<({bool hear, bool speak})> caps() async => (hear: true, speak: true);

  @override
  Future<String> hear({required String lang, bool continuous = false, void Function(String)? onPartial, void Function(double)? onLevel}) {
    hears++;
    if (errors.isNotEmpty) return Future.error(VoiceError(errors.removeAt(0)));
    final c = _hearing = Completer<String>();
    _partial = '';
    _onPartial = onPartial;
    if (heard.isNotEmpty) {
      final next = heard.removeAt(0);
      Timer(const Duration(milliseconds: 20), () {
        _partial = next.split(' ').first;
        onPartial?.call(_partial);
        Timer(const Duration(milliseconds: 20), () {
          if (!c.isCompleted) c.complete(next);
        });
      });
    }
    return c.future; // nothing queued: listens until stopped or cancelled
  }

  /// How many recordings have someone speaking in them; after that, recording waits to be stopped.
  int speech = 0;
  Completer<String?>? _recording;

  @override
  Future<String?> record({required int endSilenceMs, required int noSpeechMs, required int maxMs, void Function(double)? onLevel}) async {
    records++;
    if (speech == 0) return (_recording = Completer<String?>()).future;
    speech--;
    final f = File('${Directory.systemTemp.createTempSync('rec').path}/heard.wav')..writeAsBytesSync(List.filled(2048, 1));
    return f.path;
  }

  @override
  Future<void> stopListening() async {
    if (!(_hearing?.isCompleted ?? true)) _hearing!.complete(_partial);
    if (!(_recording?.isCompleted ?? true)) _recording!.complete(null);
  }

  @override
  Future<void> cancelListening() async {
    if (!(_hearing?.isCompleted ?? true)) _hearing!.complete('');
    if (!(_recording?.isCompleted ?? true)) _recording!.complete(null);
  }

  @override
  Future<void> say(String text, {required double pitch, required double rate, String lang = '', String voice = ''}) {
    said.add((text: text, pitch: pitch, rate: rate, lang: lang));
    final c = _saying = Completer<void>();
    Timer(sayTime, () {
      if (!c.isCompleted) c.complete();
    });
    return c.future;
  }

  @override
  Future<void> play(String path) async {
    played.add(File(path).readAsStringSync());
  }

  @override
  Future<void> silence() async {
    silences++;
    if (!(_saying?.isCompleted ?? true)) _saying!.complete();
  }

  @override
  Future<List<({String name, String lang})>> voices() async => const [];

  final tones = <String>[];
  @override
  Future<void> tone(String kind) async => tones.add(kind);
}

/// The fake server: one agent "a", /api/chat streams [reply] in pieces, records what was sent.
Future<({HttpServer server, List<Map<String, Object?>> chats, List<String> spoken, List<Map<String, Object?>> ended})> fakeServer(
    {bool upstream = false, List<Map<String, Object?>> history = const []}) async {
  final chats = <Map<String, Object?>>[];
  final spoken = <String>[];
  final ended = <Map<String, Object?>>[];
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
      case '/api/settings/voice':
        res.write(jsonEncode(upstream
            ? {'stt': {'mode': 'upstream', 'provider_id': '', 'model': 'm'}, 'tts': {'mode': 'upstream', 'provider_id': '', 'model': 't', 'voice': 'v'}}
            : {'stt': {'mode': 'device'}, 'tts': {'mode': 'device'}}));
      case '/api/dm/a':
        res.write(jsonEncode(history));
      case '/api/calls/end':
        ended.add(jsonDecode(body) as Map<String, Object?>);
        res.write('{"ok":true}');
      case '/api/voice/transcribe':
        res.write(jsonEncode({'text': 'heard by the upstream'}));
      case '/api/voice/speak':
        final text = (jsonDecode(body) as Map)['text'] as String;
        spoken.add(text);
        res.headers.contentType = ContentType('audio', 'mpeg');
        res.write('audio:$text');
      case '/api/chat':
        chats.add(jsonDecode(body) as Map<String, Object?>);
        res.headers.contentType = ContentType('text', 'event-stream', charset: 'utf-8');
        res.bufferOutput = false;
        void ev(String name, Map<String, Object?> d) => res.write('event: $name\ndata: ${jsonEncode(d)}\n\n');
        ev('session', {'id': 's1'});
        ev('start', {'botId': 'a'});
        // "bye": the agent hangs up — its farewell is the reply, then the call ends
        if ('${(jsonDecode(body) as Map)['text']}'.contains('bye')) {
          ev('delta', {'botId': 'a', 'text': 'Talk soon!'});
          ev('end', {'botId': 'a'});
          ev('call_end', {'title': 'Quick chat'});
          ev('done', {});
          await res.close();
          return;
        }
        for (final piece in reply) {
          ev('delta', {'botId': 'a', 'text': piece});
          await res.flush();
          await Future<void>.delayed(const Duration(milliseconds: 10));
        }
        ev('end', {'botId': 'a'});
        ev('done', {});
      default:
        res.write('[]');
    }
    await res.close();
  });
  return (server: server, chats: chats, spoken: spoken, ended: ended);
}

Future<void> until(bool Function() f, {String reason = ''}) async {
  for (var i = 0; i < 1000 && !f(); i++) {
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
  expect(f(), isTrue, reason: reason);
}

Future<({Workbench bench, VoiceController voice, FakeEngine engine})> start(HttpServer server) async {
  final bench = Workbench(Settings(baseUrl: 'http://127.0.0.1:${server.port}', token: 't'));
  await bench.refresh();
  await bench.open(bench.conversations.single);
  final engine = FakeEngine();
  final voice = VoiceController(bench, engine, dir: Directory.systemTemp.createTempSync('voice'), deviceLocales: const [Locale('en', 'US')]);
  await voice.init();
  return (bench: bench, voice: voice, engine: engine);
}

void main() {
  test('a streaming reply is read sentence by sentence — only when reading aloud is on', () async {
    final f = await fakeServer();
    final t = await start(f.server);
    await t.bench.send('hi');
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(t.engine.said, isEmpty, reason: 'reading aloud is off by default');

    await t.voice.savePrefs(t.voice.prefs.copyWith(autoRead: true));
    await t.bench.send('again');
    await until(() => t.engine.said.length >= expected.length && !t.voice.speaking);
    expect(t.engine.said.map((x) => x.text).toList(), expected);
    final tone = deviceTone('a');
    expect(t.engine.said.every((x) => x.pitch == tone.pitch && x.rate == tone.rate && x.lang == 'en-US'), isTrue);

    // one message on its button; pressed again while it reads = stop
    t.engine.said.clear();
    t.engine.sayTime = const Duration(milliseconds: 300);
    final text = reply.join();
    await t.voice.readMessage(text, 'a');
    expect(t.voice.reading, text);
    await t.voice.readMessage(text, 'a');
    expect(t.voice.speaking, isFalse);
    expect(t.engine.said.length, 1, reason: 'stopped after the first sentence');
    t.voice.dispose();
    t.bench.dispose();
    await f.server.close(force: true);
  });

  test('a Chinese sentence is said in a Chinese voice whatever the interface is', () async {
    final f = await fakeServer();
    final t = await start(f.server);
    expect(t.voice.speakLang('你好。'), 'zh-CN');
    expect(t.voice.speakLang('Hello.'), 'en-US');
    await t.voice.savePrefs(t.voice.prefs.copyWith(lang: 'es-ES'));
    expect(t.voice.speakLang('Hola.'), 'es-ES');
    expect(t.voice.hearLang, 'es-ES');
    t.voice.dispose();
    t.bench.dispose();
    await f.server.close(force: true);
  });

  test('dictation returns what was heard; cancelled returns nothing', () async {
    final f = await fakeServer();
    final t = await start(f.server);
    t.engine.heard.add('hello there');
    expect(await t.voice.dictate(), 'hello there');
    expect(t.voice.dictating, isFalse);
    final listening = t.voice.dictate();
    await until(() => t.engine.hears == 2);
    await t.voice.cancelDictation();
    expect(await listening, '');
    t.voice.dispose();
    t.bench.dispose();
    await f.server.close(force: true);
  });

  test('a call: listen → send → read the answer → listen again; cut in; mute; hang up', () async {
    final f = await fakeServer();
    final t = await start(f.server);
    t.engine.heard.add('what time is it');
    expect(await t.voice.startCall(), isNull);
    await until(() => t.engine.said.length >= expected.length, reason: 'the answer is read');
    expect(f.chats.single['text'], 'what time is it');
    expect(f.chats.single['files'] ?? const [], isEmpty, reason: 'said in a call: no attachments ride along');
    expect(t.engine.said.map((x) => x.text).toList(), expected);
    await until(() => t.voice.callState == CallState.listening && t.engine.hears == 2, reason: 'listening again');

    // cut in while it speaks: the rest of that answer stays unread
    t.engine.sayTime = const Duration(milliseconds: 400);
    t.engine.said.clear();
    t.engine.heard.add('tell me more');
    await t.voice.tap(); // listening → "that's all": sends 'tell me more'... queued above
    await until(() => t.voice.callState == CallState.speaking, reason: 'speaking the second answer');
    await t.voice.tap();
    await until(() => t.voice.callState == CallState.listening);
    await Future<void>.delayed(const Duration(milliseconds: 500));
    expect(t.engine.said.length, 1, reason: 'cut in after the first sentence');

    await t.voice.toggleMute();
    expect(t.voice.callState, CallState.muted);
    final hears = t.engine.hears;
    await Future<void>.delayed(const Duration(milliseconds: 200));
    expect(t.engine.hears, hears, reason: 'muted: not listening');
    await t.voice.toggleMute();
    await until(() => t.voice.callState == CallState.listening && t.engine.hears == hears + 1);

    await t.voice.endCall();
    expect(t.voice.inCall, isFalse);
    t.voice.dispose();
    t.bench.dispose();
    await f.server.close(force: true);
  });

  test('talking over the agent cuts in; its own voice coming back does not', () async {
    final f = await fakeServer();
    final t = await start(f.server);
    t.engine.sayTime = const Duration(milliseconds: 400);
    t.engine.heard.add('first question');
    expect(await t.voice.startCall(), isNull);
    await until(() => t.voice.callState == CallState.speaking && t.engine.hearing, reason: 'listening while it speaks');
    // its own words through the mic — only what has already been played can come back
    await until(() => t.voice.saying == 'Here is the command:');
    t.engine.partial('Sure here is the command');
    await Future<void>.delayed(const Duration(milliseconds: 450));
    expect(t.voice.speaking, isTrue, reason: 'echo does not cut in');
    expect(t.voice.heard, isNot(contains('Sure')), reason: 'and is not shown as what the person said');
    // the person
    t.engine.partial('hang on what about');
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(t.voice.speaking, isTrue, reason: 'not before it has stood for a moment');
    t.engine.partial('hang on what about the tests');
    await until(() => !t.voice.speaking && t.voice.callState == CallState.listening, reason: 'cut in');
    final read = t.engine.said.length;
    expect(read, lessThan(expected.length), reason: 'the rest of the answer was not read');
    t.engine.finish('hang on what about the tests');
    await until(() => f.chats.length == 2, reason: 'what they said is the next message');
    expect(f.chats.last['text'], 'hang on what about the tests');
    await until(() => t.voice.speaking);
    t.engine.sayTime = const Duration(milliseconds: 5);
    await until(() => !t.voice.speaking && t.voice.callState == CallState.listening);
    // a final that is only the echo of what it just said is dropped, not sent
    t.engine.finish('that lists the files anything else');
    await Future<void>.delayed(const Duration(milliseconds: 300));
    expect(f.chats.length, 2, reason: 'its own voice is not sent back to it');
    expect(t.engine.hearing, isTrue, reason: 'and it keeps listening');
    await t.voice.endCall();
    t.voice.dispose();
    t.bench.dispose();
    await f.server.close(force: true);
  });

  test('the agent hangs up: its farewell is read, then the call ends with a tone', () async {
    final f = await fakeServer();
    final t = await start(f.server);
    t.engine.heard.add('ok bye');
    expect(await t.voice.startCall(), isNull);
    final id = t.voice.callId;
    await until(() => !t.voice.inCall, reason: 'hung up by the agent');
    expect(t.engine.said.map((x) => x.text), ['Talk soon!'], reason: 'the farewell was read first');
    expect((f.chats.single['call'] as Map)['id'], id, reason: 'what was said carried the call id');
    expect(t.engine.tones, ['connect', 'hangup']);
    await until(() => f.ended.isNotEmpty);
    expect(f.ended.single, {'session': 's1', 'call': id});
    t.voice.dispose();
    t.bench.dispose();
    await f.server.close(force: true);
  });

  test('a call in the history folds into one card', () async {
    final f = await fakeServer(history: [
      {'id': 1, 'role': 'user', 'content': 'before the call', 'at': 1000},
      {'id': 2, 'role': 'event', 'at': 2000, 'event': {'kind': 'call', 'phase': 'start', 'call': 'call-x'}},
      {'id': 3, 'role': 'user', 'content': 'plan the weekend', 'at': 3000},
      {'id': 4, 'role': 'assistant', 'content': 'Sure.', 'at': 4000},
      {'id': 5, 'role': 'event', 'at': 182000, 'event': {'kind': 'call', 'phase': 'end', 'call': 'call-x', 'title': 'Weekend plan'}},
      {'id': 6, 'role': 'user', 'content': 'after the call', 'at': 190000},
    ]);
    final t = await start(f.server);
    final e = t.bench.entries;
    expect(e.length, 3);
    expect((e[0] as Said).text, 'before the call');
    final card = e[1] as CallCard;
    expect([card.heading, card.said, card.lines.length, (card.lastAt - card.startAt) ~/ 60000], ['Weekend plan', 1, 2, 3]);
    expect((e[2] as Said).text, 'after the call');
    t.voice.dispose();
    t.bench.dispose();
    await f.server.close(force: true);
  });

  test('a call rides out a passing recognizer error, and hangs up on a run of them or one that cannot pass', () async {
    final f = await fakeServer();
    final t = await start(f.server);
    final said = <String>[];
    t.voice.onError = said.add;
    t.engine.errors.addAll(['network', 'busy']);
    t.engine.heard.add('still there?');
    expect(await t.voice.startCall(), isNull);
    await until(() => f.chats.isNotEmpty, reason: 'two passing errors, then heard and sent');
    expect(t.voice.inCall, isTrue);
    expect(said, isEmpty, reason: 'nothing to tell the person');
    await t.voice.endCall();

    t.engine.errors.addAll(['error', 'error', 'error']);
    expect(await t.voice.startCall(), isNull);
    await until(() => !t.voice.inCall, reason: 'three in a row: hung up');
    expect(said.single, isNotEmpty);

    t.engine.errors.add('denied');
    expect(await t.voice.startCall(), isNull);
    await until(() => !t.voice.inCall, reason: 'no microphone: hung up at once');
    expect(said.length, 2);
    t.voice.dispose();
    t.bench.dispose();
    await f.server.close(force: true);
  });

  test('on an upstream voice: recorded, transcribed by the server, answer played from its audio', () async {
    final f = await fakeServer(upstream: true);
    final t = await start(f.server);
    t.engine.speech = 1;
    expect(await t.voice.startCall(), isNull);
    await until(() => t.engine.played.length >= expected.length, reason: 'the answer is played');
    expect(t.engine.records, greaterThanOrEqualTo(1));
    expect(f.chats.first['text'], 'heard by the upstream');
    expect(f.spoken.toSet(), expected.toSet());
    expect(t.engine.played, [for (final s in expected) 'audio:$s'], reason: 'played in order');
    expect(t.engine.said, isEmpty, reason: 'no device voice on an upstream voice');
    await t.voice.endCall();
    t.voice.dispose();
    t.bench.dispose();
    await f.server.close(force: true);
  });
}
