/// Everything that differs per operating system, in one place.
///
/// Scattered `Platform.isX` checks are how half a port happens: one screen
/// moves and the other quietly keeps the macOS behaviour. If a new difference
/// appears, it goes here — `test/platform_test.dart` scans `lib/` and fails
/// when it is written anywhere else.
library;

import 'dart:io';

abstract final class AppPlatform {
  /// Where this app keeps its own settings — the server address and token,
  /// and nothing else. Everything the product is actually made of lives in
  /// the server's PostgreSQL.
  static Directory get dataDir {
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
}
