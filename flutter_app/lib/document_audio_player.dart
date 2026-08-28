import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:just_audio/just_audio.dart';

import 'api_client.dart';

class DocumentAudioPlayer extends StatefulWidget {
  const DocumentAudioPlayer({
    super.key,
    required this.api,
    required this.documentId,
  });

  final ApiClient api;
  final String documentId;

  @override
  State<DocumentAudioPlayer> createState() => _DocumentAudioPlayerState();
}

class _DocumentAudioPlayerState extends State<DocumentAudioPlayer> {
  final AudioPlayer player = AudioPlayer();
  final subscriptions = <StreamSubscription<dynamic>>[];
  File? temporaryFile;
  Duration position = Duration.zero;
  Duration duration = Duration.zero;
  bool prepared = false;
  bool loading = false;
  bool playing = false;
  String? error;

  @override
  void initState() {
    super.initState();
    subscriptions.add(
      player.positionStream.listen((value) {
        if (mounted) setState(() => position = value);
      }),
    );
    subscriptions.add(
      player.durationStream.listen((value) {
        if (mounted && value != null) setState(() => duration = value);
      }),
    );
    subscriptions.add(
      player.playerStateStream.listen((state) {
        if (!mounted) return;
        setState(() => playing = state.playing);
        if (state.processingState == ProcessingState.completed) {
          unawaited(player.seek(Duration.zero));
          unawaited(player.pause());
        }
      }),
    );
  }

  Future<void> toggle() async {
    if (loading) return;
    try {
      if (!prepared) {
        setState(() {
          loading = true;
          error = null;
        });
        final bytes = await widget.api.downloadDocument(widget.documentId);
        final file = File(
          '${Directory.systemTemp.path}/daynote-audio-${widget.documentId}.wav',
        );
        await file.writeAsBytes(bytes, flush: true);
        temporaryFile = file;
        await player.setFilePath(file.path);
        prepared = true;
      }
      if (player.playing) {
        await player.pause();
      } else {
        await player.play();
      }
    } catch (exception) {
      if (mounted) setState(() => error = exception.toString());
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  Future<void> seek(double milliseconds) async {
    await player.seek(Duration(milliseconds: milliseconds.round()));
  }

  @override
  void dispose() {
    for (final subscription in subscriptions) {
      unawaited(subscription.cancel());
    }
    unawaited(player.dispose());
    final file = temporaryFile;
    if (file != null) unawaited(file.delete().catchError((_) => file));
    super.dispose();
  }

  String label(Duration value) {
    final hours = value.inHours;
    final minutes = value.inMinutes.remainder(60).toString().padLeft(2, '0');
    final seconds = value.inSeconds.remainder(60).toString().padLeft(2, '0');
    return hours > 0 ? '$hours:$minutes:$seconds' : '$minutes:$seconds';
  }

  @override
  Widget build(BuildContext context) {
    final maximum = duration.inMilliseconds > 0
        ? duration.inMilliseconds.toDouble()
        : 1.0;
    final current = position.inMilliseconds
        .clamp(0, maximum.toInt())
        .toDouble();
    return Container(
      margin: const EdgeInsets.only(top: 18),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0xfff3f1eb),
        borderRadius: BorderRadius.circular(15),
        border: Border.all(color: const Color(0xffe4ded4)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Row(
            children: [
              Icon(Icons.graphic_eq_rounded, size: 19),
              SizedBox(width: 8),
              Text('原始录音', style: TextStyle(fontWeight: FontWeight.w700)),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              IconButton.filled(
                onPressed: loading ? null : toggle,
                icon: loading
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: Colors.white,
                        ),
                      )
                    : Icon(
                        playing
                            ? Icons.pause_rounded
                            : Icons.play_arrow_rounded,
                      ),
              ),
              Expanded(
                child: Slider(
                  value: current,
                  max: maximum,
                  onChanged: prepared ? seek : null,
                ),
              ),
              Text(
                '${label(position)} / ${label(duration)}',
                style: const TextStyle(fontSize: 11, color: Color(0xff716b63)),
              ),
            ],
          ),
          if (error != null)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                error!,
                style: const TextStyle(fontSize: 12, color: Color(0xffb42318)),
              ),
            ),
        ],
      ),
    );
  }
}
