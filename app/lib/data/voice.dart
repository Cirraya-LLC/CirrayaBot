/// What is said out loud: the same rules as the web's `web/voice.mjs`, so a reply sounds the
/// same on the phone as in the browser. Pure — no platform code. `test/voice_test.dart` runs the
/// same cases as that file's self-test.
library;

/// Voice settings as the server keeps them (`/api/settings/voice`): which engine hears and which
/// speaks. `device` = the phone's own; `upstream` = one of the person's upstreams, by the server.
class VoiceSettings {
  const VoiceSettings({this.stt = const VoicePart(), this.tts = const VoicePart()});
  final VoicePart stt;
  final VoicePart tts;

  static VoiceSettings fromJson(Map<String, Object?> j) => VoiceSettings(
    stt: VoicePart.fromJson((j['stt'] as Map?)?.cast<String, Object?>() ?? const {}),
    tts: VoicePart.fromJson((j['tts'] as Map?)?.cast<String, Object?>() ?? const {}),
  );
  Map<String, Object?> toJson() => {'stt': stt.toJson(), 'tts': tts.toJson()};
}

class VoicePart {
  const VoicePart({this.mode = 'device', this.providerId = '', this.model = '', this.voice = ''});
  final String mode;
  final String providerId;
  final String model;

  /// Only for speaking: the default voice name on the upstream.
  final String voice;

  bool get upstream => mode == 'upstream';

  static VoicePart fromJson(Map<String, Object?> j) => VoicePart(
    mode: j['mode'] == 'upstream' ? 'upstream' : 'device',
    providerId: (j['provider_id'] as String?) ?? '',
    model: (j['model'] as String?) ?? '',
    voice: (j['voice'] as String?) ?? '',
  );
  Map<String, Object?> toJson() => {
    'mode': mode,
    if (upstream) ...{'provider_id': providerId, 'model': model, if (voice.isNotEmpty) 'voice': voice},
  };
}

/// A reply as it should sound: code is "(code)" ([codeWord]), links are their words, URLs and
/// Markdown's marks are not read.
String speakable(String md, {String codeWord = 'code'}) {
  var t = md;
  t = t.replaceAll(RegExp(r'```[\s\S]*?(```|$)'), ' ($codeWord) ');
  t = t.replaceAllMapped(RegExp(r'!\[([^\]]*)\]\([^)]*\)'), (m) => m[1]!);
  t = t.replaceAllMapped(RegExp(r'\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)'), (m) => m[1]!);
  t = t.replaceAll(RegExp(r'https?://\S+'), '');
  t = t.replaceAllMapped(RegExp(r'`([^`\n]+)`'), (m) => m[1]!);
  t = t.replaceAll(RegExp(r'^\s{0,3}#{1,6}\s+', multiLine: true), '');
  t = t.replaceAll(RegExp(r'^\s*[-*+]\s+', multiLine: true), '').replaceAll(RegExp(r'^\s*\d+[.)]\s+', multiLine: true), '');
  t = t.replaceAll(RegExp(r'^\s*>\s?', multiLine: true), '');
  t = t.replaceAll(RegExp(r'^[ \t]*\|?[ \t]*:?-{3,}.*$', multiLine: true), '');
  t = t.replaceAllMapped(RegExp(r'^[ \t]*\|(.*)\|[ \t]*$', multiLine: true),
      (m) => m[1]!.split('|').map((c) => c.trim()).where((c) => c.isNotEmpty).join(', '));
  t = t.replaceAllMapped(RegExp(r'(\*\*|__|~~)(.+?)\1'), (m) => m[2]!);
  t = t.replaceAllMapped(RegExp(r'(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)', multiLine: true), (m) => '${m[1]}${m[2]}');
  t = t.replaceAllMapped(RegExp(r'@(\S+)'), (m) => m[1]!);
  t = t.replaceAll(RegExp(r'\*\*|__|~~|`'), '');
  return t
      .replaceAll(RegExp(r'[ \t]+'), ' ')
      .replaceAll(RegExp(r'\s*\n\s*'), '\n')
      .replaceAll(RegExp(r'\n{2,}'), '\n')
      .trim();
}

