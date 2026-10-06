/// Everything that differs per operating system, in one place.
///
/// Scattered `Platform.isX` checks are how half a port happens: one screen
/// moves and the other quietly keeps the macOS behaviour. If a new difference
/// appears, it goes here — `test/platform_test.dart` scans `lib/` and fails
/// when it is written anywhere else.
library;

import 'dart:io';

import 'package:flutter/services.dart';

abstract final class AppPlatform {
  // Android: the app's own directories and handing a file to another app come from the
  // activity (android/app/src/main/kotlin/.../MainActivity.kt) over this channel.
  static const _channel = MethodChannel('cirraya/platform');
  static String? _androidFiles;
  static String? _androidCache;

  /// Ask Android for the app's directories, once, before anything reads [dataDir].
  static Future<void> init() async {
    if (!Platform.isAndroid) return;
    final dirs = await _channel.invokeMapMethod<String, String>('dirs');
    _androidFiles = dirs?['files'];
    _androidCache = dirs?['cache'];
  }

  /// A phone: one column at a time, touch, no file save dialog.
  static bool get isPhone => Platform.isAndroid || Platform.isIOS;

  /// Where this app keeps its own settings — the server address and token,
  /// and nothing else. Everything the product is actually made of lives in
  /// the server's PostgreSQL.
  static Directory get dataDir {
    if (Platform.isAndroid) return Directory('${_androidFiles ?? Directory.systemTemp.path}/settings');
    if (Platform.isWindows) {
      final appData = Platform.environment['APPDATA'];
      if (appData != null && appData.isNotEmpty) {
        return Directory('$appData\\MultiAgent');
      }
      return Directory('$_home\\AppData\\Roaming\\MultiAgent');
    }
    if (Platform.isMacOS) {
      return Directory('$_home/Library/Application Support/MultiAgent');
    }
    // XDG, which is also the sane fallback for anything else unix-shaped.
    final xdg = Platform.environment['XDG_DATA_HOME'];
    if (xdg != null && xdg.isNotEmpty) return Directory('$xdg/multi-agent');
    return Directory('$_home/.local/share/multi-agent');
  }

  static String get _home =>
      Platform.environment['HOME'] ?? Platform.environment['USERPROFILE'] ?? '.';

  /// The monospace face to ask for. Naming per system rather than bundling a
  /// font: a missing family falls back silently, and code in a proportional
  /// face is unreadable rather than merely off-brand.
  static String get monospaceFamily {
    if (Platform.isAndroid) return 'monospace';
    if (Platform.isWindows) return 'Cascadia Mono';
    if (Platform.isMacOS) return 'SF Mono';
    return 'DejaVu Sans Mono';
  }

  static List<String> get monospaceFallback {
    if (Platform.isWindows) return const ['Consolas', 'Courier New'];
    if (Platform.isMacOS) return const ['Menlo', 'Monaco'];
    return const ['Liberation Mono', 'Noto Sans Mono', 'monospace'];
  }

  /// The CJK face. Windows and macOS ship different ones, and asking for the
  /// wrong one gives tofu for every Chinese character — which is most of the
  /// text in this product.
  static List<String> get textFallback {
    if (Platform.isWindows) return const ['Microsoft YaHei', 'Segoe UI'];
    if (Platform.isMacOS) return const ['PingFang SC', 'Helvetica Neue'];
    return const ['Noto Sans CJK SC', 'WenQuanYi Zen Hei', 'DejaVu Sans'];
  }

  // ── notifications while the app is closed (Android: NoticeService) ──

  /// Notices can arrive while the app isn't running.
  static bool get backgroundNotices => Platform.isAndroid;

  /// Keep the server's notification feed open in the background. [texts] are the notification texts
  /// in the app's language (the service has no translations of its own).
  static Future<void> startNotices(String base, String token, Map<String, String> texts) =>
      _channel.invokeMethod('noticesStart', {'base': base, 'token': token, 'texts': texts});

  static Future<void> stopNotices() => _channel.invokeMethod('noticesStop');

  /// Ask to be spared from battery optimisation (a system dialog). True when already spared.
  static Future<bool> batteryExempt() async => await _channel.invokeMethod<bool>('batteryExempt') ?? false;

  /// The conversation a notice was about, when tapping it is what started the app.
  static Future<Map<String, String>?> launchTarget() =>
      Platform.isAndroid ? _channel.invokeMapMethod<String, String>('launchTarget') : Future.value(null);

  /// A notice tapped while the app was running.
  static void onOpenConversation(void Function(Map<String, String> target) open) {
    if (!Platform.isAndroid) return;
    _channel.setMethodCallHandler((call) async {
      if (call.method == 'openConversation') open(Map<String, String>.from(call.arguments as Map));
    });
  }

  /// The system camera can be asked for a photo or a video to attach.
  static bool get canCapture => Platform.isAndroid;

  /// Take a photo (or record a video) with the system camera app. The file's path, or null if cancelled.
  static Future<String?> capture({bool video = false}) => _channel.invokeMethod<String>('capture', {'video': video});

  /// Where a file downloaded to be opened or shared goes. On Android it must be the cache's
  /// shared/ folder: that is the one place its FileProvider hands out (res/xml/file_paths.xml).
  static Directory get downloadRoot =>
      Platform.isAndroid ? Directory('${_androidCache ?? Directory.systemTemp.path}/shared') : Directory.systemTemp;

  /// A "save as" dialog exists (file_selector has none on Android; there it is Share instead).
  static bool get canSaveAs => !Platform.isAndroid && !Platform.isIOS;

  /// A share sheet exists.
  static bool get canShare => Platform.isAndroid;

  /// Hand a file to the system's own app for it: Preview / QuickTime on macOS, the default app on
  /// Windows and Linux, the "open with" chooser on Android.
  static Future<void> openFile(String path, String mime) async {
    if (Platform.isAndroid) {
      final ok = await _channel.invokeMethod<bool>('open', {'path': path, 'mime': mime});
      if (ok != true) throw Exception('no app can open this file');
      return;
    }
    final (cmd, args) = openCommand(path);
    final r = await Process.run(cmd, args);
    if (r.exitCode != 0) throw Exception('${r.stderr}'.trim().isEmpty ? 'exit ${r.exitCode}' : '${r.stderr}'.trim());
  }

  /// Where there is no save dialog: write [text] to a file named [name] and offer it through the
  /// share sheet, which is how a phone saves (Files, Drive) or sends a file.
  static Future<void> shareText(String name, String text, String mime) async {
    await downloadRoot.create(recursive: true);
    final dir = await downloadRoot.createTemp('cirrayabot-');
    final f = File('${dir.path}/${name.replaceAll(RegExp(r'[\\/:*?"<>|]'), '_')}');
    await f.writeAsString(text);
    await shareFile(f.path, mime);
  }

  /// Android's share sheet: save to Files, Drive, send in a chat…
  static Future<void> shareFile(String path, String mime) async {
    final ok = await _channel.invokeMethod<bool>('share', {'path': path, 'mime': mime});
    if (ok != true) throw Exception('nothing to share with');
  }

  /// How to hand a file to the system's own app for it: Preview / QuickTime on
  /// macOS, the default app on Windows and Linux.
  static (String, List<String>) openCommand(String path) {
    if (Platform.isMacOS) return ('open', [path]);
    // `start`'s first quoted argument is a window title, hence the empty one.
    if (Platform.isWindows) return ('cmd', ['/c', 'start', '', path]);
    return ('xdg-open', [path]);
  }
}
