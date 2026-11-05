/// Create / edit / delete Agents and groups — the same things the web page
/// does, over the same endpoints.
library;

import 'dart:async';
import 'dart:io';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../data/api.dart';
import '../../l10n.dart';
import '../../platform.dart';
import '../../state/workbench.dart';
import '../../theme/app_theme.dart';

/// [agent] null = create; [template] fills a new one (its skills are installed when it is saved).
/// Returns once the lists are reloaded.
Future<void> showAgentEditor(BuildContext context, Workbench bench, {Agent? agent, AgentTemplate? template}) =>
    showDialog<void>(
      context: context,
      builder: (_) => _AgentEditor(bench: bench, agent: agent, template: agent == null ? template : null),
    );

/// Template files, for the save and open dialogs.
const templateFiles = XTypeGroup(label: 'CirrayaBot agent', extensions: ['json'], mimeTypes: ['application/json']);

/// [group] null = create.
Future<void> showGroupEditor(BuildContext context, Workbench bench, {Conversation? group}) => showDialog<void>(
  context: context,
  builder: (_) => _GroupEditor(bench: bench, group: group),
);

/// Reasoning effort: the stored value and the string that names it. '' = send nothing.
const _effortLevels = <MapEntry<String, String>>[
  MapEntry('', 'ed.effortDefault'),
  MapEntry('low', 'ed.effortLow'),
  MapEntry('medium', 'ed.effortMedium'),
  MapEntry('high', 'ed.effortHigh'),
];

/// When this one has to ask a person first. '' = whatever the platform says.
/// How far it goes on its own. '' = follow the platform setting.
const _autonomyModes = <MapEntry<String, String>>[
  MapEntry('', 'ed.autonomyDefault'),
  MapEntry('auto', 'ed.autonomyAuto'),
  MapEntry('manual', 'ed.autonomyManual'),
];

const _approvalModes = <MapEntry<String, String>>[
  MapEntry('', 'ed.approvalDefault'),
  MapEntry('off', 'ed.approvalOff'),
  MapEntry('match', 'ed.approvalMatch'),
  MapEntry('all', 'ed.approvalAll'),
];

/// One backup model being edited: an upstream, and a model from its list (or typed, when the
/// upstream gives no list), with its own loading state.
class _FallbackPick {
  _FallbackPick(this.providerId, this.model) : manual = TextEditingController(text: model);
  String providerId;
  String model;
  final TextEditingController manual;
  final key = UniqueKey();
  List<String> models = const [];
  bool loading = true;
  int seq = 0;

  String get chosen => (models.isEmpty ? manual.text : model).trim();
}

const _maxFallbacks = 3;

class _AgentEditor extends StatefulWidget {
  const _AgentEditor({required this.bench, this.agent, this.template});
  final Workbench bench;
  final Agent? agent;
  final AgentTemplate? template;

  @override
  State<_AgentEditor> createState() => _AgentEditorState();
}

class _AgentEditorState extends State<_AgentEditor> {
  late final _name = TextEditingController(text: widget.agent?.name ?? widget.template?.name ?? '');
  late final _desc = TextEditingController(text: widget.agent?.description ?? widget.template?.description ?? '');
  late final _persona = TextEditingController(text: widget.agent?.persona ?? widget.template?.persona ?? '');

  /// Typed model name — only used when the upstream will not list its models.
  late final _manualModel = TextEditingController(text: widget.agent?.model ?? '');

  /// Daily spend cap, in dollars as typed. Empty = the platform default.
  late final _cap = TextEditingController(text: dollarsText(widget.agent?.dailyCapMicro));
  late final _voiceName = TextEditingController(text: widget.agent?.voice ?? '');
  late String _providerId = widget.agent?.providerId ?? '';

  /// '' = send nothing, which is what every model got before this setting existed.
  late String _effort = const ['low', 'medium', 'high'].contains(widget.agent?.effort) ? widget.agent!.effort : '';
  late String _approval = (() {
    final v = widget.agent?.approval ?? widget.template?.approval;
    return const ['off', 'match', 'all'].contains(v) ? v! : '';
  })();
  late String _autonomy = (() {
    final v = widget.agent?.autonomy ?? widget.template?.autonomy;
    return const ['auto', 'manual'].contains(v) ? v! : '';
  })();
  late String _modelMode = const ['auto', 'manual'].contains(widget.agent?.modelMode) ? widget.agent!.modelMode : '';
  List<Provider> _providers = const [];
  List<String> _models = const [];
  String _model = '';
  bool _modelsLoading = true;
  int _modelsSeq = 0;
  String _error = '';
  bool _busy = false;
  late final List<_FallbackPick> _fallbacks = [
    for (final f in widget.agent?.fallbacks ?? const <Fallback>[]) _FallbackPick(f.providerId, f.model),
  ];

  /// What its background tasks run on. [_taskSame] = the model above.
  late bool _taskSame = widget.agent?.taskModel == null;
  late final _taskPick = _FallbackPick(widget.agent?.taskModel?.providerId ?? '', widget.agent?.taskModel?.model ?? '');

  /// Check-ins: goals it works toward on its own, and how often.
  late final _goals = TextEditingController(text: widget.agent?.goals ?? widget.template?.goals ?? '');
  late int _checkinEvery = (() {
    final v = widget.agent?.checkinEvery ?? widget.template?.checkinEvery ?? 0;
    return const [0, 60, 240, 720, 1440].contains(v) ? v : 0;
  })();
  String _checkinNote = '';

  /// The machine's setup script, and how it last went (polled while it runs).
  late final _setup = TextEditingController(text: widget.agent?.setup ?? widget.template?.setup ?? '');
  late SetupState? _setupState = widget.agent?.setupState;
  late bool _setupRunning = widget.agent?.setupRunning ?? false;
  Timer? _setupPoll;
  bool get _hasMachine => widget.agent?.machine ?? widget.bench.agents.firstOrNull?.machine ?? false;

  @override
  void initState() {
    super.initState();
    widget.bench.api.providers().then((list) {
      if (!mounted) return;
      setState(() {
        _providers = list;
        // An upstream deleted elsewhere: fall back to the default rather than
        // a dropdown with a value it cannot show.
        if (!list.any((p) => p.id == _providerId)) _providerId = '';
        for (final f in [..._fallbacks, _taskPick]) {
          if (!list.any((p) => p.id == f.providerId)) f.providerId = '';
        }
      });
    }, onError: (_) {}).whenComplete(() {
      // Whether or not the upstream list came: the model fields must stop "asking" either way —
      // with no answer they fall back to typing the name, instead of spinning forever.
      if (!mounted) return;
      _loadModels(_providerId, widget.agent?.model ?? '');
      for (final f in _fallbacks) {
        _loadFallback(f, f.model);
      }
      if (!_taskSame) _loadFallback(_taskPick, _taskPick.model);
    });
    if (_setupRunning) _pollSetup();
  }

  /// A backup row's model list. Unlike the main pick, nothing is preselected for a new row: the
  /// list's first entry is most likely the main model, and a backup that is the main model would
  /// only fail twice.
  Future<void> _loadFallback(_FallbackPick f, String current) async {
    final seq = ++f.seq;
    setState(() => f.loading = true);
    var models = const <String>[];
    try {
      models = (await widget.bench.api.models(f.providerId)).models;
    } on ApiException {
      // falls through to typing the name
    }
    if (!mounted || seq != f.seq || (!_fallbacks.contains(f) && f != _taskPick)) return;
    setState(() {
      f.loading = false;
      f.models = current.isNotEmpty && models.isNotEmpty && !models.contains(current) ? [current, ...models] : models;
      f.model = current;
      f.manual.text = current;
    });
  }

