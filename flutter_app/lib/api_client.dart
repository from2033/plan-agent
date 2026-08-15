import 'dart:async';
import 'dart:convert';

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
  final http.Client _http;
  final GuestStore _guestStore = GuestStore();

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
    } catch (_) {
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
    await _storage.delete(key: _tokenKey);
    await _storage.delete(key: _sessionModeKey);
  }

  Future<void> deleteAccount() async {
    if (_isGuest) throw const ApiException('访客模式没有云端账户');
    await _request('DELETE', '/account');
    _token = null;
    _isGuest = false;
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
  }) async {
    final body = <String, dynamic>{'raw': raw};
    if (_isGuest) {
      body['knowledge'] = (await _guestStore.knowledge())
          .map((item) => item.toJson())
          .toList();
    }
    final response = await _send('POST', '/entries', body: body);
    final json = _decode(response);
    final result = response.statusCode == 202
        ? await () async {
            onQueued?.call();
            final jobId = (json as Map<String, dynamic>)['jobId'] as String;
            return _waitForJob(jobId);
          }()
        : json as Map<String, dynamic>;
    if (_isGuest) await _persistGuestResult(result);
    return result;
  }

  Future<Map<String, dynamic>> _waitForJob(String id) async {
    final deadline = DateTime.now().add(const Duration(seconds: 90));
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
                'description': entry.description,
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
