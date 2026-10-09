import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multi_agent/data/api.dart';
import 'package:multi_agent/data/settings.dart';
import 'package:multi_agent/data/speech.dart';
import 'package:multi_agent/features/workbench/call_page.dart';
import 'package:multi_agent/features/workbench/workbench_page.dart';
import 'package:multi_agent/l10n.dart';
import 'package:multi_agent/state/voice.dart';
import 'package:multi_agent/state/workbench.dart';
import 'package:multi_agent/theme/app_theme.dart';

/// An engine that never hears or says anything: this file is about layout.
class QuietEngine implements VoiceEngine {
  @override
  Future<({bool hear, bool speak})> caps() async => (hear: true, speak: true);
  @override
  Future<String> hear({required String lang, bool continuous = false, void Function(String)? onPartial, void Function(double)? onLevel}) async => '';
  @override
  Future<String?> record({required int endSilenceMs, required int noSpeechMs, required int maxMs, void Function(double)? onLevel}) async => null;
  @override
  Future<void> stopListening() async {}
  @override
  Future<void> cancelListening() async {}
  @override
  Future<void> say(String text, {required double pitch, required double rate, String lang = '', String voice = ''}) async {}
  @override
  Future<void> play(String path) async {}
  @override
  Future<void> silence() async {}
  @override
  Future<List<({String name, String lang})>> voices() async => const [];
}

const op = Conversation(kind: 'agent', id: 'op', name: 'Operator', tag: 'Puts well-thought-out changes into effect',
  preview: '', at: 0, members: ['op'], color: '#f0a040', colors: ['#f0a040']);

// Its own file: a testWidgets beside real-HttpServer tests breaks them (fake-async binding).
void main() {
  // The narrowest phone layouts (360 wide at 130% is 277 logical pixels): the composer gains a
  // microphone and, while nothing is typed, a call button in place of Send.
  for (final (size, scale) in const [(Size(393, 851), 1.15), (Size(360, 640), 1.3)]) {
    testWidgets('composer with voice at ${size.width.toInt()} ×$scale: mic, call ↔ send, no overflow', (tester) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final bench = Workbench(const Settings(baseUrl: 'http://127.0.0.1:1', token: 't'));
      bench.agents = const [Agent(id: 'op', name: 'Operator', description: 'x', persona: 'x', color: '#f0a040')];
      bench.conversations = const [op];
      bench.loading = false;
      final voice = VoiceController(bench, QuietEngine(), dir: Directory.systemTemp.createTempSync('v'));
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark().copyWith(platform: TargetPlatform.android),
        builder: (context, child) => UiScale(scale: scale, child: child!),
        home: WorkbenchPage(bench: bench, onEditServer: () {}, collapsed: false, onCollapsed: (_) {}, voice: voice),
      ));
      await tester.pump();
      expect(find.byTooltip(tr('vo.title')), findsOneWidget, reason: 'voice settings in the footer');
      await tester.tap(find.text('Operator'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.byKey(const ValueKey('composer-mic')), findsOneWidget);
      expect(find.byKey(const ValueKey('composer-call')), findsOneWidget, reason: 'nothing typed: a call');
      await tester.enterText(find.byType(TextField).last, 'hello');
      await tester.pump();
      expect(find.byKey(const ValueKey('composer-call')), findsNothing, reason: 'something typed: Send');
      expect(tester.getSize(find.byType(TextField).last).width, greaterThan(90), reason: 'room left to type in');
      expect(tester.takeException(), isNull);
      voice.dispose();
      bench.dispose();
    });

    testWidgets('call page at ${size.width.toInt()} ×$scale: every state fits; hanging up leaves it', (tester) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final bench = Workbench(const Settings(baseUrl: 'http://127.0.0.1:1', token: 't'));
      final voice = VoiceController(bench, QuietEngine(), dir: Directory.systemTemp.createTempSync('v'))
        ..callWith = op
        ..heard = 'Could you look at the deployment logs from last night and tell me what failed first, please?' * 2
        ..saying = 'The first failure was the database migration, which timed out after thirty seconds.' * 2;
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark().copyWith(platform: TargetPlatform.android),
        builder: (context, child) => UiScale(scale: scale, child: child!),
        home: Builder(
          builder: (context) => TextButton(
            onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => CallPage(voice: voice, conversation: op))),
            child: const Text('open'),
          ),
        ),
      ));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      for (final s in CallState.values) {
        voice.callState = s;
        voice.notifyListeners();
        await tester.pump(const Duration(milliseconds: 200));
        expect(find.text(tr('vo.state.${s.name}')), findsOneWidget);
        expect(tester.takeException(), isNull, reason: '$s');
      }
      await tester.tap(find.byKey(const ValueKey('call-end')));
      await tester.pumpAndSettle();
      expect(voice.inCall, isFalse);
      expect(find.byType(CallPage), findsNothing, reason: 'hanging up leaves the page');
      voice.dispose();
      bench.dispose();
    });
  }
}
