import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:multi_agent/data/api.dart';
import 'package:multi_agent/data/settings.dart';
import 'package:multi_agent/l10n.dart';

void main() {
  // What the Mac hit on "Save": the server had closed a pooled keep-alive socket,
  // the client reused it, and the request died with "Connection closed before
  // full header was received" — as an unhandled exception, not an error message.
  test('a request the server hangs up on is sent again, not thrown', () async {
    final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    var seen = 0;
    server.listen((sock) {
      sock.listen((_) {
        if (++seen == 1) {
          sock.destroy(); // read the request, answer nothing
        } else {
          sock.write('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n'
              'content-length: 2\r\nconnection: close\r\n\r\n[]');
          sock.close();
        }
      });
    });
    final api = Api(Settings(baseUrl: 'http://127.0.0.1:${server.port}', token: 't'));
    expect(await api.providers(), isEmpty);
    expect(seen, 2);
    api.close();
    await server.close();
  });

  test('a server that keeps hanging up becomes an ApiException', () async {
    final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((sock) => sock.listen((_) => sock.destroy()));
    final api = Api(Settings(baseUrl: 'http://127.0.0.1:${server.port}', token: 't'));
    await expectLater(api.providers(), throwsA(isA<ApiException>()));
    api.close();
    await server.close();
  });

  // Picking the wrong file must say so, not crash with a FormatException.
  test('importing a file that is not JSON is an ApiException, and nothing is sent', () async {
    final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    var sent = 0;
    server.listen((sock) => sock.listen((_) { sent++; sock.destroy(); }));
    final api = Api(Settings(baseUrl: 'http://127.0.0.1:${server.port}', token: 't'));
    final c = Conversation.fromJson({'kind': 'agent', 'id': 'a', 'name': 'A'});
    await expectLater(api.importChat(c, 'not json', replace: false), throwsA(isA<ApiException>()));
    expect(sent, 0);
    api.close();
    await server.close();
  });

  test('every request says which language to answer in', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    String? header, query;
    server.listen((req) async {
      header = req.headers.value('x-lang');
      query = req.uri.queryParameters['lang'];
      req.response.write('[]');
      await req.response.close();
    });
    currentLang.value = Lang.zhHant;
    final api = Api(Settings(baseUrl: 'http://127.0.0.1:${server.port}', token: 't'));
    await api.providers();
    expect(header, 'zh-Hant');
    expect(query, 'zh-Hant');
    currentLang.value = Lang.en;
    api.close();
    await server.close(force: true);
  });
}