// CJK sentence marks end a sentence where they stand; . ! ? only before a space or the end ("3.14").
final _end = RegExp('[。！？…]+["\'”’」』)\\]*_]*|[.!?]+["\'”’)\\]*_]*(\\s+|\$)|\\n+');
final _hasWord = RegExp(r'[\p{L}\p{N}]', unicode: true);

/// Split text into pieces to speak one after another: whole sentences in `out`, the unfinished
/// tail in `rest` (unless [isFinal]). Long runs are cut at a comma or a space.
({List<String> out, String rest}) sentences(String text, {bool isFinal = false, int max = 220}) {
  final out = <String>[];
  var from = 0;
  for (final m in _end.allMatches(text)) {
    if (m.end == text.length && !isFinal && RegExp(r'^[.!?]').hasMatch(m[0]!) && !RegExp(r'\s$').hasMatch(m[0]!)) break;
    final piece = text.substring(from, m.end).trim();
    if (piece.isNotEmpty) out.addAll(_cut(piece, max));
    from = m.end;
  }
  var rest = text.substring(from);
  if (isFinal && rest.trim().isNotEmpty) {
    out.addAll(_cut(rest.trim(), max));
    rest = '';
  } else if (rest.length > max) {
    final at = _lastBreak(rest, max - 1, cjkComma: false);
    if (at > 40) {
      out.add(rest.substring(0, at + 1).trim());
      rest = rest.substring(at + 1);
    }
  }
  return (out: out.where(_hasWord.hasMatch).toList(), rest: rest);
}

int _lastBreak(String s, int before, {bool cjkComma = true}) {
  var at = -1;
  for (final sep in [', ', '，', if (cjkComma) '、', ' ']) {
    final i = s.lastIndexOf(sep, before);
    if (i > at) at = i;
  }
  return at;
}

List<String> _cut(String s, int max) {
  final out = <String>[];
  while (s.length > max) {
    var at = _lastBreak(s, max - 1);
    if (at < 40) at = max - 1;
    out.add(s.substring(0, at + 1).trim());
    s = s.substring(at + 1).trim();
  }
  if (s.isNotEmpty) out.add(s);
  return out;
}

/// Reads a reply as it streams: [push] the new text, get back what can be spoken now. A code
/// block is held until it closes (then "(code)" once), never read line by line; a sentence comes
/// out only once complete. `push('', isFinal: true)` flushes the rest.
class Reader {
  Reader({this.codeWord = 'code', this.max = 220});
  final String codeWord;
  final int max;
  String _raw = '';
  int _at = 0;

  List<String> push(String delta, {bool isFinal = false}) {
    _raw += delta;
    final p = _raw.substring(_at);
    var cut = 0;
    if (isFinal) {
      cut = p.length;
    } else {
      final fences = [for (final m in RegExp('```').allMatches(p)) m.start];
      bool inFence(int i) => fences.where((f) => f < i).length.isOdd;
      for (final m in _end.allMatches(p)) {
        if (inFence(m.start)) continue;
        if (m.end == p.length && RegExp(r'^[.!?]').hasMatch(m[0]!) && !RegExp(r'\s$').hasMatch(m[0]!)) break;
        cut = m.end;
      }
      if (cut == 0 && p.length > max && fences.isEmpty) {
        final at = _lastBreak(p, max - 1, cjkComma: false);
        if (at > 40) cut = at + 1;
      }
    }
    if (cut == 0) return const [];
    _at += cut;
    return sentences(speakable(p.substring(0, cut), codeWord: codeWord), isFinal: true, max: max).out;
  }
}

/// The language a piece is written in, by script — enough to pick a voice that can say it:
/// 'zh' / 'ja' / 'ko' / 'ru', or '' for anything else.
String scriptOf(String text) {
  if (RegExp(r'[぀-ヿ]').hasMatch(text)) return 'ja';
  if (RegExp(r'[가-힯]').hasMatch(text)) return 'ko';
  if (RegExp(r'[一-鿿]').hasMatch(text)) return 'zh';
  if (RegExp(r'[Ѐ-ӿ]').hasMatch(text)) return 'ru';
  return '';
}

