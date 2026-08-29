import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

import 'api_client.dart';

const meetingSampleRate = 16000;
const meetingChannels = 1;
const meetingBytesPerSecond = meetingSampleRate * meetingChannels * 2;
const meetingChunkSeconds = 50;

class PersistentMeetingResult {
  const PersistentMeetingResult({
    required this.sessionId,
    required this.pcmPath,
    required this.pcmBytes,
    required this.transcript,
    required this.createdAt,
  });

  final String sessionId;
  final String pcmPath;
  final int pcmBytes;
  final String transcript;
  final DateTime createdAt;

  int get wavBytes => 44 + pcmBytes;

  Future<Uint8List> readWavChunk(int offset, int length) async {
    if (offset < 0 || length < 0 || offset + length > wavBytes) {
      throw const ApiException('录音分片范围无效');
    }
    final output = Uint8List(length);
    final header = wavHeader(pcmBytes);
    final headerStart = offset.clamp(0, header.length);
    final headerEnd = (offset + length).clamp(0, header.length);
    if (headerEnd > headerStart) {
      output.setRange(0, headerEnd - headerStart, header, headerStart);
    }
    final pcmOutputOffset = (header.length - offset).clamp(0, length);
    final pcmOffset = (offset - header.length).clamp(0, pcmBytes);
    final pcmLength = length - pcmOutputOffset;
    if (pcmLength > 0) {
      final file = await File(pcmPath).open();
      try {
        await file.setPosition(pcmOffset);
        final bytes = await file.read(pcmLength);
        if (bytes.length != pcmLength) throw const ApiException('本机录音读取不完整');
        output.setRange(pcmOutputOffset, length, bytes);
      } finally {
        await file.close();
      }
    }
    return output;
  }
}

class PersistentMeetingRecorder {
  PersistentMeetingRecorder(this.api);

  final ApiClient api;
  final AudioRecorder recorder = AudioRecorder();
  static const recordingChannel = MethodChannel(
    'com.from2033.assistant/recording',
  );
  Directory? sessionDirectory;
  IOSink? pcmSink;
  StreamSubscription<Uint8List>? audioSubscription;
  Timer? flushTimer;
  final List<int> pendingPcm = [];
  Future<void> processing = Future.value();
  DateTime? createdAt;
  void Function(int completedChunks)? onChunkProcessed;
  int completedChunks = 0;
  int processedBytes = 0;
  bool transcriptionFailed = false;
  bool _recovering = false;

  bool get isRecording => sessionDirectory != null;
  DateTime? get startedAt => createdAt;

  Future<void> beginProcessing() async {
    try {
      await recordingChannel.invokeMethod<void>('beginProcessing');
    } catch (_) {}
  }

  Future<void> endProcessing() async {
    try {
      await recordingChannel.invokeMethod<void>('endProcessing');
    } catch (_) {}
  }

  Future<void> start({void Function(int completedChunks)? onProgress}) async {
    await cancelActive();
    if (!await recorder.hasPermission()) {
      throw const ApiException('需要麦克风权限才能记录会议');
    }
    if (!await recorder.isEncoderSupported(AudioEncoder.pcm16bits)) {
      throw const ApiException('当前设备不支持持续音频流录制');
    }
    await recordingChannel.invokeMethod<void>('activate');
    final root = await _root();
    createdAt = DateTime.now();
    final sessionId = createdAt!.microsecondsSinceEpoch.toString();
    final directory = Directory('${root.path}/$sessionId');
    await directory.create(recursive: true);
    sessionDirectory = directory;
    onChunkProcessed = onProgress;
    completedChunks = 0;
    processedBytes = 0;
    transcriptionFailed = false;
    pendingPcm.clear();
    await _writeMetadata(directory, state: 'recording');
    pcmSink = File(
      '${directory.path}/audio.pcm',
    ).openWrite(mode: FileMode.append);
    final stream = await recorder.startStream(
      const RecordConfig(
        encoder: AudioEncoder.pcm16bits,
        sampleRate: meetingSampleRate,
        numChannels: meetingChannels,
        echoCancel: true,
        noiseSuppress: true,
      ),
    );
    audioSubscription = stream.listen(
      _acceptAudio,
      onError: (_) => unawaited(_flush()),
    );
    flushTimer = Timer.periodic(const Duration(seconds: 5), (_) {
      unawaited(_flush());
    });
  }

