/// Splits a multipart/x-mixed-replace (MJPEG) byte stream into frames.
///
/// Each part: `--frame`, headers, blank line, `content-length` bytes of body.
/// Bytes arrive in arbitrary chunks, so this keeps a buffer and only emits a
/// frame once all of it is there. Parts that are not JPEG (heartbeats) are
/// skipped.
library;

import 'dart:convert';
import 'dart:typed_data';

class MjpegFrame {
  MjpegFrame(this.image, this.headers);
  final Uint8List image;
  final Map<String, String> headers;

  String header(String name) => Uri.decodeComponent(headers[name] ?? '');
}

class MjpegParser {
  final _buf = BytesBuilder(copy: false);
  Uint8List _data = Uint8List(0);

  static final _headEnd = ascii.encode('\r\n\r\n');

  List<MjpegFrame> add(List<int> chunk) {
    _buf
      ..add(_data)
      ..add(chunk);
    _data = _buf.takeBytes();
    final out = <MjpegFrame>[];
    var pos = 0;
    while (true) {
      final start = _indexOf(_data, ascii.encode('--frame'), pos);
      if (start < 0) break;
      final end = _indexOf(_data, _headEnd, start);
      if (end < 0) break;
      final headers = <String, String>{};
      for (final line in latin1.decode(_data.sublist(start, end)).split('\r\n').skip(1)) {
        final i = line.indexOf(':');
        if (i > 0) headers[line.substring(0, i).trim().toLowerCase()] = line.substring(i + 1).trim();
      }
      final len = int.tryParse(headers['content-length'] ?? '') ?? 0;
      final bodyStart = end + _headEnd.length;
      if (_data.length < bodyStart + len) break; // wait for the rest of this frame
      if ((headers['content-type'] ?? '').startsWith('image/') && len > 0) {
        out.add(MjpegFrame(Uint8List.fromList(_data.sublist(bodyStart, bodyStart + len)), headers));
      }
      pos = bodyStart + len;
    }
    _data = Uint8List.sublistView(_data, pos);
    return out;
  }

  static int _indexOf(Uint8List hay, List<int> needle, int from) {
    outer:
    for (var i = from; i <= hay.length - needle.length; i++) {
      for (var j = 0; j < needle.length; j++) {
        if (hay[i + j] != needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  }
}
