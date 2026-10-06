import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multi_agent/app.dart';
import 'package:multi_agent/data/settings.dart';
import 'package:multi_agent/l10n.dart';
import 'package:multi_agent/features/settings/setup_page.dart';
import 'package:multi_agent/theme/app_theme.dart';

void main() {
  test('bare host gets http://, trailing slashes go', () {
    expect(Settings.normaliseUrl('192.168.1.10:8080'), 'http://192.168.1.10:8080');
    expect(Settings.normaliseUrl('http://x.com/'), 'http://x.com');
    expect(Settings.normaliseUrl('  https://x.com//  '), 'https://x.com');
  });

  // The scheme is never upgraded to https: that would hide that the token travels in clear text.
  test('http is not turned into https', () {
    expect(Settings.normaliseUrl('http://x.com'), 'http://x.com');
  });

  test('a whole ?k= link is split', () {
    final s = Settings.fromPastedLink('http://216.195.192.61:8080/?k=A3LxeQ9xwKlTJCE')!;
    expect(s.baseUrl, 'http://216.195.192.61:8080');
    expect(s.token, 'A3LxeQ9xwKlTJCE');
  });

  test('not a link returns null, no guessing', () {
    expect(Settings.fromPastedLink('just some words'), isNull);
  });

  // ⚠️ This pins a real bug, found only by typing character by character.
  //
  // The address field used to be rewritten in onChanged: once `?k=` appeared
  // the field became just the host, and every later character was appended to
  // the rewritten value — giving `http://host:8080TOKEN`. Pasting is a single
  // onChanged, so pasting looked fine, which is why it survived.
  testWidgets('typing a whole link one character at a time does not eat itself', (tester) async {
    Settings? saved;
    await tester.pumpWidget(
      MaterialApp(
        // Desktop target. Widget tests default to Android; this app ships on
        // Windows and macOS, whose scrollbar and text behaviour differ.
        theme: AppTheme.dark().copyWith(platform: TargetPlatform.macOS),
        home: SetupPage(initial: const Settings(), onSaved: (s) => saved = s),
      ),
    );

    final field = find.byType(TextField).first;
    const link = 'http://127.0.0.1:8080/?k=A3LxeQ9xwKlTJCE';
    // ⚠️ Must APPEND to the field's current value. enterText(prefix) replaces
    // the whole text from the original prefix each time — then the test stays
    // green even if onChanged rewrites the field. The first version did that
    // and passed on both old and new code, i.e. verified nothing.
    for (final ch in link.split('')) {
      final now = tester.widget<TextField>(field).controller!.text;
      await tester.enterText(field, now + ch);
    }
    await tester.pump();

    await tester.tap(find.text('Connect'));
    await tester.pump();

    expect(saved, isNotNull);
    expect(saved!.baseUrl, 'http://127.0.0.1:8080');
    expect(saved!.token, 'A3LxeQ9xwKlTJCE');
  });

  testWidgets('a separately typed token is not overridden by k= in the address', (tester) async {
    Settings? saved;
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark().copyWith(platform: TargetPlatform.macOS),
        home: SetupPage(initial: const Settings(), onSaved: (s) => saved = s),
      ),
    );
    await tester.enterText(find.byType(TextField).at(0), 'http://h:8080/?k=old');
    await tester.enterText(find.byType(TextField).at(1), 'new');
    await tester.tap(find.text('Connect'));
    await tester.pump();
    expect(saved!.token, 'new');
  });

  test('language defaults to en and survives a save/load round trip', () async {
    expect(const Settings().lang, 'en');
    expect(Settings.fromJson({'baseUrl': 'h'}).lang, 'en'); // files from before the field
    final dir = await Directory.systemTemp.createTemp('ma-settings');
    final store = SettingsStore(dir: dir);
    await store.save(const Settings(baseUrl: 'http://h', token: 't', lang: 'zh-Hant'));
    final back = await store.load();
    expect(back.lang, 'zh-Hant');
    expect(back.copyWith(token: 'x').lang, 'zh-Hant');
    await dir.delete(recursive: true);
  });

  // Switching language redraws everything in place: typed text stays, and the
  // choice is written to settings.json.
  testWidgets('changing currentLang relabels the app without losing state and persists it', (tester) async {
    final dir = Directory.systemTemp.createTempSync('ma-lang');
    final store = SettingsStore(dir: dir);
    await tester.pumpWidget(MultiAgentApp(store: store, initial: const Settings()));
    await tester.enterText(find.byType(TextField).first, 'http://typed');
    expect(find.text('Connect'), findsOneWidget);

    currentLang.value = Lang.zhHans;
    await tester.pump();
    expect(find.text('连接'), findsOneWidget);
    expect(find.text('http://typed'), findsOneWidget);
    // The save was started inside the test's fake zone: let real I/O and the
    // fake zone's microtasks take turns until it lands.
    for (var i = 0; i < 10; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      await tester.pump();
    }
    expect((await tester.runAsync(store.load))!.lang, 'zh-Hans');

    currentLang.value = Lang.en;
    await tester.pump();
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
    dir.deleteSync(recursive: true);
  });

  testWidgets('appearance: system follows the desktop live, a choice sticks', (tester) async {
    final dir = Directory.systemTemp.createTempSync('ma-theme');
    final store = SettingsStore(dir: dir);
    addTearDown(() => dir.deleteSync(recursive: true));
    addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);
    addTearDown(() => currentTheme.value = ThemeMode.system);

    tester.platformDispatcher.platformBrightnessTestValue = Brightness.dark;
    await tester.pumpWidget(MultiAgentApp(store: store, initial: const Settings()));
    expect(C.isLight, isFalse);

    // No reload, no re-selection: the desktop flipped and so does the app.
    tester.platformDispatcher.platformBrightnessTestValue = Brightness.light;
    await tester.pump();
    expect(C.isLight, isTrue);

    // An explicit choice outranks the desktop and is written down.
    currentTheme.value = ThemeMode.dark;
    await tester.pump();
    expect(C.isLight, isFalse);
    for (var i = 0; i < 10; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      await tester.pump();
    }
    expect((await tester.runAsync(store.load))!.theme, ThemeMode.dark);
  });

  test('interface size and notifications survive a save/load round trip; old files get the defaults', () async {
    final dir = await Directory.systemTemp.createTemp('settings-scale');
    final store = SettingsStore(dir: dir);
    await store.save(const Settings(baseUrl: 'http://x:1', uiScale: 1.3, notify: false));
    final back = await store.load();
    expect(back.uiScale, 1.3);
    expect(back.notify, isFalse);
    // a settings file from before these existed
    await File('${dir.path}/settings.json').writeAsString('{"baseUrl":"http://x:1","token":"t"}');
    final old = await store.load();
    expect(old.uiScale, 0, reason: 'automatic');
    expect(old.notify, isTrue, reason: 'on unless turned off');
    await dir.delete(recursive: true);
  });
}
