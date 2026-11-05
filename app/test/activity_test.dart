import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multi_agent/data/settings.dart';
import 'package:multi_agent/features/workbench/activity_page.dart';
import 'package:multi_agent/l10n.dart';
import 'package:multi_agent/state/workbench.dart';
import 'package:multi_agent/theme/app_theme.dart';

final _now = DateTime.now().millisecondsSinceEpoch;
Map<String, Object?> sample() => {
  'now': _now,
  'asks': [
    {'id': 'ap1', 'agent_id': 'kim', 'who': 'Kim', 'conv_name': 'Kim', 'kind': 'agent', 'conv': 'kim', 'session': 's1',
      'subject': 'git push origin main --force-with-lease --set-upstream a-rather-long-branch-name', 'at': _now - 60000, 'task': null},
  ],
  'runs': [
    {'session': 's1', 'kind': 'agent', 'id': 'kim', 'who': 'Kim', 'conv_name': 'Kim', 'started_at': _now - 120000, 'detached': true},
  ],
  'tasks': [
    {'id': 7, 'status': 'waiting', 'question': 'Which branch should I deploy?', 'approval': null, 'title': 'Deploy',
      'who': 'Lee', 'conv_name': 'Ops team', 'kind': 'group', 'conv': 'g1', 'session': 's2'},
    {'id': 8, 'status': 'running', 'question': '', 'approval': null, 'title': 'Count the files in every repository',
      'who': 'Max', 'conv_name': 'Max', 'kind': 'agent', 'conv': 'max', 'session': 's3', 'helper': true},
  ],
  'routines': [
    {'id': 'r1', 'name': 'Morning digest', 'kind': 'agent', 'conv': 'kim', 'conv_name': 'Kim',
      'next_run_at': DateTime.now().add(const Duration(hours: 3)).toIso8601String(), 'running': false},
  ],
  'machines': [
    {'agent_id': 'kim', 'state': 'awake', 'last_use': _now},
    {'agent_id': 'lee', 'state': 'asleep', 'last_use': _now - 3600000},
    {'agent_id': 'max', 'state': 'none', 'helpers': 2},
  ],
  'actions': [
    for (var i = 0; i < 5; i++)
      {'at': _now - i * 60000, 'who': 'Kim', 'kind': 'agent', 'conv': 'kim', 'session': 's1', 'name': 'bash',
        'subject': 'ls -la /work/projects/some/deeply/nested/folder/with/a/long/name $i', 'output': ''},
  ],
};

void main() {
  for (final (size, scale) in const [(Size(1280, 800), 1.0), (Size(360, 640), 1.3)]) {
    testWidgets('activity at ${size.width.toInt()} ×$scale: every section, no overflow', (tester) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final bench = Workbench(const Settings(baseUrl: 'http://127.0.0.1:1', token: 't'));
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark().copyWith(platform: TargetPlatform.android),
        builder: (context, child) => UiScale(scale: scale, child: child!),
        home: ActivityPage(bench: bench, debugLoad: () async => sample()),
      ));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      expect(find.text(tr('act.asks')), findsOneWidget);
      expect(find.byKey(const ValueKey('ask-ap1')), findsOneWidget);
      expect(find.text(tr('ap.approve')), findsOneWidget);
      expect(find.text('Which branch should I deploy?'), findsOneWidget);
      await tester.dragUntilVisible(find.textContaining('Count the files'), find.byType(ListView), const Offset(0, -150));
      expect(find.textContaining(tr('tk.helper')), findsOneWidget, reason: 'a task on a machine of its own says so');
      await tester.dragUntilVisible(find.textContaining('Morning digest'), find.byType(ListView), const Offset(0, -150));
      await tester.dragUntilVisible(find.text(tr('act.recent')), find.byType(ListView), const Offset(0, -200));
      expect(find.textContaining('awake'), findsOneWidget);
      expect(find.textContaining(tr('act.helpers', {'n': '2'})), findsOneWidget,
          reason: 'an agent with helpers running is listed even without a machine of its own');
      expect(tester.takeException(), isNull);
      bench.dispose();
    });
  }

  testWidgets('empty: each section says so', (tester) async {
    final bench = Workbench(const Settings(baseUrl: 'http://127.0.0.1:1', token: 't'));
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.dark(),
      home: ActivityPage(bench: bench, debugLoad: () async => {'now': _now}),
    ));
    await tester.pump();
    expect(find.text(tr('act.noAsks')), findsOneWidget);
    expect(find.text(tr('act.noWork')), findsOneWidget);
    expect(find.text(tr('act.noComing')), findsOneWidget);
    expect(find.text(tr('act.noRecent')), findsOneWidget);
    bench.dispose();
  });
}
