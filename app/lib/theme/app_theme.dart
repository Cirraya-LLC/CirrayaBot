/// The design system lives here, not in the widgets.
///
/// Same palette as the web UI — it is one product, and a desktop client that
/// looks like a different app makes people wonder whether it talks to the same
/// server. Material's defaults are all on another scale (40px pill buttons,
/// elevation shadows, a purple seed colour), so they are overridden once here
/// rather than fought per-screen.
///
/// Two palettes, one set of names. Light is not the dark one inverted: the
/// surface *relationships* are kept — the composer, tool cards and bubbles sit
/// above the canvas, input wells sit below it — but the base flips, so the
/// chrome is tinted grey and the content is white, which is what a light
/// workspace looks like.
///
/// Contrast: every text/surface pair actually used clears WCAG AA (4.5:1).
/// The dimmest text is 4.56:1 in dark, 4.60:1 in light.
library;

import 'package:flutter/material.dart';

import '../platform.dart';

class Palette {
  const Palette({
    required this.brightness,
    required this.bg,
    required this.side,
    required this.panel,
    required this.line,
    required this.bubble,
    required this.bubbleMine,
    required this.tool,
    required this.codeBlock,
    required this.codeBlockLine,
    required this.field,
    required this.raise,
    required this.hover,
    required this.selected,
    required this.chip,
    required this.chipStrong,
    required this.ink,
    required this.dim,
    required this.dim2,
    required this.chipInk,
    required this.codeBlockInk,
    required this.accent,
    required this.onAccent,
    required this.code,
    required this.codeBg,
    required this.tint,
    required this.tintInk,
    required this.bad,
    required this.badBg,
    required this.ok,
    required this.warn,
    required this.warnBg,
    required this.shadow,
  });

  final Brightness brightness;
  final Color bg, side, panel, line;
  final Color bubble, bubbleMine, tool, codeBlock, codeBlockLine, field;
  final Color raise, hover, selected, chip, chipStrong;
  final Color ink, dim, dim2, chipInk, codeBlockInk;
  final Color accent, onAccent, code, codeBg, tint, tintInk;
  final Color bad, badBg, ok, warn, warnBg, shadow;

  static const dark = Palette(
    brightness: Brightness.dark,
    bg: Color(0xFF0E0E10),
    side: Color(0xFF18181B),
    panel: Color(0xFF1F1F23),
    line: Color(0xFF2A2A30),
    bubble: Color(0xFF26262B),
    bubbleMine: Color(0xFF2F4A86),
    tool: Color(0xFF17171B),
    codeBlock: Color(0xFF141418),
    codeBlockLine: Color(0xFF2A2A30),
    field: Color(0xFF151519),
    raise: Color(0xFF232328),
    hover: Color(0xFF212127),
    selected: Color(0xFF2A2A31),
    chip: Color(0xFF2F2F37),
    chipStrong: Color(0xFF3A3A44),
    ink: Color(0xFFECECF0),
    dim: Color(0xFF919199),
    dim2: Color(0xFF8A8A94),
    chipInk: Color(0xFFC2C2CC),
    codeBlockInk: Color(0xFFC9D1D9),
    accent: Color(0xFF5B8CFF),
    // Near-black on the accent: white on this blue reads 3.2:1.
    onAccent: Color(0xFF0E1014),
    code: Color(0xFFFF7B72),
    codeBg: Color(0xFF33232A),
    tint: Color(0xFF22314D),
    tintInk: Color(0xFF9DC0FF),
    bad: Color(0xFFEA8890),
    badBg: Color(0xFF3A2226),
    ok: Color(0xFF3ECF8E),
    warn: Color(0xFFFFB454),
    warnBg: Color(0xFF3A3122),
    shadow: Color(0x66000000),
  );

