/// Draws what parseMarkdown read: an agent's message in a bubble (`chat: true`), or a Markdown file in its preview.
/// Links are drawn as links but never followed or fetched from here; images aren't drawn at all.
library;

import 'package:flutter/material.dart';

import '../../data/markdown.dart';
import '../../theme/app_theme.dart';

class MarkdownView extends StatelessWidget {
  const MarkdownView({
    super.key,
    required this.text,
    this.names = const [],
    this.colorOf,
    this.chat = false,
  });

  final String text;

  /// Agents that may be mentioned (`@name` drawn as a chip), and the colour of each.
  final List<String> names;
  final Color Function(String)? colorOf;

  /// In a chat bubble: the bubble's type size, tighter blocks, smaller headings, a code block's language on top.
  final bool chat;

  @override
  Widget build(BuildContext context) {
    final blocks = parseMarkdown(text);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (var i = 0; i < blocks.length; i++)
          Padding(
            // The last block of a bubble adds no space under itself: the bubble has its own padding.
            padding: EdgeInsets.only(bottom: i == blocks.length - 1 && chat ? 0 : _gap),
            child: _block(blocks[i]),
          ),
      ],
    );
  }

  double get _gap => chat ? 7 : 10;

  TextStyle get _body => TextStyle(
    fontSize: 14,
    height: chat ? 1.62 : 1.6,
    color: C.ink,
    fontFamilyFallback: AppTheme.textFallback,
  );

  Widget _rich(String s, {TextStyle? style}) => SelectableText.rich(
    TextSpan(
      style: style ?? _body,
      children: [for (final sp in parseInline(s, names: names)) _span(sp)],
    ),
  );

  InlineSpan _span(MdSpan sp) {
    if (sp.mention != null) return _mention(sp.mention!);
    return TextSpan(
      text: sp.text,
      style: TextStyle(
        fontWeight: sp.bold ? FontWeight.w700 : null,
        fontStyle: sp.italic ? FontStyle.italic : null,
        fontFamily: sp.code ? AppTheme.mono : null,
        fontFamilyFallback: sp.code ? AppTheme.monoFallback : null,
        fontSize: sp.code && chat ? 12.5 : null,
        color: sp.code ? C.code : (sp.link != null ? C.tintInk : null),
        decoration: sp.link != null ? TextDecoration.underline : null,
      ),
    );
  }

  // A mention is an event, so it gets a chip rather than coloured text.
  InlineSpan _mention(String name) => WidgetSpan(
    alignment: PlaceholderAlignment.middle,
    child: Container(
      margin: const EdgeInsets.symmetric(horizontal: 1),
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(color: C.tint, borderRadius: BorderRadius.circular(6)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(color: colorOf?.call(name) ?? C.dim, shape: BoxShape.circle),
          ),
          const SizedBox(width: 5),
          Text(
            name,
            style: TextStyle(fontSize: 12.5, color: C.tintInk, fontFamilyFallback: AppTheme.textFallback),
          ),
        ],
      ),
    ),
  );

  Widget _block(MdBlock b) => switch (b) {
    MdHeading h => _rich(
      h.text,
      style: _body.copyWith(
        fontSize: (chat ? const [17.0, 16.0, 15.0, 14.5, 14.0, 14.0] : const [22.0, 19.0, 16.5, 15.0, 14.0, 14.0])[h.level - 1],
        fontWeight: FontWeight.w700,
        height: 1.35,
      ),
    ),
    MdParagraph p => _rich(p.text),
    MdList l => Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (var i = 0; i < l.items.length; i++)
          Padding(
            padding: EdgeInsets.only(bottom: 3, left: 18.0 * l.items[i].level),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: l.ordered ? 26 : 18,
                  child: l.items[i].checked != null
                      ? Padding(
                          padding: const EdgeInsets.only(top: 3),
                          child: Icon(
                            l.items[i].checked! ? Icons.check_box_outlined : Icons.check_box_outline_blank,
                            size: 16,
                            color: C.dim,
                          ),
                        )
                      : Text(
                          l.ordered ? '${l.start + i}.' : (l.items[i].level == 0 ? '•' : '◦'),
                          style: _body.copyWith(color: C.dim),
                        ),
                ),
                Expanded(child: _rich(l.items[i].text)),
              ],
            ),
          ),
      ],
    ),
    MdCode c => Container(
      width: double.infinity,
      padding: const EdgeInsets.all(11),
      decoration: BoxDecoration(
        color: C.codeBlock,
        borderRadius: BorderRadius.circular(chat ? 9 : 8),
        border: Border.all(color: C.codeBlockLine),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (chat && c.lang.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 5),
              child: Text(
                c.lang.toUpperCase(),
                style: TextStyle(fontSize: 10.5, color: C.dim2, letterSpacing: 0.5, fontWeight: FontWeight.w500),
              ),
            ),
          SelectableText(
            c.code,
            style: TextStyle(
              fontFamily: AppTheme.mono,
              fontFamilyFallback: AppTheme.monoFallback,
              fontSize: chat ? 12 : 12.5,
              height: 1.5,
              color: C.ink,
            ),
          ),
        ],
      ),
    ),
    MdQuote q => Container(
      padding: const EdgeInsets.only(left: 12),
      decoration: BoxDecoration(border: Border(left: BorderSide(color: C.line, width: 3))),
      child: DefaultTextStyle.merge(
        style: TextStyle(color: C.dim),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (final x in q.blocks)
              Padding(padding: EdgeInsets.only(bottom: _gap), child: _block(x)),
          ],
        ),
      ),
    ),
    MdRule _ => Divider(color: C.line, height: 12),
    MdTable t => SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Table(
        defaultColumnWidth: const IntrinsicColumnWidth(),
        border: TableBorder.all(color: C.line),
        children: [
          TableRow(
            decoration: BoxDecoration(color: C.panel),
            children: [
              for (final h in t.header)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
                  child: _rich(h, style: _body.copyWith(fontWeight: FontWeight.w600)),
                ),
            ],
          ),
          for (final r in t.rows)
            TableRow(
              children: [
                // A short row is padded, a long one cut: Table needs every row the same width.
                for (var i = 0; i < t.header.length; i++)
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
                    child: _rich(i < r.length ? r[i] : ''),
                  ),
              ],
            ),
        ],
      ),
    ),
  };
}
