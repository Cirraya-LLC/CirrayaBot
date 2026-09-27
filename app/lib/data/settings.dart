/// The only thing this client stores locally: which server, the token, and
/// the interface language.
///
/// There is no account system and no login screen — the server has one shared
/// access token, so "signing in" is telling the app an address. Anything more
/// would be a login wall in front of a product that does not have accounts.
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart' show ThemeMode;

import '../platform.dart';

class Settings {
  const Settings({
    this.baseUrl = '',
    this.token = '',
    this.lang = 'en',
    this.theme = ThemeMode.system,
    this.sidebarCollapsed = false,
    this.sidebarWidth = defaultSidebarWidth,
    this.panelWidth = defaultPanelWidth,
  });

  static const double defaultSidebarWidth = 308;
  static const double defaultPanelWidth = 290;

  /// e.g. `http://192.168.1.10:8080`. No trailing slash — normalised on the
  /// way in so every call site can just append a path.
  final String baseUrl;
  final String token;

  /// Interface language code (`en` / `zh-Hans` / `zh-Hant`), see l10n.dart.
  final String lang;

  /// Light, dark, or whatever the desktop is set to. Per machine, like the
  /// language — the same person's laptop and desktop need not agree.
  final ThemeMode theme;

  /// Whether the conversation list is showing as a rail.
  final bool sidebarCollapsed;

  /// Widths someone dragged the conversation list and the right panel to.
  /// The page clamps them against the window; these are what was asked for.
  final double sidebarWidth;
  final double panelWidth;

  bool get configured => baseUrl.isNotEmpty;

  Settings copyWith({
    String? baseUrl,
    String? token,
    String? lang,
    ThemeMode? theme,
    bool? sidebarCollapsed,
    double? sidebarWidth,
    double? panelWidth,
  }) => Settings(
    baseUrl: normaliseUrl(baseUrl ?? this.baseUrl),
    token: token ?? this.token,
    lang: lang ?? this.lang,
    theme: theme ?? this.theme,
    sidebarCollapsed: sidebarCollapsed ?? this.sidebarCollapsed,
    sidebarWidth: sidebarWidth ?? this.sidebarWidth,
    panelWidth: panelWidth ?? this.panelWidth,
  );

  Map<String, Object?> toJson() => {
    'baseUrl': baseUrl,
    'token': token,
    'lang': lang,
    'theme': theme.name,
    'sidebarCollapsed': sidebarCollapsed,
    'sidebarWidth': sidebarWidth,
    'panelWidth': panelWidth,
  };

  static Settings fromJson(Map<String, Object?> j) => Settings(
    baseUrl: normaliseUrl((j['baseUrl'] as String?) ?? ''),
    token: (j['token'] as String?) ?? '',
    lang: (j['lang'] as String?) ?? 'en',
    theme: parseTheme(j['theme'] as String?),
    sidebarCollapsed: (j['sidebarCollapsed'] as bool?) ?? false,
    sidebarWidth: (j['sidebarWidth'] as num?)?.toDouble() ?? defaultSidebarWidth,
    panelWidth: (j['panelWidth'] as num?)?.toDouble() ?? defaultPanelWidth,
  );

  /// Anything unrecognised means "follow the desktop" — the answer that is
  /// right for someone who has never chosen.
  static ThemeMode parseTheme(String? name) =>
      ThemeMode.values.firstWhere((m) => m.name == name, orElse: () => ThemeMode.system);

  /// Trims, drops trailing slashes, and assumes http:// when someone types a
  /// bare host — which they will, because the address they were handed looks
  /// like `192.168.1.10:8080`.
  ///
  /// It does not upgrade to https: silently "fixing" the scheme would hide
  /// the fact that the token is going over the wire in the clear.
  static String normaliseUrl(String raw) {
    var s = raw.trim();
    if (s.isEmpty) return '';
    if (!s.contains('://')) s = 'http://$s';
    while (s.endsWith('/')) {
      s = s.substring(0, s.length - 1);
    }
    return s;
  }

  /// Pulls `?k=` out of a pasted link. The server prints its address in that
  /// shape, so pasting the whole thing is the obvious thing to do — and
  /// making the person split it by hand is a step that exists for no reason.
  static Settings? fromPastedLink(String raw) {
    final uri = Uri.tryParse(raw.trim());
    if (uri == null || !uri.hasScheme || uri.host.isEmpty) return null;
    final token = uri.queryParameters['k'] ?? '';
    final port = uri.hasPort ? ':${uri.port}' : '';
    return Settings(baseUrl: '${uri.scheme}://${uri.host}$port', token: token);
  }
}

class SettingsStore {
  SettingsStore({Directory? dir}) : _dir = dir ?? AppPlatform.dataDir;

  final Directory _dir;
  File get _file => File('${_dir.path}${Platform.pathSeparator}settings.json');

  Future<Settings> load() async {
    try {
      final text = await _file.readAsString();
      return Settings.fromJson(jsonDecode(text) as Map<String, Object?>);
    } catch (_) {
      // No file, bad JSON, unreadable directory — all mean the same thing to
      // the caller: nothing configured yet, show the setup screen.
      return const Settings();
    }
  }

  Future<void> save(Settings s) async {
    await _dir.create(recursive: true);
    await _file.writeAsString(jsonEncode(s.toJson()));
  }
}