  Widget _fallbackRow(_FallbackPick f) => Padding(
    key: f.key,
    padding: const EdgeInsets.only(bottom: 8),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: DropdownButtonFormField<String>(
            key: ValueKey('${f.key}/${_providers.length}'),
            initialValue: _providers.isEmpty ? '' : f.providerId,
            isExpanded: true,
            decoration: InputDecoration(labelText: tr('ed.provider')),
            items: _providerItems(),
            onChanged: (v) {
              setState(() => f.providerId = v ?? '');
              final old = widget.agent?.fallbacks.where((x) => x.providerId == f.providerId).firstOrNull;
              _loadFallback(f, old?.model ?? '');
            },
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: f.loading
              ? InputDecorator(
                  decoration: InputDecoration(labelText: tr('ed.model')),
                  child: Text(tr('ed.askingProvider'), style: TextStyle(fontSize: 13, color: C.dim)),
                )
              : f.models.isEmpty
              ? TextField(
                  controller: f.manual,
                  decoration: InputDecoration(labelText: tr('ed.model'), hintText: tr('ed.manualModelHint')),
                )
              : DropdownButtonFormField<String>(
                  key: ValueKey('${f.key}/${f.providerId}/${f.models.length}'),
                  initialValue: f.models.contains(f.model) ? f.model : null,
                  isExpanded: true,
                  hint: Text(tr('ed.fallbackPick'), overflow: TextOverflow.ellipsis),
                  decoration: InputDecoration(labelText: tr('ed.model')),
                  items: [
                    for (final m in f.models)
                      DropdownMenuItem(value: m, child: Text(m, overflow: TextOverflow.ellipsis)),
                  ],
                  onChanged: (v) => setState(() => f.model = v ?? ''),
                ),
        ),
        IconButton(
          tooltip: tr('ed.fallbackRemove'),
          icon: const Icon(Icons.close, size: 18),
          onPressed: () => setState(() {
            _fallbacks.remove(f);
            f.manual.dispose();
          }),
        ),
      ],
    ),
  );

  static const _same = '__same__';

  /// The background model: "the same as above", or an upstream and a model like a backup row.
  Widget _taskModelRow() => Row(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Expanded(
        child: DropdownButtonFormField<String>(
          key: ValueKey('task/${_providers.length}'),
          initialValue: _taskSame || _providers.isEmpty ? (_taskSame ? _same : '') : _taskPick.providerId,
          isExpanded: true,
          decoration: InputDecoration(labelText: tr('ed.provider')),
          items: [
            DropdownMenuItem(value: _same, child: Text(tr('ed.taskModelSame'), overflow: TextOverflow.ellipsis)),
            ..._providerItems(),
          ],
          onChanged: (v) {
            if (v == _same) return setState(() => _taskSame = true);
            setState(() {
              _taskSame = false;
              _taskPick.providerId = v ?? '';
            });
            final old = widget.agent?.taskModel;
            _loadFallback(_taskPick, old != null && old.providerId == _taskPick.providerId ? old.model : '');
          },
        ),
      ),
      if (!_taskSame) ...[
        const SizedBox(width: 10),
        Expanded(
          child: _taskPick.loading
              ? InputDecorator(
                  decoration: InputDecoration(labelText: tr('ed.model')),
                  child: Text(tr('ed.askingProvider'), style: TextStyle(fontSize: 13, color: C.dim)),
                )
              : _taskPick.models.isEmpty
              ? TextField(
                  controller: _taskPick.manual,
                  decoration: InputDecoration(labelText: tr('ed.model'), hintText: tr('ed.manualModelHint')),
                )
              : DropdownButtonFormField<String>(
                  key: ValueKey('task/${_taskPick.providerId}/${_taskPick.models.length}'),
                  initialValue: _taskPick.models.contains(_taskPick.model) ? _taskPick.model : null,
                  isExpanded: true,
                  hint: Text(tr('ed.fallbackPick'), overflow: TextOverflow.ellipsis),
                  decoration: InputDecoration(labelText: tr('ed.model')),
                  items: [
                    for (final m in _taskPick.models)
                      DropdownMenuItem(value: m, child: Text(m, overflow: TextOverflow.ellipsis)),
                  ],
                  onChanged: (v) => setState(() => _taskPick.model = v ?? ''),
                ),
        ),
      ],
    ],
  );

  String _checkinLine() {
    if (_checkinNote.isNotEmpty) return _checkinNote;
    String at(Object? v) {
      final d = (v is num ? DateTime.fromMillisecondsSinceEpoch(v.toInt()) : DateTime.tryParse('$v'))?.toLocal();
      return d == null ? '' : '${d.month}/${d.day} ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
    }
    final a = widget.agent;
    return [
      if (a != null && a.checkinEvery > 0 && a.checkinNextAt != null) tr('ed.ckNext', {'when': at(a.checkinNextAt)}),
      if (a?.checkinLast != null) tr('ed.ckLast.${a!.checkinLast!['status']}', {'when': at(a.checkinLast!['at'])}),
    ].join(' · ');
  }

  Future<void> _checkInNow() async {
    final a = widget.agent;
    if (a == null) return;
    setState(() => _error = '');
    try {
      if (_goals.text.trim() != a.goals) await widget.bench.api.updateAgent(a.id, {'goals': _goals.text});
      await widget.bench.api.checkInNow(a.id);
      setState(() => _checkinNote = tr('ed.ckStarted'));
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    }
  }

  String _setupLine() {
    if (_setupRunning) return tr('ed.setupRunning');
    final st = _setupState;
    if (st == null) return tr('ed.setupNever');
    final at = DateTime.fromMillisecondsSinceEpoch(st.at).toLocal().toString().substring(0, 16);
    final line = st.code == 0
        ? tr('ed.setupOk', {'when': at, 'sec': (st.ms / 1000).round()})
        : tr('ed.setupFail', {'when': at, 'code': st.code});
    return st.stale ? '$line · ${tr('ed.setupStale')}' : line;
  }

  void _pollSetup() {
    _setupPoll?.cancel();
    _setupPoll = Timer(const Duration(seconds: 3), () async {
      final id = widget.agent?.id;
      if (!mounted || id == null) return;
      try {
        final a = (await widget.bench.api.agents()).where((x) => x.id == id).firstOrNull;
        if (!mounted || a == null) return;
        setState(() {
          _setupState = a.setupState;
          _setupRunning = a.setupRunning;
        });
      } on ApiException {
        // try again
      }
      if (mounted && _setupRunning) _pollSetup();
    });
  }

  Future<void> _runSetup() async {
    final a = widget.agent;
    if (a == null) return;
    setState(() => _error = '');
    try {
      // What runs is what is on screen: save an edit first.
      if (_setup.text != a.setup) await widget.bench.api.updateAgent(a.id, {'setup': _setup.text});
      await widget.bench.api.runSetup(a.id);
      setState(() => _setupRunning = true);
      _pollSetup();
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    }
  }

  List<DropdownMenuItem<String>> _providerItems() => [
    DropdownMenuItem(
      value: '',
      child: Text(
        _providers.where((p) => p.isDefault).map((p) => tr('ed.defaultProviderNamed', {'name': p.name})).firstOrNull ??
            tr('ed.defaultProvider'),
        overflow: TextOverflow.ellipsis,
      ),
    ),
    for (final p in _providers)
      DropdownMenuItem(
        value: p.id,
        child: Text(p.name, overflow: TextOverflow.ellipsis),
      ),
  ];

  /// Ask the upstream what it offers. [current] is kept even when the list no
  /// longer has it — silently swapping in another model is worse than showing
  /// the stale one. A new Agent starts on whatever the upstream is already used
  /// with, not the alphabetically first entry.
  Future<void> _loadModels(String providerId, String current) async {
    final seq = ++_modelsSeq;
    setState(() => _modelsLoading = true);
    var models = const <String>[];
    var suggested = '';
    try {
      final r = await widget.bench.api.models(providerId);
      models = r.models;
      suggested = r.suggested;
    } on ApiException {
      // falls through to typing the name
    }
    if (!mounted || seq != _modelsSeq) return; // switched upstream meanwhile
    setState(() {
      _modelsLoading = false;
      _models = current.isNotEmpty && models.isNotEmpty && !models.contains(current) ? [current, ...models] : models;
      _model = current.isNotEmpty ? current : (suggested.isNotEmpty ? suggested : models.firstOrNull ?? '');
      _manualModel.text = current;
    });
  }

  String get _chosenModel => (_models.isEmpty ? _manualModel.text : _model).trim();

  /// The upstream in force for this agent has no prices, so a cap cannot bite.
  bool get _capUseless {
    final chosen = _providerId.isEmpty
        ? _providers.where((p) => p.isDefault).firstOrNull ?? _providers.firstOrNull
        : _providers.where((p) => p.id == _providerId).firstOrNull;
    return chosen != null && !chosen.priced;
  }

  @override
  void dispose() {
    _name.dispose();
    _desc.dispose();
    _persona.dispose();
    _manualModel.dispose();
    _cap.dispose();
    _voiceName.dispose();
    for (final f in _fallbacks) {
      f.manual.dispose();
    }
    _taskPick.manual.dispose();
    _goals.dispose();
    _setup.dispose();
    _setupPoll?.cancel();
    super.dispose();
  }

  Future<void> _run(Future<String?> Function() job) async {
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      final openId = await job();
      await widget.bench.reload(id: openId);
      if (mounted) Navigator.of(context).pop();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _save() async {
    final name = _name.text.trim(), desc = _desc.text.trim(), persona = _persona.text.trim();
    if (name.isEmpty || persona.isEmpty) {
      setState(() => _error = tr('ed.needNamePersona'));
      return;
    }
    if (_chosenModel.isEmpty) {
      setState(() => _error = tr(_modelsLoading ? 'ed.modelsLoading' : 'ed.pickModel'));
      return;
    }
    final cap = parseDollars(_cap.text);
    if (!cap.ok) {
      setState(() => _error = tr('ed.badCap'));
      return;
    }
    final a = widget.agent;
    final body = <String, Object?>{
      'name': name,
      'description': desc,
      'persona': persona,
      'provider_id': _providerId,
      'model': _chosenModel,
      'effort': _effort,
      'approval': _approval,
      'autonomy': _autonomy,
      'model_mode': _modelMode,
      'daily_cap_micro': cap.value,
      'voice': _voiceName.text.trim(),
      // A row left without a model is not a backup; it is dropped rather than refused.
      'fallbacks': [
        for (final f in _fallbacks)
          if (f.chosen.isNotEmpty) {'provider_id': f.providerId, 'model': f.chosen},
      ],
      'task_model': _taskSame || _taskPick.chosen.isEmpty ? null : {'provider_id': _taskPick.providerId, 'model': _taskPick.chosen},
      if (_hasMachine) 'setup': _setup.text,
      if (_hasMachine) 'goals': _goals.text,
      if (_hasMachine) 'checkin_every': _checkinEvery,
      // From a template: its skills come along, and its colour.
      if (a == null && widget.template != null) 'skills': [for (final k in widget.template!.skills) k.toJson()],
      if (a == null && widget.template?.color != null) 'color': widget.template!.color,
    };
    await _run(() async {
      if (a == null) return widget.bench.api.createAgent(body);
      await widget.bench.api.updateAgent(a.id, body);
      return a.id;
    });
  }

  /// This agent as a template file: saved where the person picks (desktop), or shared (Android).
  Future<void> _export() async {
    final a = widget.agent!;
    try {
      final text = await widget.bench.api.exportTemplate(a.id);
      final name = '${a.name}.cirrayabot-agent.json';
      if (!AppPlatform.canSaveAs) {
        await AppPlatform.shareText(name, text, 'application/json');
        return;
      }
      final loc = await getSaveLocation(suggestedName: name, acceptedTypeGroups: const [templateFiles]);
      if (loc == null) return;
      await File(loc.path).writeAsString(text);
      if (mounted) setState(() => _error = tr('ed.tplExported', {'path': loc.path}));
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } on FileSystemException catch (e) {
      if (mounted) setState(() => _error = e.osError?.message ?? e.message);
    }
  }

  Future<void> _delete() async {
    final a = widget.agent!;
    if (!await _confirm(context, tr('ed.deleteAgentQ', {'name': a.name}), tr('ed.deleteAgentBody'))) return;
    await _run(() async {
      await widget.bench.api.deleteAgent(a.id);
      return null;
    });
  }

  @override
  Widget build(BuildContext context) {
    final editing = widget.agent != null;
    return AlertDialog(
      // The form is taller than a phone (and than a short laptop window): it scrolls, title and all.
      scrollable: true,
      title: Text(
        editing ? tr('ed.editTitle', {'name': widget.agent!.name}) : tr('wb.newAgent'),
        style: const TextStyle(fontSize: 16),
      ),
      content: SizedBox(
        width: 460,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextField(
              controller: _name,
              autofocus: !editing,
              decoration: InputDecoration(hintText: tr('ed.nameHint')),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _desc,
              decoration: InputDecoration(hintText: tr('ed.descHint')),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _persona,
              minLines: 6,
              maxLines: 12,
              decoration: InputDecoration(hintText: tr('ed.personaHint')),
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                  // Rebuilt once the list arrives: before that the saved id is
                  // not among the items, and a dropdown asserts on that.
                  child: DropdownButtonFormField<String>(
                    key: ValueKey(_providers.length),
                    initialValue: _providers.isEmpty ? '' : _providerId,
                    isExpanded: true,
                    decoration: InputDecoration(labelText: tr('ed.provider')),
                    items: _providerItems(),
                    onChanged: (v) {
                      setState(() => _providerId = v ?? '');
                      // The old model name almost never belongs to another upstream;
                      // switching back to the agent's own restores it.
                      final a = widget.agent;
                      _loadModels(_providerId, a != null && _providerId == a.providerId ? a.model : '');
                    },
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: _modelsLoading
                      ? InputDecorator(
                          decoration: InputDecoration(labelText: tr('ed.model')),
                          child: Text(tr('ed.askingProvider'), style: TextStyle(fontSize: 13, color: C.dim)),
                        )
                      : _models.isEmpty
                      ? TextField(
                          controller: _manualModel,
                          decoration: InputDecoration(labelText: tr('ed.model'), hintText: tr('ed.manualModelHint')),
                        )
                      : DropdownButtonFormField<String>(
                          // Rebuilt per list: a new upstream brings a new set of items.
                          key: ValueKey('$_providerId/${_models.length}'),
                          initialValue: _models.contains(_model) ? _model : null,
                          isExpanded: true,
                          decoration: InputDecoration(labelText: tr('ed.model')),
                          items: [
                            for (final m in _models)
                              DropdownMenuItem(
                                value: m,
                                child: Text(m, overflow: TextOverflow.ellipsis),
                              ),
                          ],
                          onChanged: (v) => setState(() => _model = v ?? ''),
                        ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            DropdownButtonFormField<String>(
              initialValue: _effort,
              isExpanded: true,
              decoration: InputDecoration(labelText: tr('ed.effort')),
              items: [
                for (final e in _effortLevels)
                  DropdownMenuItem(value: e.key, child: Text(tr(e.value))),
              ],
              onChanged: (v) => setState(() => _effort = v ?? ''),
            ),
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(tr('ed.effortHint'), style: TextStyle(fontSize: 11, color: C.dim)),
            ),
            const SizedBox(height: 14),
            Row(
              children: [
                Expanded(child: Text(tr('ed.fallbacks'), style: TextStyle(fontSize: 13, color: C.dim))),
                if (_fallbacks.length < _maxFallbacks)
                  TextButton.icon(
                    onPressed: () {
                      final f = _FallbackPick('', '');
                      setState(() => _fallbacks.add(f));
                      _loadFallback(f, '');
                    },
                    icon: const Icon(Icons.add, size: 16),
                    label: Text(tr('ed.fallbackAdd')),
                  ),
              ],
            ),
            for (final f in _fallbacks) _fallbackRow(f),
            Text(tr('ed.fallbackHint'), style: TextStyle(fontSize: 11, color: C.dim)),
            const SizedBox(height: 14),
            Text(tr('ed.taskModel'), style: TextStyle(fontSize: 13, color: C.dim)),
            const SizedBox(height: 6),
            _taskModelRow(),
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(tr('ed.taskModelHint'), style: TextStyle(fontSize: 11, color: C.dim)),
            ),
            const SizedBox(height: 10),
            DropdownButtonFormField<String>(
              key: const ValueKey('ed-model-mode'),
              initialValue: _modelMode,
              isExpanded: true,
              decoration: InputDecoration(labelText: tr('mm.title')),
              items: [
                for (final m in const ['', 'auto', 'manual'])
                  DropdownMenuItem(value: m, child: Text(tr('mm.${m.isEmpty ? 'default' : m}'), overflow: TextOverflow.ellipsis)),
              ],
              onChanged: (v) => setState(() => _modelMode = v ?? ''),
            ),
            const SizedBox(height: 10),
            DropdownButtonFormField<String>(
              initialValue: _approval,
              isExpanded: true,
              decoration: InputDecoration(labelText: tr('ed.approval')),
              items: [
                for (final m in _approvalModes)
                  DropdownMenuItem(value: m.key, child: Text(tr(m.value))),
              ],
              onChanged: (v) => setState(() => _approval = v ?? ''),
            ),
            const SizedBox(height: 10),
            DropdownButtonFormField<String>(
              initialValue: _autonomy,
              isExpanded: true,
              decoration: InputDecoration(labelText: tr('ed.autonomy')),
              items: [
                for (final m in _autonomyModes)
                  DropdownMenuItem(value: m.key, child: Text(tr(m.value))),
              ],
              onChanged: (v) => setState(() => _autonomy = v ?? ''),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _cap,
              decoration: InputDecoration(labelText: tr('ed.dailyCap'), hintText: tr('ed.dailyCapHint')),
            ),
            // A cap only means something when the upstream has prices — saying so
            // beats letting someone think a number here is guarding them.
            if (_capUseless)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(tr('wb.unpriced'), style: TextStyle(fontSize: 11, color: C.warn)),
              ),
            const SizedBox(height: 10),
            TextField(
              controller: _voiceName,
              autocorrect: false,
              decoration: InputDecoration(labelText: tr('vo.agentVoice')),
            ),
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(tr('vo.agentVoiceHint'), style: TextStyle(fontSize: 11, color: C.dim2)),
            ),
            if (_hasMachine)
              Theme(
                data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
                child: ExpansionTile(
                  key: const ValueKey('ed-checkin'),
                  tilePadding: EdgeInsets.zero,
                  childrenPadding: EdgeInsets.zero,
                  initiallyExpanded: (widget.agent?.goals ?? widget.template?.goals ?? '').isNotEmpty,
                  title: Text(tr('ed.checkins'), style: TextStyle(fontSize: 13, color: C.dim)),
                  expandedCrossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    TextField(
                      controller: _goals,
                      minLines: 3,
                      maxLines: 8,
                      decoration: InputDecoration(hintText: tr('ed.goalsHint')),
                      style: const TextStyle(fontSize: 12.5),
                    ),
                    const SizedBox(height: 8),
                    DropdownButtonFormField<int>(
                      initialValue: _checkinEvery,
                      isExpanded: true,
                      decoration: InputDecoration(labelText: tr('ed.ckEvery')),
                      items: [
                        for (final m in const [0, 60, 240, 720, 1440])
                          DropdownMenuItem(value: m, child: Text(tr('ed.ckEvery.$m'))),
                      ],
                      onChanged: (v) => setState(() => _checkinEvery = v ?? 0),
                    ),
                    Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Text(tr('ed.ckHint'), style: TextStyle(fontSize: 11, color: C.dim)),
                    ),
                    // Two lines, not one Row: on a phone at 130 % the status and the button don't fit side by side.
                    if (widget.agent != null && widget.agent!.goals.isNotEmpty) ...[
                      if (_checkinLine().isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(top: 6),
                          child: Text(_checkinLine(), style: TextStyle(fontSize: 11.5, color: C.dim)),
                        ),
                      Align(
                        alignment: Alignment.centerRight,
                        child: TextButton(onPressed: _checkInNow, child: Text(tr('ed.ckNow'))),
                      ),
                    ],
                  ],
                ),
              ),
            if (_hasMachine)
              Theme(
                data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
                child: ExpansionTile(
                  key: const ValueKey('ed-setup'),
                  tilePadding: EdgeInsets.zero,
                  childrenPadding: EdgeInsets.zero,
                  initiallyExpanded: (widget.agent?.setup ?? widget.template?.setup ?? '').isNotEmpty,
                  title: Text(tr('ed.setup'), style: TextStyle(fontSize: 13, color: C.dim)),
                  expandedCrossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    TextField(
                      controller: _setup,
                      minLines: 3,
                      maxLines: 10,
                      autocorrect: false,
                      style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
                      decoration: InputDecoration(hintText: tr('ed.setupHintBox')),
                    ),
                    Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Text(tr('ed.setupHint'), style: TextStyle(fontSize: 11, color: C.dim)),
                    ),
                    if (widget.agent != null && widget.agent!.setup.isNotEmpty)
                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              _setupLine(),
                              style: TextStyle(fontSize: 11.5, color: (_setupState?.code ?? 0) != 0 && !_setupRunning ? C.code : C.dim),
                            ),
                          ),
                          TextButton(onPressed: _setupRunning ? null : _runSetup, child: Text(tr('ed.setupRun'))),
                        ],
                      ),
                    if ((_setupState?.tail ?? '').isNotEmpty && !_setupRunning)
                      Container(
                        constraints: const BoxConstraints(maxHeight: 140),
                        padding: const EdgeInsets.all(8),
                        decoration: BoxDecoration(color: C.field, borderRadius: BorderRadius.circular(8)),
                        child: SingleChildScrollView(
                          child: SelectableText(_setupState!.tail, style: const TextStyle(fontFamily: 'monospace', fontSize: 11)),
                        ),
                      ),
                  ],
                ),
              ),
            if (widget.template != null)
              Padding(
                padding: const EdgeInsets.only(top: 10),
                child: Text(
                  [
                    tr('ed.tplPickModel'),
                    if (widget.template!.skills.isNotEmpty)
                      tr('ed.tplComesWith', {'list': widget.template!.skills.map((k) => k.name).join(', ')}),
                    if (widget.template!.note.isNotEmpty) widget.template!.note,
                  ].join(' '),
                  key: const ValueKey('ed-template'),
                  style: TextStyle(fontSize: 11.5, color: C.dim),
                ),
              ),
            if (_error.isNotEmpty) ...[
              const SizedBox(height: 10),
              Text(_error, style: TextStyle(fontSize: 12, color: C.code)),
            ],
          ],
        ),
      ),
      actions: [
        if (editing)
          TextButton(onPressed: _busy ? null : _export, child: Text(tr('ed.tplExport'))),
        if (editing)
          TextButton(
            onPressed: _busy ? null : _delete,
            style: TextButton.styleFrom(foregroundColor: C.code),
            child: Text(tr('common.delete')),
          ),
        TextButton(onPressed: _busy ? null : () => Navigator.of(context).pop(), child: Text(tr('common.cancel'))),
        FilledButton(onPressed: _busy ? null : _save, child: Text(tr(editing ? 'common.save' : 'ed.create'))),
      ],
    );
  }
}

