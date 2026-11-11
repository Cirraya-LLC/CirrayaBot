/// A small Markdown reader for agents' messages and file previews: headings,
/// paragraphs, lists (with task boxes), fenced code, quotes, rules, tables, and
/// inline bold / italic / code / links, plus `@name` mentions in a message.
/// Pure — the widget that draws it is features/workbench/markdown_view.dart.
/// Same coverage as the web (web/markdown.mjs, change both): small on purpose,
/// and it never fetches anything a text points at.
library;

sealed class MdBlock {
  const MdBlock();
}

class MdHeading extends MdBlock {
  const MdHeading(this.level, this.text);
  final int level;
  final String text;
}

class MdParagraph extends MdBlock {
  const MdParagraph(this.text);
  final String text;
}

class MdItem {
  const MdItem(this.text, {this.checked, this.level = 0});
  final String text;

  /// null = not a task item; true / false = a ticked / unticked box.
  final bool? checked;

  /// How far it is nested: two spaces (or a tab) a level, three at most. Drawn indented in the same list.
  final int level;
}

class MdList extends MdBlock {
  const MdList(this.items, {this.ordered = false, this.start = 1});
  final List<MdItem> items;
  final bool ordered;

  /// The first number. Models write "1. …", a blank line, "2. …": each is a list of its own and keeps its number.
  final int start;
}

class MdCode extends MdBlock {
  const MdCode(this.code, {this.lang = ''});
  final String code;
  final String lang;
}

class MdQuote extends MdBlock {
  const MdQuote(this.blocks);
  final List<MdBlock> blocks;
}

class MdRule extends MdBlock {
  const MdRule();
}

class MdTable extends MdBlock {
  const MdTable(this.header, this.rows);
  final List<String> header;
  final List<List<String>> rows;
}

final _fence = RegExp(r'^\s*```');
final _heading = RegExp(r'^(#{1,6})\s+(.*)$');
final _rule = RegExp(r'^\s*([-*_])(\s*\1){2,}\s*$');
final _quote = RegExp(r'^\s*>\s?');
final _item = RegExp(r'^(\s*)([-*+]|\d+[.)])\s+');
final _task = RegExp(r'^\[([ xX])\]\s+');
final _tableSep = RegExp(r'^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$');

/// A table starts here: a row with `|` and a separator line under it.
bool _tableAt(List<String> lines, int i) =>
    lines[i].contains('|') && i + 1 < lines.length && _tableSep.hasMatch(lines[i + 1]);

List<String> _cells(String l) {
  var t = l.trim();
  if (t.startsWith('|')) t = t.substring(1);
  if (t.endsWith('|')) t = t.substring(0, t.length - 1);
  return t.split('|').map((c) => c.trim()).toList();
}

List<MdBlock> parseMarkdown(String src) {
  final lines = src.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  final out = <MdBlock>[];
  var i = 0;
  while (i < lines.length) {
    final l = lines[i];
    if (_fence.hasMatch(l)) {
      final lang = l.trim().substring(3).trim();
      final body = <String>[];
      for (i++; i < lines.length && !_fence.hasMatch(lines[i]); i++) {
        body.add(lines[i]);
      }
      i++;
      out.add(MdCode(body.join('\n'), lang: lang));
    } else if (l.trim().isEmpty) {
      i++;
    } else if (_heading.firstMatch(l) case final m?) {
      out.add(MdHeading(m.group(1)!.length, m.group(2)!.trim()));
      i++;
    } else if (_rule.hasMatch(l)) {
      out.add(const MdRule());
      i++;
    } else if (_quote.hasMatch(l)) {
      final body = <String>[];
      for (; i < lines.length && _quote.hasMatch(lines[i]); i++) {
        body.add(lines[i].replaceFirst(_quote, ''));
      }
      out.add(MdQuote(parseMarkdown(body.join('\n'))));
    } else if (_item.firstMatch(l) case final first?) {
      final ordered = RegExp(r'\d').hasMatch(first.group(2)!);
      final start = ordered ? int.tryParse(first.group(2)!.substring(0, first.group(2)!.length - 1)) ?? 1 : 1;
      final items = <MdItem>[];
      for (; i < lines.length && _item.hasMatch(lines[i]); i++) {
        final m = _item.firstMatch(lines[i])!;
        final t = lines[i].substring(m.end);
        final level = (m.group(1)!.replaceAll('\t', '  ').length ~/ 2).clamp(0, 3);
        final task = _task.firstMatch(t);
        items.add(
          task == null
              ? MdItem(t, level: level)
              : MdItem(t.substring(task.end), checked: task.group(1) != ' ', level: level),
        );
      }
      out.add(MdList(items, ordered: ordered, start: start));
    } else if (_tableAt(lines, i)) {
      final head = _cells(l);
      i += 2;
      final rows = <List<String>>[];
      for (; i < lines.length && lines[i].contains('|') && lines[i].trim().isNotEmpty; i++) {
        rows.add(_cells(lines[i]));
      }
      out.add(MdTable(head, rows));
    } else {
      final body = <String>[];
      for (;
          i < lines.length &&
              lines[i].trim().isNotEmpty &&
              !_fence.hasMatch(lines[i]) &&
              !_heading.hasMatch(lines[i]) &&
              !_quote.hasMatch(lines[i]) &&
              !_item.hasMatch(lines[i]) &&
              !(body.isNotEmpty && _tableAt(lines, i));
          i++) {
        body.add(lines[i]);
      }
      out.add(MdParagraph(body.join('\n')));
    }
  }
  return out;
}

