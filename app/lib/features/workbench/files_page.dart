/// The files on an agent's machine — its desk (/work) and the group drives it has: browse folders,
/// open a file with this device's own app, put files from here into a folder there.
/// Everything goes through the server, which reaches the files from inside the agent's container.
library;

import 'dart:io';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';

import '../../data/api.dart';
import '../../l10n.dart';
import '../../platform.dart';
import '../../theme/app_theme.dart';

class FilesPage extends StatefulWidget {
  const FilesPage({super.key, required this.api, required this.agentId, required this.name});
  final Api api;
  final String agentId;
  final String name;

  @override
  State<FilesPage> createState() => _FilesPageState();
}

class _FilesPageState extends State<FilesPage> {
  String path = '/work';
  List<DeskEntry> entries = const [];
  bool loading = true;
  String error = '';

  /// The file being fetched or put, shown while it moves.
  String moving = '';

  @override
  void initState() {
    super.initState();
    _load('/work');
  }

  Future<void> _load(String p) async {
    setState(() => loading = true);
    try {
      final r = await widget.api.deskList(widget.agentId, p);
      if (!mounted) return;
      setState(() {
        path = r.path;
        entries = r.entries;
        error = '';
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => error = e.message);
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  void _say(String text) => ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(text)));

  Future<void> _open(DeskEntry e) async {
    final full = '$path/${e.name}';
    if (e.type == 'dir') return _load(full);
    if (e.type == 'link') {
      // A link may lead to a folder or a file: a folder if it lists.
      var folder = true;
      try {
        await widget.api.deskList(widget.agentId, full);
      } on ApiException {
        folder = false; // a file, then
      }
      if (folder) return _load(full);
    }
    setState(() => moving = e.name);
    try {
      await AppPlatform.downloadRoot.create(recursive: true);
      final dir = await AppPlatform.downloadRoot.createTemp('desk-');
      final local = File('${dir.path}${Platform.pathSeparator}${e.name.replaceAll(RegExp(r'[\\/:*?"<>|]'), '_')}');
      await widget.api.deskDownload(widget.agentId, full, local);
      await AppPlatform.openFile(local.path, mimeForName(e.name));
    } on ApiException catch (x) {
      _say(x.message);
    } catch (x) {
      _say(tr('df.cantOpen', {'detail': '$x'}));
    } finally {
      if (mounted) setState(() => moving = '');
    }
  }

  Future<void> _upload() async {
    final picked = await openFiles();
    if (picked.isEmpty) return;
    var n = 0;
    for (final f in picked) {
      setState(() => moving = f.name);
      try {
        await widget.api.deskUpload(widget.agentId, path, f.path);
        n++;
      } on ApiException catch (x) {
        _say(x.message);
      }
    }
    if (!mounted) return;
    setState(() => moving = '');
    if (n > 0) _say(tr('df.uploaded', {'n': n}));
    await _load(path);
  }

  String _size(int n) => n < 1024 ? '$n B' : n < 1048576 ? '${(n / 1024).toStringAsFixed(1)} KB' : '${(n / 1048576).toStringAsFixed(1)} MB';

  @override
  Widget build(BuildContext context) {
    final parts = path.split('/').where((p) => p.isNotEmpty).toList();
    return Scaffold(
      appBar: AppBar(
        backgroundColor: C.side,
        title: Text(tr('df.title', {'name': widget.name}), style: const TextStyle(fontSize: 15)),
        actions: [
          IconButton(tooltip: tr('df.upload'), onPressed: moving.isEmpty ? _upload : null, icon: const Icon(Icons.upload_file, size: 20)),
          IconButton(tooltip: tr('common.refresh'), onPressed: loading ? null : () => _load(path), icon: const Icon(Icons.refresh, size: 20)),
        ],
      ),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // /work/a/b → work › a › b, each a way back up
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.fromLTRB(8, 6, 8, 2),
            child: Row(
              children: [
                for (var i = 0; i < parts.length; i++) ...[
                  if (i > 0) Text('›', style: TextStyle(color: C.dim2)),
                  TextButton(
                    onPressed: loading ? null : () => _load('/${parts.sublist(0, i + 1).join('/')}'),
                    child: Text(parts[i], style: const TextStyle(fontSize: 13)),
                  ),
                ],
              ],
            ),
          ),
          if (moving.isNotEmpty) LinearProgressIndicator(minHeight: 2, color: C.accent),
          Expanded(
            child: loading && entries.isEmpty
                ? Center(child: CircularProgressIndicator(strokeWidth: 2, color: C.dim))
                : error.isNotEmpty
                ? Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(error, textAlign: TextAlign.center, style: TextStyle(color: C.dim))))
                : entries.isEmpty
                ? Center(child: Text(tr('df.empty'), style: TextStyle(color: C.dim2)))
                : ListView.builder(
                    itemCount: entries.length,
                    itemBuilder: (_, i) {
                      final e = entries[i];
                      return ListTile(
                        key: ValueKey('desk-${e.name}'),
                        dense: true,
                        leading: Icon(
                          e.type == 'dir' ? Icons.folder_outlined : e.type == 'link' ? Icons.link : Icons.insert_drive_file_outlined,
                          size: 20,
                          color: e.type == 'dir' ? C.accent : C.dim,
                        ),
                        title: Text(e.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13.5)),
                        trailing: e.type == 'file' ? Text(_size(e.size), style: TextStyle(fontSize: 11.5, color: C.dim2)) : null,
                        onTap: moving.isEmpty ? () => _open(e) : null,
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }
}