class _GroupEditor extends StatefulWidget {
  const _GroupEditor({required this.bench, this.group});
  final Workbench bench;
  final Conversation? group;

  @override
  State<_GroupEditor> createState() => _GroupEditorState();
}

class _GroupEditorState extends State<_GroupEditor> {
  late final _name = TextEditingController(text: widget.group?.name ?? '');
  late final Set<String> _members = {...?widget.group?.members};
  late String _lead = widget.group?.lead ?? '';
  String _error = '';
  bool _busy = false;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _run(Future<String?> Function() job) async {
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      final openId = await job();
      await widget.bench.reload(id: openId);
      if (mounted) Navigator.of(context).pop();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _save() async {
    final name = _name.text.trim();
    // Say it here rather than round-trip for the server's 400: a one-member
    // group is a DM, and the form knows that as well as the server does.
    if (name.isEmpty || _members.length < 2) {
      setState(() => _error = tr('ed.groupNeeds'));
      return;
    }
    // Keep the Agents' own order, so the first speaker doesn't depend on
    // the order the boxes were ticked in.
    final ordered = [
      for (final a in widget.bench.agents)
        if (_members.contains(a.id)) a.id,
    ];
    final g = widget.group;
    await _run(() async {
      if (g == null) return widget.bench.api.createGroup(name, ordered, lead: _lead);
      await widget.bench.api.updateGroup(g.id, name, ordered, lead: _lead);
      return g.id;
    });
  }

  Future<void> _delete() async {
    final g = widget.group!;
    if (!await _confirm(context, tr('ed.disbandQ', {'name': g.name}), tr('ed.disbandBody'))) return;
    await _run(() async {
      await widget.bench.api.deleteGroup(g.id);
      return null;
    });
  }

  @override
  Widget build(BuildContext context) {
    final editing = widget.group != null;
    final agents = widget.bench.agents;
    return AlertDialog(
      title: Text(
        editing ? tr('ed.editTitle', {'name': widget.group!.name}) : tr('wb.newGroup'),
        style: const TextStyle(fontSize: 16),
      ),
      content: SizedBox(
        width: 420,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextField(
              controller: _name,
              autofocus: !editing,
              decoration: InputDecoration(hintText: tr('ed.groupNameHint')),
            ),
            const SizedBox(height: 14),
            Text(tr('ed.membersMin'), style: TextStyle(fontSize: 12, color: C.dim)),
            const SizedBox(height: 4),
            ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 280),
              child: agents.isEmpty
                  ? Padding(
                      padding: const EdgeInsets.symmetric(vertical: 12),
                      child: Text(tr('ed.noAgents'), style: TextStyle(fontSize: 12.5, color: C.dim2)),
                    )
                  : ListView(
                      shrinkWrap: true,
                      children: [
                        for (final a in agents)
                          CheckboxListTile(
                            dense: true,
                            contentPadding: EdgeInsets.zero,
                            controlAffinity: ListTileControlAffinity.leading,
                            value: _members.contains(a.id),
                            onChanged: (v) => setState(() {
                              v == true ? _members.add(a.id) : _members.remove(a.id);
                              // The lead has to be in the group.
                              if (!_members.contains(_lead)) _lead = '';
                            }),
                            title: Text(a.name, style: const TextStyle(fontSize: 13)),
                            subtitle: a.description.isEmpty
                                ? null
                                : Text(
                                    a.description,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: TextStyle(fontSize: 11, color: C.dim),
                                  ),
                          ),
                      ],
                    ),
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              // Rebuilt when the member set changes: its items change with it.
              key: ValueKey('lead-${_members.join(',')}'),
              initialValue: _members.contains(_lead) ? _lead : '',
              isExpanded: true,
              decoration: InputDecoration(labelText: tr('ed.lead')),
              items: [
                DropdownMenuItem(value: '', child: Text(tr('ed.noLead'))),
                for (final a in agents)
                  if (_members.contains(a.id)) DropdownMenuItem(value: a.id, child: Text(a.name)),
              ],
              onChanged: (v) => setState(() => _lead = v ?? ''),
            ),
            const SizedBox(height: 4),
            Text(tr('ed.leadHelp'), style: TextStyle(fontSize: 11, color: C.dim2)),
            if (_error.isNotEmpty) ...[
              const SizedBox(height: 10),
              Text(_error, style: TextStyle(fontSize: 12, color: C.code)),
            ],
          ],
        ),
      ),
      actions: [
        if (editing)
          TextButton(
            onPressed: _busy ? null : _delete,
            style: TextButton.styleFrom(foregroundColor: C.code),
            child: Text(tr('ed.disband')),
          ),
        TextButton(onPressed: _busy ? null : () => Navigator.of(context).pop(), child: Text(tr('common.cancel'))),
        FilledButton(onPressed: _busy ? null : _save, child: Text(tr(editing ? 'common.save' : 'ed.create'))),
      ],
    );
  }
}

