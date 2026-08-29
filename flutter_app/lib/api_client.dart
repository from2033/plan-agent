import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

import 'guest_store.dart';
import 'models.dart';

enum SessionMode { signedOut, guest, signedIn }

class ApiException implements Exception {
  const ApiException(this.message, {this.status});
  final String message;
  final int? status;
  @override
  String toString() => message;
}

class ApiClient {
  ApiClient({http.Client? httpClient}) : _http = httpClient ?? http.Client();

  static const apiBase = String.fromEnvironment(
    'API_BASE',
    defaultValue: 'https://assistant.5656ai.com/api',
  );
  static const _storage = FlutterSecureStorage();
  static const _tokenKey = 'assistant_session_token';
  static const _guestTokenKey = 'assistant_guest_token';
  static const _sessionModeKey = 'assistant_session_mode';
  static const _chunkedUploadThreshold = 8 * 1024 * 1024;
  final http.Client _http;
  GuestStore? _guestStoreInstance;
  GuestStore get _guestStore => _guestStoreInstance ??= GuestStore();
  StudySession? _studySession;

  String? _token;
  bool _isGuest = false;

  bool get isGuest => _isGuest;

  Future<SessionMode> restoreSession() async {
    final savedMode = await _storage.read(key: _sessionModeKey);
    _isGuest = savedMode == 'guest';
    _token = await _storage.read(key: _isGuest ? _guestTokenKey : _tokenKey);
    // Existing installations predate the mode key; an existing account token
    // is still a signed-in session.
    if (_token == null && savedMode == null) {
      _token = await _storage.read(key: _tokenKey);
    }
    if (_token == null) return SessionMode.signedOut;
    try {
      await me();
      if (!_isGuest && await _guestStore.hasData) {
        try {
          await _migrateGuestData();
          await _storage.delete(key: _guestTokenKey);
          await _guestStore.clear();
        } catch (_) {
          // Keep the local copy and retry migration on the next app launch.
        }
      }
      return _isGuest ? SessionMode.guest : SessionMode.signedIn;
    } catch (error) {
      // A temporary network/server failure during launch must never sign the
      // user out. Only an explicit 401 proves that the saved token is invalid.
      final unauthorized = error is ApiException && error.status == 401;
      if (!unauthorized) {
        return _isGuest ? SessionMode.guest : SessionMode.signedIn;
      }
      if (_isGuest) {
        try {
          await startGuestSession(forceRenew: true);
          return SessionMode.guest;
        } catch (_) {
          return SessionMode.signedOut;
        }
      }
      await logout();
      return SessionMode.signedOut;
    }
  }

  Future<void> startGuestSession({bool forceRenew = false}) async {
    if (!forceRenew) {
      final existing = await _storage.read(key: _guestTokenKey);
      if (existing != null) {
        _token = existing;
        _isGuest = true;
        try {
          await me();
          await _storage.write(key: _sessionModeKey, value: 'guest');
          return;
        } catch (_) {
          // Expired guest sessions are replaced below; local data is retained.
        }
      }
    }
    final json =
        await _request('POST', '/auth/guest', authenticated: false)
            as Map<String, dynamic>;
    _token = json['token'] as String;
    _isGuest = true;
    await _storage.write(key: _guestTokenKey, value: _token);
    await _storage.write(key: _sessionModeKey, value: 'guest');
  }

  Future<void> requestEmailCode(String email) async {
    await _request(
      'POST',
      '/auth/email/code',
      body: {'email': email},
      authenticated: false,
    );
  }

  Future<bool> verifyEmailCode(String email, String code) async {
    final json = await _request(
      'POST',
      '/auth/email/verify',
      body: {'email': email, 'code': code},
      authenticated: false,
    );
    _token = json['token'] as String;
    _isGuest = false;
    await _storage.write(key: _tokenKey, value: _token);
    await _storage.write(key: _sessionModeKey, value: 'signedIn');
    var migrated = true;
    if (await _guestStore.hasData) {
      try {
        await _migrateGuestData();
      } catch (_) {
        migrated = false;
      }
    }
    if (migrated) {
      await _storage.delete(key: _guestTokenKey);
      await _guestStore.clear();
    }
    return migrated;
  }

