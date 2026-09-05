import 'dart:typed_data';

import 'package:flutter/material.dart';

import 'api_client.dart';

bool isPreviewableImageMimeType(String mimeType) =>
    mimeType.toLowerCase().startsWith('image/');

class DocumentImagePreview extends StatefulWidget {
  const DocumentImagePreview({
    super.key,
    required this.api,
    required this.documentId,
    required this.fileName,
  });

  final ApiClient api;
  final String documentId;
  final String fileName;

  @override
  State<DocumentImagePreview> createState() => _DocumentImagePreviewState();
}

class _DocumentImagePreviewState extends State<DocumentImagePreview> {
  late Future<Uint8List> _image;

  @override
  void initState() {
    super.initState();
    _image = widget.api.downloadDocument(widget.documentId);
  }

  void _retry() {
    setState(() {
      _image = widget.api.downloadDocument(widget.documentId);
    });
  }

  void _openFullScreen(Uint8List bytes) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => Scaffold(
          backgroundColor: Colors.black,
          appBar: AppBar(
            title: Text(
              widget.fileName,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            backgroundColor: Colors.black,
            foregroundColor: Colors.white,
          ),
          body: SafeArea(
            child: Center(
              child: InteractiveViewer(
                minScale: .8,
                maxScale: 5,
                child: Image.memory(
                  bytes,
                  fit: BoxFit.contain,
                  semanticLabel: widget.fileName,
                  errorBuilder: (_, _, _) => const _ImageDecodeError(),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<Uint8List>(
      future: _image,
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const _ImageFrame(
            child: Center(child: CircularProgressIndicator()),
          );
        }
        if (snapshot.hasError ||
            snapshot.data == null ||
            snapshot.data!.isEmpty) {
          return _ImageFrame(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const Icon(
                  Icons.broken_image_outlined,
                  color: Color(0xff8a8680),
                  size: 34,
                ),
                const SizedBox(height: 8),
                const Text('照片加载失败'),
                TextButton.icon(
                  onPressed: _retry,
                  icon: const Icon(Icons.refresh_rounded),
                  label: const Text('重新加载'),
                ),
              ],
            ),
          );
        }
        final bytes = snapshot.data!;
        return Semantics(
          button: true,
          label: '查看照片 ${widget.fileName}',
          child: GestureDetector(
            onTap: () => _openFullScreen(bytes),
            child: _ImageFrame(
              child: Image.memory(
                bytes,
                fit: BoxFit.contain,
                gaplessPlayback: true,
                semanticLabel: widget.fileName,
                errorBuilder: (_, _, _) => const _ImageDecodeError(),
              ),
            ),
          ),
        );
      },
    );
  }
}

class _ImageFrame extends StatelessWidget {
  const _ImageFrame({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      height: 280,
      margin: const EdgeInsets.only(top: 16, bottom: 6),
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: const Color(0xfff3f0eb),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: const Color(0xffe5ded4)),
      ),
      child: child,
    );
  }
}

class _ImageDecodeError extends StatelessWidget {
  const _ImageDecodeError();

  @override
  Widget build(BuildContext context) {
    return const Center(
      child: Padding(
        padding: EdgeInsets.all(20),
        child: Text(
          '当前照片格式无法预览，请重新上传 JPG 或 PNG 格式',
          textAlign: TextAlign.center,
          style: TextStyle(color: Color(0xff8a8680)),
        ),
      ),
    );
  }
}