Future<bool> _confirm(BuildContext context, String title, String body) async =>
    await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text(title, style: const TextStyle(fontSize: 15)),
        content: Text(body, style: TextStyle(fontSize: 13, color: C.dim)),
        actions: [
          TextButton(onPressed: () => Navigator.of(c).pop(false), child: Text(tr('common.cancel'))),
          FilledButton(
            onPressed: () => Navigator.of(c).pop(true),
            style: FilledButton.styleFrom(backgroundColor: C.code),
            child: Text(tr('common.ok')),
          ),
        ],
      ),
    ) ??
    false;

// ── scheduled tasks ──────────────────────────────────────────────────────

/// The machine's IANA time zone, which Dart does not expose. macOS and Linux
/// keep it as the target of /etc/localtime; elsewhere (Windows) fall back to a
/// fixed-offset zone — right until the next daylight-saving switch, which is
/// why an existing task keeps the zone it was created with.
String localTimeZone() {
  try {
    final target = File('/etc/localtime').resolveSymbolicLinksSync();
    final i = target.indexOf('zoneinfo/');
    if (i >= 0) return target.substring(i + 'zoneinfo/'.length);
  } catch (_) {}
  final off = DateTime.now().timeZoneOffset;
  if (off.inMinutes % 60 == 0) {
    final h = off.inHours;
    // Etc/GMT signs are inverted: UTC+8 is Etc/GMT-8.
    return h == 0 ? 'UTC' : 'Etc/GMT${h > 0 ? '-' : '+'}${h.abs()}';
  }
  return 'UTC';
}

