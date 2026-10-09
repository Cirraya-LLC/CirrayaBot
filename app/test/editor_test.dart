import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multi_agent/data/api.dart';
import 'package:multi_agent/data/settings.dart';
import 'package:multi_agent/features/workbench/editors.dart';
import 'package:multi_agent/l10n.dart';
import 'package:multi_agent/state/workbench.dart';
import 'package:multi_agent/theme/app_theme.dart';

// Its own file: a testWidgets beside real-HttpServer tests breaks them (fake-async binding).
void main() {
  test('backup models come and go through JSON intact', () {
    final a = Agent.fromJson({
      'id': 'op', 'name': 'Op', 'description': '', 'persona': 'p', 'color': '#4f8cff', 'model': 'm',
      'fallbacks': [
        {'provider_id': 'p2', 'model': 'spare'},
        {'provider_id': '', 'model': 'other'},
        'junk',
      ],
    });
    expect(a.fallbacks.map((f) => f.toJson()).toList(), [
      {'provider_id': 'p2', 'model': 'spare'},
      {'provider_id': '', 'model': 'other'},
    ]);
    expect(Agent.fromJson({'id': 'x'}).fallbacks, isEmpty, reason: 'an older server sends none');
  });

  // The editor grows a row per backup model, at most three, and stays usable on a phone: it scrolls
  // instead of overflowing. (With no server to ask, the model is typed — the same path an upstream
  // without a model list takes.)
  for (final size in const [Size(1280, 800), Size(393, 700)]) {
    testWidgets('backup model rows at ${size.width.toInt()}x${size.height.toInt()}', (tester) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final bench = Workbench(const Settings(baseUrl: 'http://127.0.0.1:1', token: 't'));
      const agent = Agent(id: 'op', name: 'Op', description: '', persona: 'p', color: '#4f8cff', model: 'm',
          fallbacks: [Fallback(model: 'spare')]);
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark().copyWith(platform: TargetPlatform.android),
        home: Builder(builder: (c) => TextButton(onPressed: () => showAgentEditor(c, bench, agent: agent), child: const Text('open'))),
      ));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.text(tr('ed.fallbacks')), findsOneWidget);
      Finder rows() => find.byTooltip(tr('ed.fallbackRemove'));
      expect(rows(), findsOneWidget);
      expect(find.widgetWithText(TextField, 'spare'), findsOneWidget, reason: 'the saved backup is shown');

      final add = find.text(tr('ed.fallbackAdd'));
      for (var i = 0; i < 2; i++) {
        await tester.ensureVisible(add);
        await tester.tap(add);
        await tester.pumpAndSettle();
      }
      expect(rows(), findsNWidgets(3));
      expect(add, findsNothing, reason: 'three is the most');

      await tester.ensureVisible(rows().first);
      await tester.tap(rows().first);
      await tester.pumpAndSettle();
      expect(rows(), findsNWidgets(2));
      expect(add, findsOneWidget);
      expect(tester.takeException(), isNull);
      bench.dispose();
    });
  }
}
