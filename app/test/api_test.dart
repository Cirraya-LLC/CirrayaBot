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
    await expectLater(api.importChat(c, 'not json'), throwsA(isA<ApiException>()));
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

  // Money is an integer (micro-dollars) everywhere but the screen. The two things
  // that must not blur: "we don't know" is not zero, and a cent of spend must not
  // round away to $0.00 in a panel whose whole job is showing what was spent.
  test('money reads as money, and unknown does not read as free', () {
    expect(moneyText(null), '\u2014');
    expect(moneyText(0), '\$0.0000');
    expect(moneyText(1234), '\$0.0012');
    expect(moneyText(2500000), '\$2.50');

    expect(parseDollars('').value, isNull); //      empty = not set
    expect(parseDollars('  ').ok, isTrue);
    expect(parseDollars('2.50').value, 2500000);
    expect(parseDollars('abc').ok, isFalse); //     a typo must not become a cap of 0
    expect(parseDollars('-1').ok, isFalse);
    expect(dollarsText(parseDollars('0.15').value), '0.15');
    expect(dollarsText(10000000), '10'); //          not '10.0' in a box you retype
    expect(dollarsText(null), '');
  });

  // An upload is the raw file as the body, with the conversation and the name in
  // the query — and a refusal comes back as the server's own sentence.
  test('uploading a file streams its bytes, and a refusal is an ApiException', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final got = <String, Object?>{};
    var progressCalls = 0;
    server.listen((req) async {
      final body = await req.fold<List<int>>([], (a, b) => a..addAll(b));
      got['query'] = req.uri.queryParameters;
      got['type'] = req.headers.contentType?.mimeType;
      got['length'] = body.length;
      final res = req.response..headers.contentType = ContentType.json;
      if (req.uri.queryParameters['name'] == 'big.bin') {
        res.statusCode = 413;
        res.write('{"error":"That file is too big (the limit is 50.0 MB)"}');
      } else {
        res.write('{"id":"f1","name":"${req.uri.queryParameters['name']}","mime":"image/png","size":${body.length},"kind":"image"}');
      }
      await res.close();
    });
    final dir = await Directory.systemTemp.createTemp('upload-test');
    final file = File('${dir.path}/截图.png')..writeAsBytesSync(List.filled(70000, 7));
    final api = Api(Settings(baseUrl: 'http://127.0.0.1:${server.port}', token: 't'));
    const conv = Conversation(kind: 'agent', id: 'op', name: 'Op', tag: '', preview: '', at: 0, members: ['op'], color: '', colors: []);

    final a = await api.uploadFile(conv, file.path, onProgress: (_, _) => progressCalls++);
    expect(a.id, 'f1');
    expect(a.name, '截图.png');
    expect(a.isImage, isTrue);
    expect(got['length'], 70000);
    expect(got['type'], 'image/png');
    final q = got['query'] as Map<String, String>;
    expect(q['kind'], 'agent');
    expect(q['id'], 'op');
    expect(q['name'], '截图.png');
    expect(q['k'], 't');
    expect(progressCalls, greaterThan(1));

    final big = File('${dir.path}/big.bin')..writeAsBytesSync([1, 2, 3]);
    await expectLater(
      api.uploadFile(conv, big.path),
      throwsA(isA<ApiException>().having((e) => e.detail, 'detail', contains('too big'))),
    );
    api.close();
    await server.close(force: true);
    await dir.delete(recursive: true);
  });

  test('a text preview reads only the start, and says when there was more', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final whole = 'x' * 5000;
    String? range;
    server.listen((req) async {
      range = req.headers.value(HttpHeaders.rangeHeader);
      final res = req.response
        ..statusCode = 206
        ..headers.contentType = ContentType.text
        ..headers.set(HttpHeaders.contentRangeHeader, 'bytes 0-99/${whole.length}');
      res.write(whole.substring(0, 100));
      await res.close();
    });
    final api = Api(Settings(baseUrl: 'http://127.0.0.1:${server.port}', token: 't'));
    final got = await api.fileText('f1', maxBytes: 100);
    expect(range, 'bytes=0-99');
    expect(got.text.length, 100);
    expect(got.cut, isTrue);
    expect(api.fileUri('f1', download: true).queryParameters['download'], '1');
    api.close();
    await server.close(force: true);
  });

  test('attachments read from whatever the server sent', () {
    expect(Attachment.listOf(null), isEmpty);
    expect(Attachment.listOf('nope'), isEmpty);
    final l = Attachment.listOf([
      {'id': 'a', 'name': 'r.pdf', 'mime': 'application/pdf', 'size': 2048, 'kind': 'pdf'},
      'junk',
    ]);
    expect(l.single.kind, 'pdf');
    expect(sizeText(l.single.size), '2.0 KB');
    expect(sizeText(512), '512 B');
    expect(sizeText(3 * 1024 * 1024), '3.0 MB');
    expect(mimeForName('Notes.MD'), 'text/markdown');
    expect(mimeForName('x.unknown'), 'application/octet-stream');
  });
}
