import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:assistant/api_client.dart';

void main() {
  test('API requests fail with a readable error instead of hanging', () async {
    final pendingResponse = Completer<http.Response>();
    final api = ApiClient(
      httpClient: MockClient((_) => pendingResponse.future),
      requestTimeout: const Duration(milliseconds: 10),
    );

    await expectLater(
      api.me(),
      throwsA(
        isA<ApiException>().having(
          (error) => error.message,
          'message',
          contains('超时'),
        ),
      ),
    );
  });
}
