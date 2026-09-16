import 'package:flutter_test/flutter_test.dart';
import 'package:multi_agent/l10n.dart';

void main() {
  test('every key has three non-empty translations and is defined once', () {
    final seen = <String>{};
    for (final table in stringTables) {
      for (final e in table.entries) {
        expect(seen.add(e.key), isTrue, reason: 'duplicate key ${e.key}');
        expect(e.value.length, 3, reason: e.key);
        expect(e.value.every((s) => s.isNotEmpty), isTrue, reason: e.key);
      }
    }
  });

  test('tr fills variables and falls back to the key', () {
    expect(tr('no.such.key'), 'no.such.key');
  });
}