String _two(int n) => n.toString().padLeft(2, '0');

String _clock(DateTime d) => '${_two(d.hour)}:${_two(d.minute)}';

/// "Weekdays 09:00", "Every 2 h", "9/21 09:00, once" — the same wording as the web page.
String scheduleText(Routine r) {
  final tz = r.tz.isNotEmpty && r.tz != localTimeZone() ? tr('ed.tzSuffix', {'tz': r.tz}) : '';
  if (r.kind == 'interval') {
    return r.everyMinutes % 60 == 0
        ? tr('ed.everyHours', {'n': r.everyMinutes ~/ 60})
        : tr('ed.everyMinutes', {'n': r.everyMinutes});
  }
  if (r.kind == 'once') {
    final d = DateTime.fromMillisecondsSinceEpoch(r.runAt ?? 0);
    return tr('ed.onceAt', {'date': '${d.month}/${d.day}', 'time': _clock(d)});
  }
  final w = r.weekdays.join(',');
  final days = r.weekdays.isEmpty
      ? tr('ed.everyDay')
      : w == '1,2,3,4,5'
      ? tr('ed.weekdays')
      : w == '0,6'
      ? tr('ed.weekends')
      : tr('ed.everyWeek', {'days': r.weekdays.map((d) => tr('ed.wd$d')).join(tr('wb.listSep'))});
  return '$days ${r.atTime}$tz';
}

/// When it runs next, in local time: "Today 09:00", "Mon 09:00", "9/30 09:00".
String nextRunText(Routine r) {
  if (!r.enabled || r.nextRunAt == null) return '';
  final d = DateTime.fromMillisecondsSinceEpoch(r.nextRunAt!);
  final now = DateTime.now();
  final days = DateTime(d.year, d.month, d.day).difference(DateTime(now.year, now.month, now.day)).inDays;
  final day = days == 0
      ? tr('ed.today')
      : days == 1
      ? tr('ed.tomorrow')
      : days < 7
      ? tr('wb.wd${d.weekday % 7}')
      : '${d.month}/${d.day}';
  return tr('ed.next', {'when': '$day ${_clock(d)}'});
}

/// [routine] null = create one for [target].
Future<void> showRoutineEditor(BuildContext context, Workbench bench, Conversation target, {Routine? routine}) =>
    showDialog<void>(
      context: context,
      builder: (_) => _RoutineEditor(bench: bench, target: target, routine: routine),
    );

class _RoutineEditor extends StatefulWidget {
  const _RoutineEditor({required this.bench, required this.target, this.routine});
  final Workbench bench;
  final Conversation target;
  final Routine? routine;

  @override
  State<_RoutineEditor> createState() => _RoutineEditorState();
}

class _RoutineEditorState extends State<_RoutineEditor> {
  late final _name = TextEditingController(text: widget.routine?.name ?? '');
  late final _prompt = TextEditingController(text: widget.routine?.prompt ?? '');
  late final _every = TextEditingController(text: '${widget.routine?.everyMinutes ?? 60}');
  late String _kind = widget.routine?.kind ?? 'daily';
  late TimeOfDay _time = _parseTime(widget.routine?.atTime);
  late final Set<int> _weekdays = {...?widget.routine?.weekdays};
  late DateTime _at = widget.routine?.runAt != null
      ? DateTime.fromMillisecondsSinceEpoch(widget.routine!.runAt!)
      : DateTime.now().add(const Duration(hours: 1));
  late bool _enabled = widget.routine?.enabled ?? true;
  String _error = '';
  bool _busy = false;

  static TimeOfDay _parseTime(String? s) {
    final m = RegExp(r'^(\d\d):(\d\d)$').firstMatch(s ?? '');
    return m == null
        ? const TimeOfDay(hour: 9, minute: 0)
        : TimeOfDay(hour: int.parse(m[1]!), minute: int.parse(m[2]!));
  }

  @override
  void dispose() {
    _name.dispose();
    _prompt.dispose();
    _every.dispose();
    super.dispose();
  }

  Future<void> _run(Future<void> Function() job) async {
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      await job();
      await widget.bench.loadRoutines();
      if (mounted) Navigator.of(context).pop();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _save() {
    final r = widget.routine;
    final body = <String, Object?>{
      'name': _name.text.trim(),
      'prompt': _prompt.text.trim(),
      'target_kind': widget.target.kind,
      'target_id': widget.target.id,
      'kind': _kind,
      'at_time': '${_two(_time.hour)}:${_two(_time.minute)}',
      'weekdays': (_weekdays.toList()..sort()),
      'every_minutes': int.tryParse(_every.text.trim()) ?? 0,
      'run_at': _at.millisecondsSinceEpoch,
      'tz': (r?.tz.isNotEmpty ?? false) ? r!.tz : localTimeZone(),
      'enabled': _enabled,
    };
    return _run(() => widget.bench.api.saveRoutine(body, id: r?.id));
  }

  Future<void> _delete() async {
    final r = widget.routine!;
    if (!await _confirm(context, tr('ed.deleteRoutineQ', {'name': r.name}), tr('ed.deleteRoutineBody'))) return;
    await _run(() => widget.bench.api.deleteRoutine(r.id));
  }

  Future<void> _pickTime() async {
    final t = await showTimePicker(context: context, initialTime: _time);
    if (t != null) setState(() => _time = t);
  }

  Future<void> _pickMoment() async {
    final day = await showDatePicker(
      context: context,
      initialDate: _at,
      firstDate: DateTime.now(),
      lastDate: DateTime.now().add(const Duration(days: 366)),
    );
    if (day == null || !mounted) return;
    final t = await showTimePicker(context: context, initialTime: TimeOfDay.fromDateTime(_at));
    if (t == null) return;
    setState(() => _at = DateTime(day.year, day.month, day.day, t.hour, t.minute));
  }

  Widget _schedule() => switch (_kind) {
    'interval' => Row(
      children: [
        SizedBox(
          width: 120,
          child: TextField(
            controller: _every,
            decoration: InputDecoration(labelText: tr('ed.intervalLabel')),
          ),
        ),
        const SizedBox(width: 10),
        Text(tr('ed.min5'), style: TextStyle(fontSize: 12, color: C.dim)),
      ],
    ),
    'once' => Align(
      alignment: Alignment.centerLeft,
      child: TextButton.icon(
        onPressed: _pickMoment,
        icon: const Icon(Icons.event_outlined, size: 16),
        label: Text('${_at.year}/${_at.month}/${_at.day} ${_clock(_at)}'),
      ),
    ),
    _ => Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        TextButton.icon(
          onPressed: _pickTime,
          icon: const Icon(Icons.schedule, size: 16),
          label: Text('${_two(_time.hour)}:${_two(_time.minute)}'),
        ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: [
            for (final d in const [1, 2, 3, 4, 5, 6, 0])
              FilterChip(
                label: Text(tr('wb.wd$d'), style: const TextStyle(fontSize: 12)),
                selected: _weekdays.contains(d),
                // The checkmark widens the chip, the row re-wraps and the buttons
                // below jump away from the pointer.
                showCheckmark: false,
                onSelected: (on) => setState(() => on ? _weekdays.add(d) : _weekdays.remove(d)),
              ),
          ],
        ),
        const SizedBox(height: 4),
        Text(tr('ed.noneEveryDay'), style: TextStyle(fontSize: 11, color: C.dim2)),
      ],
    ),
  };

  @override
  Widget build(BuildContext context) {
    final r = widget.routine;
    final last = r?.lastRunAt == null
        ? (r == null ? '' : tr('ed.neverRun'))
        : tr('ed.lastRun', {
            'at': DateTime.fromMillisecondsSinceEpoch(r!.lastRunAt!).toString().substring(0, 16),
            'result': r.lastStatus == 'failed' ? tr('ed.failed', {'err': r.lastError}) : tr('ed.succeeded'),
          });
    return AlertDialog(
      title: Text(
        r == null ? tr('wb.newRoutine') : tr('ed.editTitle', {'name': r.name}),
        style: const TextStyle(fontSize: 16),
      ),
      content: SizedBox(
        width: 460,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              TextField(
                controller: _name,
                autofocus: r == null,
                decoration: InputDecoration(hintText: tr('ed.routineNameHint')),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _prompt,
                minLines: 4,
                maxLines: 10,
                decoration: InputDecoration(hintText: tr('ed.promptHint')),
              ),
              const SizedBox(height: 6),
              Text(
                tr('ed.firesInto', {'name': widget.target.name}) +
                    (widget.target.isGroup ? tr('ed.firesGroup') : '') +
                    tr('ed.costs'),
                style: TextStyle(fontSize: 11.5, color: C.dim2),
              ),
              const SizedBox(height: 12),
              SegmentedButton<String>(
                segments: [
                  for (final (v, k) in const [
                    ('daily', 'ed.kindDaily'),
                    ('interval', 'ed.kindInterval'),
                    ('once', 'ed.kindOnce'),
                  ])
                    ButtonSegment(
                      value: v,
                      label: Text(tr(k), style: const TextStyle(fontSize: 12)),
                    ),
                ],
                selected: {_kind},
                showSelectedIcon: false,
                onSelectionChanged: (v) => setState(() => _kind = v.first),
              ),
              const SizedBox(height: 12),
              _schedule(),
              const SizedBox(height: 6),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                dense: true,
                title: Text(tr('ed.enabled'), style: const TextStyle(fontSize: 13)),
                value: _enabled,
                onChanged: (v) => setState(() => _enabled = v),
              ),
              if (last.isNotEmpty) Text(last, style: TextStyle(fontSize: 11.5, color: C.dim)),
              if (_error.isNotEmpty) ...[
                const SizedBox(height: 10),
                Text(_error, style: TextStyle(fontSize: 12, color: C.code)),
              ],
            ],
          ),
        ),
      ),
      actions: [
        if (r != null) ...[
          TextButton(
            onPressed: _busy ? null : _delete,
            style: TextButton.styleFrom(foregroundColor: C.code),
            child: Text(tr('common.delete')),
          ),
          TextButton(
            onPressed: _busy || r.running ? null : () => _run(() => widget.bench.api.runRoutine(r.id)),
            child: Text(tr('ed.runNow')),
          ),
        ],
        TextButton(onPressed: _busy ? null : () => Navigator.of(context).pop(), child: Text(tr('common.cancel'))),
        FilledButton(onPressed: _busy ? null : _save, child: Text(tr(r == null ? 'ed.create' : 'common.save'))),
      ],
    );
  }
}