/// One run of inline text and how it looks.
class MdSpan {
  const MdSpan(this.text, {this.bold = false, this.italic = false, this.code = false, this.link, this.mention});
  final String text;
  final bool bold;
  final bool italic;
  final bool code;

  /// Set for a link (http/https only); the text is drawn, nothing is fetched.
  final String? link;

  /// Set for `@name` of an agent in the roster: the name as the roster has it (drawn as a chip).
  final String? mention;

  @override
  String toString() =>
      '${code ? '`' : ''}${bold ? '**' : ''}${italic ? '_' : ''}$text${link != null ? '<$link>' : ''}';
}

final _inline = RegExp(
  r'`([^`]+)`' // code
  r'|\[([^\]]+)\]\((https?://[^\s)]+)\)' // link
  r'|\*\*([^*]+)\*\*|__([^_]+)__' // bold
  r'|(?<![*\w])\*([^*\s][^*]*)\*(?!\w)' // italic
  r'|~~([^~]+)~~', // strike, drawn plain
);

/// [names] are the agents that may be mentioned: `@name` in plain, bold or italic text becomes a mention,
/// never inside code or a link. Longest name first, so "Lin2" is not eaten by "Lin".
List<MdSpan> parseInline(String text, {List<String> names = const []}) {
  final spans = _inlineSpans(text);
  if (names.every((n) => n.isEmpty)) return spans;
  final sorted = [...names.where((n) => n.isNotEmpty)]..sort((a, b) => b.length.compareTo(a.length));
  // ⚠️ No \b after the name: a Chinese name has no word boundary after it (see markup.dart).
  final re = RegExp(sorted.map((n) => '@\\s*${RegExp.escape(n)}').join('|'), caseSensitive: false);
  final out = <MdSpan>[];
  for (final s in spans) {
    if (s.code || s.link != null) {
      out.add(s);
      continue;
    }
    var at = 0;
    for (final m in re.allMatches(s.text)) {
      if (m.start > at) out.add(MdSpan(s.text.substring(at, m.start), bold: s.bold, italic: s.italic));
      final said = m.group(0)!.replaceFirst(RegExp(r'^@\s*'), '').toLowerCase();
      out.add(MdSpan(m.group(0)!, mention: sorted.firstWhere((n) => n.toLowerCase() == said)));
      at = m.end;
    }
    if (at < s.text.length) out.add(at == 0 ? s : MdSpan(s.text.substring(at), bold: s.bold, italic: s.italic));
  }
  return out;
}

List<MdSpan> _inlineSpans(String text) {
  final out = <MdSpan>[];
  var at = 0;
  for (final m in _inline.allMatches(text)) {
    if (m.start > at) out.add(MdSpan(text.substring(at, m.start)));
    if (m.group(1) != null) {
      out.add(MdSpan(m.group(1)!, code: true));
    } else if (m.group(2) != null) {
      out.add(MdSpan(m.group(2)!, link: m.group(3)));
    } else if (m.group(4) != null || m.group(5) != null) {
      out.add(MdSpan(m.group(4) ?? m.group(5)!, bold: true));
    } else if (m.group(6) != null) {
      out.add(MdSpan(m.group(6)!, italic: true));
    } else {
      out.add(MdSpan(m.group(7)!));
    }
    at = m.end;
  }
  if (at < text.length) out.add(MdSpan(text.substring(at)));
  return out;
}
