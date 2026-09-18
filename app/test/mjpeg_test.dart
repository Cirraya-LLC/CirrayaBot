import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:multi_agent/data/mjpeg.dart';

List<int> part(String type, List<int> body, {String url = ''}) => [
  ...ascii.encode('--frame\r\ncontent-type: $type\r\ncontent-length: ${body.length}\r\nx-page-url: $url\r\n\r\n'),
  ...body,
  ...ascii.encode('\r\n'),
];

void main() {
  // The stream arrives in arbitrary chunks: a frame split across reads must
  // come out whole, and heartbeats must not come out at all.
  test('frames split across chunks come out whole; heartbeats are skipped', () {
    final jpeg1 = List<int>.generate(300, (i) => i % 251);
    final jpeg2 = List<int>.generate(70, (i) => (i * 7) % 256);
    final all = [
      ...part('image/jpeg', jpeg1, url: 'https%3A%2F%2Fa.com%2F'),
      ...part('text/plain', const []),
      ...part('image/jpeg', jpeg2),
    ];
    final p = MjpegParser();
    final got = <MjpegFrame>[];
    for (var i = 0; i < all.length; i += 37) {
      got.addAll(p.add(all.sublist(i, i + 37 > all.length ? all.length : i + 37)));
    }
    expect(got.length, 2);
    expect(got[0].image, jpeg1);
    expect(got[0].header('x-page-url'), 'https://a.com/');
    expect(got[1].image, jpeg2);
  });

  // A JPEG can contain the bytes of "--frame"; the parser must go by
  // content-length, not by searching for the next boundary inside the body.
  test('a body that happens to contain the boundary text is not cut', () {
    final body = [...ascii.encode('xx--frame\r\n\r\nyy'), 1, 2, 3];
    final got = MjpegParser().add(part('image/jpeg', body));
    expect(got.single.image, body);
  });
}
