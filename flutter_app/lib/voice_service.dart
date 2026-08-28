import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/services.dart';
import 'package:record/record.dart';

import 'api_client.dart';

class VoiceService {
  VoiceService(this.api);

  final ApiClient api;
  final AudioRecorder _recorder = AudioRecorder();
  static const _recordingChannel = MethodChannel(
    'com.from2033.assistant/recording',
  );
  String? _recordingPath;

  Future<void> start() async {
    await cancel();
    if (!await _recorder.hasPermission()) {
      throw const ApiException('需要麦克风权限才能记录语音');
    }
    if (!await _recorder.isEncoderSupported(AudioEncoder.wav)) {
      throw const ApiException('当前设备不支持 WAV 录音');
    }

    try {
      await _recordingChannel.invokeMethod<void>('activate');
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
    } catch (_) {
      await _deactivateSession();
      rethrow;
    }
  }

  Future<List<int>> stopRecording() async {
    // 留一小段句尾，再由原生录音器完整封装 WAV。
    await Future<void>.delayed(const Duration(milliseconds: 300));
    final stoppedPath = await _recorder.stop();
    await _deactivateSession();
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

  Future<String> transcribeLong(List<int> audio) async {
    final chunks = splitWavForTranscription(Uint8List.fromList(audio));
    final parts = <String>[];
    for (final chunk in chunks) {
      final text = (await api.transcribeAudio(chunk)).trim();
      if (text.isNotEmpty) parts.add(text);
    }
    return parts.join('\n');
  }

  Future<void> cancel() async {
    await _recorder.cancel();
    await _deactivateSession();
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

  Future<void> _deactivateSession() async {
    try {
      await _recordingChannel.invokeMethod<void>('deactivate');
    } catch (_) {
      // Web/tests or an unavailable native channel do not need cleanup.
    }
  }
}

List<Uint8List> splitWavForTranscription(
  Uint8List wav, {
  int maxSeconds = 50,
  int bytesPerSecond = 32000,
}) {
  if (wav.length <= 44 + maxSeconds * bytesPerSecond) return [wav];
  final data = ByteData.sublistView(wav);
  var cursor = 12;
  var dataSizeOffset = -1;
  var audioOffset = -1;
  while (cursor + 8 <= wav.length) {
    final id = String.fromCharCodes(wav.sublist(cursor, cursor + 4));
    final size = data.getUint32(cursor + 4, Endian.little);
    if (id == 'data') {
      dataSizeOffset = cursor + 4;
      audioOffset = cursor + 8;
      break;
    }
    cursor += 8 + size + (size.isOdd ? 1 : 0);
  }
  if (audioOffset < 0 || dataSizeOffset < 0) return [wav];
  final chunkSize = maxSeconds * bytesPerSecond;
  final result = <Uint8List>[];
  for (var start = audioOffset; start < wav.length; start += chunkSize) {
    final end = (start + chunkSize).clamp(start, wav.length);
    final payload = wav.sublist(start, end);
    final chunk = Uint8List(audioOffset + payload.length);
    chunk.setRange(0, audioOffset, wav);
    chunk.setRange(audioOffset, chunk.length, payload);
    final chunkData = ByteData.sublistView(chunk);
    chunkData.setUint32(4, chunk.length - 8, Endian.little);
    chunkData.setUint32(dataSizeOffset, payload.length, Endian.little);
    result.add(chunk);
  }
  return result;
}
