/// Files in the conversation: what was attached, what an agent sent, and the
/// ones picked for the next message. Images show in place; a tap on anything
/// else opens a preview — Markdown rendered, text as text — or, for PDF,
/// video, audio and the rest, the system's own app for that kind of file.
library;

import 'dart:io';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';

import '../../data/api.dart';
import '../../data/markdown.dart';
import '../../l10n.dart';
import '../../platform.dart';
import '../../state/workbench.dart';
import '../../theme/app_theme.dart';

IconData iconFor(String kind) => switch (kind) {
  'image' => Icons.image_outlined,
  'video' => Icons.movie_outlined,
  'audio' => Icons.audiotrack_outlined,
  'pdf' => Icons.picture_as_pdf_outlined,
  'markdown' => Icons.article_outlined,
  'text' => Icons.description_outlined,
  _ => Icons.insert_drive_file_outlined,
};

/// The files a message carries: images as thumbnails, the rest as chips.
class AttachmentList extends StatelessWidget {
  const AttachmentList({super.key, required this.api, required this.files, this.alignEnd = false});

  final Api api;
  final List<Attachment> files;
  final bool alignEnd;

  @override
  Widget build(BuildContext context) {
    final images = files.where((f) => f.isImage).toList();
    final others = files.where((f) => !f.isImage).toList();
    final align = alignEnd ? WrapAlignment.end : WrapAlignment.start;
    return Column(
      crossAxisAlignment: alignEnd ? CrossAxisAlignment.end : CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (images.isNotEmpty)
          Wrap(
            alignment: align,
            spacing: 6,
            runSpacing: 6,
            children: [for (final f in images) _Thumb(api: api, file: f)],
          ),
        if (images.isNotEmpty && others.isNotEmpty) const SizedBox(height: 6),
        if (others.isNotEmpty)
          Wrap(
            alignment: align,
            spacing: 6,
            runSpacing: 6,
            children: [for (final f in others) FileChip(api: api, file: f)],
          ),
      ],
    );
  }
}

class _Thumb extends StatelessWidget {
  const _Thumb({required this.api, required this.file});
  final Api api;
  final Attachment file;

  @override
  Widget build(BuildContext context) => Tooltip(
    message: '${file.name} · ${sizeText(file.size)}',
    child: InkWell(
      borderRadius: BorderRadius.circular(8),
      onTap: () => showPreview(context, api, file),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(8),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 240, maxHeight: 240, minWidth: 48, minHeight: 48),
          child: Image.network(
            api.fileUri(file.id).toString(),
            fit: BoxFit.cover,
            gaplessPlayback: true,
            // A broken image is still a file the person can open or save.
            errorBuilder: (_, _, _) => FileChip(api: api, file: file),
          ),
        ),
      ),
    ),
  );
}

/// One file as a chip: what kind, its name, its size. Tap to preview.
class FileChip extends StatelessWidget {
  const FileChip({super.key, required this.api, required this.file});
  final Api api;
  final Attachment file;

  @override
  Widget build(BuildContext context) => Material(
    color: C.tool,
    borderRadius: BorderRadius.circular(9),
    child: InkWell(
      borderRadius: BorderRadius.circular(9),
      onTap: () => showPreview(context, api, file),
      child: Container(
        constraints: const BoxConstraints(maxWidth: 260),
        padding: const EdgeInsets.fromLTRB(9, 7, 11, 7),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(9),
          border: Border.all(color: C.line),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(iconFor(file.kind), size: 18, color: C.tintInk),
            const SizedBox(width: 8),
            Flexible(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(file.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12.5)),
                  Text(sizeText(file.size), style: TextStyle(fontSize: 11, color: C.dim2)),
                ],
              ),
            ),
          ],
        ),
      ),
    ),
  );
}

/// Files picked for the next message, above the input: name, size or
/// progress, and × to take one back.
class PendingRow extends StatelessWidget {
  const PendingRow({super.key, required this.bench});
  final Workbench bench;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Wrap(
      spacing: 6,
      runSpacing: 6,
      children: [for (final p in bench.pending) _PendingChip(bench: bench, p: p)],
    ),
  );
}

class _PendingChip extends StatelessWidget {
  const _PendingChip({required this.bench, required this.p});
  final Workbench bench;
  final Pending p;