  Future<void> logout() async {
    _token = null;
    _isGuest = false;
    _studySession = null;
    await _storage.delete(key: _tokenKey);
    await _storage.delete(key: _sessionModeKey);
  }

  Future<void> deleteAccount() async {
    if (_isGuest) throw const ApiException('访客模式没有云端账户');
    await _request('DELETE', '/account');
    _token = null;
    _isGuest = false;
    _studySession = null;
    // The server deletion has already succeeded and invalidated this token.
    // Local cleanup is best-effort so a Keychain error cannot make the UI
    // incorrectly claim that the account still exists.
    for (final key in [_tokenKey, _guestTokenKey, _sessionModeKey]) {
      try {
        await _storage.delete(key: key);
      } catch (_) {}
    }
    try {
      await _guestStore.clear();
    } catch (_) {}
  }

  Future<String> me() async {
    final json = await _request('GET', '/me');
    return json['user'] as String;
  }

  Future<Uri> studyLaunchUrl() async {
    final json =
        await _request('POST', '/study/launch') as Map<String, dynamic>;
    return Uri.parse(json['url'] as String);
  }

  Future<StudySession> studySession({bool refresh = false}) async {
    if (!refresh && _studySession != null) return _studySession!;
    final launch = await studyLaunchUrl();
    final ticket = launch.queryParameters['sso'];
    if (ticket == null || ticket.isEmpty) {
      throw const ApiException('QQ群消息中心登录失败');
    }
    final base = Uri.parse('${launch.scheme}://${launch.authority}/api');
    final response = await _http.post(
      base.resolve('/api/auth/assistant-login'),
      headers: {'content-type': 'application/json'},
      body: jsonEncode({'token': ticket}),
    );
    final value = _decode(response) as Map<String, dynamic>;
    _studySession = StudySession(base, value['token'] as String);
    return _studySession!;
  }

  Future<List<Map<String, dynamic>>> studyMessages(String date) async {
    final value = await _studyRequest('/messages', query: {'date': date});
    return (value as List<dynamic>).cast<Map<String, dynamic>>();
  }

  Future<List<Map<String, dynamic>>> studyDownloads(String date) async {
    final value = await _studyRequest('/downloads', query: {'date': date});
    return (value as List<dynamic>).cast<Map<String, dynamic>>();
  }