  void _acceptAudio(Uint8List data) {
    pcmSink?.add(data);
    pendingPcm.addAll(data);
    const chunkSize = meetingChunkSeconds * meetingBytesPerSecond;
    while (pendingPcm.length >= chunkSize) {
      final chunk = Uint8List.fromList(pendingPcm.sublist(0, chunkSize));
      pendingPcm.removeRange(0, chunkSize);
      _queueTranscription(chunk);
    }
  }

  void _queueTranscription(Uint8List pcm) {
    final directory = sessionDirectory;
    if (directory == null || pcm.isEmpty || transcriptionFailed) return;
    processing = processing
        .then((_) async {
          final text = (await api.transcribeAudio(pcmToWav(pcm))).trim();
          if (text.isNotEmpty) {
            await File(
              '${directory.path}/transcript.txt',
            ).writeAsString('$text\n', mode: FileMode.append, flush: true);
          }
          processedBytes += pcm.length;
          completedChunks += 1;
          await _writeMetadata(directory, state: 'recording');
          onChunkProcessed?.call(completedChunks);
        })
        .catchError((_) {
          // The durable PCM remains available for retry on the next app launch.
          transcriptionFailed = true;
        });
  }

  Future<PersistentMeetingResult> stop() async {
    final directory = sessionDirectory;
    final started = createdAt;
    if (directory == null || started == null) {
      throw const ApiException('当前没有正在进行的录音');
    }
    flushTimer?.cancel();
    flushTimer = null;
    await recorder.stop();
    await audioSubscription?.cancel();
    audioSubscription = null;
    if (pendingPcm.isNotEmpty) {
      _queueTranscription(Uint8List.fromList(pendingPcm));
      pendingPcm.clear();
    }
    await _flush();
    await pcmSink?.close();
    pcmSink = null;
    await _deactivate();
    await processing;
    await _markRecoverable(directory, started);
    sessionDirectory = null;
    createdAt = null;
    return _resultFromDirectory(directory, started);
  }

  Future<List<PersistentMeetingResult>> recoverPending() async {
    if (_recovering || isRecording) return const [];
    _recovering = true;
    try {
      final root = await _root();
      if (!await root.exists()) return const [];
      final results = <PersistentMeetingResult>[];
      await for (final entity in root.list()) {
        if (entity is! Directory) continue;
        final metadataFile = File('${entity.path}/session.json');
        final pcmFile = File('${entity.path}/audio.pcm');
        if (!await metadataFile.exists() || !await pcmFile.exists()) continue;
        try {
          final metadata =
              jsonDecode(await metadataFile.readAsString())
                  as Map<String, dynamic>;
          final started = DateTime.parse(
            metadata['createdAt'] as String,
          ).toLocal();
          final alreadyProcessed =
              (metadata['processedBytes'] as num?)?.toInt() ?? 0;
          final transcriptFile = File('${entity.path}/transcript.txt');
          final pcm = await pcmFile.readAsBytes();
          if (alreadyProcessed < pcm.length) {
            final safeOffset = alreadyProcessed.clamp(0, pcm.length);
            final pieces = splitPcm(
              Uint8List.fromList(pcm.sublist(safeOffset)),
            );
            final transcript = <String>[];
            for (final piece in pieces) {
              final text = (await api.transcribeAudio(pcmToWav(piece))).trim();
              if (text.isNotEmpty) transcript.add(text);
            }
            await transcriptFile.writeAsString(
              '${transcript.join('\n')}\n',
              mode: FileMode.append,
              flush: true,
            );
            processedBytes = pcm.length;
            createdAt = started;
            sessionDirectory = entity;
            await _writeMetadata(entity, state: 'ready');
            sessionDirectory = null;
            createdAt = null;
          }
          results.add(await _resultFromDirectory(entity, started));
        } catch (_) {
          // Leave unreadable/incomplete sessions untouched for a later retry.
        }
      }
      return results;
    } finally {
      _recovering = false;
    }
  }

  Future<int> pendingCount() async {
    final root = await _root();
    if (!await root.exists()) return 0;
    var count = 0;
    await for (final entity in root.list()) {
      if (entity is Directory &&
          await File('${entity.path}/session.json').exists() &&
          await File('${entity.path}/audio.pcm').exists()) {
        count += 1;
      }
    }
    return count;
  }

