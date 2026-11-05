import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multi_agent/data/api.dart';
import 'package:multi_agent/data/settings.dart';
import 'package:multi_agent/features/settings/skills_page.dart';
import 'package:multi_agent/features/workbench/browser_view.dart';
import 'package:multi_agent/l10n.dart';
import 'package:multi_agent/theme/app_theme.dart';

// Its own file: a testWidgets beside real-HttpServer tests breaks them (fake-async binding).
// The server is stood in for by overriding the calls this flow makes; the server side has its own e2e test.
final _png = base64Decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==');

class _FakeApi extends Api {
  _FakeApi() : super(const Settings(baseUrl: 'http://127.0.0.1:1', token: 't'));
  DateTime? since;
  final calls = <String>[];
  List<Map<String, Object?>>? draftedFrom;
  String? goal;

  @override
  Future<DateTime?> recordingSince(String agentId) async => since;
  @override
  Future<DateTime> startRecording(String agentId) async {
    calls.add('start');
    return since = DateTime.now();
  }

  @override
  Future<Recording> stopRecording(String agentId) async {
    calls.add('stop');
    since = null;
    return Recording.fromJson({
      'seconds': 30,
      'steps': [
        {'kind': 'start'}, {'kind': 'click', 'n': 'oops'}, {'kind': 'type'}, {'kind': 'key'},
      ],
      'lines': [
        '1. Started on Shop (https://shop.test/)',
        '2. Clicked the "Oops wrong link" link',
        '3. Typed "blue mug" into the "Search" field',
        '4. Pressed Enter',
      ],
    });
  }

  @override
  Future<SkillDraft> draftSkill(String agentId, {required String goal, required List<Map<String, Object?>> steps}) async {
    draftedFrom = steps;
    this.goal = goal;
    return const SkillDraft(name: 'Reorder a mug', description: 'When the mug runs out', body: '1. Open the shop', agents: ['op']);
  }

  @override
  Future<List<Agent>> agents() async => const [Agent(id: 'op', name: 'Operator', description: '', persona: 'p', color: '#4f8cff')];
  @override
  Future<List<Skill>> skills() async => const [];
  @override
  Future<({List<AgentTemplate> agents, List<SkillTemplate> skills})> templates() async => (agents: <AgentTemplate>[], skills: <SkillTemplate>[]);
  @override
  Future<void> browserAct(String agentId, Map<String, Object?> action, {String kind = 'browser'}) async {}
  @override
  Future<({Uint8List image, String url, String title})?> browserShot(String agentId, {String kind = 'browser'}) async =>
      (image: _png, url: 'https://shop.test/', title: 'Shop');
  @override
  Stream<({Uint8List image, String url, String title})> browserStream(String agentId, {String kind = 'browser'}) =>
      const Stream.empty();
}

Widget _app(Api api, {double scale = 1}) => MaterialApp(
  theme: AppTheme.dark().copyWith(platform: TargetPlatform.android),
  builder: (context, child) => UiScale(scale: scale, child: child!),
  home: BrowserPage(
    api: api,
    agentId: 'op',
    name: 'Operator',
    debugShot: (image: _png, url: 'https://shop.test/', title: 'Shop'),
    debugInput: (_) {},
  ),
);

void main() {
  for (final (size, scale) in const [(Size(1280, 800), 1.0), (Size(360, 640), 1.3)]) {
    testWidgets('record, the steps, remove one, draft into the skill library at ${size.width.toInt()} ×$scale', (tester) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final api = _FakeApi();
      await tester.pumpWidget(_app(api, scale: scale));
      await tester.pump();
      expect(find.byTooltip(tr('teach.record')), findsOneWidget);

      await tester.tap(find.byTooltip(tr('teach.record')));
      await tester.pump();
      await tester.pump(const Duration(seconds: 2));
      expect(api.calls, ['start']);
      // The time is the wall clock's (a recording outlives the page), which pump() doesn't move.
      expect(find.byWidgetPredicate((w) => w is Text && RegExp(r'^0:0\d$').hasMatch(w.data ?? '')), findsOneWidget,
          reason: 'the time recorded so far');
      expect(find.textContaining(tr('teach.recNote')), findsOneWidget, reason: 'says what is and is not recorded');

      await tester.tap(find.byTooltip(tr('teach.stop')));
      await tester.pumpAndSettle();
      expect(api.calls, ['start', 'stop']);
      expect(find.text(tr('teach.title', {'name': 'Operator'})), findsOneWidget);
      expect(find.text('Clicked the "Oops wrong link" link'), findsOneWidget, reason: 'the server\'s numbers are dropped');
      expect(find.byTooltip(tr('teach.remove')), findsNWidgets(4));

      // On a phone the dialog scrolls: everything is reached by scrolling to it.
      await tester.ensureVisible(find.byTooltip(tr('teach.remove')).at(1));
      await tester.tap(find.byTooltip(tr('teach.remove')).at(1));
      await tester.pumpAndSettle();
      expect(find.textContaining('Oops'), findsNothing);
      await tester.ensureVisible(find.byKey(const ValueKey('teach-goal')));
      await tester.enterText(find.byKey(const ValueKey('teach-goal')), 'Reorder the mug');
      await tester.tap(find.text(tr('teach.draft')));
      await tester.pumpAndSettle();
      expect(api.draftedFrom?.length, 3, reason: 'the removed step is not sent');
      expect(api.draftedFrom?.any((s) => s['n'] == 'oops'), false);
      expect(api.goal, 'Reorder the mug');

      expect(find.byType(SkillsPage), findsOneWidget);
      expect(find.widgetWithText(TextField, 'Reorder a mug'), findsOneWidget, reason: 'the draft is in the editor, unsaved');
      expect(find.text(tr('teach.drafted')), findsOneWidget);
      expect(tester.takeException(), isNull);
      api.close();
    });
  }

  testWidgets('leaving while recording stops it and shows the steps first', (tester) async {
    tester.view.physicalSize = const Size(1280, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final api = _FakeApi()..since = DateTime.now().subtract(const Duration(seconds: 5));
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.dark(),
      home: Builder(builder: (c) => TextButton(
        onPressed: () => Navigator.of(c).push(MaterialPageRoute<void>(builder: (_) => BrowserPage(
          api: api, agentId: 'op', name: 'Operator',
          debugShot: (image: _png, url: '', title: 'Shop'), debugInput: (_) {},
        ))),
        child: const Text('open'),
      )),
    ));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle(const Duration(milliseconds: 100));
    expect(find.byTooltip(tr('teach.stop')), findsOneWidget, reason: 'a recording already running shows as running');

    unawaited(tester.binding.handlePopRoute());
    await tester.pumpAndSettle();
    expect(api.calls, ['stop']);
    expect(find.text(tr('teach.title', {'name': 'Operator'})), findsOneWidget, reason: 'the steps, before the page goes');
    await tester.tap(find.text(tr('teach.discard')));
    await tester.pumpAndSettle();
    expect(find.byType(BrowserPage), findsNothing, reason: 'then it leaves');
    expect(find.text('open'), findsOneWidget);
    api.close();
  });
}
