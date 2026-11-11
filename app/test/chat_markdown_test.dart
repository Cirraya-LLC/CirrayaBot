import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multi_agent/features/workbench/message_view.dart';
import 'package:multi_agent/theme/app_theme.dart';

// An agent's message is drawn as Markdown, the person's own as typed. Its own file: widget tests only.
const reply = '''我是研究员，擅长把事情查到底：

**查证与分析**
- 阅读和分析代码
  - 嵌套的一条
- 结论附带来源，`不确定`的会明说

### 动手实验
1. 一台带完整权限的容器

2. 长时间的工作放到后台任务

| 能力 | 说明 |
|---|---|
| 浏览器 | 截图 |

```bash
echo "@Tao 不是提及"
```

有问题可以问 @Tao，*“对比 A 和 B”*。''';

Iterable<InlineSpan> _walk(InlineSpan s) sync* {
  yield s;
  if (s is TextSpan) {
    for (final c in s.children ?? const <InlineSpan>[]) {
      yield* _walk(c);
    }
  }
}

List<InlineSpan> _spans(WidgetTester t) => [
  for (final w in t.widgetList<SelectableText>(find.byType(SelectableText)))
    if (w.textSpan != null) ..._walk(w.textSpan!),
];

String _plain(WidgetTester t) => [
  for (final w in t.widgetList<SelectableText>(find.byType(SelectableText))) w.textSpan?.toPlainText() ?? w.data ?? '',
].join('\n');

Future<void> _pump(WidgetTester tester, Widget body, {double width = 900}) async {
  tester.view.physicalSize = Size(width, 1600);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(
    theme: AppTheme.dark().copyWith(platform: TargetPlatform.macOS),
    home: Scaffold(body: SingleChildScrollView(child: Padding(padding: const EdgeInsets.all(8), child: body))),
  ));
}

void main() {
  for (final width in const [900.0, 277.0]) {
    testWidgets('an agent\'s message is drawn as Markdown at ${width.toInt()} wide', (tester) async {
      await _pump(
        tester,
        MessageBody(text: reply, names: const ['Tao'], colorOf: (_) => Colors.teal, markdown: true),
        width: width,
      );
      expect(tester.takeException(), isNull, reason: 'nothing overflows');
      final spans = _spans(tester).whereType<TextSpan>();
      expect(spans.where((s) => s.text == '查证与分析' && s.style?.fontWeight == FontWeight.w700), hasLength(1),
          reason: 'bold');
      expect(spans.where((s) => s.text == '“对比 A 和 B”' && s.style?.fontStyle == FontStyle.italic), hasLength(1),
          reason: 'italic between CJK punctuation');
      expect(spans.where((s) => s.text == '不确定' && s.style?.fontFamily == AppTheme.mono), hasLength(1),
          reason: 'inline code');
      expect(_plain(tester).contains('**'), isFalse, reason: 'no Markdown marks left on screen');
      expect(_plain(tester).contains('###'), isFalse);
      expect(find.text('•'), findsNWidgets(2));
      expect(find.text('◦'), findsOneWidget, reason: 'the nested item');
      expect(find.text('1.'), findsOneWidget);
      expect(find.text('2.'), findsOneWidget, reason: 'a numbered item after a blank line keeps its number');
      expect(find.byType(Table), findsOneWidget);
      expect(find.text('BASH'), findsOneWidget, reason: "a code block's language on top");
      expect(_plain(tester), contains('echo "@Tao 不是提及"'), reason: 'code is shown as written');
      expect(find.text('Tao'), findsOneWidget, reason: 'one mention chip: in the text, not in the code');
    });
  }

  testWidgets("the person's own message is shown as typed", (tester) async {
    await _pump(tester, MessageBody(text: '**不是粗体** 和 `code`', names: const [], colorOf: (_) => Colors.teal));
    expect(_plain(tester), contains('**不是粗体**'));
    expect(_spans(tester).whereType<TextSpan>().where((s) => s.style?.fontWeight == FontWeight.w700), isEmpty);
  });
}
