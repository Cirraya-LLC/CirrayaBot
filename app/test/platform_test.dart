import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// "This differs on this OS" checks may only live in platform.dart.
///
/// Scattered Platform.isX is how half a port happens: one screen changes, the
/// other quietly keeps the macOS behaviour, and both compile.
void main() {
  test('Platform.isX appears only in platform.dart', () {
    final offenders = <String>[];
    for (final f in Directory('lib').listSync(recursive: true)) {
      if (f is! File || !f.path.endsWith('.dart')) continue;
      if (f.path.endsWith('platform.dart')) continue;
      final src = f.readAsStringSync();
      // AppPlatform.isPhone and friends are the sanctioned way to ask; dart:io's Platform.isX is not.
      if (RegExp(r'(?<!App)Platform\.is[A-Z]').hasMatch(src)) offenders.add(f.path);
    }
    expect(offenders, isEmpty, reason: 'move the difference into lib/platform.dart: $offenders');
  });
}
