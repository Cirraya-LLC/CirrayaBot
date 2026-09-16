/// Interface text in three languages: English (default), Simplified and
/// Traditional Chinese.
///
/// Strings live in `lib/l10n/*.dart`, one file per area, as
/// `key: ['English', '简体', '繁體']`. `{name}` in the text is replaced from
/// the `vars` map. `test/l10n_test.dart` checks every key has all three.
library;

import 'package:flutter/widgets.dart';

import 'l10n/common.dart';
import 'l10n/editors.dart';
import 'l10n/settings.dart';
import 'l10n/state.dart';
import 'l10n/workbench.dart';

enum Lang {
  en('en', 'English'),
  zhHans('zh-Hans', '简体中文'),
  zhHant('zh-Hant', '繁體中文');

  const Lang(this.code, this.label);
  final String code;
  final String label;

  static Lang parse(String? code) =>
      Lang.values.firstWhere((l) => l.code == code, orElse: () => Lang.en);
}

/// Every area's table, merged. A key defined twice is a bug the test catches.
final List<Map<String, List<String>>> stringTables = [
  commonStrings,
  workbenchStrings,
  editorStrings,
  settingsStrings,
  stateStrings,
];

final Map<String, List<String>> _all = {for (final t in stringTables) ...t};

/// The current language. The app root listens to it and rebuilds everything.
final ValueNotifier<Lang> currentLang = ValueNotifier(Lang.en);

String tr(String key, [Map<String, Object?> vars = const {}]) {
  final row = _all[key];
  if (row == null) return key;
  var text = row[currentLang.value.index];
  if (text.isEmpty) text = row[0];
  if (vars.isEmpty) return text;
  return text.replaceAllMapped(RegExp(r'\{(\w+)\}'), (m) {
    final k = m.group(1)!;
    return vars.containsKey(k) ? '${vars[k]}' : m.group(0)!;
  });
}
