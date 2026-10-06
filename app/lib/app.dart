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
import 'platform.dart';
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
    currentScale.value = _settings.uiScale;
    currentScale.addListener(_scaleChanged);
    _syncNotices();
  }

  /// The background notification feed follows the settings: which server, on or off, and the
  /// language its texts are in. Best effort — a phone that refuses still has the app.
  void _syncNotices() {
    if (!AppPlatform.backgroundNotices) return;
    final s = _settings;
    final run = s.configured && s.notify
        ? AppPlatform.startNotices(s.baseUrl, s.token, {
            for (final k in const ['asked', 'approval', 'replyIn', 'connected', 'connectedNote', 'chMessages', 'chConnection'])
              k: tr('nt.$k'),
          })
        : AppPlatform.stopNotices();
    run.catchError((Object _) {});
  }

  Future<void> _setNotify(bool on) async {
    _settings = _settings.copyWith(notify: on);
    await widget.store.save(_settings);
    _syncNotices();
    // Turning it on is when to ask about battery: without it Doze stops the feed while the phone sleeps.
    if (on) await AppPlatform.batteryExempt().catchError((Object _) => false);
    if (mounted) setState(() {});
  }

  void _scaleChanged() {
    _settings = _settings.copyWith(uiScale: currentScale.value);
    widget.store.save(_settings).ignore();
    if (mounted) setState(() {});
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
    _syncNotices(); // the notifications' texts are in the app's language
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
    _syncNotices();
  }

  @override
  void dispose() {
    currentLang.removeListener(_langChanged);
    currentTheme.removeListener(_themeChanged);
    currentScale.removeListener(_scaleChanged);
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
      // Around the navigator, so dialogs, menus and pushed pages are scaled too.
      builder: (context, child) => UiScale(scale: effectiveScale(currentScale.value), child: child!),
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
              notify: AppPlatform.backgroundNotices ? _settings.notify : null,
              onNotify: _setNotify,
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
