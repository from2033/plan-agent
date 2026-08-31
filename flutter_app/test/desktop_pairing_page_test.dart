import 'package:assistant/desktop_pairing_page.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('只接受带完整会话和扫码密钥的 Daynote 二维码', () {
    const session = 'ec9d3657-b75b-4a27-8d74-d508702996a6';
    const secret = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
    final code = parseDesktopPairingCode(
      'daynote://desktop-pair?session=$session&secret=$secret',
    );
    expect(code?.sessionId, session);
    expect(code?.scanSecret, secret);
    expect(
      parseDesktopPairingCode(
        'https://example.com/?session=$session&secret=$secret',
      ),
      isNull,
    );
    expect(
      parseDesktopPairingCode('daynote://desktop-pair?session=$session'),
      isNull,
    );
  });
}