  static const light = Palette(
    brightness: Brightness.light,
    // White canvas, grey bubbles, tinted chrome. Pinning the canvas at white
    // and tinting the bubble is what keeps an incoming message visible; a white
    // bubble on an off-white canvas is not.
    bg: Color(0xFFFFFFFF),
    side: Color(0xFFF4F6F9),
    panel: Color(0xFFFFFFFF),
    line: Color(0xFFDFE3EA),
    bubble: Color(0xFFEAEDF3),
    bubbleMine: Color(0xFFD8E6FF),
    tool: Color(0xFFF7F9FB),
    codeBlock: Color(0xFFE5E9EF),
    // A code block sits on a bubble, not on the canvas, so its hairline has to
    // be darker than the one used everywhere else.
    codeBlockLine: Color(0xFFC9D0DA),
    field: Color(0xFFEEF1F6),
    raise: Color(0xFFE9ECF2),
    hover: Color(0xFFE8EBF1),
    selected: Color(0xFFDDE3EE),
    chip: Color(0xFFDFE4EC),
    chipStrong: Color(0xFFCFD6E0),
    ink: Color(0xFF14161B),
    dim: Color(0xFF58606E),
    dim2: Color(0xFF616875),
    chipInk: Color(0xFF3C434F),
    codeBlockInk: Color(0xFF1F2328),
    accent: Color(0xFF215AE0),
    onAccent: Color(0xFFFFFFFF),
    code: Color(0xFFB3261E),
    codeBg: Color(0xFFFCECEB),
    tint: Color(0xFFE3ECFD),
    tintInk: Color(0xFF1D4ED8),
    bad: Color(0xFFB3261E),
    badBg: Color(0xFFFDEAEA),
    ok: Color(0xFF0B6E47),
    warn: Color(0xFF7A5000),
    warnBg: Color(0xFFFBF0DA),
    shadow: Color(0x260F172A),
  );

  static Palette of(Brightness b) => b == Brightness.light ? light : dark;
}

/// Colour names, resolved against whichever palette is in force.
///
/// A global rather than a `ThemeExtension` read from context: there is one app
/// and one theme at a time, and threading a scheme through ~130 call sites buys
/// nothing. The app root sets it in `build`, before any descendant builds.
///
/// The consequence to remember: a widget that reads one of these must not be
/// `const`, or Flutter reuses the canonical instance and it never repaints when
/// the theme changes.
abstract final class C {
  static Palette _now = Palette.dark;

  static void use(Brightness b) => _now = Palette.of(b);

  static Palette get palette => _now;
  static bool get isLight => _now.brightness == Brightness.light;

  static Color get bg => _now.bg;
  static Color get side => _now.side;
  static Color get panel => _now.panel;
  static Color get line => _now.line;
  static Color get bubble => _now.bubble;
  static Color get bubbleMine => _now.bubbleMine;
  static Color get tool => _now.tool;
  static Color get codeBlock => _now.codeBlock;
  static Color get codeBlockLine => _now.codeBlockLine;
  static Color get field => _now.field;
  static Color get raise => _now.raise;
  static Color get hover => _now.hover;
  static Color get selected => _now.selected;
  static Color get chip => _now.chip;
  static Color get chipStrong => _now.chipStrong;
  static Color get ink => _now.ink;
  static Color get dim => _now.dim;
  static Color get dim2 => _now.dim2;
  static Color get chipInk => _now.chipInk;
  static Color get codeBlockInk => _now.codeBlockInk;
  static Color get accent => _now.accent;
  static Color get onAccent => _now.onAccent;
  static Color get code => _now.code;
  static Color get codeBg => _now.codeBg;
  static Color get tint => _now.tint;
  static Color get tintInk => _now.tintInk;
  static Color get bad => _now.bad;
  static Color get badBg => _now.badBg;
  static Color get ok => _now.ok;
  static Color get warn => _now.warn;
  static Color get warnBg => _now.warnBg;
  static Color get shadow => _now.shadow;

  /// Agent colours arrive from the server as `#rrggbb`. A bad value must not
  /// take a row down with it — an Agent with an odd colour still needs to be
  /// clickable.
  static Color parse(String hex, [Color? fallback]) {
    final s = hex.replaceFirst('#', '').trim();
    if (s.length != 6) return fallback ?? dim2;
    final v = int.tryParse(s, radix: 16);
    return v == null ? (fallback ?? dim2) : Color(0xFF000000 | v);
  }
}

/// What the person chose: light, dark, or whatever the desktop is set to.
/// Anyone may set it; the app root persists it and repaints.
final ValueNotifier<ThemeMode> currentTheme = ValueNotifier(ThemeMode.system);

