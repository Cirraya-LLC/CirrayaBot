import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multi_agent/data/api.dart';
import 'package:multi_agent/data/settings.dart';
import 'package:multi_agent/features/workbench/editors.dart';
import 'package:multi_agent/l10n.dart';
import 'package:multi_agent/state/workbench.dart';
import 'package:multi_agent/theme/app_theme.dart';

// Its own file: a testWidgets beside real-HttpServer tests breaks them (fake-async binding).
// The server is stood in for; the server side has its own e2e test (test/e2e/triggers.test.mjs).
const _settings = Settings(baseUrl: 'http://127.0.0.1:1', token: 't');

Trigger _trigger(Map<String, Object?> j) => Trigger.fromJson({
  'id': 'abcdefghijklmnopqrstuvwx', 'kind': 'github', 'name': 'Triage', 'agent_id': 'kim', 'prompt': 'p',
  'events': ['issues'], 'max_per_hour': 6, 'enabled': true, 'url': 'https://bot.example/hooks/abcdefghijklmnopqrstuvwx',
  'fired': 0, ...j,
});

class _FakeApi extends Api {
  _FakeApi() : super(_settings);
  final sent = <Map<String, Object?>>[];
  var rotated = 0;

  @override
  Future<List<Trigger>> triggers(Conversation c) async => const [];
  @override
  Future<(Trigger, String)> createTrigger(Map<String, Object?> body) async {
    sent.add(body);
    return (_trigger({'name': body['name'], 'kind': body['kind'], 'agent_id': body['agent'] ?? 'kim'}), 'a' * 48);
  }

  @override
  Future<Trigger> updateTrigger(String id, Map<String, Object?> body) async {
    sent.add(body);
    return _trigger({'name': body['name']});
  }

  @override
  Future<(Trigger, String)> newTriggerSecret(String id) async {
    rotated++;
    return (_trigger({}), 'b' * 48);
  }
}

const _dm = Conversation(kind: 'agent', id: 'kim', name: 'Kim', tag: '', preview: '', at: 0, members: ['kim'], color: '#4f8cff', colors: []);
const _group = Conversation(kind: 'group', id: 'g1', name: 'Ops', tag: '', preview: '', at: 0, members: ['kim', 'bo'],
    color: '#4f8cff', colors: [], lead: 'bo');

Future<(Workbench, _FakeApi)> _open(WidgetTester tester, Conversation c, {Trigger? trigger, Size size = const Size(1280, 800), double scale = 1}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final api = _FakeApi();
  final bench = Workbench(_settings, api: api);
  await tester.pumpWidget(MaterialApp(
    theme: AppTheme.dark().copyWith(platform: TargetPlatform.android),
    builder: (context, child) => UiScale(scale: scale, child: child!),
    home: Builder(builder: (ctx) => TextButton(onPressed: () => showTriggerEditor(ctx, bench, c, trigger: trigger), child: const Text('open'))),
  ));
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
  return (bench, api);
}

Future<void> _tapKey(WidgetTester tester, String key) async {
  await tester.ensureVisible(find.byKey(ValueKey(key)));
  await tester.tap(find.byKey(ValueKey(key)));
  await tester.pumpAndSettle();
}

void main() {
  final copied = <String>[];
  setUp(() {
    copied.clear();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') copied.add((call.arguments as Map)['text'] as String);
      return null;
    });
  });

  // A new trigger stays open after saving: its address and secret have to be copied into the service.
  for (final (size, scale) in const [(Size(1280, 800), 1.0), (Size(360, 700), 1.3)]) {
    testWidgets('make one, copy the secret, at ${size.width.toInt()} ×$scale', (tester) async {
      final (bench, api) = await _open(tester, _dm, size: size, scale: scale);
      expect(find.byKey(const ValueKey('tg-agent')), findsNothing, reason: 'a DM has one agent');
      await tester.enterText(find.byKey(const ValueKey('tg-name')), 'Triage');
      await tester.enterText(find.byKey(const ValueKey('tg-prompt')), 'Triage it.');
      await tester.enterText(find.byKey(const ValueKey('tg-events')), 'issues');
      await _tapKey(tester, 'tg-save');
      expect(api.sent.single, containsPair('kind', 'github'));
      expect(api.sent.single, containsPair('events', 'issues'));
      expect(api.sent.single['target'], {'kind': 'agent', 'id': 'kim'});
      expect(find.text('a' * 48), findsOneWidget, reason: 'the secret, this once');
      expect(find.text(tr('tg.secretOnce')), findsOneWidget);
      expect(find.textContaining('Settings → Webhooks'), findsOneWidget);
      expect(find.textContaining('PUBLIC_URL'), findsNothing, reason: 'a public address needs no note');
      await _tapKey(tester, 'tg-copy-secret');
      expect(copied, ['a' * 48]);
      expect(find.text(tr('tg.copied')), findsOneWidget);
      expect(tester.takeException(), isNull);
      bench.dispose();
    });
  }

  testWidgets('an existing one: secret not shown, a new one on request; edits go out', (tester) async {
    final (bench, api) = await _open(tester, _dm, trigger: _trigger({'last_at': 1, 'last_status': 'skipped', 'last_error': 'action closed'}));
    expect(find.text(tr('tg.secretHidden')), findsOneWidget);
    expect(find.textContaining('skipped (action closed)'), findsOneWidget);
    await _tapKey(tester, 'tg-rotate');
    await tester.tap(find.text(tr('common.ok')));
    await tester.pumpAndSettle();
    expect(api.rotated, 1);
    expect(find.text('b' * 48), findsOneWidget);
    await _tapKey(tester, 'tg-save');
    expect(api.sent.single.containsKey('kind'), isFalse, reason: 'the kind is fixed once made');
    expect(find.byType(AlertDialog), findsNothing, reason: 'saving an edit closes it');
    bench.dispose();
  });

  testWidgets('in a group: who runs it', (tester) async {
    final (bench, api) = await _open(tester, _group, size: const Size(360, 700));
    expect(find.byKey(const ValueKey('tg-agent')), findsOneWidget);
    await tester.tap(find.text(tr('tg.kindWebhookShort')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('tg-events')), findsNothing, reason: 'GitHub fields only for GitHub');
    await tester.enterText(find.byKey(const ValueKey('tg-name')), 'Alerts');
    await tester.enterText(find.byKey(const ValueKey('tg-prompt')), 'Look.');
    await _tapKey(tester, 'tg-save');
    expect(api.sent.single, containsPair('agent', null), reason: 'the lead, chosen by the server');
    expect(api.sent.single.containsKey('events'), isFalse);
    expect(find.textContaining('X-Hook-Token'), findsOneWidget);
    expect(tester.takeException(), isNull);
    bench.dispose();
  });
}
