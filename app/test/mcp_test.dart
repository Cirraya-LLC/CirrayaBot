import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multi_agent/data/api.dart';
import 'package:multi_agent/data/settings.dart';
import 'package:multi_agent/features/workbench/editors.dart';
import 'package:multi_agent/l10n.dart';
import 'package:multi_agent/state/workbench.dart';
import 'package:multi_agent/theme/app_theme.dart';

// Its own file: a testWidgets beside real-HttpServer tests breaks them (fake-async binding).
// The server is stood in for; the server side has its own e2e test (test/e2e/mcp.test.mjs).
const _settings = Settings(baseUrl: 'http://127.0.0.1:1', token: 't');

McpServer _server(Map<String, Object?> j) => McpServer.fromJson({
  'id': 'srv1', 'name': 'Weather', 'kind': 'remote', 'url': 'https://w.example/mcp', 'auth': 'none', 'status': 'ok', 'enabled': true,
  'tools': [
    {'name': 'get_weather', 'description': 'The weather', 'read_only': true, 'mode': 'auto'},
    {'name': 'create_issue', 'description': 'Open an issue', 'mode': 'ask'},
  ],
  ...j,
});

class _FakeApi extends Api {
  _FakeApi() : super(_settings);
  final sent = <Map<String, Object?>>[];

  @override
  Future<List<McpServer>> mcpServers(String agentId) async => const [];
  @override
  Future<McpServer> createMcp(String agentId, Map<String, Object?> body) async {
    sent.add(body);
    return body['kind'] == 'local'
        ? _server({'kind': 'local', 'name': body['name'], 'url': '', 'command': body['command'], 'env_keys': (body['env'] as Map).keys.toList()})
        : _server({'name': body['name'], 'auth': body['auth'], 'status': body['auth'] == 'oauth' ? 'signin' : 'ok'});
  }

  @override
  Future<McpServer> updateMcp(String id, Map<String, Object?> body) async {
    sent.add(body);
    return _server({});
  }
}

Future<(Workbench, _FakeApi)> _open(WidgetTester tester, {McpServer? server, Size size = const Size(1280, 800), double scale = 1}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final api = _FakeApi();
  final bench = Workbench(_settings, api: api);
  await tester.pumpWidget(MaterialApp(
    theme: AppTheme.dark().copyWith(platform: TargetPlatform.android),
    builder: (context, child) => UiScale(scale: scale, child: child!),
    home: Builder(builder: (ctx) => TextButton(onPressed: () => showMcpEditor(ctx, bench, 'kim', server: server), child: const Text('open'))),
  ));
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
  return (bench, api);
}

Future<void> _tapKey(WidgetTester tester, String key) async {
  await tester.ensureVisible(find.byKey(ValueKey(key)));
  await tester.tap(find.byKey(ValueKey(key)));
  await tester.pumpAndSettle();
}

void main() {
  for (final (size, scale) in const [(Size(1280, 800), 1.0), (Size(360, 700), 1.3)]) {
    testWidgets('connect a remote server, then choose what its tools may do, at ${size.width.toInt()} ×$scale', (tester) async {
      final (bench, api) = await _open(tester, size: size, scale: scale);
      await tester.enterText(find.byKey(const ValueKey('mcp-name')), 'Weather');
      await tester.enterText(find.byKey(const ValueKey('mcp-url')), 'https://w.example/mcp');
      await _tapKey(tester, 'mcp-save');
      expect(api.sent.single, containsPair('kind', 'remote'));
      expect(api.sent.single, containsPair('url', 'https://w.example/mcp'));
      expect(find.byType(AlertDialog), findsOneWidget, reason: 'a new one stays open with its tools');
      expect(find.text(tr('mcp.mode.auto')), findsOneWidget);
      expect(find.text(tr('mcp.mode.ask')), findsOneWidget);
      await tester.ensureVisible(find.byKey(const ValueKey('mcp-mode-create_issue')));
      await tester.tap(find.byKey(const ValueKey('mcp-mode-create_issue')));
      await tester.pumpAndSettle();
      await tester.tap(find.text(tr('mcp.mode.off')).last);
      await tester.pumpAndSettle();
      await _tapKey(tester, 'mcp-save');
      expect(api.sent.last['tools'], {'get_weather': 'auto', 'create_issue': 'off'});
      expect(find.byType(AlertDialog), findsNothing, reason: 'saving an edit closes it');
      expect(tester.takeException(), isNull);
      bench.dispose();
    });
  }

  testWidgets('OAuth: a sign-in button; a saved token is never shown, only replaced', (tester) async {
    final (bench, _) = await _open(tester, server: _server({'auth': 'oauth', 'status': 'signin', 'redirect_uri': 'https://bot.example/oauth/callback'}));
    expect(find.byKey(const ValueKey('mcp-signin')), findsOneWidget);
    expect(find.textContaining(tr('mcp.st.signin')), findsWidgets);
    await tester.tap(find.byKey(const ValueKey('mcp-auth')));
    await tester.pumpAndSettle();
    await tester.tap(find.text(tr('mcp.auth.token')).last);
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('mcp-token')), findsOneWidget);
    bench.dispose();
  });

  testWidgets('a local server: command and environment; values never come back', (tester) async {
    final (bench, api) = await _open(tester, size: const Size(360, 700), scale: 1.3);
    await tester.tap(find.text(tr('mcp.kindLocal')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('mcp-url')), findsNothing);
    await tester.enterText(find.byKey(const ValueKey('mcp-name')), 'Notes');
    await tester.enterText(find.byKey(const ValueKey('mcp-command')), 'npx -y some-server');
    await tester.enterText(find.byKey(const ValueKey('mcp-env')), 'API_KEY=abc123\n');
    await _tapKey(tester, 'mcp-save');
    expect(api.sent.single['env'], {'API_KEY': 'abc123'});
    final env = tester.widget<TextField>(find.byKey(const ValueKey('mcp-env')));
    expect(env.controller!.text, 'API_KEY=', reason: 'the value is not shown back');
    await tester.enterText(find.byKey(const ValueKey('mcp-env')), 'no equals sign');
    await _tapKey(tester, 'mcp-save');
    expect(find.text(tr('mcp.envBad')), findsOneWidget);
    expect(tester.takeException(), isNull);
    bench.dispose();
  });
}
