import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multi_agent/data/api.dart';
import 'package:multi_agent/data/settings.dart';
import 'package:multi_agent/features/workbench/attachments.dart';
import 'package:multi_agent/state/workbench.dart';
import 'package:multi_agent/theme/app_theme.dart';

// Its own file: a testWidgets beside real-HttpServer tests installs the
// fake-async binding for them too and breaks them.
void main() {
  // Long names, a failed upload, one in flight: none of it may overflow a
  // narrow composer or a narrow transcript column.
  testWidgets('pending chips and attachment chips fit a narrow width', (tester) async {
    tester.view.physicalSize = const Size(1000, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final bench = Workbench(const Settings(baseUrl: 'http://127.0.0.1:1', token: 't'));
    bench.pending.addAll([
      Pending(path: '/tmp/x', name: '一个非常非常长的文件名-quarterly-report-final-v12-really-final.pdf', size: 3 << 20)
        ..sent = 1 << 20,
      Pending(path: '/tmp/y', name: 'notes.md', size: 1200)..error = 'That file is too big (the limit is 50.0 MB) and more words',
      Pending(path: '/tmp/z', name: 'ok.txt', size: 3)
        ..attachment = const Attachment(id: 'z', name: 'ok.txt', mime: 'text/plain', size: 3, kind: 'text'),
    ]);
    const files = [
      Attachment(id: 'a', name: 'a-very-long-name-for-a-spreadsheet-that-goes-on-and-on.xlsx', mime: 'x', size: 99999, kind: 'other'),
      Attachment(id: 'b', name: 'clip.mp4', mime: 'video/mp4', size: 12 << 20, kind: 'video'),
      Attachment(id: 'c', name: 'README.md', mime: 'text/markdown', size: 2048, kind: 'markdown'),
    ];
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark().copyWith(platform: TargetPlatform.macOS),
        home: Scaffold(
          body: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(width: 260, child: PendingRow(bench: bench)),
              SizedBox(width: 220, child: AttachmentList(api: bench.api, files: files)),
            ],
          ),
        ),
      ),
    );
    expect(find.byType(LinearProgressIndicator), findsOneWidget, reason: 'only the one still uploading shows progress');
    expect(find.byTooltip('Remove'), findsNWidgets(3));
    expect(find.byType(FileChip), findsNWidgets(3));
    expect(tester.takeException(), isNull);
    bench.dispose();
  });
}
