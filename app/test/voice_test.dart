// The same cases as web/voice.mjs's self-test: a reply must sound the same in both clients.
import 'package:flutter_test/flutter_test.dart';
import 'package:multi_agent/data/voice.dart';

void main() {
  test('what is read out of a reply', () {
    expect(speakable('Run this:\n```bash\nrm -rf /\n```\nthen check.'), 'Run this:\n(code)\nthen check.');
    expect(speakable('See [the docs](https://x.com/a_(b)) and https://y.com/z now.'), 'See the docs and now.');
    expect(speakable('## Title\n- **bold** item\n- `code` item\n1. first'), 'Title\nbold item\ncode item\nfirst');
    expect(speakable('| a | b |\n|---|---|\n| 1 | 2 |'), 'a, b\n1, 2');
    expect(speakable('half a block ```js\nconst x = 1'), 'half a block (code)');
    expect(speakable('@Lin please look'), 'Lin please look');
    expect(speakable('snake_case and *emphasis*'), 'snake_case and emphasis');
    expect(speakable('代码：\n```\nls\n```', codeWord: '代码'), '代码：\n(代码)');
  });

  test('sentences', () {
    var s = sentences('Hello there. How are');
    expect(s.out, ['Hello there.']);
    expect(s.rest, 'How are');
    expect(sentences('Pi is 3.14').out, isEmpty, reason: 'a decimal point is not the end of a sentence');
    expect(sentences('Pi is 3.14', isFinal: true).out, ['Pi is 3.14']);
    expect(sentences('你好。今天怎么样？还').out, ['你好。', '今天怎么样？']);
    expect(sentences('Line one\nLine two\n').out, ['Line one', 'Line two']);
    expect(sentences('(code)\n...\n', isFinal: true).out, ['(code)']);
    expect(sentences('word, ' * 80).out.every((x) => x.length <= 220), isTrue);
  });

  test('a streaming reply is read sentence by sentence, a code block once', () {
    final r = Reader();
    expect(r.push('Here it is. Run'), ['Here it is.']);
    expect(r.push(' this:\n```bash\nls -la\nrm x\n'), ['Run this:']);
    expect(r.push('```\nDone. All'), ['(code)', 'Done.']);
    expect(r.push(' good', isFinal: true), ['All good']);
    final r2 = Reader();
    expect(r2.push('**Bold claim.** And more'), ['Bold claim.']);
    expect(r2.push('', isFinal: true), ['And more']);
    final r3 = Reader();
    expect(r3.push('Pi is 3.'), isEmpty);
    expect(r3.push('14 roughly. '), ['Pi is 3.14 roughly.']);
    expect(Reader().push('| a | b |\n|---|---|\n| 1 | 2 |\n'), ['a, b', '1, 2']);
    expect(Reader().push('word ' * 80), isNotEmpty);
  });

  test('script', () {
    expect(scriptOf('你好'), 'zh');
    expect(scriptOf('こんにちは'), 'ja');
    expect(scriptOf('안녕'), 'ko');
    expect(scriptOf('Привет'), 'ru');
    expect(scriptOf('Hello'), '');
  });

  test('each agent sounds the same on the phone as on the web', () {
    // Values printed by web/voice.mjs's deviceTone for the same ids.
    const web = {
      'chief': (0.95, 0.94), 'operator': (1.0, 0.97), 'researcher': (1.075, 0.94),
      'lin': (0.9, 1.0), 'a1b2c3': (0.925, 1.06), '小林': (0.85, 1.03),
    };
    for (final e in web.entries) {
      final t = deviceTone(e.key);
      expect((t.pitch, t.rate), e.value, reason: e.key);
    }
  });

  test('cutting in: the agent\'s own voice coming back is not the person', () {
    expect(tokens('Hello, World 42'), ['hello', 'world', '42']);
    expect(tokens('巴黎是首都'), ['巴黎', '黎是', '是首', '首都']);
    expect(wordCount('what is three'), 3);
    expect(wordCount('等一下'), 1.5);
    const t0 = 1000000;
    final mem = SpokenMemory()..add('The capital of France is Paris.', now: t0);
    expect(mem.isEcho('capital of France is', now: t0 + 500), isTrue);
    expect(mem.isEcho('what about Germany', now: t0 + 500), isFalse);
    expect(isBargeIn('France is Paris', mem, now: t0 + 500), isFalse, reason: 'echo never cuts in');
    expect(isBargeIn('what about Germany', mem, now: t0 + 500), isTrue);
    expect(isBargeIn('Stop!', mem, now: t0 + 500) && isBargeIn('等一下', mem, now: t0 + 500), isTrue);
    expect(isBargeIn('okay', mem, now: t0 + 500) || isBargeIn('好的', mem, now: t0 + 500), isFalse);
    expect(isInterimBargeIn('stop', mem, now: t0 + 500), isFalse);
    expect(isInterimBargeIn('wait a second', mem, now: t0 + 500), isTrue);
    final zh = SpokenMemory()..add('图片中是一台安装在墙上的空调。', now: t0);
    expect(zh.isEcho('一台安装在墙上的', ratio: 0.4, now: t0 + 100), isTrue);
    expect(zh.isEcho('那温度是多少', ratio: 0.4, now: t0 + 100), isFalse);
    expect(isBargeIn('那温度是多少呢', zh, now: t0 + 100), isTrue);
    expect(isBargeIn('墙上的空调', zh, now: t0 + 100), isFalse);
    final old = SpokenMemory()..add('The capital of France is Paris.', now: t0);
    expect(old.isEcho('capital of France is', now: t0 + 31000), isFalse, reason: 'forgotten after half a minute');
  });

  test('settings round trip', () {
    final v = VoiceSettings.fromJson({
      'stt': {'mode': 'upstream', 'provider_id': 'p1', 'model': 'm'},
      'tts': {'mode': 'device'},
    });
    expect(v.stt.upstream, isTrue);
    expect(v.toJson(), {
      'stt': {'mode': 'upstream', 'provider_id': 'p1', 'model': 'm'},
      'tts': {'mode': 'device'},
    });
  });
}
