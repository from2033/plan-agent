import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import 'api_client.dart';

class DesktopPairingCode {
  const DesktopPairingCode({required this.sessionId, required this.scanSecret});

  final String sessionId;
  final String scanSecret;
}

DesktopPairingCode? parseDesktopPairingCode(String raw) {
  final uri = Uri.tryParse(raw.trim());
  if (uri == null || uri.scheme != 'daynote' || uri.host != 'desktop-pair') {
    return null;
  }
  final sessionId = uri.queryParameters['session']?.trim() ?? '';
  final scanSecret = uri.queryParameters['secret']?.trim() ?? '';
  if (!RegExp(
        r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
        caseSensitive: false,
      ).hasMatch(sessionId) ||
      scanSecret.length < 32 ||
      scanSecret.length > 80) {
    return null;
  }
  return DesktopPairingCode(sessionId: sessionId, scanSecret: scanSecret);
}

class DesktopPairingPage extends StatefulWidget {
  const DesktopPairingPage({super.key, required this.api});

  final ApiClient api;

  @override
  State<DesktopPairingPage> createState() => _DesktopPairingPageState();
}

class _DesktopPairingPageState extends State<DesktopPairingPage> {
  final MobileScannerController controller = MobileScannerController(
    formats: const [BarcodeFormat.qrCode],
    detectionSpeed: DetectionSpeed.noDuplicates,
  );
  bool handling = false;
  String? error;

  Future<void> handleCapture(BarcodeCapture capture) async {
    if (handling) return;
    String? raw;
    for (final barcode in capture.barcodes) {
      if ((barcode.rawValue ?? '').isNotEmpty) {
        raw = barcode.rawValue;
        break;
      }
    }
    if (raw == null) return;
    final code = parseDesktopPairingCode(raw);
    if (code == null) {
      setState(() => error = '这不是 Daynote 电脑端二维码');
      return;
    }
    setState(() {
      handling = true;
      error = null;
    });
    await controller.stop();
    try {
      final request = await widget.api.inspectDesktopPairing(
        code.sessionId,
        code.scanSecret,
      );
      if (!mounted) return;
      final deviceLabel = request['deviceLabel']?.toString() ?? '电脑浏览器';
      final approved = await showDialog<bool>(
        context: context,
        barrierDismissible: false,
        builder: (dialogContext) => AlertDialog(
          icon: const Icon(Icons.computer_rounded, size: 34),
          title: const Text('允许电脑端使用？'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                deviceLabel,
                style: const TextStyle(
                  fontSize: 17,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 12),
              const Text(
                '确认后，这台电脑将获得独立的两小时临时会话。它不会取得手机上的登录令牌。',
                textAlign: TextAlign.center,
                style: TextStyle(color: Color(0xff77736c), height: 1.5),
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext, false),
              child: const Text('取消'),
            ),
            FilledButton.icon(
              onPressed: () => Navigator.pop(dialogContext, true),
              icon: const Icon(Icons.phonelink_lock_rounded, size: 18),
              label: const Text('允许两小时'),
            ),
          ],
        ),
      );
      if (approved != true) {
        if (mounted) {
          setState(() => handling = false);
          unawaited(controller.start());
        }
        return;
      }
      await widget.api.approveDesktopPairing(code.sessionId, code.scanSecret);
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('$deviceLabel 已连接，两小时后自动退出')));
      Navigator.of(context).pop(true);
    } catch (exception) {
      if (!mounted) return;
      setState(() {
        handling = false;
        error = exception.toString();
      });
      unawaited(controller.start());
    }
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        title: const Text('扫描电脑二维码'),
        foregroundColor: Colors.white,
        backgroundColor: Colors.black,
      ),
      body: Stack(
        fit: StackFit.expand,
        children: [
          MobileScanner(
            controller: controller,
            onDetect: handleCapture,
            errorBuilder: (context, exception) => Center(
              child: Padding(
                padding: const EdgeInsets.all(32),
                child: Text(
                  '无法使用相机：${exception.errorDetails?.message ?? '请检查相机权限'}',
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: Colors.white),
                ),
              ),
            ),
          ),
          IgnorePointer(
            child: Center(
              child: Container(
                width: 258,
                height: 258,
                decoration: BoxDecoration(
                  border: Border.all(color: Colors.white, width: 3),
                  borderRadius: BorderRadius.circular(24),
                ),
              ),
            ),
          ),
          Positioned(
            left: 24,
            right: 24,
            bottom: 48,
            child: Column(
              children: [
                Text(
                  handling ? '正在核对电脑…' : '将电脑上的二维码放入框内',
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: Colors.white, fontSize: 16),
                ),
                if (error != null) ...[
                  const SizedBox(height: 12),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 14,
                      vertical: 9,
                    ),
                    decoration: BoxDecoration(
                      color: const Color(0xcc2b211d),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Text(
                      error!,
                      textAlign: TextAlign.center,
                      style: const TextStyle(color: Color(0xffffd2bf)),
                    ),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}
