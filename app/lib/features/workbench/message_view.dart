/// Painting one transcript entry.
///
/// The parsing is in `data/markup.dart` and is pure; this file only decides
/// what the three span kinds look like. Keeping them apart is what makes the
/// `@name` rule testable without a window.
library;

import 'package:flutter/material.dart';

import '../../data/api.dart';
import '../../data/markup.dart';
import '../../l10n.dart';
import '../../state/workbench.dart';
import '../../theme/app_theme.dart';

/// A round initial. Same idea as the web UI's avatars — a colour and a
/// character is enough to tell four colleagues apart at a glance.
class Avatar extends StatelessWidget {
  const Avatar({super.key, required this.label, required this.color, this.size = 26});

  final String label;
  final Color color;
  final double size;

  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    alignment: Alignment.center,
    decoration: BoxDecoration(color: color, shape: BoxShape.circle),
    child: Text(
      label.isEmpty ? '?' : label.characters.first,
      style: TextStyle(
        fontSize: size * 0.42,
        fontWeight: FontWeight.w600,
        color: Colors.white,
        fontFamilyFallback: AppTheme.textFallback,
      ),
    ),
  );
}

/// Stacked member avatars with a `+N`, so a group row says who is in it
/// without being opened.
class GroupAvatar extends StatelessWidget {
  const GroupAvatar({super.key, required this.colors, required this.count});

  final List<Color> colors;
  final int count;

  @override
  Widget build(BuildContext context) {
    final shown = colors.take(3).toList();
    return SizedBox(
      width: 34,
      height: 34,
      child: Stack(
        children: [
          for (var i = 0; i < shown.length; i++)
            Positioned(
              left: i * 9,
              top: i.isOdd ? 12 : 0,
              child: Container(
                width: 16,
                height: 16,
                decoration: BoxDecoration(color: shown[i], shape: BoxShape.circle),
              ),
            ),
          if (count > 3)
            Positioned(
              right: 0,
              bottom: 0,
              child: Text('+${count - 3}', style: TextStyle(fontSize: 9, color: C.dim)),
            ),
        ],
      ),
    );
  }
}

class EntryView extends StatelessWidget {
  const EntryView({
    super.key,
    required this.entry,
    required this.names,
    required this.colorOf,
    this.onApprove,
    this.onSecret,
    this.news,
    this.files,
    this.onRead,
    this.reading = false,
  });

  final Entry entry;

  /// Read an agent's message aloud (where this device can speak); [reading] = it is being read now.
  final void Function(Said said)? onRead;
  final bool reading;

  /// Answer an agent's request for a credential: the value, or null for no.
  final void Function(Ran card, String? value)? onSecret;
  final List<String> names;

  /// Answer a tool call that is waiting for a person. Null where nothing can wait.
  final void Function(Ran card, bool ok, bool always)? onApprove;

  /// Agent name → colour, for the `@name` pills.
  final Color Function(String name) colorOf;

  /// Draws task news. It needs the workbench (to answer a task), which this file doesn't.
  final Widget Function(News n)? news;

  /// Draws a message's files. It needs the Api (to fetch them), which this file doesn't.
  final Widget Function(List<Attachment> files, bool mine)? files;

  @override
  Widget build(BuildContext context) => switch (entry) {
    Note n => Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Center(
        child: Text(
          n.text,
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 11.5, color: C.dim2),
        ),
      ),
    ),
    Ran r => _ToolCard(r, onApprove, onSecret),
    News n => news?.call(n) ?? const SizedBox.shrink(),
    Said s => _Bubble(said: s, names: names, colorOf: colorOf, files: files, onRead: onRead, reading: reading),
    SentFile f => _SentFile(sent: f, files: files),
  };
}

class _Bubble extends StatelessWidget {
  const _Bubble({required this.said, required this.names, required this.colorOf, this.files, this.onRead, this.reading = false});

