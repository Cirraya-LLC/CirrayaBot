import 'package:flutter_test/flutter_test.dart';
import 'package:multi_agent/data/markdown.dart';

void main() {
  test('blocks: headings, lists, task boxes, code, quotes, rules, tables', () {
    final b = parseMarkdown('# Title\n\nSome text\nmore text\n\n- [x] done\n- [ ] todo\n\n1. one\n2. two\n\n'
        '```js\n<script>\n```\n\n> quoted\n\n---\n\n| a | b |\n|---|:-:|\n| 1 | 2 |\n| 3 |');
    expect((b[0] as MdHeading).level, 1);
    expect((b[0] as MdHeading).text, 'Title');
    expect((b[1] as MdParagraph).text, 'Some text\nmore text');
    final tasks = b[2] as MdList;
    expect(tasks.ordered, isFalse);
    expect(tasks.items.map((i) => i.checked), [true, false]);
    expect(tasks.items.first.text, 'done');
    final ordered = b[3] as MdList;
    expect(ordered.ordered, isTrue);
    expect(ordered.items.map((i) => i.text), ['one', 'two']);
    expect((b[4] as MdCode).code, '<script>');
    expect((b[4] as MdCode).lang, 'js');
    expect(((b[5] as MdQuote).blocks.single as MdParagraph).text, 'quoted');
    expect(b[6], isA<MdRule>());
    final t = b[7] as MdTable;
    expect(t.header, ['a', 'b']);
    expect(t.rows, [
      ['1', '2'],
      ['3'],
    ]);
  });

  test('a list item without a box is not a task', () {
    expect((parseMarkdown('* plain').single as MdList).items.single.checked, isNull);
  });

  test('an unclosed fence runs to the end instead of swallowing nothing', () {
    expect((parseMarkdown('```\na\nb').single as MdCode).code, 'a\nb');
  });

  test('inline: bold, italic, code, links — only http(s) links are links', () {
    final s = parseInline('a **b** *c* `d` [e](https://x.dev) [f](javascript:alert(1)) ~~g~~');
    expect(s.where((x) => x.bold).single.text, 'b');
    expect(s.where((x) => x.italic).single.text, 'c');
    expect(s.where((x) => x.code).single.text, 'd');
    final links = s.where((x) => x.link != null).toList();
    expect(links.single.text, 'e');
    expect(links.single.link, 'https://x.dev');
    expect(s.map((x) => x.text).join(), contains('[f](javascript:alert(1))'));
    expect(s.map((x) => x.text).join(), contains('g'));
    expect(s.map((x) => x.text).join().contains('~~'), isFalse);
  });

  test('stars inside a word are not italics', () {
    expect(parseInline('2*3*4').every((x) => !x.italic), isTrue);
  });

  test('lists keep their number and nesting; a table right under a paragraph is a table', () {
    final b = parseMarkdown('**Steps**\n- a\n  - b\n\t- c\n\n3. third\n\nBefore\n| x | y |\n|---|---|\n| 1 | 2 |');
    expect((b[0] as MdParagraph).text, '**Steps**');
    final l = b[1] as MdList;
    expect(l.items.map((i) => i.level), [0, 1, 1]);
    final n = b[2] as MdList;
    expect(n.ordered, isTrue);
    expect(n.start, 3);
    expect((b[3] as MdParagraph).text, 'Before');
    expect((b[4] as MdTable).rows, [
      ['1', '2'],
    ]);
  });

  test('mentions: in text and bold, never in code or a link; longest name first; Chinese names', () {
    final s = parseInline('@小林二 和 **@Tao** 看 `@Tao` [@Tao](https://x.dev) @tao', names: ['Tao', '小林', '小林二']);
    expect(s.where((x) => x.mention != null).map((x) => x.mention), ['小林二', 'Tao', 'Tao']);
    expect(s.where((x) => x.code).single.text, '@Tao');
    expect(s.where((x) => x.link != null).single.text, '@Tao');
    expect(parseInline('@nobody hi', names: ['Tao']).every((x) => x.mention == null), isTrue);
  });
}
