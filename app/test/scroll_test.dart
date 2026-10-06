import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multi_agent/data/api.dart';
import 'package:multi_agent/data/settings.dart';
import 'package:multi_agent/features/workbench/workbench_page.dart';
import 'package:multi_agent/state/workbench.dart';
import 'package:multi_agent/theme/app_theme.dart';

/// A workbench that never goes to the network: the page's start-up refresh and open would
/// otherwise clear the transcript the test just filled in.
class _Bench extends Workbench {
  _Bench() : super(const Settings(baseUrl: 'http://127.0.0.1:1', token: 't'));

  @override
  Future<void> refresh({bool keepSelection = true}) async {}

  @override
  Future<void> open(Conversation c) async {}

  @override
  Future<void> poll() async {}

  /// A reply line arriving, the way a streaming turn adds one.
  void arrive(String text) {
    entries.add(Said(mine: false, speaker: 'Operator', color: '#f0a040', text: text));
    notifyListeners();
  }
}

// Its own file: a testWidgets beside real-HttpServer tests breaks them (fake-async binding).
void main() {
  // The transcript follows new content down while the newest line is in view. A swipe up from
  // the bottom used to be taken back: content changing mid-swipe (a reply streaming in, the lazy
  // list re-measuring rows) counted as "grew while at the bottom", and the jump to the bottom
  // also ended the drag — the rest of the swipe moved nothing. On the phone it simply would not scroll.
  testWidgets('a swipe up from the bottom is not taken back while the transcript changes', (tester) async {
    tester.view.physicalSize = const Size(1100, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final bench = _Bench();
    const conv = Conversation(kind: 'agent', id: 'op', name: 'Operator', tag: '', preview: '', at: 0,
      members: ['op'], color: '#f0a040', colors: ['#f0a040']);
    bench.conversations = const [conv];
    bench.current = conv;
    bench.loading = false;
    for (var i = 0; i < 79; i++) {
      bench.entries.add(Said(mine: i.isEven, speaker: i.isEven ? 'You' : 'Operator', color: '#f0a040',
        text: 'Message $i ${'word ' * (i * 7 % 60)}'));
    }
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.dark().copyWith(platform: TargetPlatform.android),
      home: WorkbenchPage(bench: bench, onEditServer: () {}, collapsed: false, onCollapsed: (_) {}),
    ));
    // the page learns which conversation is open from a change, as it does when one is opened
    bench.arrive('Message 79');
    await tester.pumpAndSettle();
    final list = find.byWidgetPredicate((w) => w is ListView && w.semanticChildCount == 80);
    expect(list, findsOneWidget);
    final pos = tester.state<ScrollableState>(find.descendant(of: list, matching: find.byType(Scrollable)).first).position;
    expect(pos.pixels, pos.maxScrollExtent, reason: 'opened at the newest message');
    final bottom = pos.pixels;

    // A slow swipe down the screen (= back in time), with a reply line arriving after the first step.
    final gesture = await tester.startGesture(tester.getCenter(list));
    for (var i = 0; i < 16; i++) {
      await gesture.moveBy(const Offset(0, 25));
      await tester.pump(const Duration(milliseconds: 40));
      if (i == 1) {
        bench.arrive('a reply streaming in while the person scrolls up');
        await tester.pump(const Duration(milliseconds: 40));
      }
    }
    await gesture.up();
    await tester.pumpAndSettle();
    expect(pos.pixels, lessThan(bottom - 300), reason: 'the swipe moved the transcript and it stayed there');

    // Scrolled up to read: more arriving leaves the view where it is.
    final reading = pos.pixels;
    bench.arrive('and another one');
    await tester.pumpAndSettle();
    expect(pos.pixels, reading);

    // Back at the bottom, hands off: new lines are followed down again.
    pos.jumpTo(pos.maxScrollExtent);
    await tester.pumpAndSettle();
    bench.arrive('followed ${'long line ' * 40}');
    await tester.pumpAndSettle();
    expect(pos.pixels, pos.maxScrollExtent);
    expect(tester.takeException(), isNull);
    bench.dispose();
  });
}
