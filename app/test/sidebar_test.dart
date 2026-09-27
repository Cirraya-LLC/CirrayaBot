import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multi_agent/data/settings.dart';
import 'package:multi_agent/features/workbench/workbench_page.dart';
import 'package:multi_agent/l10n.dart';
import 'package:multi_agent/state/workbench.dart';
import 'package:multi_agent/theme/app_theme.dart';

void main() {

  // The sidebar has to *animate*, not jump: a test that only looks before and
  // after would pass on a version with no transition at all.
  testWidgets('collapsing the sidebar travels, and stops travelling when the desktop says so', (
    tester,
  ) async {
    Future<double> widthAfter(Duration d) async {
      await tester.pump(d);
      return tester.getSize(find.byKey(const ValueKey('sidebar'))).width;
    }

    // A real surface, not a faked MediaQuery: three columns in 800x600 overflow,
    // and the noise would bury what this test is actually looking at.
    tester.view.physicalSize = const Size(1320, 840);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    var run = 0;
    final open_ = <Workbench>[];
    Future<void> open({required bool reduceMotion}) async {
      // A fresh key, or Flutter reuses the State and the second page opens
      // already collapsed from the first.
      run++;
      final bench = Workbench(const Settings(baseUrl: 'http://127.0.0.1:1', token: 't'));
      open_.add(bench);
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark().copyWith(platform: TargetPlatform.macOS),
          home: Builder(
            builder: (context) => MediaQuery(
              data: MediaQuery.of(context).copyWith(disableAnimations: reduceMotion),
              child: WorkbenchPage(
                key: ValueKey(run),
                bench: bench,
                onEditServer: () {},
                collapsed: false,
                onCollapsed: (_) {},
              ),
            ),
          ),
        ),
      );
      await tester.pump();
    }

    await open(reduceMotion: false);
    expect(tester.getSize(find.byKey(const ValueKey('sidebar'))).width, 308);
    await tester.tap(find.byTooltip(tr('wb.collapseSidebar')));
    await tester.pump();
    final midway = await widthAfter(const Duration(milliseconds: 100));
    expect(midway, greaterThan(72), reason: 'still on its way in');
    expect(midway, lessThan(308), reason: 'has started moving');
    await tester.pumpAndSettle();
    expect(tester.getSize(find.byKey(const ValueKey('sidebar'))).width, 72);

    // Reduced motion: the end state, with no travel through it.
    await open(reduceMotion: true);
    await tester.tap(find.byTooltip(tr('wb.collapseSidebar')));
    expect(await widthAfter(const Duration(milliseconds: 1)), 72);

    // Before the frame ends: the poll timer outlives a tearDown callback.
    await tester.pumpWidget(const SizedBox.shrink());
    for (final b in open_) {
      b.dispose();
    }
  });

  // Same rule for the right panel: it used to leave the tree outright, so it
  // appeared and vanished with no travel at all.
  testWidgets('closing the right panel travels too', (tester) async {
    tester.view.physicalSize = const Size(1320, 840);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    final bench = Workbench(const Settings(baseUrl: 'http://127.0.0.1:1', token: 't'));
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark().copyWith(platform: TargetPlatform.macOS),
        home: WorkbenchPage(
          bench: bench,
          onEditServer: () {},
          collapsed: false,
          onCollapsed: (_) {},
        ),
      ),
    );
    await tester.pump();

    double width() => tester.getSize(find.byKey(const ValueKey('rightpane'))).width;
    expect(width(), 290);
    await tester.tap(find.byTooltip(tr('wb.hideRight')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(width(), greaterThan(0), reason: 'still on its way out');
    expect(width(), lessThan(290), reason: 'has started moving');
    await tester.pumpAndSettle();
    expect(width(), 0);

    await tester.pumpWidget(const SizedBox.shrink());
    bench.dispose();
  });

  // Dragging an edge follows the pointer at once (no 200ms trail), stops at
  // the limits, keeps the chat its minimum, and writes the width back on release.
  testWidgets('both sidebars can be dragged to a width, and double-click resets', (tester) async {
    tester.view.physicalSize = const Size(1300, 840);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    final bench = Workbench(const Settings(baseUrl: 'http://127.0.0.1:1', token: 't'));
    final saved = <List<double>>[];
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark().copyWith(platform: TargetPlatform.macOS),
        home: WorkbenchPage(
          bench: bench,
          onEditServer: () {},
          collapsed: false,
          onCollapsed: (_) {},
          sidebarWidth: 330,
          onResized: (a, b) => saved.add([a, b]),
        ),
      ),
    );
    await tester.pump();
    double left() => tester.getSize(find.byKey(const ValueKey('sidebar'))).width;
    double right() => tester.getSize(find.byKey(const ValueKey('rightpane'))).width;
    expect(left(), 330, reason: 'the saved width is restored');

    final g = await tester.startGesture(tester.getCenter(find.byKey(const ValueKey('grip-left'))));
    await g.moveBy(const Offset(20, 0));
    await g.moveBy(const Offset(40, 0));
    await tester.pump();
    expect(left(), 390, reason: 'follows the pointer with no animation in between');
    await g.moveBy(const Offset(600, 0));
    await tester.pump();
    expect(left(), 480, reason: 'stops at the maximum');
    await g.up();
    await tester.pumpAndSettle();
    expect(saved.last, [480, 290]);

    // One flick, no frame in between: the release must not write back the
    // width from before the drag.
    await tester.drag(find.byKey(const ValueKey('grip-right')), const Offset(-100, 0));
    await tester.pumpAndSettle();
    expect(right(), 390);
    expect(saved.last, [480, 390]);
    await tester.drag(find.byKey(const ValueKey('grip-right')), const Offset(-200, 0));
    await tester.pumpAndSettle();
    expect(right(), 1300 - 480 - 380.0, reason: 'stops where the chat would drop below its minimum');

    await tester.tap(find.byKey(const ValueKey('grip-left')));
    await tester.pump(const Duration(milliseconds: 50));
    await tester.tap(find.byKey(const ValueKey('grip-left')));
    await tester.pumpAndSettle();
    expect(left(), 308, reason: 'double-click resets');

    await tester.pumpWidget(const SizedBox.shrink());
    bench.dispose();
  });
}