  @override
  Widget build(BuildContext context) {
    final failed = p.error != null;
    final sub = failed
        ? tr('att.failed', {'msg': p.error})
        : p.uploading
        ? tr('att.uploading', {'pct': (p.progress * 100).round()})
        : sizeText(p.size);
    return Container(
      constraints: const BoxConstraints(maxWidth: 240),
      padding: const EdgeInsets.fromLTRB(9, 5, 2, 5),
      decoration: BoxDecoration(
        color: C.tool,
        borderRadius: BorderRadius.circular(9),
        border: Border.all(color: failed ? C.bad : C.line),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(iconFor(p.attachment?.kind ?? _kindGuess(p.name)), size: 17, color: failed ? C.bad : C.tintInk),
          const SizedBox(width: 7),
          Flexible(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(p.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12.5)),
                Text(
                  sub,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 11, color: failed ? C.bad : C.dim2),
                ),
                if (p.uploading)
                  Padding(
                    padding: const EdgeInsets.only(top: 3),
                    child: SizedBox(
                      width: 120,
                      child: LinearProgressIndicator(value: p.progress, minHeight: 2, color: C.accent, backgroundColor: C.line),
                    ),
                  ),
              ],
            ),
          ),
          IconButton(
            tooltip: tr('att.remove'),
            visualDensity: VisualDensity.compact,
            iconSize: 15,
            constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
            padding: EdgeInsets.zero,
            onPressed: () => bench.removePending(p),
            icon: const Icon(Icons.close),
          ),
        ],
      ),
    );
  }
}

String _kindGuess(String name) {
  final m = mimeForName(name);
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m == 'application/pdf') return 'pdf';
  if (m == 'text/markdown') return 'markdown';
  if (m.startsWith('text/') || m == 'application/json') return 'text';
  return 'other';
}

// ---------- previews ----------

/// Open a file: images and text-like files in a preview; everything else
/// offered to the system's app for it. Every preview can be saved.
Future<void> showPreview(BuildContext context, Api api, Attachment file) => showDialog<void>(
  context: context,
  builder: (_) => file.isImage ? _ImageViewer(api: api, file: file) : _PreviewDialog(api: api, file: file),
);

class _ImageViewer extends StatelessWidget {
  const _ImageViewer({required this.api, required this.file});
  final Api api;
  final Attachment file;

  @override
  Widget build(BuildContext context) => Dialog(
    backgroundColor: C.bg,
    insetPadding: const EdgeInsets.all(24),
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        _Header(api: api, file: file),
        Flexible(
          child: InteractiveViewer(
            maxScale: 8,
            child: Image.network(
              api.fileUri(file.id).toString(),
              errorBuilder: (_, e, _) => Padding(
                padding: const EdgeInsets.all(24),
                child: Text(tr('att.loadFailed', {'msg': '$e'})),
              ),
            ),
          ),
        ),
      ],
    ),
  );
}

class _PreviewDialog extends StatelessWidget {
  const _PreviewDialog({required this.api, required this.file});
  final Api api;
  final Attachment file;

  bool get _textual => file.kind == 'text' || file.kind == 'markdown';

  @override
  Widget build(BuildContext context) {
    final size = MediaQuery.sizeOf(context);
    return Dialog(
      backgroundColor: C.bg,
      insetPadding: const EdgeInsets.all(24),
      child: SizedBox(
        width: _textual ? (size.width - 48).clamp(320, 860).toDouble() : 440,
        height: _textual ? (size.height - 48).clamp(240, 720).toDouble() : null,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _Header(api: api, file: file),
            if (_textual)
              Expanded(child: _TextBody(api: api, file: file))
            else
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 8, 20, 20),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(tr('att.noPreview'), style: TextStyle(color: C.dim)),
                    const SizedBox(height: 4),
                    Text(tr('att.openHint'), style: TextStyle(fontSize: 12, color: C.dim2)),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// Name, size, and what can be done with it.
class _Header extends StatefulWidget {
  const _Header({required this.api, required this.file});
  final Api api;
  final Attachment file;

  @override
  State<_Header> createState() => _HeaderState();
}

class _HeaderState extends State<_Header> {
  String? _status;
  bool _working = false;

  Future<void> _run(Future<String?> Function() f) async {
    if (_working) return;
    setState(() => _working = true);
    String? status;
    try {
      status = await f();
    } on ApiException catch (e) {
      status = tr('att.openFailed', {'msg': e.message});
    } catch (e) {
      status = tr('att.openFailed', {'msg': '$e'});
    }
    if (!mounted) return;
    setState(() {
      _working = false;
      _status = status;
    });
  }

  Future<String?> _saveAs() async {
    final where = await getSaveLocation(suggestedName: widget.file.name);
    if (where == null) return null;
    await widget.api.downloadFile(widget.file.id, where.path);
    return tr('att.saved', {'path': where.path});
  }

  Future<String?> _open() async {
    final path = await downloadToTemp(widget.api, widget.file);
    await openWithSystem(path);
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final f = widget.file;
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 12, 8, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Icon(iconFor(f.kind), size: 18, color: C.tintInk),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  '${f.name} · ${sizeText(f.size)}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontWeight: FontWeight.w600),
                ),
              ),
              if (_working)
                const Padding(
                  padding: EdgeInsets.symmetric(horizontal: 8),
                  child: SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 1.6)),
                ),
              TextButton(onPressed: () => _run(_open), child: Text(tr('att.open'))),
              TextButton(onPressed: () => _run(_saveAs), child: Text(tr('att.saveAs'))),
              IconButton(
                tooltip: tr('att.close'),
                onPressed: () => Navigator.of(context).pop(),
                icon: const Icon(Icons.close, size: 18),
              ),
            ],
          ),
          if (_status != null)
            Text(_status!, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12, color: C.dim)),
        ],
      ),
    );
  }
}

