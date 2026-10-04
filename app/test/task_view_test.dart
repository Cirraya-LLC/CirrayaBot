import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multi_agent/data/api.dart';
import 'package:multi_agent/data/settings.dart';
import 'package:multi_agent/features/workbench/task_view.dart';
import 'package:multi_agent/l10n.dart';
import 'package:multi_agent/state/workbench.dart';
import 'package:multi_agent/theme/app_theme.dart';

Task task(int id, String status, {String question = '', String? approval, String result = ''}) => Task(
  id: id, session: 's', agentId: 'a', byAgent: 'lead', title: 'A rather long task title that has to fit $id',
  brief: 'Do the thing, carefully, and report back.', status: status, question: question,
  approvalId: approval, approvalSubject: approval == null ? '' : 'git push origin main',
  result: result, createdAt: 1, updatedAt: 1,
);

void main() {
  // The right panel is 290px wide. Every state of a task — including the open
  // reply box and the approval buttons — has to fit it without overflowing.
  testWidgets('the task list fits the side panel in every state', (tester) async {
    tester.view.physicalSize = const Size(1320, 1600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final bench = Workbench(const Settings(baseUrl: 'http://127.0.0.1:1', token: 't'));
    bench.tasks = [
      task(4, 'waiting', question: 'Which folder should I count? It matters which one.'),
      task(3, 'waiting', approval: 'ap1'),
      task(2, 'done', result: 'counted 7 files'),
      task(1, 'failed', result: 'Upstream 500'),
    ];
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.dark().copyWith(platform: TargetPlatform.macOS),
      home: Scaffold(
        body: SingleChildScrollView(
          child: Column(children: [
            SizedBox(width: 290, child: TaskList(bench: bench)),
            SizedBox(
              width: 600,
              child: NewsCard(bench: bench, news: News({'task': 4, 'kind': 'asked', 'agent': 'A', 'agent_id': 'a',
                'title': 't', 'text': 'Which folder should I count? It matters which one.'})),
            ),
          ]),
        ),
      ),
    ));
    expect(find.text(tr('tk.st.waiting')), findsNWidgets(2));
    // The card for a question still open has a reply box
    expect(find.byType(ReplyBox), findsOneWidget);
    for (final id in [4, 3]) {
      await tester.tap(find.text('#$id'));
      await tester.pump();
    }
    await tester.tap(find.text('#4'));
    await tester.pump();
    expect(find.byType(ReplyBox), findsNWidgets(2), reason: 'the open row answers too');
    await tester.tap(find.text('#3'));
    await tester.pump();
    expect(find.text(tr('ap.approve')), findsOneWidget);
    expect(tester.takeException(), isNull);
    bench.dispose();
  });
}
