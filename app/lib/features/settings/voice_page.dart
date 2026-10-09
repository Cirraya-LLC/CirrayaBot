/// Voice settings: which engine hears and which speaks (the server's setting — this device's own,
/// or one of the person's upstreams), and what only this device decides (the language spoken, the
/// device voice, reading replies aloud). Model and voice names are typed; what the chosen upstream
/// lists is offered as suggestions, and nothing else is suggested.
library;

import 'package:flutter/material.dart';

import '../../data/api.dart';
import '../../data/voice.dart';
import '../../l10n.dart';
import '../../state/voice.dart';
import '../../theme/app_theme.dart';

const voiceLanguages = [
  ('en-US', 'English (US)'), ('en-GB', 'English (UK)'), ('en-IN', 'English (India)'), ('es-ES', 'Español'),
  ('fr-FR', 'Français'), ('de-DE', 'Deutsch'), ('it-IT', 'Italiano'), ('pt-BR', 'Português (Brasil)'), ('nl-NL', 'Nederlands'),
  ('pl-PL', 'Polski'), ('tr-TR', 'Türkçe'), ('ru-RU', 'Русский'), ('uk-UA', 'Українська'), ('ar-SA', 'العربية'),
  ('hi-IN', 'हिन्दी'), ('id-ID', 'Bahasa Indonesia'), ('vi-VN', 'Tiếng Việt'), ('th-TH', 'ไทย'), ('ja-JP', '日本語'),
  ('ko-KR', '한국어'), ('zh-CN', '中文（普通话）'), ('zh-TW', '中文（台灣）'), ('zh-HK', '粵語（香港）'),
];

class VoicePage extends StatefulWidget {
  const VoicePage({super.key, required this.voice});
  final VoiceController voice;

  @override
  State<VoicePage> createState() => _VoicePageState();
}

class _VoicePageState extends State<VoicePage> {
  VoiceController get v => widget.voice;
  List<Provider> _providers = const [];
  List<({String name, String lang})> _voices = const [];
  final _models = <String, List<String>>{};
  bool _loading = true;
  String _status = '';
  bool _bad = false;

