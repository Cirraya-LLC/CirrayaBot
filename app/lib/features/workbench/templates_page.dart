/// Start a new Agent from a template: the shipped ones, or a file exported from another CirrayaBot.
/// Picking one opens the editor with everything filled in but the model.
library;

import 'dart:convert';
import 'dart:io';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';

import '../../data/api.dart';
import '../../l10n.dart';
import '../../state/workbench.dart';
import '../../theme/app_theme.dart';
import 'editors.dart';

/// Shows the gallery; returns once an Agent was made from one (or the page was left).
Future<void> showTemplates(BuildContext context, Workbench bench) async {
  final picked = await Navigator.of(context).push<AgentTemplate>(
    MaterialPageRoute(builder: (_) => TemplatesPage(api: bench.api)),
  );
  if (picked != null && context.mounted) await showAgentEditor(context, bench, template: picked);
}

class TemplatesPage extends StatefulWidget {
  const TemplatesPage({super.key, required this.api, this.debugLoad});
  final Api api;

  /// Tests: the list instead of asking the server.
  final Future<List<AgentTemplate>> Function()? debugLoad;

  @override
  State<TemplatesPage> createState() => _TemplatesPageState();
}

class _TemplatesPageState extends State<TemplatesPage> {
  List<AgentTemplate>? _list;
  String _error = '';

  @override
  void initState() {
    super.initState();
    (widget.debugLoad ?? () async => (await widget.api.templates()).agents)().then((l) {
      if (mounted) setState(() => _list = l);
    }, onError: (Object e) {
      if (mounted) setState(() => _error = e is ApiException ? e.message : '$e');
    });
  }

  Future<void> _import() async {
    final f = await openFile(acceptedTypeGroups: const [templateFiles]);
    if (f == null || !mounted) return;
    try {
      final doc = jsonDecode(await File(f.path).readAsString());
      final t = await widget.api.checkTemplate(doc);
      if (mounted) Navigator.of(context).pop(t);
    } on FormatException {
      setState(() => _error = tr('tpl.notJson'));
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } on FileSystemException catch (e) {
      setState(() => _error = e.osError?.message ?? e.message);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      backgroundColor: C.side,
      title: Text(tr('tpl.title'), style: const TextStyle(fontSize: 15)),
      actions: [
        TextButton.icon(
          key: const ValueKey('tpl-import'),
          onPressed: _import,
          icon: const Icon(Icons.file_open_outlined, size: 18),
          label: Text(tr('tpl.importFile')),
        ),
      ],
    ),
    body: _list == null
        ? Center(
            child: _error.isNotEmpty
                ? Text(_error, style: TextStyle(color: C.dim))
                : CircularProgressIndicator(strokeWidth: 2, color: C.dim),
          )
        : ListView(
            padding: const EdgeInsets.all(14),
            children: [
              Text(tr('tpl.intro'), style: TextStyle(fontSize: 12.5, color: C.dim, height: 1.5)),
              if (_error.isNotEmpty) Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(_error, style: TextStyle(fontSize: 12, color: C.code)),
              ),
              const SizedBox(height: 10),
              for (final t in _list!)
                Card(
                  key: ValueKey('tpl-${t.id}'),
                  margin: const EdgeInsets.only(bottom: 8),
                  color: C.field,
                  child: InkWell(
                    borderRadius: BorderRadius.circular(12),
                    onTap: () => Navigator.of(context).pop(t),
                    child: Padding(
                      padding: const EdgeInsets.all(12),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(t.name, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
                          const SizedBox(height: 3),
                          Text(t.description, style: TextStyle(fontSize: 12.5, color: C.dim)),
                          const SizedBox(height: 6),
                          Wrap(
                            spacing: 5,
                            runSpacing: 4,
                            children: [
                              for (final x in [...t.skills.map((k) => k.name), if (t.setup.isNotEmpty) tr('tpl.hasSetup')])
                                Container(
                                  padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                                  decoration: BoxDecoration(color: C.chip, borderRadius: BorderRadius.circular(99)),
                                  child: Text(x, style: TextStyle(fontSize: 10.5, color: C.dim)),
                                ),
                            ],
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
            ],
          ),
  );
}
