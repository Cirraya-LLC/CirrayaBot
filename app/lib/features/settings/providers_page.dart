/// Model upstreams: name, address, key, protocol, context window.
/// No model — each Agent picks its own (see the Agent editor).
///
/// Same three questions the web UI answers, because they are the ones that
/// matter when something is wrong: which one is in use, can it be reached,
/// and how big is its window.
library;

import 'package:flutter/material.dart';

import '../../data/api.dart';
import '../../l10n.dart';
import '../../theme/app_theme.dart';

/// The three wire formats the server can speak to an upstream.
const protocolLabels = {'chat': 'Chat Completions', 'responses': 'Responses', 'messages': 'Messages'};

class ProvidersPage extends StatefulWidget {
  const ProvidersPage({super.key, required this.api});
  final Api api;

  @override
  State<ProvidersPage> createState() => _ProvidersPageState();
}

class _ProvidersPageState extends State<ProvidersPage> {
  List<Provider> _rows = const [];
  Provider? _editing;
  bool _loading = true;

  final _name = TextEditingController();
  final _url = TextEditingController();
  final _key = TextEditingController();
  final _tokens = TextEditingController();

  /// Prices per million tokens and the platform-wide cap, in dollars as typed.
  final _priceIn = TextEditingController();
  final _priceOut = TextEditingController();
  final _defaultCap = TextEditingController();
  bool _auto = true;
  bool _busy = false;
  String _protocol = 'chat';
  String _hint = '';
  Color _hintColor = C.dim;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    for (final c in [_name, _url, _key, _tokens, _priceIn, _priceOut, _defaultCap]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _load() async {
    try {
      _rows = await widget.api.providers();
      _defaultCap.text = dollarsText((await widget.api.usage()).defaultCapMicro);
      _fill(_rows.where((p) => p.isDefault).firstOrNull ?? _rows.firstOrNull);
    } on ApiException catch (e) {
      _say(e.message, bad: true);
    }
    if (mounted) setState(() => _loading = false);
  }

  void _fill(Provider? p) {
    _editing = p;
    _name.text = p?.name ?? '';
    _url.text = p?.baseUrl ?? '';
    _protocol = p?.protocol ?? 'chat';
    _key.text = '';
    _tokens.text = p == null ? '' : '${p.contextTokens}';
    _priceIn.text = dollarsText(p?.priceInMicro);
    _priceOut.text = dollarsText(p?.priceOutMicro);
    _auto = p?.autoContext ?? true;
    _hint = p == null ? '' : (p.autoContext ? p.ctxSource : tr('prov.ctxManual', {'n': p.contextTokens, 'source': p.ctxSource}));
    _hintColor = C.dim;
    if (mounted) setState(() {});
  }

  void _say(String text, {bool bad = false, bool good = false}) {
    if (!mounted) return;
    setState(() {
      _hint = text;
      _hintColor = bad ? C.code : (good ? C.ok : C.dim);
    });
  }

  Map<String, Object?> get _body => {
    if (_editing != null) 'id': _editing!.id,
    'name': _name.text.trim(),
    'base_url': _url.text.trim(),
    'protocol': _protocol,
    'api_key': _key.text,
    'auto_context': _auto,
    if (!_auto) 'context_tokens': int.tryParse(_tokens.text.trim()) ?? 128000,
    // null means "not known" — never a price of zero.
    'price_in_micro': parseDollars(_priceIn.text).value,
    'price_out_micro': parseDollars(_priceOut.text).value,
  };

  /// Every button goes through here: one request at a time (a second click on
  /// Save while the first is still probing the upstream made a duplicate),
  /// errors land in the hint line, and nothing touches state after the page
  /// is gone.
  Future<void> _act(String doing, Future<void> Function() job) async {
    if (_busy) return;
    setState(() => _busy = true);
    _say(doing);
    try {
      await job();
    } on ApiException catch (e) {
      _say(e.message, bad: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _test() => _act(tr('prov.connecting'), () async {
    final r = await widget.api.testProvider(_body);
    if (r['ok'] == true) {
      _say(
        tr('prov.testOk', {'ms': r['ms'], 'models': r['models'], 'model': r['model'], 'reply': r['reply']}),
        good: true,
      );
    } else {
      _say(tr('prov.testFail', {'error': r['error']}), bad: true);
    }
  });

  Future<void> _save() async {
    if (_name.text.trim().isEmpty || _url.text.trim().isEmpty) {
      _say(tr('prov.needFields'), bad: true);
      return;
    }
    if (!parseDollars(_priceIn.text).ok || !parseDollars(_priceOut.text).ok) {
      _say(tr('prov.badPrice'), bad: true);
      return;
    }
    await _act(tr('prov.saving'), () async {
      final saved = await widget.api.saveProvider(_body, id: _editing?.id);
      _rows = await widget.api.providers();
      _fill(_rows.where((p) => p.id == saved.id).firstOrNull);
      _say(
        saved.autoContext
            ? tr('prov.savedAuto', {'source': saved.ctxSource})
            : tr('prov.savedManual', {'n': saved.contextTokens}),
        good: true,
      );
    });
  }

  Future<void> _saveDefaultCap() async {
    final cap = parseDollars(_defaultCap.text);
    if (!cap.ok) {
      _say(tr('prov.badPrice'), bad: true);
      return;
    }
    await _act(tr('prov.saving'), () async {
      await widget.api.setDefaultCap(cap.value);
      _say(tr('prov.capSaved', {'cap': cap.value == null ? tr('prov.noCap') : moneyText(cap.value)}), good: true);
    });
  }

  Future<void> _delete() async {
    final p = _editing!;
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text(tr('prov.deleteTitle', {'name': p.name}), style: const TextStyle(fontSize: 15)),
        content: Text(tr('prov.deleteBody'), style: TextStyle(fontSize: 13, color: C.dim)),
        actions: [
          TextButton(onPressed: () => Navigator.of(c).pop(false), child: Text(tr('common.cancel'))),
          FilledButton(
            onPressed: () => Navigator.of(c).pop(true),
            style: FilledButton.styleFrom(backgroundColor: C.code),
            child: Text(tr('common.delete')),
          ),
        ],
      ),
    );
    if (ok != true) return;
    await _act(tr('prov.deleting'), () async {
      await widget.api.deleteProvider(p.id);
      _rows = await widget.api.providers();
      _fill(_rows.where((p) => p.isDefault).firstOrNull ?? _rows.firstOrNull);
      _say(tr('prov.deleted', {'name': p.name}), good: true);
    });
  }

  Future<void> _makeDefault(Provider p) => _act(tr('prov.switching'), () async {
    await widget.api.makeDefaultProvider(p.id);
    _rows = await widget.api.providers();
    if (mounted) setState(() {});
    _say(tr('prov.nowUsing', {'name': p.name}), good: true);
  });

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        backgroundColor: C.side,
        title: Text(tr('prov.title'), style: const TextStyle(fontSize: 15)),
      ),
      body: _loading
          ? Center(child: CircularProgressIndicator(strokeWidth: 2, color: C.dim))
          : Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 620),
                child: ListView(
                  padding: const EdgeInsets.all(22),
                  children: [
                    if (_rows.isEmpty)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 8),
                        child: Text(tr('prov.none'), style: TextStyle(fontSize: 12.5, color: C.dim2)),
                      ),
                    for (final p in _rows) _row(p),
                    const SizedBox(height: 18),
                    const Divider(height: 1),
                    const SizedBox(height: 16),
                    Text(
                      _editing == null ? tr('prov.addTitle') : tr('prov.editTitle', {'name': _editing!.name}),
                      style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _name,
                      decoration: InputDecoration(hintText: tr('prov.nameHint')),
                    ),
                    const SizedBox(height: 9),
                    SegmentedButton<String>(
                      segments: [
                        for (final e in protocolLabels.entries)
                          ButtonSegment(
                            value: e.key,
                            label: Text(e.value, style: const TextStyle(fontSize: 12)),
                          ),
                      ],
                      selected: {_protocol},
                      showSelectedIcon: false,
                      onSelectionChanged: (v) => setState(() => _protocol = v.first),
                    ),
                    const SizedBox(height: 10),
                    TextField(
                      controller: _url,
                      decoration: InputDecoration(hintText: tr('prov.urlHint')),
                    ),
                    const SizedBox(height: 9),
                    TextField(
                      controller: _key,
                      obscureText: true,
                      decoration: InputDecoration(
                        hintText: _editing?.keyHint.isNotEmpty == true
                            ? tr('prov.keySaved', {'hint': _editing!.keyHint})
                            : 'API Key',
                      ),
                    ),
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        _radio(tr('prov.ctxAuto'), true),
                        const SizedBox(width: 14),
                        _radio(tr('prov.ctxManualLabel'), false),
                        const SizedBox(width: 12),
                        SizedBox(
                          width: 118,
                          child: TextField(
                            controller: _tokens,
                            enabled: !_auto,
                            decoration: const InputDecoration(hintText: '128000'),
                          ),
                        ),
                        const SizedBox(width: 9),
                        TextButton(onPressed: _busy ? null : _test, child: Text(tr('setup.test'))),
                      ],
                    ),
                    const SizedBox(height: 10),
                    Row(
                      children: [
                        Expanded(
                          child: TextField(
                            controller: _priceIn,
                            decoration: InputDecoration(labelText: tr('prov.priceIn'), hintText: '1.25'),
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: TextField(
                            controller: _priceOut,
                            decoration: InputDecoration(labelText: tr('prov.priceOut'), hintText: '10'),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Text(tr('prov.priceHint'), style: TextStyle(fontSize: 11.5, color: C.dim2)),
                    const SizedBox(height: 14),
                    const Divider(height: 1),
                    const SizedBox(height: 12),
                    // Not a property of any one upstream: it is what every agent without a
                    // cap of its own falls back to, so it saves on its own button.
                    Row(
                      children: [
                        Expanded(
                          child: TextField(
                            controller: _defaultCap,
                            decoration: InputDecoration(labelText: tr('prov.defaultCap'), hintText: '5'),
                          ),
                        ),
                        const SizedBox(width: 9),
                        TextButton(onPressed: _busy ? null : _saveDefaultCap, child: Text(tr('common.save'))),
                      ],
                    ),
                    const SizedBox(height: 10),
                    Text(_hint, style: TextStyle(fontSize: 11.5, color: _hintColor)),
                    const SizedBox(height: 16),
                    Row(
                      children: [
                        if (_editing != null && _rows.length > 1)
                          TextButton(
                            onPressed: _busy ? null : _delete,
                            child: Text(tr('common.delete'), style: TextStyle(color: C.code)),
                          ),
                        const Spacer(),
                        TextButton(onPressed: () => _fill(null), child: Text(tr('prov.new'))),
                        const SizedBox(width: 9),
                        FilledButton(onPressed: _busy ? null : _save, child: Text(tr('common.save'))),
                      ],
                    ),
                  ],
                ),
              ),
            ),
    );
  }

  Widget _radio(String label, bool value) => InkWell(
    onTap: () => setState(() => _auto = value),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        // Hand-drawn, not Radio: Radio is deprecated in 3.47 and its
        // replacement RadioGroup is built for shared-state groups — two
        // exclusive options need only a bool.
        Container(
          width: 14,
          height: 14,
          margin: const EdgeInsets.only(right: 6),
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            border: Border.all(color: _auto == value ? C.accent : C.dim2, width: 1.5),
          ),
          child: _auto == value
              ? Center(
                  child: Container(
                    width: 6,
                    height: 6,
                    decoration: BoxDecoration(color: C.accent, shape: BoxShape.circle),
                  ),
                )
              : null,
        ),
        Text(label, style: TextStyle(fontSize: 12.5, color: C.dim)),
      ],
    ),
  );

  Widget _row(Provider p) {
    final on = _editing?.id == p.id;
    return InkWell(
      onTap: () => _fill(p),
      borderRadius: BorderRadius.circular(9),
      child: Container(
        margin: const EdgeInsets.only(bottom: 4),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
        decoration: BoxDecoration(
          color: on ? C.tint : null,
          border: Border.all(color: on ? C.accent : Colors.transparent),
          borderRadius: BorderRadius.circular(9),
        ),
        child: Row(
          children: [
            // The dot is both the "in use" marker and the switch. One green
            // dot means one upstream is answering right now.
            Tooltip(
              message: p.isDefault ? tr('prov.inUse') : tr('prov.makeDefault'),
              child: InkWell(
                onTap: p.isDefault || _busy ? null : () => _makeDefault(p),
                customBorder: const CircleBorder(),
                // 10px is too small to hit; pad the tap target, not the dot.
                child: Padding(
                  padding: const EdgeInsets.all(7),
                  child: Container(
                    width: 10,
                    height: 10,
                    decoration: BoxDecoration(
                      color: p.isDefault ? C.ok : C.chipStrong,
                      shape: BoxShape.circle,
                    ),
                  ),
                ),
              ),
            ),
            const SizedBox(width: 4),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(p.name, style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600)),
                  Text(
                    '${protocolLabels[p.protocol] ?? 'Chat'} · ${p.autoContext ? tr('prov.ctxAuto') : '${(p.contextTokens / 1000).round()}k'} · ${p.baseUrl}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 11.5, color: C.dim),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