  Future<void> markUploaded(String sessionId) async {
    final root = await _root();
    final directory = Directory('${root.path}/$sessionId');
    if (await directory.exists()) await directory.delete(recursive: true);
  }

  Future<void> cancelActive() async {
    flushTimer?.cancel();
    flushTimer = null;
    if (await recorder.isRecording()) await recorder.stop();
    await audioSubscription?.cancel();
    audioSubscription = null;
    await _flush();
    await pcmSink?.close();
    pcmSink = null;
    pendingPcm.clear();
    await _deactivate();
    sessionDirectory = null;
    createdAt = null;
  }

  Future<void> dispose() async {
    // Do not delete the session: an app shutdown must leave recovery data.
    flushTimer?.cancel();
    await audioSubscription?.cancel();
    await _flush();
    await pcmSink?.close();
    pcmSink = null;
    await recorder.dispose();
    await _deactivate();
  }

  Future<void> _flush() async {
    try {
      await pcmSink?.flush();
    } catch (_) {}
  }

  Future<void> _deactivate() async {
    try {
      await recordingChannel.invokeMethod<void>('deactivate');
    } catch (_) {}
  }

  Future<Directory> _root() async {
    final support = await getApplicationSupportDirectory();
    final root = Directory('${support.path}/meeting-recordings');
    await root.create(recursive: true);
    return root;
  }

  Future<void> _markRecoverable(Directory directory, DateTime started) async {
    createdAt = started;
    sessionDirectory = directory;
    await _writeMetadata(directory, state: 'ready');
  }

  Future<void> _writeMetadata(Directory directory, {required String state}) {
    final started = createdAt ?? DateTime.now();
    return File('${directory.path}/session.json').writeAsString(
      jsonEncode({
        'sessionId': directory.path.split('/').last,
        'createdAt': started.toUtc().toIso8601String(),
        'state': state,
        'processedBytes': processedBytes,
      }),
      flush: true,
    );
  }

  Future<PersistentMeetingResult> _resultFromDirectory(
    Directory directory,
    DateTime started,
  ) async {
    final pcmFile = File('${directory.path}/audio.pcm');
    final transcriptFile = File('${directory.path}/transcript.txt');
    return PersistentMeetingResult(
      sessionId: directory.path.split('/').last,
      pcmPath: pcmFile.path,
      pcmBytes: await pcmFile.length(),
      transcript: await transcriptFile.exists()
          ? (await transcriptFile.readAsString()).trim()
          : '',
      createdAt: started,
    );
  }
}

List<Uint8List> splitPcm(
  Uint8List pcm, {
  int chunkSeconds = meetingChunkSeconds,
  int bytesPerSecond = meetingBytesPerSecond,
}) {
  final chunkSize = chunkSeconds * bytesPerSecond;
  if (pcm.isEmpty) return const [];
  return [
    for (var start = 0; start < pcm.length; start += chunkSize)
      Uint8List.fromList(
        pcm.sublist(start, (start + chunkSize).clamp(0, pcm.length)),
      ),
  ];
}

Uint8List pcmToWav(
  List<int> pcm, {
  int sampleRate = meetingSampleRate,
  int channels = meetingChannels,
}) {
  final header = wavHeader(
    pcm.length,
    sampleRate: sampleRate,
    channels: channels,
  );
  final output = Uint8List(header.length + pcm.length);
  output.setRange(0, header.length, header);
  output.setRange(header.length, output.length, pcm);
  return output;
}

Uint8List wavHeader(
  int pcmLength, {
  int sampleRate = meetingSampleRate,
  int channels = meetingChannels,
}) {
  final output = Uint8List(44);
  final data = ByteData.sublistView(output);
  output.setRange(0, 4, ascii.encode('RIFF'));
  data.setUint32(4, pcmLength + 36, Endian.little);
  output.setRange(8, 12, ascii.encode('WAVE'));
  output.setRange(12, 16, ascii.encode('fmt '));
  data.setUint32(16, 16, Endian.little);
  data.setUint16(20, 1, Endian.little);
  data.setUint16(22, channels, Endian.little);
  data.setUint32(24, sampleRate, Endian.little);
  data.setUint32(28, sampleRate * channels * 2, Endian.little);
  data.setUint16(32, channels * 2, Endian.little);
  data.setUint16(34, 16, Endian.little);
  output.setRange(36, 40, ascii.encode('data'));
  data.setUint32(40, pcmLength, Endian.little);
  return output;
}