// ── tool servers (MCP) ───────────────────────────────────────────────────

/// A server's state as a pill: label, text colour, background.
(String, Color, Color) mcpStatus(McpServer m) => !m.enabled
    ? (tr('mcp.st.off'), C.dim, C.selected)
    : m.status == 'ok'
    ? (tr('mcp.st.ok', {'n': '${m.offered}'}), C.tintInk, C.tint)
    : m.status == 'signin'
    ? (tr('mcp.st.signin'), C.warn, C.warnBg)
    : m.status == 'error'
    ? (tr('mcp.st.error'), C.bad, C.badBg)
    : (tr('mcp.st.unchecked'), C.dim, C.selected);

/// Connect or edit a tool server. A new one stays open after saving: its tools to choose for, or a sign-in to do.
Future<void> showMcpEditor(BuildContext context, Workbench bench, String agentId, {McpServer? server}) async {
  await showDialog<void>(context: context, builder: (_) => _McpEditor(bench: bench, agentId: agentId, server: server));
  await bench.loadMcp();
}

class _McpEditor extends StatefulWidget {
  const _McpEditor({required this.bench, required this.agentId, this.server});
  final Workbench bench;
  final String agentId;
  final McpServer? server;

  @override
  State<_McpEditor> createState() => _McpEditorState();
}

class _McpEditorState extends State<_McpEditor> {
  late McpServer? _m = widget.server;
  late String _kind = _m?.kind ?? 'remote';
  late final _name = TextEditingController(text: _m?.name ?? '');
  late final _url = TextEditingController(text: _m?.url ?? '');
  late String _auth = _m?.auth ?? 'none';
  late final _header = TextEditingController(text: _m != null && _m!.header != 'Authorization' ? _m!.header : '');
  final _token = TextEditingController();
  late final _clientId = TextEditingController(text: _m?.clientId ?? '');
  final _clientSecret = TextEditingController();
  late final _command = TextEditingController(text: _m?.command ?? '');
  late final _env = TextEditingController(text: (_m?.envKeys ?? const []).map((k) => '$k=').join('\n'));
  late bool _enabled = _m?.enabled ?? true;
  late Map<String, String> _modes = {for (final t in _m?.tools ?? const <McpTool>[]) t.name: t.mode};
  String _error = '';
  String _note = '';
  bool _busy = false;
  Timer? _poll;

  @override
  void dispose() {
    _poll?.cancel();
    for (final c in [_name, _url, _header, _token, _clientId, _clientSecret, _command, _env]) {
      c.dispose();
    }
    super.dispose();
  }

  void _show(McpServer m) => setState(() {
    _m = m;
    _modes = {for (final t in m.tools) t.name: t.mode};
    _env.text = m.envKeys.map((k) => '$k=').join('\n');
    _token.clear();
    _clientSecret.clear();
  });

  Future<void> _run(Future<void> Function() job) async {
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      await job();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Map<String, String>? _envMap() {
    final out = <String, String>{};
    for (final line in _env.text.split('\n')) {
      final l = line.trim();
      if (l.isEmpty) continue;
      final i = l.indexOf('=');
      if (i < 1) return null;
      out[l.substring(0, i).trim()] = l.substring(i + 1);
    }
    return out;
  }

  Future<void> _save() async {
    final m = _m;
    final body = <String, Object?>{'name': _name.text.trim(), 'enabled': _enabled};
    if (_kind == 'remote') {
      body.addAll({'url': _url.text.trim(), 'auth': _auth, 'header': _header.text.trim().isEmpty ? 'Authorization' : _header.text.trim()});
      if (_token.text.isNotEmpty) body['token'] = _token.text;
      if (_auth == 'oauth' && (_clientId.text.trim() != (m?.clientId ?? '') || _clientSecret.text.isNotEmpty)) {
        body.addAll({'client_id': _clientId.text.trim(), 'client_secret': _clientSecret.text});
      }
    } else {
      final env = _envMap();
      if (env == null) return setState(() => _error = tr('mcp.envBad'));
      body.addAll({'command': _command.text.trim(), 'env': env});
    }
    if (m != null) body['tools'] = _modes;
    await _run(() async {
      final x = m == null ? await widget.bench.api.createMcp(widget.agentId, {...body, 'kind': _kind}) : await widget.bench.api.updateMcp(m.id, body);
      if (!mounted) return;
      if (m != null && x.status != 'signin' && x.status != 'error') {
        Navigator.of(context).pop();
      } else {
        _show(x);
      }
    });
  }

  Future<void> _signIn() => _run(() async {
    final m = _m!;
    final url = await widget.bench.api.signInMcp(m.id);
    try {
      await AppPlatform.openUrl(url);
    } on Object catch (e) {
      if (mounted) setState(() => _error = '$e');
      return;
    }
    if (mounted) setState(() => _note = tr('mcp.waiting'));
    final until = DateTime.now().add(const Duration(minutes: 5));
    _poll?.cancel();
    _poll = Timer.periodic(const Duration(seconds: 2), (t) async {
      try {
        final now = (await widget.bench.api.mcpServers(widget.agentId)).where((x) => x.id == m.id).firstOrNull;
        if (now != null && (now.signedIn || DateTime.now().isAfter(until))) {
          t.cancel();
          if (mounted) {
            _show(now);
            setState(() => _note = '');
          }
        }
      } on ApiException catch (_) {}
    });
  });

  Future<void> _delete() async {
    final m = _m!;
    if (!await _confirm(context, tr('mcp.confirmDelete', {'name': m.name}), tr('mcp.deleteBody'))) return;
    await _run(() async {
      await widget.bench.api.deleteMcp(m.id);
      if (mounted) Navigator.of(context).pop();
    });
  }

  Widget _tool(McpTool t) {
    final text = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(t.title.isNotEmpty ? t.title : t.name, style: const TextStyle(fontSize: 13)),
        Text(
          [if (t.readOnly) tr('mcp.readOnly') else if (t.destructive) tr('mcp.destructive'), t.description].where((x) => x.isNotEmpty).join(' · '),
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(fontSize: 11.5, color: C.dim2),
        ),
      ],
    );
    DropdownButton<String> pick({bool wide = false}) => DropdownButton<String>(
      key: ValueKey('mcp-mode-${t.name}'),
      value: _modes[t.name] ?? t.mode,
      isDense: true,
      isExpanded: wide,
      style: TextStyle(fontSize: 12, color: C.ink),
      items: [
        for (final v in const ['auto', 'ask', 'off']) DropdownMenuItem(value: v, child: Text(tr('mcp.mode.$v'), overflow: TextOverflow.ellipsis)),
      ],
      onChanged: (v) => setState(() => _modes[t.name] = v ?? 'ask'),
    );
    // On a phone the choice goes under the name: beside it, it didn't fit (63 px over at 360 wide ×1.3).
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: LayoutBuilder(
        builder: (context, box) => box.maxWidth < 380
            ? Column(crossAxisAlignment: CrossAxisAlignment.start, children: [text, const SizedBox(height: 2), pick(wide: true)])
            : Row(children: [Expanded(child: text), const SizedBox(width: 8), pick()]),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final m = _m;
    final small = TextStyle(fontSize: 11.5, color: C.dim2);
    final status = m == null ? null : mcpStatus(m);
    return AlertDialog(
      title: Text(m == null ? tr('mcp.new') : tr('ed.editTitle', {'name': m.name}), style: const TextStyle(fontSize: 16)),
      content: SizedBox(
        width: 520,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (m == null) ...[
                SegmentedButton<String>(
                  segments: [
                    ButtonSegment(value: 'remote', label: Text(tr('mcp.kindRemote'), style: const TextStyle(fontSize: 12))),
                    ButtonSegment(value: 'local', label: Text(tr('mcp.kindLocal'), style: const TextStyle(fontSize: 12))),
                  ],
                  selected: {_kind},
                  showSelectedIcon: false,
                  onSelectionChanged: (v) => setState(() => _kind = v.first),
                ),
                const SizedBox(height: 12),
              ],
              TextField(
                key: const ValueKey('mcp-name'),
                controller: _name,
                maxLength: 40,
                decoration: InputDecoration(hintText: tr('mcp.namePh'), counterText: ''),
              ),
              const SizedBox(height: 10),
              if (_kind == 'remote') ...[
                TextField(key: const ValueKey('mcp-url'), controller: _url, decoration: InputDecoration(hintText: tr('mcp.urlPh'))),
                const SizedBox(height: 10),
                DropdownButtonFormField<String>(
                  key: const ValueKey('mcp-auth'),
                  initialValue: _auth,
                  isExpanded: true,
                  items: [for (final v in const ['none', 'token', 'oauth']) DropdownMenuItem(value: v, child: Text(tr('mcp.auth.$v')))],
                  onChanged: (v) => setState(() => _auth = v ?? 'none'),
                ),
                if (_auth == 'token') ...[
                  const SizedBox(height: 10),
                  TextField(controller: _header, decoration: InputDecoration(hintText: tr('mcp.headerPh'))),
                  const SizedBox(height: 10),
                  TextField(
                    key: const ValueKey('mcp-token'),
                    controller: _token,
                    obscureText: true,
                    decoration: InputDecoration(hintText: tr(m?.hasSecret == true && m?.auth == 'token' ? 'mcp.tokenKeep' : 'mcp.tokenPh')),
                  ),
                ],
                if (_auth == 'oauth')
                  ExpansionTile(
                    tilePadding: EdgeInsets.zero,
                    initiallyExpanded: (m?.clientId ?? '').isNotEmpty,
                    title: Text(tr('mcp.clientSum'), style: TextStyle(fontSize: 12.5, color: C.dim)),
                    children: [
                      Text(tr('mcp.redirect', {'url': m?.redirectUri ?? ''}), style: small),
                      const SizedBox(height: 6),
                      TextField(controller: _clientId, decoration: InputDecoration(hintText: tr('mcp.clientIdPh'))),
                      const SizedBox(height: 6),
                      TextField(controller: _clientSecret, obscureText: true, decoration: InputDecoration(hintText: tr('mcp.clientSecretPh'))),
                    ],
                  ),
              ] else ...[
                TextField(
                  key: const ValueKey('mcp-command'),
                  controller: _command,
                  style: const TextStyle(fontFamily: 'monospace', fontSize: 12.5),
                  decoration: InputDecoration(hintText: tr('mcp.commandPh')),
                ),
                const SizedBox(height: 10),
                TextField(
                  key: const ValueKey('mcp-env'),
                  controller: _env,
                  minLines: 2,
                  maxLines: 6,
                  style: const TextStyle(fontFamily: 'monospace', fontSize: 12.5),
                  decoration: InputDecoration(hintText: tr('mcp.envPh')),
                ),
                const SizedBox(height: 4),
                Text(tr('mcp.envHint'), style: small),
              ],
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                dense: true,
                title: Text(tr('ed.enabled'), style: const TextStyle(fontSize: 13)),
                value: _enabled,
                onChanged: (v) => setState(() => _enabled = v),
              ),
              if (status != null)
                Text(
                  status.$1 + (m!.lastError.isNotEmpty ? ' — ${m.lastError}' : ''),
                  key: const ValueKey('mcp-status'),
                  style: TextStyle(fontSize: 12, color: m.status == 'error' || m.status == 'signin' ? C.bad : C.dim),
                ),
              if (m != null && m.kind == 'remote' && m.auth == 'oauth') ...[
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  runSpacing: 6,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    FilledButton(key: const ValueKey('mcp-signin'), onPressed: _busy ? null : _signIn, child: Text(tr('mcp.signIn'))),
                    if (m.signedIn)
                      TextButton(
                        onPressed: _busy ? null : () => _run(() async => _show(await widget.bench.api.signOutMcp(m.id))),
                        child: Text(tr('mcp.signOut')),
                      ),
                    Text(_note.isNotEmpty ? _note : m.signedIn ? tr('mcp.signedIn') : '', style: small),
                  ],
                ),
              ],
              if (m != null && m.tools.isNotEmpty) ...[
                const SizedBox(height: 10),
                Text(tr('mcp.toolsHead'), style: small),
                for (final t in m.tools) _tool(t),
              ],
              const SizedBox(height: 8),
              Text(tr('mcp.safety'), style: small),
              if (_error.isNotEmpty) ...[
                const SizedBox(height: 10),
                Text(_error, style: TextStyle(fontSize: 12, color: C.code)),
              ],
            ],
          ),
        ),
      ),
      actions: [
        if (m != null) ...[
          TextButton(
            onPressed: _busy ? null : _delete,
            style: TextButton.styleFrom(foregroundColor: C.code),
            child: Text(tr('common.delete')),
          ),
          TextButton(
            key: const ValueKey('mcp-refresh'),
            onPressed: _busy ? null : () => _run(() async => _show(await widget.bench.api.refreshMcp(m.id))),
            child: Text(tr('mcp.refresh')),
          ),
        ],
        TextButton(onPressed: _busy ? null : () => Navigator.of(context).pop(), child: Text(tr(m == null ? 'common.cancel' : 'common.close'))),
        FilledButton(
          key: const ValueKey('mcp-save'),
          onPressed: _busy ? null : _save,
          child: Text(tr(m == null ? 'ed.create' : 'common.save')),
        ),
      ],
    );
  }
}

