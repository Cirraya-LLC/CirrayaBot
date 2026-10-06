import 'package:flutter/material.dart';

import 'app.dart';
import 'platform.dart';
import 'data/settings.dart';
import 'l10n.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await AppPlatform.init();
  final store = SettingsStore();
  final initial = await store.load();
  currentLang.value = Lang.parse(initial.lang);
  runApp(MultiAgentApp(store: store, initial: initial));
}
