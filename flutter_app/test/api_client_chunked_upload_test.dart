import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:assistant/api_client.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('长录音自动分片并只完成一次归档', () async {
    final requests = <String>[];
    final chunkSizes = <int>[];
    final client = MockClient((request) async {
      requests.add('${request.method} ${request.url.path}');
      if (request.url.path.endsWith('/documents/uploads')) {
        final body = jsonDecode(request.body) as Map<String, dynamic>;
        expect(body['totalBytes'], 8 * 1024 * 1024 + 17);
        expect((body['userNote'] as String).length, 2500);
        return http.Response(
          jsonEncode({
            'uploadId': '123e4567-e89b-42d3-a456-426614174000',
            'chunkSize': 8 * 1024 * 1024,
            'chunkCount': 2,
          }),
          201,
          headers: {'content-type': 'application/json'},
        );
      }
      if (request.method == 'PUT') {
        chunkSizes.add(request.contentLength);
        return http.Response('', 204);
      }
      if (request.url.path.endsWith('/complete')) {
        return http.Response(
          jsonEncode({
            'documentId': '223e4567-e89b-42d3-a456-426614174000',
            'jobId': 'job-1',
            'status': 'QUEUED',
          }),
          202,
          headers: {'content-type': 'application/json'},
        );
      }
      throw StateError('unexpected request: ${request.method} ${request.url}');
    });
    final api = ApiClient(httpClient: client);

    final result = await api.uploadDocument(
      fileName: '班会.wav',
      mimeType: 'audio/wav',
      bytes: Uint8List(8 * 1024 * 1024 + 17),
      note: List<String>.filled(2500, '会').join(),
      waitForProcessing: false,
    );

    expect(result['status'], 'QUEUED');
    expect(chunkSizes, [8 * 1024 * 1024, 17]);
    expect(requests.where((value) => value.endsWith('/complete')).length, 1);
  });

  test('家庭共享使用 PUT，取消共享使用 DELETE', () async {
    final requests = <String>[];
    final client = MockClient((request) async {
      requests.add('${request.method} ${request.url.path}');
      if (request.method == 'PUT') {
        return http.Response(
          jsonEncode({'ok': true}),
          200,
          headers: {'content-type': 'application/json'},
        );
      }
      if (request.method == 'DELETE') return http.Response('', 204);
      throw StateError('unexpected request: ${request.method} ${request.url}');
    });
    final api = ApiClient(httpClient: client);

    await api.setKnowledgeFamilyShared('note-1', true);
    await api.setDocumentFamilyShared('document-1', true);
    await api.setKnowledgeFamilyShared('note-1', false);
    await api.setDocumentFamilyShared('document-1', false);

    expect(requests, [
      'PUT /api/knowledge/note-1/family',
      'PUT /api/documents/document-1/family',
      'DELETE /api/knowledge/note-1/family',
      'DELETE /api/documents/document-1/family',
    ]);
  });
}
