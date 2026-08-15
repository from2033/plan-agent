import 'dart:io';

import 'package:record/record.dart';

import 'api_client.dart';

class VoiceService {
  VoiceService(this.api);

  final ApiClient api;
  final AudioRecorder _recorder = AudioRecorder();
  String? _recordingPath;

  Future<void> start() async {
    await cancel();
    if (!await _recorder.hasPermission()) {
      throw const ApiException('需要麦克风权限才能记录语音');
    }
    if (!await _recorder.isEncoderSupported(AudioEncoder.wav)) {
      throw const ApiException('当前设备不支持 WAV 录音');
    }

    final path =
        '${Directory.systemTemp.path}/assistant-${DateTime.now().microsecondsSinceEpoch}.wav';
    _recordingPath = path;
    await _recorder.start(
      const RecordConfig(
        encoder: AudioEncoder.wav,
        sampleRate: 16000,
        numChannels: 1,
        echoCancel: true,
        noiseSuppress: true,
      ),
      path: path,
    );
  }

  Future<List<int>> stopRecording() async {
    // 留一小段句尾，再由原生录音器完整封装 WAV。
    await Future<void>.delayed(const Duration(milliseconds: 300));
    final stoppedPath = await _recorder.stop();
    final path = stoppedPath ?? _recordingPath;
    _recordingPath = null;
    if (path == null) throw const ApiException('录音未生成，请重试');

    final file = File(path);
    try {
      final bytes = await file.readAsBytes();
      if (bytes.length < 1600) {
        throw const ApiException('按住多说一会儿再松手哦');
      }
      return bytes;
    } finally {
      if (await file.exists()) await file.delete();
    }
  }

  Future<String> transcribe(List<int> audio) => api.transcribeAudio(audio);

  Future<void> cancel() async {
    await _recorder.cancel();
    final path = _recordingPath;
    _recordingPath = null;
    if (path != null) {
      final file = File(path);
      if (await file.exists()) await file.delete();
    }
  }

  Future<void> dispose() async {
    await cancel();
    _recorder.dispose();
  }
}
