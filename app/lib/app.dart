/// Two states: no server configured yet, or the workbench.
///
/// There is no login, so there is no session to expire and nothing to log out
/// of — changing servers is editing a setting.
library;

import 'package:flutter/material.dart';

import 'data/settings.dart';
import 'features/settings/setup_page.dart';
import 'features/workbench/workbench_page.dart';
import 'l10n.dart';
import 'state/workbench.dart';
import 'theme/app_theme.dart';

class MultiAgentApp extends StatefulWidget {
  const MultiAgentApp({super.key, required this.store, required this.initial});

  final SettingsStore store;
  final Settings initial;

  @override
  State<MultiAgentApp> createState() => _MultiAgentAppState();
}

class _MultiAgentAppState extends State<MultiAgentApp> {
  late Settings _settings = widget.initial;
  Workbench? _bench;
  bool _editing = false;

  @override
  void initState() {
    super.initState();
    if (_settings.configured) _bench = Workbench(_settings);
    currentLang.addListener(_langChanged);
    currentTheme.value = _settings.theme;
    currentTheme.addListener(_themeChanged);
  }

  void _themeChanged() {
    _settings = _settings.copyWith(theme: currentTheme.value);
    widget.store.save(_settings).ignore(); // best effort, same as the language
    if (mounted) setState(() {});
  }

  /// Anyone may set `currentLang.value`; this persists it and redraws every
  /// widget in place. Marking elements dirty (rather than swapping a key)
  /// keeps all state — open dialogs, typed text, scroll positions.
  void _langChanged() {
    _settings = _settings.copyWith(lang: currentLang.value.code);
    widget.store.save(_settings).ignore(); // best effort: a read-only disk keeps the choice for this run
    void mark(Element e) {
      e.markNeedsBuild();
      e.visitChildren(mark);
    }

    if (mounted) (context as Element).visitChildren(mark);
  }

  Future<void> _connect(Settings s) async {
    s = s.copyWith(lang: currentLang.value.code);
    await widget.store.save(s);
    // A new controller rather than a mutated one: the old one may still be
    // streaming a reply from the old server, and letting that land in the new
    // window would show one server's answer under another's name.
    _bench?.dispose();
    if (!mounted) return;
    setState(() {
      _settings = s;
      _bench = Workbench(s);
      _editing = false;
    });
  }

  @override
  void dispose() {
    currentLang.removeListener(_langChanged);
    currentTheme.removeListener(_themeChanged);
    _bench?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final bench = _bench;
    final mode = currentTheme.value;
    final brightness = switch (mode) {
      ThemeMode.light => Brightness.light,
      ThemeMode.dark => Brightness.dark,
      // runApp's View provides this, so the dependency is real: when the
      // desktop flips, this rebuilds and everything follows without a reload.
      ThemeMode.system => MediaQuery.platformBrightnessOf(context),
    };
    // Set before the subtree builds: C.* is read during build, not from
    // context. One app, one theme at a time.
    C.use(brightness);
    return MaterialApp(
      title: 'CirrayaBot',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light(),
      darkTheme: AppTheme.dark(),
      themeMode: mode,
      // Material cross-fades themes over 200ms while C.* flips at once, which
      // leaves half the window mid-fade. Everything switches together instead.
      themeAnimationDuration: Duration.zero,
      home: (bench == null || _editing)
          ? SetupPage(
              key: ValueKey(_settings.baseUrl),
              initial: _settings,
              onCancel: bench == null ? null : () => setState(() => _editing = false),
              onSaved: _connect,
            )
          : WorkbenchPage(
              key: ValueKey(_settings.baseUrl),
              bench: bench,
              onEditServer: () => setState(() => _editing = true),
              collapsed: _settings.sidebarCollapsed,
              // The page owns the state while it is open; this only writes it
              // down, so toggling does not rebuild the whole app mid-animation.
              onCollapsed: (v) {
                _settings = _settings.copyWith(sidebarCollapsed: v);
                widget.store.save(_settings).ignore();
              },
              sidebarWidth: _settings.sidebarWidth,
              panelWidth: _settings.panelWidth,
              onResized: (side, panel) {
                _settings = _settings.copyWith(sidebarWidth: side, panelWidth: panel);
                widget.store.save(_settings).ignore();
              },
            ),
    );
  }
}
