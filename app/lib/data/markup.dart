/// What a message looks like, before anyone decides how to paint it.
///
/// Three things earn special rendering and nothing else does: fenced code
/// blocks (the Agents paste commands), inline code (technical talk is all
/// slugs and field names), and `@name` (a handoff is a visible event in the
/// group, not a word in a sentence).
///
/// Deliberately not a Markdown renderer. The Agents' output is untrusted text
/// that we display in our own window — the smaller the grammar, the smaller
/// the surface. Bold and headings can wait until someone misses them.
library;

sealed class Block {
  const Block();
}

/// A fenced block. [language] is whatever followed the opening fence, possibly
/// empty.
class CodeBlock extends Block {
  const CodeBlock(this.language, this.code);
  final String language;
  final String code;
}

class Paragraph extends Block {
  const Paragraph(this.spans);
  final List<Span> spans;
}

sealed class Span {
  const Span();
}

class TextSpanPart extends Span {
  const TextSpanPart(this.text);
  final String text;
}

class CodeSpan extends Span {
  const CodeSpan(this.text);
  final String text;
}

/// `@name`. Carries the name as written so the caller can look up the colour;
/// an unknown name never becomes a mention in the first place.
class MentionSpan extends Span {
  const MentionSpan(this.name);
  final String name;
}

final _fence = RegExp(r'```([^\n`]*)\n([\s\S]*?)```', multiLine: true);
final _inline = RegExp(r'`([^`\n]{1,200})`');

/// Splits [text] into blocks. [names] are the Agent names that may appear as
/// mentions — matching against the real roster rather than a generic `@\w+`
/// pattern is what makes Chinese names work at all.
List<Block> parseMessage(String text, {List<String> names = const []}) {
  final blocks = <Block>[];
  var cursor = 0;

  void flush(String chunk) {
    final trimmed = chunk.trim();
    if (trimmed.isEmpty) return;
    blocks.add(Paragraph(_spans(trimmed, names)));
  }

  for (final m in _fence.allMatches(text)) {
    flush(text.substring(cursor, m.start));
    blocks.add(CodeBlock((m.group(1) ?? '').trim(), (m.group(2) ?? '').trimRight()));
    cursor = m.end;
  }
  flush(text.substring(cursor));
  return blocks;
}

List<Span> _spans(String text, List<String> names) {
  // Longest name first, so "Lin2" is not eaten by "Lin".
  final sorted = [...names]..sort((a, b) => b.length.compareTo(a.length));

  final marks = <({int start, int end, Span span})>[];
  for (final m in _inline.allMatches(text)) {
    marks.add((start: m.start, end: m.end, span: CodeSpan(m.group(1)!)));
  }
  for (final name in sorted) {
    if (name.isEmpty) continue;
    // ⚠️ No \b after the name. Word boundaries are defined over [A-Za-z0-9_],
    // so a Chinese name has no boundary after it and would never match — and
    // Chinese names are the main case. The server's findMention has the same
    // note for the same reason; if one side changes, handoffs stop rendering
    // as pills while still working, which reads like a UI bug.
    final re = RegExp('@\\s*${RegExp.escape(name)}', caseSensitive: false);
    for (final m in re.allMatches(text)) {
      final overlaps = marks.any((k) => m.start < k.end && k.start < m.end);
      if (!overlaps) marks.add((start: m.start, end: m.end, span: MentionSpan(name)));
    }
  }
  marks.sort((a, b) => a.start.compareTo(b.start));

  final out = <Span>[];
  var at = 0;
  for (final k in marks) {
    if (k.start < at) continue;
    if (k.start > at) out.add(TextSpanPart(text.substring(at, k.start)));
    out.add(k.span);
    at = k.end;
  }
  if (at < text.length) out.add(TextSpanPart(text.substring(at)));
  return out;
}