// ── Cutting in on a call (web/voice.mjs has the same rules) ──
// The agent's own voice comes back through the microphone and is transcribed like any other, so what
// is heard is compared with what was said in the last half minute: mostly the same words = echo.
// Words for spaced scripts; pairs of characters for Chinese / Japanese / Korean.
final _cjk = RegExp(r'[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]', unicode: true);
final _run = RegExp(r'[\p{L}\p{N}]+', unicode: true);

List<String> tokens(String text) {
  final out = <String>[];
  for (final m in _run.allMatches(text.toLowerCase())) {
    final run = m[0]!;
    if (!_cjk.hasMatch(run)) {
      out.add(run);
      continue;
    }
    final chars = run.runes.map(String.fromCharCode).toList();
    if (chars.length == 1) out.add(run);
    for (var i = 0; i + 1 < chars.length; i++) {
      out.add(chars[i] + chars[i + 1]);
    }
  }
  return out;
}

/// How much was said: spaced words, plus CJK characters counted two to a word.
double wordCount(String text) {
  var n = 0.0;
  for (final m in _run.allMatches(text)) {
    n += _cjk.hasMatch(m[0]!) ? m[0]!.runes.length / 2 : 1;
  }
  return n;
}

class SpokenMemory {
  SpokenMemory({this.keepMs = 30000});
  final int keepMs;
  final _items = <({int at, Set<String> words})>[];

  void add(String text, {int? now}) {
    _items.add((at: now ?? DateTime.now().millisecondsSinceEpoch, words: tokens(text).toSet()));
    _prune(now);
  }

  void clear() => _items.clear();

  void _prune(int? now) {
    final t = now ?? DateTime.now().millisecondsSinceEpoch;
    _items.removeWhere((x) => t - x.at >= keepMs);
  }

  /// The share of what was heard that the agent itself said lately (0–1).
  double echoShare(String text, {int? now}) {
    _prune(now);
    final heard = tokens(text);
    if (heard.isEmpty || _items.isEmpty) return 0;
    return heard.where((w) => _items.any((x) => x.words.contains(w))).length / heard.length;
  }

  bool isEcho(String text, {double ratio = 0.6, int? now}) => echoShare(text, now: now) >= ratio;
}

const _interrupt = {'stop', 'wait', 'hold on', 'hang on', 'pause', 'no', 'enough',
  '停', '停下', '停一下', '等等', '等一下', '别说了', '不对', '暂停', '好了', '够了'};
String _clean(String t) =>
    t.toLowerCase().replaceAll(RegExp(r'[^\p{L}\p{N}\s]+', unicode: true), ' ').trim().replaceAll(RegExp(r'\s+'), ' ');

/// Heard while the agent speaks — does it cut in? A sentence that isn't its own voice coming back
/// (while it plays, a lower share already counts as echo), or one interruption word.
bool isBargeIn(String text, SpokenMemory? memory, {int? now}) {
  final c = _clean(text);
  if (c.isEmpty || (memory?.isEcho(c, ratio: 0.4, now: now) ?? false)) return false;
  return wordCount(c) >= 2 || _interrupt.contains(c);
}

/// The same for a transcript still being revised: never on one word, which may yet change.
bool isInterimBargeIn(String text, SpokenMemory? memory, {int? now}) {
  final c = _clean(text);
  return c.isNotEmpty && wordCount(c) >= 2 && !(memory?.isEcho(c, ratio: 0.4, now: now) ?? false);
}

/// How long an interim must keep counting as cutting in before playback stops.
const interimBargeInMs = 300;

/// Each agent's own pitch and pace on a device voice, from its id — so in a group you hear who
/// is speaking. The same numbers as the web gives the same agent (FNV-1a over the code points).
({double pitch, double rate}) deviceTone(String? agentId) {
  var h = 0x811c9dc5;
  for (final c in (agentId ?? '').runes) {
    h ^= c;
    h = (h * 0x01000193) & 0xffffffff;
  }
  double r3(double x) => double.parse(x.toStringAsFixed(3));
  return (pitch: r3(0.85 + (h % 13) * 0.025), rate: r3(0.94 + ((h >> 8) % 5) * 0.03));
}
