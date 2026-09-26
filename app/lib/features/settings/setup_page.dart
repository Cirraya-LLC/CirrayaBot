/// Where the server is. This is the whole of "signing in".
///
/// There are no accounts — the server has one shared access token. So this
/// screen asks for an address and a token, and accepts the link the server
/// prints on startup pasted whole, because that is what people will do.
library;

import 'package:flutter/material.dart';

import '../../data/api.dart';
import '../../data/settings.dart';
import '../../l10n.dart';
import '../../theme/app_theme.dart';

class SetupPage extends StatefulWidget {
  const SetupPage({super.key, required this.initial, required this.onSaved, this.onCancel});

  final Settings initial;
  final ValueChanged<Settings> onSaved;
  /// Null on first run: there is nothing to go back to.
  ///
  /// ⚠️ A callback, not `Navigator.maybePop`. This page is swapped in as
  /// `home`, not pushed, so there is no route to pop and the button did nothing.
  final VoidCallback? onCancel;

  @override
  State<SetupPage> createState() => _SetupPageState();
}

class _SetupPageState extends State<SetupPage> {
  late final _url = TextEditingController(text: widget.initial.baseUrl);
  late final _token = TextEditingController(text: widget.initial.token);
  String _status = '';
  bool _bad = false;
  bool _testing = false;

  @override
  void dispose() {
    _url.dispose();
    _token.dispose();
    super.dispose();
  }

  /// What the two fields mean, read once, at the moment it matters.
  ///
  /// A whole `http://host:8080/?k=TOKEN` link in the address field is split
  /// here rather than in `onChanged`. ⚠️ Doing it per keystroke rewrites the
  /// controller mid-typing: the moment `?k=` appears the field is replaced
  /// with just the host, and every character after that lands on the end of
  /// the *rewritten* value — you get `http://host:8080TOKEN`. Pasting looked
  /// fine, which is exactly why this survived being tried.
  Settings get _settings {
    final typed = _url.text.trim();
    final token = _token.text.trim();
    if (typed.contains('k=')) {
      final parsed = Settings.fromPastedLink(typed);
      if (parsed != null && parsed.token.isNotEmpty) {
        return Settings(baseUrl: parsed.baseUrl, token: token.isEmpty ? parsed.token : token);
      }
    }
    return Settings(baseUrl: Settings.normaliseUrl(typed), token: token);
  }

  /// Puts back what we understood, so the person can see the split happened
  /// instead of wondering where their token went.
  void _reflect() {
    final s = _settings;
    if (_url.text.trim() != s.baseUrl) _url.text = s.baseUrl;
    if (_token.text.trim() != s.token) _token.text = s.token;
    setState(() {});
  }

  Future<void> _test() async {
    setState(() {
      _testing = true;
      _status = tr('setup.connecting');
      _bad = false;
    });
    _reflect();
    final api = Api(_settings);
    try {
      final convs = await api.conversations();
      if (!mounted) return;
      setState(() {
        _status = tr('setup.ok', {'n': convs.length});
        _bad = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _status = e.message;
        _bad = true;
      });
    } finally {
      api.close();
      if (mounted) setState(() => _testing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: SingleChildScrollView(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 460),
            child: Padding(
              padding: const EdgeInsets.all(28),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Row(
                    children: [
                      const Text(
                        'CirrayaBot',
                        style: TextStyle(fontSize: 22, fontWeight: FontWeight.w600),
                      ),
                      const Spacer(),
                      DropdownButton<Lang>(
                        value: currentLang.value,
                        underline: const SizedBox.shrink(),
                        style: TextStyle(fontSize: 12.5, color: C.dim),
                        items: [
                          for (final l in Lang.values) DropdownMenuItem(value: l, child: Text(l.label)),
                        ],
                        onChanged: (l) {
                          if (l != null) currentLang.value = l;
                        },
                      ),
                    ],
                  ),
                  const SizedBox(height: 6),
                  Text(
                    tr('setup.intro'),
                    style: TextStyle(fontSize: 12.5, color: C.dim, height: 1.6),
                  ),
                  const SizedBox(height: 20),
                  TextField(
                    controller: _url,
                    onChanged: (_) => setState(() {}),
                    onSubmitted: (_) => _reflect(),
                    autofocus: true,
                    decoration: InputDecoration(hintText: tr('setup.urlHint')),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    controller: _token,
                    decoration: InputDecoration(hintText: tr('setup.tokenHint')),
                  ),
                  const SizedBox(height: 10),
                  Text(
                    _status,
                    style: TextStyle(fontSize: 11.5, color: _bad ? C.code : C.ok),
                  ),
                  const SizedBox(height: 16),
                  Row(
                    children: [
                      if (widget.onCancel != null)
                        TextButton(
                          onPressed: widget.onCancel,
                          child: Text(tr('common.cancel')),
                        ),
                      const Spacer(),
                      TextButton(
                        onPressed: _testing || _url.text.trim().isEmpty ? null : _test,
                        child: Text(tr('setup.test')),
                      ),
                      const SizedBox(width: 9),
                      FilledButton(
                        onPressed: _url.text.trim().isEmpty
                            ? null
                            : () {
                                _reflect();
                                widget.onSaved(_settings);
                              },
                        child: Text(tr('setup.connect')),
                      ),
                    ],
                  ),
                  const SizedBox(height: 18),
                  Text(
                    tr('setup.footer'),
                    style: TextStyle(fontSize: 11, color: C.dim2, height: 1.6),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
