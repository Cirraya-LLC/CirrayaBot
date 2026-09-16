/// The design system lives here, not in the widgets.
///
/// Same palette as the web UI — it is one product, and a desktop client that
/// looks like a different app makes people wonder whether it talks to the same
/// server. Material's defaults are all on another scale (40px pill buttons,
/// elevation shadows, a purple seed colour), so they are overridden once here
/// rather than fought per-screen.
library;

import 'package:flutter/material.dart';

import '../platform.dart';

abstract final class C {
  static const bg = Color(0xFF0E0E10);
  static const side = Color(0xFF18181B);
  static const panel = Color(0xFF1F1F23);
  static const bubble = Color(0xFF26262B);
  static const line = Color(0xFF2A2A30);
  static const ink = Color(0xFFECECF0);
  static const dim = Color(0xFF8B8B95);
  static const dim2 = Color(0xFF6A6A74);
  static const accent = Color(0xFF5B8CFF);
  static const code = Color(0xFFFF7B72);
  static const ok = Color(0xFF3ECF8E);
  static const warn = Color(0xFFFFB454);

  /// Agent colours arrive from the server as `#rrggbb`. A bad value must not
  /// take a row down with it — an Agent with an odd colour still needs to be
  /// clickable.
  static Color parse(String hex, [Color fallback = dim2]) {
    final s = hex.replaceFirst('#', '').trim();
    if (s.length != 6) return fallback;
    final v = int.tryParse(s, radix: 16);
    return v == null ? fallback : Color(0xFF000000 | v);
  }
}

abstract final class AppTheme {
  static String? get mono => AppPlatform.monospaceFamily;
  static List<String> get monoFallback => AppPlatform.monospaceFallback;
  static List<String> get textFallback => AppPlatform.textFallback;

  static ThemeData dark() {
    final base = ThemeData.dark(useMaterial3: true);
    return base.copyWith(
      scaffoldBackgroundColor: C.bg,
      canvasColor: C.bg,
      dividerColor: C.line,
      colorScheme: base.colorScheme.copyWith(
        primary: C.accent,
        surface: C.panel,
        onSurface: C.ink,
        error: C.code,
      ),
      textTheme: base.textTheme.apply(
        bodyColor: C.ink,
        displayColor: C.ink,
        fontFamilyFallback: textFallback,
      ),
      // 14px body at 1.6 — the same rhythm as the web UI. Material's default
      // is larger and looser, which turns a chat transcript into a scroll.
      textSelectionTheme: const TextSelectionThemeData(cursorColor: C.accent),
      scrollbarTheme: ScrollbarThemeData(
        thickness: const WidgetStatePropertyAll(7),
        thumbColor: const WidgetStatePropertyAll(Color(0x33FFFFFF)),
        radius: const Radius.circular(4),
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: C.panel,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(15),
          side: const BorderSide(color: C.line),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: const Color(0xFF151519),
        hintStyle: const TextStyle(color: C.dim2, fontSize: 13),
        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
        border: _field(C.line),
        enabledBorder: _field(C.line),
        focusedBorder: _field(C.accent),
        isDense: true,
      ),
      filledButtonTheme: FilledButtonThemeData(style: _button(C.accent, Colors.white)),
      textButtonTheme: TextButtonThemeData(style: _button(const Color(0xFF2F2F37), C.ink)),
    );
  }

  static OutlineInputBorder _field(Color c) => OutlineInputBorder(
    borderRadius: BorderRadius.circular(9),
    borderSide: BorderSide(color: c),
  );

  static ButtonStyle _button(Color bg, Color fg) => ButtonStyle(
    backgroundColor: WidgetStatePropertyAll(bg),
    foregroundColor: WidgetStatePropertyAll(fg),
    textStyle: const WidgetStatePropertyAll(TextStyle(fontSize: 12.5, fontWeight: FontWeight.w500)),
    padding: const WidgetStatePropertyAll(EdgeInsets.symmetric(horizontal: 14)),
    minimumSize: const WidgetStatePropertyAll(Size(0, 34)),
    shape: WidgetStatePropertyAll(
      RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
    ),
    elevation: const WidgetStatePropertyAll(0),
    visualDensity: VisualDensity.compact,
  );
}