class _TextBody extends StatefulWidget {
  const _TextBody({required this.api, required this.file});
  final Api api;
  final Attachment file;

  @override
  State<_TextBody> createState() => _TextBodyState();
}

class _TextBodyState extends State<_TextBody> {
  late final Future<({String text, bool cut})> _load = widget.api.fileText(widget.file.id);

  @override
  Widget build(BuildContext context) => FutureBuilder(
    future: _load,
    builder: (context, snap) {
      if (snap.hasError) {
        final e = snap.error;
        return Padding(
          padding: const EdgeInsets.all(20),
          child: Text(tr('att.loadFailed', {'msg': e is ApiException ? e.message : '$e'})),
        );
      }
      final got = snap.data;
      if (got == null) return const Center(child: CircularProgressIndicator());
      return Container(
        margin: const EdgeInsets.fromLTRB(12, 0, 12, 12),
        decoration: BoxDecoration(
          color: C.panel,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: C.line),
        ),
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (widget.file.kind == 'markdown')
                MarkdownView(text: got.text)
              else
                SelectableText(
                  got.text,
                  style: TextStyle(
                    fontFamily: AppTheme.mono,
                    fontFamilyFallback: AppTheme.monoFallback,
                    fontSize: 12.5,
                    height: 1.5,
                    color: C.ink,
                  ),
                ),
              if (got.cut)
                Padding(
                  padding: const EdgeInsets.only(top: 10),
                  child: Text(tr('att.cut'), style: TextStyle(fontSize: 12, color: C.dim2)),
                ),
            ],
          ),
        ),
      );
    },
  );
}

/// Download a file into a temporary folder of its own, under its own name,
/// so the app that opens it shows the right name.
Future<String> downloadToTemp(Api api, Attachment f) async {
  final dir = await Directory.systemTemp.createTemp('cirrayabot-');
  final path = '${dir.path}${Platform.pathSeparator}${f.name.replaceAll(RegExp(r'[\\/:*?"<>|]'), '_')}';
  await api.downloadFile(f.id, path);
  return path;
}

/// Hand a file to the system's own app for it (AppPlatform.openCommand).
Future<void> openWithSystem(String path) async {
  final (cmd, args) = AppPlatform.openCommand(path);
  final r = await Process.run(cmd, args);
  if (r.exitCode != 0) throw Exception('${r.stderr}'.trim().isEmpty ? 'exit ${r.exitCode}' : '${r.stderr}'.trim());
}

// ---------- Markdown ----------

/// Draws what parseMarkdown read. Links are drawn as links but never followed
/// or fetched from here.
class MarkdownView extends StatelessWidget {
  const MarkdownView({super.key, required this.text});
  final String text;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [for (final b in parseMarkdown(text)) _block(b)],
  );

  TextStyle get _body => TextStyle(fontSize: 14, height: 1.6, color: C.ink, fontFamilyFallback: AppTheme.textFallback);

  Widget _rich(String s, {TextStyle? style}) => SelectableText.rich(
    TextSpan(
      style: style ?? _body,
      children: [
        for (final sp in parseInline(s))
          TextSpan(
            text: sp.text,
            style: TextStyle(
              fontWeight: sp.bold ? FontWeight.w700 : null,
              fontStyle: sp.italic ? FontStyle.italic : null,
              fontFamily: sp.code ? AppTheme.mono : null,
              fontFamilyFallback: sp.code ? AppTheme.monoFallback : null,
              color: sp.code ? C.code : (sp.link != null ? C.tintInk : null),
              decoration: sp.link != null ? TextDecoration.underline : null,
            ),
          ),
      ],
    ),
  );

  Widget _block(MdBlock b) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: switch (b) {
      MdHeading h => _rich(
        h.text,
        style: _body.copyWith(
          fontSize: const [22.0, 19.0, 16.5, 15.0, 14.0, 14.0][h.level - 1],
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
              padding: const EdgeInsets.only(bottom: 3),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 24,
                    child: l.items[i].checked != null
                        ? Icon(
                            l.items[i].checked! ? Icons.check_box_outlined : Icons.check_box_outline_blank,
                            size: 16,
                            color: C.dim,
                          )
                        : Text(l.ordered ? '${i + 1}.' : '•', style: _body.copyWith(color: C.dim)),
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
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: C.codeBlockLine),
        ),
        child: SelectableText(
          c.code,
          style: TextStyle(
            fontFamily: AppTheme.mono,
            fontFamilyFallback: AppTheme.monoFallback,
            fontSize: 12.5,
            height: 1.5,
            color: C.ink,
          ),
        ),
      ),
      MdQuote q => Container(
        padding: const EdgeInsets.only(left: 12),
        decoration: BoxDecoration(border: Border(left: BorderSide(color: C.line, width: 3))),
        child: DefaultTextStyle.merge(
          style: TextStyle(color: C.dim),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [for (final x in q.blocks) _block(x)]),
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
    },
  );
}
