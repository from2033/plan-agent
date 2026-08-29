import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';

import 'package:assistant/persistent_meeting_recorder.dart';

void main() {
  test('本机 PCM 可按上传边界流式组成完整 WAV', () async {
    final directory = await Directory.systemTemp.createTemp(
      'assistant-meeting-result-test-',
    );
    try {
      final pcm = Uint8List.fromList(List<int>.generate(1000, (i) => i % 256));
      final pcmFile = File('${directory.path}/audio.pcm');
      await pcmFile.writeAsBytes(pcm);
      final result = PersistentMeetingResult(
        sessionId: 'meeting-1',
        pcmPath: pcmFile.path,
        pcmBytes: pcm.length,
        transcript: '',
        createdAt: DateTime(2026, 8, 29),
      );

      final first = await result.readWavChunk(0, 100);
      final second = await result.readWavChunk(100, result.wavBytes - 100);
      expect(Uint8List.fromList([...first, ...second]), pcmToWav(pcm));
    } finally {
      await directory.delete(recursive: true);
    }
  });
}