/// How big the whole interface is drawn: 0 = automatic (larger on a phone, where the desktop
/// sizes — 12px labels, 18px icons — are too small to read and tap), else a factor.
final ValueNotifier<double> currentScale = ValueNotifier(0);

/// The choices offered under Appearance.
const uiScales = [0.0, 1.0, 1.15, 1.3];

/// The factor actually used for a choice.
double effectiveScale(double chosen) => chosen > 0 ? chosen : (AppPlatform.isPhone ? 1.15 : 1.0);

/// Draws [child] [scale] times larger: it is laid out at the screen size divided by [scale] and
/// stretched to fill — text, icons and spacing grow together, so nothing has to be resized one
/// widget at a time. Everything that comes from the screen in logical pixels (size, safe areas,
/// the keyboard) is divided too, so layout and the keyboard still line up.
class UiScale extends StatelessWidget {
  const UiScale({super.key, required this.scale, required this.child});

  final double scale;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    if (scale == 1) return child;
    final mq = MediaQuery.of(context);
    final size = mq.size / scale;
    return MediaQuery(
      data: mq.copyWith(
        size: size,
        devicePixelRatio: mq.devicePixelRatio * scale,
        padding: mq.padding / scale,
        viewPadding: mq.viewPadding / scale,
        viewInsets: mq.viewInsets / scale,
        systemGestureInsets: mq.systemGestureInsets / scale,
      ),
      child: SizedBox.expand(
        child: FittedBox(
          fit: BoxFit.fill,
          alignment: Alignment.topLeft,
          child: SizedBox(width: size.width, height: size.height, child: child),
        ),
      ),
    );
  }
}

abstract final class AppTheme {
  static String? get mono => AppPlatform.monospaceFamily;
  static List<String> get monoFallback => AppPlatform.monospaceFallback;
  static List<String> get textFallback => AppPlatform.textFallback;

  static ThemeData dark() => of(Brightness.dark);
  static ThemeData light() => of(Brightness.light);

  static ThemeData of(Brightness brightness) {
    final p = Palette.of(brightness);
    final base = ThemeData(brightness: brightness, useMaterial3: true);
    return base.copyWith(
      scaffoldBackgroundColor: p.bg,
      canvasColor: p.bg,
      dividerColor: p.line,
      dividerTheme: DividerThemeData(color: p.line, space: 1, thickness: 1),
      colorScheme: base.colorScheme.copyWith(
        brightness: brightness,
        primary: p.accent,
        onPrimary: p.onAccent,
        surface: p.panel,
        onSurface: p.ink,
        error: p.code,
      ),
      textTheme: base.textTheme.apply(
        bodyColor: p.ink,
        displayColor: p.ink,
        fontFamilyFallback: textFallback,
      ),
      // 14px body at 1.6 — the same rhythm as the web UI. Material's default
      // is larger and looser, which turns a chat transcript into a scroll.
      textSelectionTheme: TextSelectionThemeData(cursorColor: p.accent),
      scrollbarTheme: ScrollbarThemeData(
        thickness: const WidgetStatePropertyAll(7),
        thumbColor: WidgetStatePropertyAll(p.ink.withValues(alpha: 0.2)),
        radius: const Radius.circular(4),
      ),
      popupMenuTheme: PopupMenuThemeData(
        color: p.panel,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(10),
          side: BorderSide(color: p.line),
        ),
      ),
      tooltipTheme: TooltipThemeData(
        decoration: BoxDecoration(
          color: p.panel,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: p.line),
        ),
        textStyle: TextStyle(fontSize: 12.5, color: p.ink, fontFamilyFallback: textFallback),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        waitDuration: const Duration(milliseconds: 300),
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: p.panel,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(15),
          side: BorderSide(color: p.line),
        ),
      ),
      drawerTheme: DrawerThemeData(backgroundColor: p.side, surfaceTintColor: Colors.transparent),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: p.field,
        hintStyle: TextStyle(color: p.dim2, fontSize: 13),
        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
        border: _field(p.line),
        enabledBorder: _field(p.line),
        focusedBorder: _field(p.accent),
        isDense: true,
      ),
      filledButtonTheme: FilledButtonThemeData(style: _button(p.accent, p.onAccent)),
      textButtonTheme: TextButtonThemeData(style: _button(p.chip, p.ink)),
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
