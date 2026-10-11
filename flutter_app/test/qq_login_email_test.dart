import 'dart:convert';

import 'package:assistant/api_client.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  test('请求新的 QQ 登录二维码使用受鉴权的服务端入口', () async {
    late http.Request captured;
    final api = ApiClient(
      httpClient: MockClient((request) async {
        captured = request;
        return http.Response(
          jsonEncode({'status': 'sent', 'message': '已发送'}),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    final result = await api.requestQqLoginEmail();

    expect(captured.method, 'POST');
    expect(captured.url.path, '/api/qq-login-email');
    expect(result['status'], 'sent');
  });

  test('同步遗漏 QQ 消息使用受鉴权的服务端入口', () async {
    late http.Request captured;
    final api = ApiClient(
      httpClient: MockClient((request) async {
        captured = request;
        return http.Response(
          jsonEncode({'created': 2, 'duplicates': 8, 'message': '同步完成'}),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    final result = await api.syncMissedQqMessages();

    expect(captured.method, 'POST');
    expect(captured.url.path, '/api/qq-sync-missed');
    expect(result['created'], 2);
  });
}