// ── triggers ─────────────────────────────────────────────────────────────

/// Make or edit a trigger: a URL a service calls (GitHub, or any webhook). A new one stays open after saving, since
/// its address and secret have to be copied into the service and the secret is never shown again.
Future<void> showTriggerEditor(BuildContext context, Workbench bench, Conversation target, {Trigger? trigger}) =>
    showDialog<void>(
      context: context,
      builder: (_) => _TriggerEditor(bench: bench, target: target, trigger: trigger),
    );

class _TriggerEditor extends StatefulWidget {
  const _TriggerEditor({required this.bench, required this.target, this.trigger});
  final Workbench bench;
  final Conversation target;
  final Trigger? trigger;

  @override
  State<_TriggerEditor> createState() => _TriggerEditorState();
}

class _TriggerEditorState extends State<_TriggerEditor> {
  late Trigger? _t = widget.trigger;
  late String _kind = _t?.kind ?? 'github';
  late final _name = TextEditingController(text: _t?.name ?? '');
  late final _prompt = TextEditingController(text: _t?.prompt ?? '');
  late final _events = TextEditingController(text: _t?.events.join(', ') ?? '');
  late final _actions = TextEditingController(text: _t?.actions.join(', ') ?? '');
  late final _branches = TextEditingController(text: _t?.branches.join(', ') ?? '');
  late final _keywords = TextEditingController(text: _t?.keywords.join(', ') ?? '');
  late final _perHour = TextEditingController(text: '${_t?.maxPerHour ?? 6}');
  late String _agent = widget.target.isGroup ? (_t?.agentId ?? '') : '';
  late bool _enabled = _t?.enabled ?? true;
  String _secret = '';
  String _copied = '';
  String _error = '';
  bool _busy = false;