  final Said said;
  final List<String> names;
  final Color Function(String) colorOf;
  final Widget Function(List<Attachment> files, bool mine)? files;
  final void Function(Said said)? onRead;
  final bool reading;

  @override
  Widget build(BuildContext context) {
    final colour = said.mine ? C.accent : C.parse(said.color);
    final avatar = Padding(
      padding: const EdgeInsets.only(top: 2),
      child: Avatar(label: said.mine ? tr('wb.you') : said.speaker, color: colour),
    );
    final body = Column(
      crossAxisAlignment: said.mine ? CrossAxisAlignment.end : CrossAxisAlignment.start,
      children: [
        if (!said.mine)
          Padding(
            padding: const EdgeInsets.only(bottom: 3, left: 2),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Flexible(
                  child: Text(
                    said.speaker,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 11.5, color: colour, fontWeight: FontWeight.w600),
                  ),
                ),
                if (onRead != null && said.text.isNotEmpty && !said.streaming)
                  Tooltip(
                    message: tr(reading ? 'vo.stopReading' : 'vo.readThis'),
                    child: InkWell(
                      onTap: () => onRead!(said),
                      borderRadius: BorderRadius.circular(6),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                        child: Icon(
                          reading ? Icons.stop_circle_outlined : Icons.volume_up_outlined,
                          size: 15,
                          color: reading ? C.accent : C.dim2,
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        // A message that is only files has no bubble, just the files.
        if (said.text.isNotEmpty || said.streaming || said.files.isEmpty)
          Container(
            constraints: const BoxConstraints(maxWidth: 720),
            padding: const EdgeInsets.fromLTRB(14, 10, 14, 11),
            decoration: BoxDecoration(
              color: said.mine ? C.bubbleMine : C.bubble,
              borderRadius: BorderRadius.circular(13),
            ),
            child: MessageBody(
              text: said.text.isEmpty && said.streaming ? '…' : said.text,
              names: names,
              colorOf: colorOf,
            ),
          ),
        if (said.files.isNotEmpty && files != null)
          Padding(
            padding: EdgeInsets.only(top: said.text.isEmpty ? 0 : 6),
            child: files!(said.files, said.mine),
          ),
      ],
    );

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7),
      child: Row(
        mainAxisAlignment: said.mine ? MainAxisAlignment.end : MainAxisAlignment.start,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: said.mine
            ? [Flexible(child: body), const SizedBox(width: 9), avatar]
            : [avatar, const SizedBox(width: 9), Flexible(child: body)],
      ),
    );
  }
}

/// Renders parsed blocks. Text is selectable — people copy what an Agent
/// produced, and a chat you cannot copy out of is a demo.
class MessageBody extends StatelessWidget {
  const MessageBody({super.key, required this.text, required this.names, required this.colorOf});

  final String text;
  final List<String> names;
  final Color Function(String) colorOf;

  @override
  Widget build(BuildContext context) {
    final blocks = parseMessage(text, names: names);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final b in blocks)
          switch (b) {
            CodeBlock c => Container(
              width: double.infinity,
              margin: const EdgeInsets.symmetric(vertical: 6),
              padding: const EdgeInsets.all(11),
              decoration: BoxDecoration(
                color: C.codeBlock,
                borderRadius: BorderRadius.circular(9),
                border: Border.all(color: C.codeBlockLine),
              ),
              child: SelectableText(
                c.code,
                style: TextStyle(
                  fontFamily: AppTheme.mono,
                  fontFamilyFallback: AppTheme.monoFallback,
                  fontSize: 12,
                  height: 1.5,
                  color: C.ink,
                ),
              ),
            ),
            Paragraph p => Padding(
              padding: const EdgeInsets.symmetric(vertical: 1),
              child: SelectableText.rich(
                TextSpan(children: [for (final s in p.spans) _span(s)]),
                style: TextStyle(fontSize: 14, height: 1.62, color: C.ink),
              ),
            ),
          },
      ],
    );
  }

  InlineSpan _span(Span s) => switch (s) {
    TextSpanPart t => TextSpan(
      text: t.text,
      style: TextStyle(fontFamilyFallback: AppTheme.textFallback),
    ),
    CodeSpan c => TextSpan(
      text: c.text,
      style: TextStyle(
        fontFamily: AppTheme.mono,
        fontFamilyFallback: AppTheme.monoFallback,
        fontSize: 12.5,
        color: C.code,
      ),
    ),
    // A mention is an event, so it gets a chip rather than coloured text.
    MentionSpan m => WidgetSpan(
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
              decoration: BoxDecoration(color: colorOf(m.name), shape: BoxShape.circle),
            ),
            const SizedBox(width: 5),
            Text(
              m.name,
              style: TextStyle(fontSize: 12.5, color: C.tintInk, fontFamilyFallback: AppTheme.textFallback),
            ),
          ],
        ),
      ),
    ),
  };
}

