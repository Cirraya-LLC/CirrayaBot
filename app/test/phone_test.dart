import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multi_agent/data/api.dart';
import 'package:multi_agent/data/settings.dart';
import 'package:multi_agent/features/workbench/workbench_page.dart';
import 'package:multi_agent/l10n.dart';
import 'package:multi_agent/state/workbench.dart';
import 'package:multi_agent/theme/app_theme.dart';

// Its own file: a testWidgets beside real-HttpServer tests breaks them (fake-async binding).
void main() {
  // A phone shows one column at a time: the list, then the chat with a way back — the arrow
  // or the system back gesture — and nothing desktop-only (rail toggle, resize grips).
  // Sizes as the phone draws them: the interface is scaled up (UiScale), so 360 wide at 130% lays
  // out in 277 logical pixels.
  for (final (size, scale) in const [(Size(393, 851), 1.0), (Size(360, 640), 1.0), (Size(393, 851), 1.15), (Size(360, 640), 1.15), (Size(360, 640), 1.3)]) {
    testWidgets('phone layout at ${size.width.toInt()}x${size.height.toInt()} ×$scale: list ↔ chat, no overflow', (tester) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final bench = Workbench(const Settings(baseUrl: 'http://127.0.0.1:1', token: 't'));
      bench.agents = const [Agent(id: 'op', name: 'Operator', description: 'Puts changes into effect', persona: 'x', color: '#f0a040')];
      bench.conversations = const [
        Conversation(kind: 'agent', id: 'op', name: 'Operator', tag: 'Puts well-thought-out changes into effect',
          preview: 'A rather long last message that has to be cut off on a narrow phone screen', at: 0,
          members: ['op'], color: '#f0a040', colors: ['#f0a040']),
      ];
      bench.loading = false;
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark().copyWith(platform: TargetPlatform.android),
        builder: (context, child) => UiScale(scale: scale, child: child!),
        home: WorkbenchPage(bench: bench, onEditServer: () {}, collapsed: false, onCollapsed: (_) {}),
      ));
      await tester.pump();

      // the list, full width, without the desktop's rail toggle or grips
      expect(find.text('Operator'), findsOneWidget);
      expect(tester.getSize(find.byKey(const ValueKey('sidebar'))).width, closeTo(size.width / scale, 0.01));
      expect(find.byTooltip(tr('wb.collapseSidebar')), findsNothing);
      expect(find.byKey(const ValueKey('grip-left')), findsNothing);
      expect(find.byTooltip(tr('wb.back')), findsNothing);

      // tap a conversation: the chat takes the screen, with a way back
      await tester.tap(find.text('Operator'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.byTooltip(tr('wb.back')), findsOneWidget);
      expect(find.byKey(const ValueKey('sidebar')), findsNothing);
      expect(find.byType(TextField), findsWidgets, reason: 'the composer is there');

      // the arrow goes back to the list
      await tester.tap(find.byTooltip(tr('wb.back')));
      await tester.pump();
      expect(find.byKey(const ValueKey('sidebar')), findsOneWidget);

      // and so does the system back gesture — but an open panel closes first
      await tester.tap(find.text('Operator'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.byTooltip(tr('wb.back')), findsOneWidget);
      await tester.tap(find.byTooltip(tr('wb.showRight')));
      await tester.pumpAndSettle();
      expect(find.byType(Drawer), findsOneWidget);
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(find.byType(Drawer), findsNothing, reason: 'back closed the panel');
      expect(find.byTooltip(tr('wb.back')), findsOneWidget, reason: 'and left the chat where it was');
      final popped = await tester.binding.handlePopRoute();
      await tester.pump();
      expect(popped, isTrue, reason: 'the gesture was taken by the page, not closing the app');
      expect(find.byKey(const ValueKey('sidebar')), findsOneWidget);

      expect(tester.takeException(), isNull);
      bench.dispose();
    });
  }
}