  @override
  void dispose() {
    for (final c in [_name, _prompt, _events, _actions, _branches, _keywords, _perHour]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _run(Future<void> Function() job) async {
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      await job();
      unawaited(widget.bench.loadTriggers());
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _save() => _run(() async {
    final body = <String, Object?>{
      'name': _name.text.trim(),
      'prompt': _prompt.text.trim(),
      'keywords': _keywords.text,
      'max_per_hour': int.tryParse(_perHour.text.trim()) ?? 0,
      'enabled': _enabled,
      if (_kind == 'github') ...{'events': _events.text, 'actions': _actions.text, 'branches': _branches.text},
      if (widget.target.isGroup) 'agent': _agent.isEmpty ? null : _agent,
    };
    final t = _t;
    if (t != null) {
      await widget.bench.api.updateTrigger(t.id, body);
      if (mounted) Navigator.of(context).pop();
      return;
    }
    final (made, secret) = await widget.bench.api.createTrigger({
      ...body,
      'kind': _kind,
      'target': {'kind': widget.target.kind, 'id': widget.target.id},
    });
    if (mounted) {
      setState(() {
        _t = made;
        _secret = secret;
        _agent = widget.target.isGroup ? made.agentId : '';
      });
    }
  });

  Future<void> _newSecret() async {
    final t = _t!;
    if (!await _confirm(context, tr('tg.newSecret'), tr('tg.confirmRotate', {'name': t.name}))) return;
    await _run(() async {
      final (fresh, secret) = await widget.bench.api.newTriggerSecret(t.id);
      if (mounted) {
        setState(() {
          _t = fresh;
          _secret = secret;
        });
      }
    });
  }

  Future<void> _delete() async {
    final t = _t!;
    if (!await _confirm(context, tr('tg.confirmDelete', {'name': t.name}), tr('tg.deleteBody'))) return;
    await _run(() async {
      await widget.bench.api.deleteTrigger(t.id);
      if (mounted) Navigator.of(context).pop();
    });
  }

  static bool _local(String url) {
    final h = Uri.tryParse(url)?.host ?? '';
    return h == 'localhost' || h.startsWith('127.') || h == '::1' || h == '0.0.0.0';
  }

  Widget _copyRow(String key, String text) => Padding(
    padding: const EdgeInsets.only(top: 6),
    child: Row(
      children: [
        Expanded(
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
            decoration: BoxDecoration(color: C.field, borderRadius: BorderRadius.circular(6)),
            child: SelectableText(text, style: const TextStyle(fontSize: 12, fontFamily: 'monospace')),
          ),
        ),
        const SizedBox(width: 6),
        TextButton(
          key: ValueKey('tg-copy-$key'),
          onPressed: () async {
            await Clipboard.setData(ClipboardData(text: text));
            if (mounted) setState(() => _copied = key);
          },
          child: Text(tr(_copied == key ? 'tg.copied' : 'tg.copy'), style: const TextStyle(fontSize: 12)),
        ),
      ],
    ),
  );

  String _status(Trigger t) {
    if (t.lastAt == null) return tr('tg.never');
    final why = t.lastError;
    final result = switch (t.lastStatus) {
      'fired' => tr('tg.st.fired'),
      'skipped' => tr('tg.st.skipped', {'why': why}),
      'limited' => tr('tg.st.limited'),
      'failed' => tr('tg.st.failed', {'why': why}),
      _ => '',
    };
    final at = DateTime.fromMillisecondsSinceEpoch(t.lastAt!);
    return tr('tg.last', {'time': '${at.year}/${at.month}/${at.day} ${_clock(at)}', 'result': result});
  }

  @override
  Widget build(BuildContext context) {
    final t = _t;
    final small = TextStyle(fontSize: 11.5, color: C.dim2);
    final members = widget.target.members;
    return AlertDialog(
      title: Text(t == null ? tr('tg.new') : tr('ed.editTitle', {'name': t.name}), style: const TextStyle(fontSize: 16)),
      content: SizedBox(
        width: 480,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (t == null) ...[
                SegmentedButton<String>(
                  segments: [
                    ButtonSegment(value: 'github', label: Text(tr('tg.kindGithub'), style: const TextStyle(fontSize: 12))),
                    ButtonSegment(value: 'webhook', label: Text(tr('tg.kindWebhookShort'), style: const TextStyle(fontSize: 12))),
                  ],
                  selected: {_kind},
                  showSelectedIcon: false,
                  onSelectionChanged: (v) => setState(() => _kind = v.first),
                ),
                const SizedBox(height: 12),
              ],
              TextField(
                key: const ValueKey('tg-name'),
                controller: _name,
                autofocus: t == null,
                maxLength: 60,
                decoration: InputDecoration(hintText: tr('tg.namePh'), counterText: ''),
              ),
              const SizedBox(height: 10),
              TextField(
                key: const ValueKey('tg-prompt'),
                controller: _prompt,
                minLines: 3,
                maxLines: 8,
                decoration: InputDecoration(hintText: tr('tg.promptPh')),
              ),
              if (widget.target.isGroup) ...[
                const SizedBox(height: 10),
                DropdownButtonFormField<String>(
                  key: const ValueKey('tg-agent'),
                  initialValue: members.contains(_agent) ? _agent : '',
                  isExpanded: true,
                  decoration: InputDecoration(labelText: tr('tg.agent')),
                  items: [
                    DropdownMenuItem(value: '', child: Text(tr('tg.lead'), overflow: TextOverflow.ellipsis)),
                    for (final id in members)
                      DropdownMenuItem(value: id, child: Text(widget.bench.agentById(id)?.name ?? id, overflow: TextOverflow.ellipsis)),
                  ],
                  onChanged: (v) => setState(() => _agent = v ?? ''),
                ),
              ],
              if (_kind == 'github') ...[
                const SizedBox(height: 10),
                TextField(key: const ValueKey('tg-events'), controller: _events, decoration: InputDecoration(hintText: tr('tg.eventsPh'))),
                const SizedBox(height: 10),
                TextField(controller: _actions, decoration: InputDecoration(hintText: tr('tg.actionsPh'))),
                const SizedBox(height: 10),
                TextField(controller: _branches, decoration: InputDecoration(hintText: tr('tg.branchesPh'))),
              ],
              const SizedBox(height: 10),
              TextField(controller: _keywords, decoration: InputDecoration(hintText: tr('tg.keywordsPh'))),
              const SizedBox(height: 10),
              Row(
                children: [
                  SizedBox(
                    width: 80,
                    child: TextField(controller: _perHour, keyboardType: TextInputType.number),
                  ),
                  const SizedBox(width: 10),
                  Expanded(child: Text(tr('tg.perHour'), style: TextStyle(fontSize: 12, color: C.dim))),
                ],
              ),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                dense: true,
                title: Text(tr('ed.enabled'), style: const TextStyle(fontSize: 13)),
                value: _enabled,
                onChanged: (v) => setState(() => _enabled = v),
              ),
              if (t != null) ...[
                Text(
                  tr(t.kind == 'github' ? 'tg.howGithub' : 'tg.howWebhook') + (_local(t.url) ? ' ${tr('tg.localUrl')}' : ''),
                  style: small,
                ),
                _copyRow('url', t.url),
                if (_secret.isNotEmpty) _copyRow('secret', _secret),
                const SizedBox(height: 6),
                Text(tr(_secret.isNotEmpty ? 'tg.secretOnce' : 'tg.secretHidden'), style: small),
                const SizedBox(height: 6),
                Text(_status(t), style: TextStyle(fontSize: 11.5, color: C.dim)),
              ],
              const SizedBox(height: 8),
              Text(tr('tg.safety'), style: small),
              if (_error.isNotEmpty) ...[
                const SizedBox(height: 10),
                Text(_error, style: TextStyle(fontSize: 12, color: C.code)),
              ],
            ],
          ),
        ),
      ),
      actions: [
        if (t != null) ...[
          TextButton(
            onPressed: _busy ? null : _delete,
            style: TextButton.styleFrom(foregroundColor: C.code),
            child: Text(tr('common.delete')),
          ),
          TextButton(key: const ValueKey('tg-rotate'), onPressed: _busy ? null : _newSecret, child: Text(tr('tg.newSecret'))),
        ],
        TextButton(onPressed: _busy ? null : () => Navigator.of(context).pop(), child: Text(tr(t == null ? 'common.cancel' : 'common.close'))),
        FilledButton(
          key: const ValueKey('tg-save'),
          onPressed: _busy ? null : _save,
          child: Text(tr(t == null ? 'ed.create' : 'common.save')),
        ),
      ],
    );
  }
}

/// Give an agent a secret by hand. The value goes in once and is never shown again.
Future<void> showSecretEditor(BuildContext context, Workbench bench, String agentId) =>
    showDialog<void>(context: context, builder: (_) => _SecretEditor(bench: bench, agentId: agentId));

class _SecretEditor extends StatefulWidget {
  const _SecretEditor({required this.bench, required this.agentId});
  final Workbench bench;
  final String agentId;

  @override
  State<_SecretEditor> createState() => _SecretEditorState();
}

class _SecretEditorState extends State<_SecretEditor> {
  final _name = TextEditingController();
  final _origin = TextEditingController();
  final _header = TextEditingController();
  final _format = TextEditingController();
  final _value = TextEditingController();
  String _kind = 'header';
  String _error = '';
  bool _busy = false;

  @override
  void dispose() {
    for (final c in [_name, _origin, _header, _format, _value]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      await widget.bench.api.addSecret(widget.agentId, {
        'name': _name.text.trim(),
        'kind': _kind,
        'origin': _origin.text.trim(),
        'header': _header.text.trim(),
        'format': _format.text,
        'value': _value.text,
      });
      _value.clear();
      if (mounted) Navigator.of(context).pop();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    scrollable: true,
    title: Text(tr('sec.addTitle'), style: const TextStyle(fontSize: 16)),
    content: SizedBox(
      width: 420,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          TextField(controller: _name, autocorrect: false, decoration: InputDecoration(hintText: tr('sec.namePh'))),
          const SizedBox(height: 10),
          DropdownButtonFormField<String>(
            initialValue: _kind,
            isExpanded: true,
            items: [
              DropdownMenuItem(value: 'header', child: Text(tr('sec.kindHeader'), overflow: TextOverflow.ellipsis)),
              DropdownMenuItem(value: 'login', child: Text(tr('sec.kindLogin'), overflow: TextOverflow.ellipsis)),
            ],
            onChanged: (v) => setState(() => _kind = v ?? 'header'),
          ),
          const SizedBox(height: 10),
          TextField(controller: _origin, autocorrect: false, decoration: InputDecoration(hintText: tr('sec.originPh'))),
          if (_kind == 'header') ...[
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(child: TextField(controller: _header, autocorrect: false, decoration: InputDecoration(hintText: tr('sec.headerPh')))),
                const SizedBox(width: 10),
                Expanded(child: TextField(controller: _format, autocorrect: false, decoration: InputDecoration(hintText: tr('sec.formatPh')))),
              ],
            ),
          ],
          const SizedBox(height: 10),
          TextField(
            controller: _value,
            obscureText: true,
            autocorrect: false,
            enableSuggestions: false,
            decoration: InputDecoration(hintText: tr('sec.valuePh')),
          ),
          const SizedBox(height: 8),
          Text(tr('sec.hint'), style: TextStyle(fontSize: 11.5, color: C.dim2)),
          if (_error.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(_error, style: TextStyle(fontSize: 12, color: C.code)),
          ],
        ],
      ),
    ),
    actions: [
      TextButton(onPressed: _busy ? null : () => Navigator.of(context).pop(), child: Text(tr('common.cancel'))),
      FilledButton(onPressed: _busy ? null : _save, child: Text(tr('common.save'))),
    ],
  );
}