/// What an "always allow" answer would cover, said before anyone presses it: a risky pattern for
/// this agent, or ('') the whole tool with risky commands still asking.
String alwaysWhat(List<String> always) =>
    always.any((p) => p.isEmpty) ? tr('ap.alwaysTool') : tr('ap.alwaysPattern', {'what': always.join('  ')});

class _ToolCard extends StatelessWidget {
  const _ToolCard(this.ran, this.onApprove, this.onSecret);
  final Ran ran;
  final void Function(Ran card, bool ok, bool always)? onApprove;
  final void Function(Ran card, String? value)? onSecret;

  @override
  Widget build(BuildContext context) {
    final colour = C.parse(ran.color);
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.symmetric(vertical: 6),
      padding: const EdgeInsets.fromLTRB(12, 9, 12, 10),
      decoration: BoxDecoration(
        color: C.tool,
        borderRadius: BorderRadius.circular(10),
        // Waiting on a person is the one state worth shouting about, so it takes the border.
        border: Border.all(
          color: ran.approvalId != null
              ? C.warn
              : ran.running
              ? colour.withValues(alpha: 0.5)
              : C.line,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 8,
                height: 8,
                decoration: BoxDecoration(color: colour, shape: BoxShape.circle),
              ),
              const SizedBox(width: 7),
              Text(tr('wb.ran', {'name': ran.speaker}), style: TextStyle(fontSize: 11.5, color: C.dim)),
              const SizedBox(width: 7),
              Expanded(
                child: Text(
                  ran.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontFamily: AppTheme.mono,
                    fontFamilyFallback: AppTheme.monoFallback,
                    fontSize: 12,
                    color: C.warn,
                  ),
                ),
              ),
              if (ran.running)
                SizedBox(width: 11, height: 11, child: CircularProgressIndicator(strokeWidth: 1.6, color: C.dim)),
            ],
          ),
          if (ran.image != null) ...[
            const SizedBox(height: 8),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 520),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(8),
                child: Image.memory(ran.image!, gaplessPlayback: true),
              ),
            ),
          ],
          if (ran.secretAsk != null)
            _SecretAsk(key: ValueKey(ran.secretAsk!['id']), ask: ran.secretAsk!, onAnswer: onSecret == null ? null : (v) => onSecret!(ran, v))
          else if (ran.secretAnswer != null) ...[
            const SizedBox(height: 6),
            Text(
              ran.secretAnswer == 'saved'
                  ? tr('sec.saved')
                  : ran.secretAnswer == 'declined'
                  ? tr('sec.declined')
                  : ran.secretAnswer!,
              style: TextStyle(fontSize: 11.5, color: C.dim2),
            ),
          ],
          if (ran.approvalId != null) ...[
            const SizedBox(height: 8),
            Text(tr('ap.asks'), style: TextStyle(fontSize: 11.5, color: C.warn)),
            const SizedBox(height: 4),
            // A Wrap, not a Row: three buttons don't fit beside the label on a phone.
            Wrap(
              spacing: 6,
              runSpacing: 4,
              children: [
                TextButton(
                  onPressed: onApprove == null ? null : () => onApprove!(ran, false, false),
                  child: Text(tr('ap.deny')),
                ),
                FilledButton(
                  onPressed: onApprove == null ? null : () => onApprove!(ran, true, false),
                  child: Text(tr('ap.approve')),
                ),
                if (ran.always.isNotEmpty)
                  Tooltip(
                    message: alwaysWhat(ran.always),
                    child: OutlinedButton(
                      onPressed: onApprove == null ? null : () => onApprove!(ran, true, true),
                      child: Text(tr('ap.always')),
                    ),
                  ),
              ],
            ),
          ] else if (ran.approved != null) ...[
            const SizedBox(height: 6),
            Text(
              tr(ran.alwaysAllowed ? 'ap.alwaysDone' : ran.approved! ? 'ap.approved' : 'ap.denied'),
              style: TextStyle(fontSize: 11.5, color: ran.approved! ? C.dim2 : C.warn),
            ),
          ],
          if (ran.output.isNotEmpty) ...[
            const SizedBox(height: 8),
            SelectableText(
              ran.output,
              style: TextStyle(
                fontFamily: AppTheme.mono,
                fontFamilyFallback: AppTheme.monoFallback,
                fontSize: 11.5,
                height: 1.5,
                color: C.dim,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// A file an agent handed over: its avatar and name, then the file.
class _SentFile extends StatelessWidget {
  const _SentFile({required this.sent, this.files});

  final SentFile sent;
  final Widget Function(List<Attachment> files, bool mine)? files;

  @override
  Widget build(BuildContext context) {
    final colour = C.parse(sent.color);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Avatar(label: sent.speaker, color: colour),
          ),
          const SizedBox(width: 9),
          Flexible(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(bottom: 3, left: 2),
                  child: Text(
                    tr('att.sent', {'name': sent.speaker}),
                    style: TextStyle(fontSize: 11.5, color: colour, fontWeight: FontWeight.w600),
                  ),
                ),
                if (files != null) files!([sent.file], false),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// An agent asks for a credential: where it may be used and why, then a password field. What is typed
/// goes straight to the store — the agent hears only "saved" — so the field never shows it again.
class _SecretAsk extends StatefulWidget {
  const _SecretAsk({super.key, required this.ask, required this.onAnswer});
  final Map<String, Object?> ask;
  final void Function(String? value)? onAnswer;

  @override
  State<_SecretAsk> createState() => _SecretAskState();
}

class _SecretAskState extends State<_SecretAsk> {
  final _value = TextEditingController();

  @override
  void dispose() {
    _value.dispose();
    super.dispose();
  }

  void _save() {
    final v = _value.text;
    if (v.isEmpty) return;
    _value.clear();
    widget.onAnswer?.call(v);
  }

  @override
  Widget build(BuildContext context) {
    final a = widget.ask;
    final purpose = '${a['purpose'] ?? ''}';
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(tr('sec.asks', {'name': a['name'] ?? '', 'origin': a['origin'] ?? ''}), style: TextStyle(fontSize: 12, color: C.warn)),
          if (purpose.isNotEmpty) Text(purpose, style: const TextStyle(fontSize: 12.5)),
          const SizedBox(height: 6),
          TextField(
            controller: _value,
            obscureText: true,
            autocorrect: false,
            enableSuggestions: false,
            autofocus: true,
            onSubmitted: (_) => _save(),
            decoration: InputDecoration(
              isDense: true,
              hintText: tr(a['kind'] == 'login' ? 'sec.typePassword' : 'sec.typeValue'),
            ),
          ),
          const SizedBox(height: 6),
          Wrap(
            spacing: 6,
            children: [
              TextButton(onPressed: widget.onAnswer == null ? null : () => widget.onAnswer!(null), child: Text(tr('sec.decline'))),
              FilledButton(onPressed: widget.onAnswer == null ? null : _save, child: Text(tr('common.save'))),
            ],
          ),
        ],
      ),
    );
  }
}
