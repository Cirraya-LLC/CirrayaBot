import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multi_agent/data/api.dart';
import 'package:multi_agent/data/settings.dart';
import 'package:multi_agent/features/workbench/editors.dart';
import 'package:multi_agent/features/workbench/templates_page.dart';
import 'package:multi_agent/l10n.dart';
import 'package:multi_agent/state/workbench.dart';
import 'package:multi_agent/theme/app_theme.dart';

const watcher = AgentTemplate(
  id: 'watcher', name: 'Watcher', description: 'Keeps an eye on pages', note: 'Give it goals under Check-ins.',
  persona: 'You are the Watcher.', goals: 'Watch the pricing page', checkinEvery: 240, setup: 'echo hi',
  skills: [SkillTemplate(name: 'page-watch', description: 'When watching', body: 'Steps.')],
);

void main() {
  test('a template comes through JSON with its skills, and never a model', () {
    final t = AgentTemplate.fromJson({
      'id': 'w', 'name': 'Watcher', 'persona': 'p', 'checkin_every': 240, 'model': 'x',
      'skills': [{'name': 'k', 'description': 'd', 'body': 'b'}, 'junk'],
    });
    expect([t.name, t.checkinEvery, t.skills.single.body], ['Watcher', 240, 'b']);
  });

  for (final (size, scale) in const [(Size(1280, 800), 1.0), (Size(360, 640), 1.3)]) {
    testWidgets('gallery at ${size.width.toInt()} ×$scale: cards, and a tap picks one', (tester) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final bench = Workbench(const Settings(baseUrl: 'http://127.0.0.1:1', token: 't'));
      AgentTemplate? picked;
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark().copyWith(platform: TargetPlatform.android),
        builder: (context, child) => UiScale(scale: scale, child: child!),
        home: Builder(builder: (c) => TextButton(
          onPressed: () async => picked = await Navigator.of(c).push<AgentTemplate>(MaterialPageRoute(
            builder: (_) => TemplatesPage(api: bench.api, debugLoad: () async => [watcher, watcher]))),
          child: const Text('open'),
        )),
      ));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.text('Watcher'), findsNWidgets(2));
      expect(find.text('page-watch'), findsWidgets);
      expect(find.text(tr('tpl.hasSetup')), findsWidgets);
      expect(find.byKey(const ValueKey('tpl-import')), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.tap(find.text('Watcher').first);
      await tester.pumpAndSettle();
      expect(picked?.id, 'watcher');
      bench.dispose();
    });
  }

  testWidgets('the editor starts from a template: fields filled, what comes along said', (tester) async {
    tester.view.physicalSize = const Size(1280, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final bench = Workbench(const Settings(baseUrl: 'http://127.0.0.1:1', token: 't'));
    bench.agents = const [Agent(id: 'x', name: 'X', description: '', persona: 'p', color: '#4f8cff', machine: true)];
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.dark(),
      home: Builder(builder: (c) => TextButton(onPressed: () => showAgentEditor(c, bench, template: watcher), child: const Text('open'))),
    ));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.text(tr('wb.newAgent')), findsOneWidget, reason: 'a new Agent, not an edit');
    expect(find.widgetWithText(TextField, 'Watcher'), findsOneWidget);
    expect(find.widgetWithText(TextField, 'You are the Watcher.'), findsOneWidget);
    expect(find.widgetWithText(TextField, 'Watch the pricing page'), findsOneWidget);
    expect(find.widgetWithText(TextField, 'echo hi'), findsOneWidget);
    final note = tester.widget<Text>(find.byKey(const ValueKey('ed-template'))).data!;
    expect(note, contains('page-watch'));
    expect(note, contains('Give it goals'));
    expect(find.text(tr('ed.tplExport')), findsNothing, reason: 'nothing to export before it exists');
    bench.dispose();
  });
}
