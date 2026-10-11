import 'dart:convert';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multi_agent/data/api.dart';
import 'package:multi_agent/data/settings.dart';
import 'package:multi_agent/features/workbench/browser_view.dart';
import 'package:multi_agent/theme/app_theme.dart';

// Its own file: a testWidgets beside real-HttpServer tests breaks them (fake-async binding).
// 1×1 transparent PNG: something real for Image.memory to hold.
final _png = base64Decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==');

void main() {
  // The agent's desktop uses the same view: no address bar, back or reload — a "New terminal" instead —
  // and the same touch handling, at the narrowest phone width.
  testWidgets('the desktop view at 360x640 ×1.3: a terminal button, no address bar, taps click', (tester) async {
    tester.view.physicalSize = const Size(360, 640);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final sent = <Map<String, Object?>>[];
    final api = Api(const Settings(baseUrl: 'http://127.0.0.1:1', token: 't'));
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.dark().copyWith(platform: TargetPlatform.android),
      builder: (context, child) => UiScale(scale: 1.3, child: child!),
      home: BrowserPage(
        api: api,
        agentId: 'op',
        name: 'Operator',
        kind: 'desktop',
        debugShot: (image: _png, url: '', title: 'Desktop'),
        debugInput: sent.add,
      ),
    ));
    await tester.pump();
    expect(find.byIcon(Icons.terminal), findsOneWidget);
    expect(find.byType(TextField), findsOneWidget, reason: 'only the hidden typing field: no address bar');
    expect(find.byIcon(Icons.refresh), findsNothing);
    final page = find.ancestor(of: find.byType(Image), matching: find.byType(Listener)).first;
    await tester.tapAt(tester.getRect(page).center, kind: PointerDeviceKind.touch);
    await tester.pump();
    expect(sent.map((e) => e['t']), ['down', 'up']);
    expect(tester.takeException(), isNull);
    api.close();
  });

  // On a phone the Agent's browser should feel like a phone's browser: a tap clicks there,
  // a drag scrolls the page (as wheel turns) instead of dragging the mouse — and a mouse still
  // behaves exactly as on a desktop.
  testWidgets('touch on the Agent browser: tap clicks, drag scrolls, mouse unchanged, fits 360x640', (tester) async {
    tester.view.physicalSize = const Size(360, 640);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final sent = <Map<String, Object?>>[];
    final api = Api(const Settings(baseUrl: 'http://127.0.0.1:1', token: 't'));
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.dark().copyWith(platform: TargetPlatform.android),
      home: BrowserPage(
        api: api,
        agentId: 'op',
        name: 'A rather long Agent name for a narrow phone',
        debugShot: (image: _png, url: 'https://example.com/a/long/path/that/goes/on', title: 'Example page'),
        debugInput: sent.add,
      ),
    ));
    await tester.pump();

    final page = find.ancestor(of: find.byType(Image), matching: find.byType(Listener)).first;
    final box = tester.getRect(page);
    // fits the width (4px margin each side), keeps 1280:800
    expect(box.width, closeTo(352, 1));
    expect(box.height, closeTo(352 * 800 / 1280, 1));

    // a tap: one click, at the right page coordinates
    await tester.tapAt(box.center, kind: PointerDeviceKind.touch);
    await tester.pump();
    expect(sent.map((e) => e['t']), ['down', 'up']);
    expect(sent.first['x'], closeTo(640, 2));
    expect(sent.first['y'], closeTo(400, 2));
    expect(sent.first['button'], 'left');

    // a drag up: wheel turns down, in page pixels, no mouse down/move
    sent.clear();
    final finger = await tester.startGesture(box.center, kind: PointerDeviceKind.touch);
    for (var i = 0; i < 11; i++) {
      await finger.moveBy(const Offset(0, -8));
      await tester.pump(const Duration(milliseconds: 16));
    }
    await finger.up();
    await tester.pump(const Duration(milliseconds: 50));
    expect(sent.every((e) => e['t'] == 'wheel'), isTrue, reason: '$sent');
    final dy = sent.fold<double>(0, (a, e) => a + (e['dy'] as num).toDouble());
    expect(dy, closeTo(88 * 1280 / 352, 4), reason: 'the whole drag, scaled to the page');
    expect(sent.fold<double>(0, (a, e) => a + (e['dx'] as num).toDouble()).abs(), lessThan(1));

    // a mouse is still a mouse: down at once, then up
    sent.clear();
    await tester.tapAt(box.center + const Offset(20, 0), kind: PointerDeviceKind.mouse);
    await tester.pump(const Duration(milliseconds: 50));
    expect(sent.where((e) => e['t'] != 'move').map((e) => e['t']), ['down', 'up']);

    // the soft keyboard comes up (a tap focuses the page): the picture shrinks, nothing overflows
    tester.view.viewInsets = const FakeViewPadding(bottom: 280);
    addTearDown(tester.view.resetViewInsets);
    await tester.pump();
    expect(tester.getRect(page).height, lessThan(box.height + 0.01));

    expect(tester.takeException(), isNull);
    // dispose: the polling timer and the input timers go with the page
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 2));
    api.close();
  });
}
