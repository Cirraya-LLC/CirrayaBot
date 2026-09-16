import 'package:flutter_test/flutter_test.dart';
import 'package:multi_agent/data/markup.dart';

void main() {
  test('plain text is one paragraph', () {
    final b = parseMessage('just one sentence');
    expect(b, hasLength(1));
    expect((b.single as Paragraph).spans.single, isA<TextSpanPart>());
  });

  test('a fenced code block is its own block, language recognised', () {
    final b = parseMessage('look:\n```bash\nls -la\n```\ndone');
    expect(b, hasLength(3));
    expect(b[1], isA<CodeBlock>());
    expect((b[1] as CodeBlock).language, 'bash');
    expect((b[1] as CodeBlock).code, 'ls -la');
  });

  test('inline code', () {
    final p = parseMessage('edit `group/ok.txt` and done').single as Paragraph;
    expect(p.spans.whereType<CodeSpan>().single.text, 'group/ok.txt');
  });

  // This is why the file exists. \b uses [A-Za-z0-9_] word boundaries; there
  // is no boundary after a CJK character, so \b never matches Chinese names —
  // and Chinese names are the main use case. The CJK test data is deliberate.
  test('@ with a Chinese name is recognised', () {
    final p = parseMessage('@小林 please write the README', names: ['小林']).single as Paragraph;
    expect(p.spans.first, isA<MentionSpan>());
    expect((p.spans.first as MentionSpan).name, '小林');
  });

  test('longer name wins: 小林二 is not taken by 小林', () {
    final p = parseMessage('@小林二 carry on', names: ['小林', '小林二']).single as Paragraph;
    expect((p.spans.first as MentionSpan).name, '小林二');
  });

  test('an @ not on the roster is plain text', () {
    final p = parseMessage('@nobody hello', names: ['小林']).single as Paragraph;
    expect(p.spans.whereType<MentionSpan>(), isEmpty);
  });

  test('@name inside a code block is not a handoff', () {
    final b = parseMessage('```\n@小林\n```', names: ['小林']);
    expect(b.single, isA<CodeBlock>());
  });

  test('@name inside inline code is not either', () {
    final p = parseMessage('write it as `@小林` like this', names: ['小林']).single as Paragraph;
    expect(p.spans.whereType<MentionSpan>(), isEmpty);
  });

  test('English names with spaces work (Chief of Staff)', () {
    final p = parseMessage('@Chief of Staff please review', names: ['Chief of Staff'])
        .single as Paragraph;
    expect((p.spans.first as MentionSpan).name, 'Chief of Staff');
  });
}