  late String _sttMode = v.settings.stt.mode, _ttsMode = v.settings.tts.mode;
  late String _sttProv = v.settings.stt.providerId, _ttsProv = v.settings.tts.providerId;
  late final _sttModel = TextEditingController(text: v.settings.stt.model);
  late final _ttsModel = TextEditingController(text: v.settings.tts.model);
  late final _ttsVoice = TextEditingController(text: v.settings.tts.voice);
  late String _lang = v.prefs.lang;
  late String _deviceVoice = v.prefs.voice;
  late bool _autoRead = v.prefs.autoRead;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      _providers = await v.bench.api.providers();
    } on ApiException {
      // the pickers show only "default upstream"
    }
    try {
      _voices = await v.engine.voices();
    } catch (_) {
      // no device voices to choose from: automatic
    }
    if (!mounted) return;
    setState(() => _loading = false);
    _loadModels(_sttProv);
    _loadModels(_ttsProv);
  }

  Future<void> _loadModels(String providerId) async {
    if (_models.containsKey(providerId)) return;
    _models[providerId] = const [];
    try {
      final r = await v.bench.api.models(providerId);
      _models[providerId] = r.models;
    } on ApiException {
      // typed by hand then
    }
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _sttModel.dispose();
    _ttsModel.dispose();
    _ttsVoice.dispose();
    super.dispose();
  }

  Future<bool> _save() async {
    await v.savePrefs(v.prefs.copyWith(
      lang: _lang,
      voice: _deviceVoice,
      voiceLang: _voices.where((x) => x.name == _deviceVoice).firstOrNull?.lang ?? '',
      autoRead: _autoRead,
    ));
    try {
      await v.saveSettings(VoiceSettings(
        stt: VoicePart(mode: _sttMode, providerId: _sttProv, model: _sttModel.text.trim()),
        tts: VoicePart(mode: _ttsMode, providerId: _ttsProv, model: _ttsModel.text.trim(), voice: _ttsVoice.text.trim()),
      ));
      setState(() {
        _status = tr('vo.saved');
        _bad = false;
      });
      return true;
    } on ApiException catch (e) {
      setState(() {
        _status = e.message;
        _bad = true;
      });
      return false;
    }
  }

  Future<void> _try() async {
    if (!await _save()) return;
    await v.stopSpeaking();
    v.say(tr('vo.sample'), v.bench.current?.isGroup == false ? v.bench.current!.id : null);
  }

  Widget _mode(String value, ValueChanged<String> onChanged, String label) => DropdownButtonFormField<String>(
    initialValue: value,
    isExpanded: true,
    decoration: InputDecoration(labelText: label),
    items: [
      DropdownMenuItem(value: 'device', child: Text(tr('vo.modeDevice'))),
      DropdownMenuItem(value: 'upstream', child: Text(tr('vo.modeUpstream'))),
    ],
    onChanged: (x) => setState(() => onChanged(x ?? 'device')),
  );

  Widget _provider(String value, ValueChanged<String> onChanged) {
    final def = _providers.where((p) => p.isDefault).firstOrNull;
    return DropdownButtonFormField<String>(
      key: ValueKey('prov-${_providers.length}-$value'),
      initialValue: _providers.any((p) => p.id == value) ? value : '',
      isExpanded: true,
      decoration: InputDecoration(labelText: tr('vo.provTitle')),
      items: [
        DropdownMenuItem(value: '', child: Text(def == null ? tr('vo.defaultProv') : tr('vo.defaultProvNamed', {'name': def.name}), overflow: TextOverflow.ellipsis)),
        for (final p in _providers)
          DropdownMenuItem(
            value: p.id,
            enabled: p.protocol != 'messages',
            child: Text(p.protocol == 'messages' ? '${p.name}${tr('vo.noSpeech')}' : p.name, overflow: TextOverflow.ellipsis),
          ),
      ],
      onChanged: (x) {
        setState(() => onChanged(x ?? ''));
        _loadModels(x ?? '');
      },
    );
  }

  /// A typed name, with what the upstream lists as suggestions.
  Widget _model(TextEditingController ctl, String providerId, String hint) => Autocomplete<String>(
    key: ValueKey('model-$providerId-$hint'),
    initialValue: ctl.value,
    optionsBuilder: (t) {
      final all = _models[providerId] ?? const [];
      final q = t.text.trim().toLowerCase();
      return q.isEmpty ? all.take(50) : all.where((m) => m.toLowerCase().contains(q)).take(50);
    },
    onSelected: (m) => ctl.text = m,
    fieldViewBuilder: (context, field, focus, onSubmit) => TextField(
      controller: field,
      focusNode: focus,
      autocorrect: false,
      onChanged: (t) => ctl.text = t,
      decoration: InputDecoration(labelText: hint),
    ),
  );

  Widget _note(String text) => Padding(
    padding: const EdgeInsets.only(top: 6),
    child: Text(text, style: TextStyle(fontSize: 12, color: C.dim2, height: 1.45)),
  );

  Widget _head(String text) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Text(text, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
  );

  @override
  Widget build(BuildContext context) {
    final sttUp = _sttMode == 'upstream', ttsUp = _ttsMode == 'upstream';
    return Scaffold(
      appBar: AppBar(backgroundColor: C.side, title: Text(tr('vo.title'), style: const TextStyle(fontSize: 15))),
      body: _loading
          ? Center(child: CircularProgressIndicator(strokeWidth: 2, color: C.dim))
          : Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 620),
                child: ListView(
                  padding: const EdgeInsets.all(22),
                  children: [
                    _head(tr('vo.hear')),
                    _mode(_sttMode, (x) => _sttMode = x, tr('vo.engine')),
                    if (sttUp) ...[
                      const SizedBox(height: 10),
                      _provider(_sttProv, (x) => _sttProv = x),
                      const SizedBox(height: 10),
                      _model(_sttModel, _sttProv, tr('vo.sttModelPh')),
                    ],
                    const SizedBox(height: 10),
                    DropdownButtonFormField<String>(
                      initialValue: voiceLanguages.any((l) => l.$1 == _lang) ? _lang : '',
                      isExpanded: true,
                      decoration: InputDecoration(labelText: tr('vo.langTitle')),
                      items: [
                        DropdownMenuItem(
                          value: '',
                          child: Text(sttUp ? tr('vo.langDetect') : tr('vo.langAuto', {'l': v.hearLangFor('')}), overflow: TextOverflow.ellipsis),
                        ),
                        for (final l in voiceLanguages) DropdownMenuItem(value: l.$1, child: Text('${l.$2} · ${l.$1}')),
                      ],
                      onChanged: (x) => setState(() => _lang = x ?? ''),
                    ),
                    _note(sttUp ? tr('vo.sttUpNote') : v.deviceHears ? tr('vo.sttDevNote') : tr('vo.noRecognizer')),
                    const SizedBox(height: 22),
                    const Divider(height: 1),
                    const SizedBox(height: 18),
                    _head(tr('vo.speak')),
                    _mode(_ttsMode, (x) => _ttsMode = x, tr('vo.engine')),
                    const SizedBox(height: 10),
                    if (ttsUp) ...[
                      _provider(_ttsProv, (x) => _ttsProv = x),
                      const SizedBox(height: 10),
                      _model(_ttsModel, _ttsProv, tr('vo.ttsModelPh')),
                      const SizedBox(height: 10),
                      TextField(
                        controller: _ttsVoice,
                        autocorrect: false,
                        decoration: InputDecoration(labelText: tr('vo.voicePh')),
                      ),
                    ] else
                      DropdownButtonFormField<String>(
                        initialValue: _voices.any((x) => x.name == _deviceVoice) ? _deviceVoice : '',
                        isExpanded: true,
                        decoration: InputDecoration(labelText: tr('vo.devVoiceTitle')),
                        items: [
                          DropdownMenuItem(value: '', child: Text(tr('vo.devVoiceAuto'), overflow: TextOverflow.ellipsis)),
                          for (final x in _voices)
                            DropdownMenuItem(value: x.name, child: Text('${x.name} · ${x.lang}', overflow: TextOverflow.ellipsis)),
                        ],
                        onChanged: (x) => setState(() => _deviceVoice = x ?? ''),
                      ),
                    _note(ttsUp ? tr('vo.ttsUpNote') : v.deviceSpeaks ? tr('vo.ttsDevNote') : tr('vo.noVoices')),
                    const SizedBox(height: 14),
                    SwitchListTile(
                      contentPadding: EdgeInsets.zero,
                      value: _autoRead,
                      onChanged: (x) => setState(() => _autoRead = x),
                      title: Text(tr('vo.autoRead'), style: const TextStyle(fontSize: 13.5)),
                    ),
                    if (_status.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 6),
                        child: Text(_status, style: TextStyle(fontSize: 12.5, color: _bad ? C.bad : C.ok)),
                      ),
                    const SizedBox(height: 14),
                    Wrap(
                      spacing: 10,
                      runSpacing: 8,
                      alignment: WrapAlignment.end,
                      children: [
                        OutlinedButton(onPressed: _try, child: Text(tr('vo.try'))),
                        FilledButton(
                          onPressed: () async {
                            if (await _save() && context.mounted) Navigator.of(context).pop();
                          },
                          child: Text(tr('common.save')),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
    );
  }
}