  Future<Uint8List> studyPrintBundle(List<int> ids) async {
    final session = await studySession();
    final response = await _http.post(
      session.apiBase.resolve('/api/downloads/print-bundle'),
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ${session.token}',
      },
      body: jsonEncode({'ids': ids}),
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      _decode(response);
    }
    return response.bodyBytes;
  }

  Future<dynamic> _studyRequest(
    String path, {
    Map<String, String>? query,
  }) async {
    var session = await studySession();
    Future<http.Response> send() {
      final uri = session.apiBase
          .resolve('/api$path')
          .replace(queryParameters: query);
      return _http.get(
        uri,
        headers: {'authorization': 'Bearer ${session.token}'},
      );
    }

    var response = await send();
    if (response.statusCode == 401) {
      session = await studySession(refresh: true);
      response = await send();
    }
    return _decode(response);
  }

  Future<List<AssistantEntry>> entries() async {
    if (_isGuest) return _guestStore.entries();
    final value = await _request('GET', '/entries') as List<dynamic>;
    return value
        .map((item) => AssistantEntry.fromJson(item as Map<String, dynamic>))
        .toList();
  }

  Future<List<KnowledgeItem>> knowledge() async {
    if (_isGuest) return _guestStore.knowledge();
    final value = await _request('GET', '/knowledge') as List<dynamic>;
    return value
        .map((item) => KnowledgeItem.fromJson(item as Map<String, dynamic>))
        .toList();
  }

  Future<List<AiConversation>> conversations() async {
    if (_isGuest) return const [];
    final value = await _request('GET', '/conversations') as List<dynamic>;
    return value
        .map((item) => AiConversation.fromJson(item as Map<String, dynamic>))
        .toList();
  }

  Future<String> createConversation(String title) async {
    final value =
        await _request('POST', '/conversations', body: {'title': title.trim()})
            as Map<String, dynamic>;
    return value['id'] as String;
  }

  Future<List<ConversationInvitation>> conversationInvitations() async {
    if (_isGuest) return const [];
    final value =
        await _request('GET', '/conversation-invitations') as List<dynamic>;
    return value
        .map(
          (item) =>
              ConversationInvitation.fromJson(item as Map<String, dynamic>),
        )
        .toList();
  }

  Future<String?> respondToConversationInvitation(
    String id, {
    required bool accept,
  }) async {
    final value =
        await _request(
              'POST',
              '/conversation-invitations/${Uri.encodeComponent(id)}/respond',
              body: {'accept': accept},
            )
            as Map<String, dynamic>;
    return value['conversationId'] as String?;
  }

  Future<List<Map<String, dynamic>>> conversationMembers(String id) async {
    final value =
        await _request(
              'GET',
              '/conversations/${Uri.encodeComponent(id)}/members',
            )
            as List<dynamic>;
    return value.cast<Map<String, dynamic>>();
  }

  Future<void> inviteConversationMember(String id, String account) async {
    await _request(
      'POST',
      '/conversations/${Uri.encodeComponent(id)}/invitations',
      body: {'account': account.trim()},
    );
  }

  Future<void> addConversationResource(
    String conversationId,
    String resourceType,
    String resourceId,
  ) async {
    await _request(
      'PUT',
      '/conversations/${Uri.encodeComponent(conversationId)}/resources/'
          '${Uri.encodeComponent(resourceType)}/${Uri.encodeComponent(resourceId)}',
    );
  }

  Future<List<AiConversationMessage>> conversationMessages(
    String conversationId, {
    int limit = 100,
  }) async {
    if (_isGuest) return const [];
    final value =
        await _request(
              'GET',
              '/conversations/${Uri.encodeComponent(conversationId)}/messages?limit=$limit',
            )
            as List<dynamic>;
    return value
        .map(
          (item) =>
              AiConversationMessage.fromJson(item as Map<String, dynamic>),
        )
        .toList();
  }

  Future<List<Map<String, dynamic>>> documents() async {
    if (_isGuest) return const [];
    final value = await _request('GET', '/documents') as List<dynamic>;
    return value.cast<Map<String, dynamic>>();
  }

  Future<Map<String, dynamic>> family() async {
    if (_isGuest) return {'family': null, 'invitations': <dynamic>[]};
    return await _request('GET', '/family') as Map<String, dynamic>;
  }

  Future<void> inviteFamilyMember(String account) async {
    await _request(
      'POST',
      '/family/invitations',
      body: {'account': account.trim()},
    );
  }

  Future<Map<String, dynamic>> respondToFamilyInvitation(
    String id, {
    required bool accept,
  }) async {
    return await _request(
          'POST',
          '/family/invitations/${Uri.encodeComponent(id)}/respond',
          body: {'accept': accept},
        )
        as Map<String, dynamic>;
  }

  Future<void> setKnowledgeFamilyShared(String id, bool shared) async {
    await _request(
      shared ? 'PUT' : 'DELETE',
      '/knowledge/${Uri.encodeComponent(id)}/family',
    );
  }

  Future<void> setDocumentFamilyShared(String id, bool shared) async {
    await _request(
      shared ? 'PUT' : 'DELETE',
      '/documents/${Uri.encodeComponent(id)}/family',
    );
  }

  Future<Map<String, dynamic>> worldPulse({bool force = false}) async {
    final value = await _request(
      'GET',
      force ? '/world-pulse?refresh=1' : '/world-pulse',
    );
    return value as Map<String, dynamic>;
  }

  Future<Uint8List> downloadDocument(String id) async {
    if (_isGuest) throw const ApiException('请先登录后再查看原始资料');
    final response = await _send(
      'GET',
      '/documents/${Uri.encodeComponent(id)}/content',
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      _decode(response);
    }
    return response.bodyBytes;
  }

  Future<void> deleteDocument(String id) async {
    if (_isGuest) throw const ApiException('请先登录后再删除资料');
    await _request('DELETE', '/documents/${Uri.encodeComponent(id)}');
  }

  Future<Map<String, dynamic>> uploadDocument({
    required String fileName,
    required String mimeType,
    required Uint8List bytes,
    String note = '',
    bool waitForProcessing = true,
  }) async {
    if (_isGuest) throw const ApiException('请先登录后再上传家庭资料');
    if (bytes.length > _chunkedUploadThreshold) {
      return uploadDocumentInChunks(
        fileName: fileName,
        mimeType: mimeType,
        totalBytes: bytes.length,
        readChunk: (offset, length) async =>
            Uint8List.sublistView(bytes, offset, offset + length),
        note: note,
        waitForProcessing: waitForProcessing,
      );
    }
    final uri = Uri.parse(
      '$apiBase/documents',
    ).replace(queryParameters: {'fileName': fileName});
    try {
      final response = await _http.post(
        uri,
        headers: {
          'content-type': mimeType,
          if (note.trim().isNotEmpty)
            'x-document-note-b64': base64Encode(utf8.encode(note.trim())),
          if (_token != null) 'authorization': 'Bearer $_token',
        },
        body: bytes,
      );
      final json = _decode(response) as Map<String, dynamic>;
      if (response.statusCode != 202 || !waitForProcessing) return json;
      final result = await _waitForJob(
        json['jobId'] as String,
        timeoutSeconds: 300,
      );
      return {
        ...result,
        if (json['duplicate'] == true) 'duplicate': true,
        if (json['noteQueued'] == true) 'noteAppended': true,
      };
    } catch (error) {
      if (error is ApiException) rethrow;
      throw const ApiException('资料上传失败，请检查网络后重试');
    }
  }

  Future<Map<String, dynamic>> uploadDocumentInChunks({
    required String fileName,
    required String mimeType,
    required int totalBytes,
    required Future<Uint8List> Function(int offset, int length) readChunk,
    String note = '',
    bool waitForProcessing = true,
  }) async {
    if (_isGuest) throw const ApiException('请先登录后再上传家庭资料');
    try {
      final session =
          await _request(
                'POST',
                '/documents/uploads',
                body: {
                  'fileName': fileName,
                  'mimeType': mimeType,
                  'userNote': note.trim(),
                  'totalBytes': totalBytes,
                },
              )
              as Map<String, dynamic>;
      final uploadId = session['uploadId'] as String;
      final chunkSize = (session['chunkSize'] as num).toInt();
      final chunkCount = (session['chunkCount'] as num).toInt();
      for (var index = 0; index < chunkCount; index += 1) {
        final start = index * chunkSize;
        final end = (start + chunkSize).clamp(0, totalBytes);
        final chunk = await readChunk(start, end - start);
        if (chunk.length != end - start) {
          throw const ApiException('本机录音分片读取不完整');
        }
        await _uploadDocumentChunk(uploadId, index, chunk);
      }
      final json =
          await _request(
                'POST',
                '/documents/uploads/${Uri.encodeComponent(uploadId)}/complete',
              )
              as Map<String, dynamic>;
      if (json['status'] != 'QUEUED' || !waitForProcessing) return json;
      final result = await _waitForJob(
        json['jobId'] as String,
        timeoutSeconds: 300,
      );
      return {
        ...result,
        if (json['duplicate'] == true) 'duplicate': true,
        if (json['noteQueued'] == true) 'noteAppended': true,
      };
    } catch (error) {
      if (error is ApiException) rethrow;
      throw const ApiException('资料分段上传失败，请检查网络后重试');
    }
  }

  Future<void> _uploadDocumentChunk(
    String uploadId,
    int index,
    Uint8List chunk,
  ) async {
    Object? lastError;
    for (var attempt = 0; attempt < 3; attempt += 1) {
      try {
        final response = await _http.put(
          Uri.parse(
            '$apiBase/documents/uploads/${Uri.encodeComponent(uploadId)}/chunks/$index',
          ),
          headers: {
            'content-type': 'application/octet-stream',
            if (_token != null) 'authorization': 'Bearer $_token',
          },
          body: chunk,
        );
        if (response.statusCode >= 200 && response.statusCode < 300) return;
        _decode(response);
      } catch (error) {
        lastError = error;
        if (error is ApiException && (error.status ?? 0) < 500) rethrow;
        if (attempt < 2) {
          await Future<void>.delayed(
            Duration(milliseconds: 350 * (attempt + 1)),
          );
        }
      }
    }
    if (lastError is ApiException) throw lastError;
    throw const ApiException('录音分片上传失败，请稍后重试');
  }

  Future<Map<String, dynamic>> addDocumentNote(
    String documentId,
    String note,
  ) async {
    if (_isGuest) throw const ApiException('请先登录后再补充资料说明');
    final response = await _send(
      'POST',
      '/documents/${Uri.encodeComponent(documentId)}/notes',
      body: {'note': note.trim()},
    );
    final json = _decode(response) as Map<String, dynamic>;
    if (response.statusCode != 202) return json;
    return _waitForJob(json['jobId'] as String, timeoutSeconds: 120);
  }

  Future<void> deleteKnowledge(String id) async {
    if (_isGuest) {
      await _guestStore.deleteKnowledge(id);
      return;
    }
    await _request('DELETE', '/knowledge/$id');
  }

  Future<String> transcribeAudio(List<int> audio) async {
    final headers = <String, String>{
      'content-type': 'application/octet-stream',
      if (_token != null) 'authorization': 'Bearer $_token',
    };
    try {
      final response = await _http.post(
        Uri.parse('$apiBase/transcribe'),
        headers: headers,
        body: audio,
      );
      final json = _decode(response) as Map<String, dynamic>;
      return (json['text'] as String? ?? '').trim();
    } catch (error) {
      if (error is ApiException) rethrow;
      throw const ApiException('语音上传失败，请检查网络后重试');
    }
  }

  Future<Map<String, dynamic>> ingest(
    String raw, {
    void Function()? onQueued,
    String inputMode = 'voice',
    String? conversationId,
    bool waitForCompletion = true,
  }) async {
    final body = <String, dynamic>{
      'raw': raw,
      'inputMode': inputMode == 'text' ? 'text' : 'voice',
      if (conversationId != null && conversationId.isNotEmpty)
        'conversationId': conversationId,
    };
    if (_isGuest) {
      body['knowledge'] = (await _guestStore.knowledge())
          .map((item) => item.toJson())
          .toList();
    }
    final response = await _send('POST', '/entries', body: body);
    final json = _decode(response);
    final queued = response.statusCode == 202;
    if (queued) onQueued?.call();
    final result = queued && waitForCompletion
        ? await _waitForJob((json as Map<String, dynamic>)['jobId'] as String)
        : json as Map<String, dynamic>;
    if (_isGuest) await _persistGuestResult(result);
    return result;
  }

  Future<Map<String, dynamic>> _waitForJob(
    String id, {
    int timeoutSeconds = 90,
  }) async {
    final deadline = DateTime.now().add(Duration(seconds: timeoutSeconds));
    while (DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 900));
      final json =
          await _request('GET', '/ai-jobs/$id') as Map<String, dynamic>;
      if (json['status'] == 'COMPLETE') {
        return json['result'] as Map<String, dynamic>;
      }
      if (json['status'] == 'FAILED') {
        throw ApiException((json['error'] as String?) ?? 'AI 处理失败');
      }
    }
    throw const ApiException('AI 仍在排队，稍后刷新即可看到结果');
  }

  Future<AssistantEntry> toggleDone(String id, bool done) async {
    if (_isGuest) {
      try {
        return await _guestStore.setEntryDone(id, done);
      } on StateError {
        throw const ApiException('记录不存在');
      }
    }
    final json = await _request('PATCH', '/entries/$id', body: {'done': done});
    return AssistantEntry.fromJson(json as Map<String, dynamic>);
  }

  Future<void> deleteEntry(String id) async {
    if (_isGuest) {
      await _guestStore.deleteEntry(id);
      return;
    }
    await _request('DELETE', '/entries/$id');
  }

  Future<void> _persistGuestResult(Map<String, dynamic> result) async {
    if (result['kind'] == 'record') {
      final incoming = (result['entries'] as List<dynamic>? ?? const []).map(
        (item) => AssistantEntry.fromJson(item as Map<String, dynamic>),
      );
      await _guestStore.upsertEntries(incoming);
    } else if (result['kind'] == 'save' && result['item'] != null) {
      final item = KnowledgeItem.fromJson(
        result['item'] as Map<String, dynamic>,
      );
      await _guestStore.upsertKnowledge(item);
    }
  }

  Future<void> _migrateGuestData() async {
    final entries = await _guestStore.entries();
    final knowledge = await _guestStore.knowledge();
    if (entries.isEmpty && knowledge.isEmpty) return;
    await _request(
      'POST',
      '/import',
      body: {
        'migrationId': await _guestStore.migrationId(),
        'entries': entries.map((item) => item.toJson()).toList(),
        'knowledge': knowledge.map((item) => item.toJson()).toList(),
      },
    );
  }

  Future<ReportLoadResult?> report({
    required String scope,
    required String periodKey,
    required String dateLabel,
    required List<AssistantEntry> entries,
  }) async {
    final response = await _send(
      'POST',
      '/summary',
      body: {
        'scope': scope,
        'periodKey': periodKey,
        'dateLabel': dateLabel,
        'entries': entries
            .map(
              (entry) => {
                'type': entry.type.name,
                'category': entry.category,
                'description': entry.displayDescription,
                if (entry.amount != null) 'amount': entry.amount,
                if (entry.hasTimeRange)
                  'timeRange': {'start': entry.timeStart, 'end': entry.timeEnd},
                if (entry.type == EntryType.memo) 'done': entry.done,
              },
            )
            .toList(),
      },
    );
    if (response.statusCode == 204) return null;
    final json = _decode(response) as Map<String, dynamic>;
    if (response.statusCode == 202) {
      final value = await _waitForJob(json['jobId'] as String);
      return ReportLoadResult(report: AssistantReport.fromJson(value));
    }
    return ReportLoadResult(
      report: AssistantReport.fromJson(json),
      stale: json['stale'] == true,
      refreshJobId: json['refreshJobId'] as String?,
      updatedAt: json['updatedAt'] == null
          ? null
          : DateTime.parse(json['updatedAt'] as String).toLocal(),
    );
  }

  Future<AssistantReport> waitForReport(String jobId) async =>
      AssistantReport.fromJson(await _waitForJob(jobId));

  Uri asrUri() {
    final uri = Uri.parse('$apiBase/asr');
    return uri.replace(
      scheme: uri.scheme == 'https' ? 'wss' : 'ws',
      queryParameters: {'token': _token ?? ''},
    );
  }

  Future<dynamic> _request(
    String method,
    String path, {
    Map<String, dynamic>? body,
    bool authenticated = true,
  }) async {
    return _decode(
      await _send(method, path, body: body, authenticated: authenticated),
    );
  }

  Future<http.Response> _send(
    String method,
    String path, {
    Map<String, dynamic>? body,
    bool authenticated = true,
  }) async {
    final headers = <String, String>{'content-type': 'application/json'};
    if (authenticated && _token != null) {
      headers['authorization'] = 'Bearer $_token';
    }
    final uri = Uri.parse('$apiBase$path');
    final encoded = body == null ? null : jsonEncode(body);
    try {
      return await switch (method) {
        'POST' => _http.post(uri, headers: headers, body: encoded),
        'PUT' => _http.put(uri, headers: headers, body: encoded),
        'PATCH' => _http.patch(uri, headers: headers, body: encoded),
        'DELETE' => _http.delete(uri, headers: headers),
        _ => _http.get(uri, headers: headers),
      };
    } catch (_) {
      throw const ApiException('暂时无法连接服务器，请检查网络后重试');
    }
  }

  dynamic _decode(http.Response response) {
    dynamic value;
    if (response.body.isNotEmpty) {
      try {
        value = jsonDecode(response.body);
      } catch (_) {
        value = null;
      }
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      final message = value is Map<String, dynamic>
          ? value['error'] as String?
          : null;
      throw ApiException(
        message ?? '请求失败 (${response.statusCode})',
        status: response.statusCode,
      );
    }
    return value;
  }
}

class StudySession {
  const StudySession(this.apiBase, this.token);

  final Uri apiBase;
  final String token;
}
