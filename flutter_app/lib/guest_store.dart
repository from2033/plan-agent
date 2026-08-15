import 'dart:async';
import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import 'models.dart';

class GuestStore {
  static const _entriesKey = 'guest_entries_v1';
  static const _knowledgeKey = 'guest_knowledge_v1';
  static const _migrationKey = 'guest_migration_id_v1';

  final SharedPreferencesAsync _preferences = SharedPreferencesAsync();
  Future<void> _mutationTail = Future<void>.value();

  Future<List<AssistantEntry>> _readEntries() async {
    final raw = await _preferences.getString(_entriesKey);
    if (raw == null || raw.isEmpty) return [];
    try {
      return (jsonDecode(raw) as List<dynamic>)
          .map((item) => AssistantEntry.fromJson(item as Map<String, dynamic>))
          .toList();
    } catch (_) {
      return [];
    }
  }

  Future<List<AssistantEntry>> entries() async {
    await _mutationTail;
    return _readEntries();
  }

  Future<void> saveEntries(List<AssistantEntry> value) =>
      _preferences.setString(
        _entriesKey,
        jsonEncode(value.map((item) => item.toJson()).toList()),
      );

  Future<List<KnowledgeItem>> _readKnowledge() async {
    final raw = await _preferences.getString(_knowledgeKey);
    if (raw == null || raw.isEmpty) return [];
    try {
      return (jsonDecode(raw) as List<dynamic>)
          .map((item) => KnowledgeItem.fromJson(item as Map<String, dynamic>))
          .toList();
    } catch (_) {
      return [];
    }
  }

  Future<List<KnowledgeItem>> knowledge() async {
    await _mutationTail;
    return _readKnowledge();
  }

  Future<void> saveKnowledge(List<KnowledgeItem> value) =>
      _preferences.setString(
        _knowledgeKey,
        jsonEncode(value.map((item) => item.toJson()).toList()),
      );

  Future<String> migrationId() async {
    final existing = await _preferences.getString(_migrationKey);
    if (existing != null && existing.isNotEmpty) return existing;
    final value = '${DateTime.now().microsecondsSinceEpoch}';
    await _preferences.setString(_migrationKey, value);
    return value;
  }

  Future<bool> get hasData async =>
      (await entries()).isNotEmpty || (await knowledge()).isNotEmpty;

  Future<void> upsertEntries(Iterable<AssistantEntry> incoming) =>
      _enqueueMutation(() async {
        final stored = await _readEntries();
        final byId = {for (final item in stored) item.id: item};
        for (final item in incoming) {
          byId[item.id] = item;
        }
        await saveEntries(byId.values.toList());
      });

  Future<AssistantEntry> setEntryDone(String id, bool done) =>
      _enqueueMutation(() async {
        final items = await _readEntries();
        final index = items.indexWhere((item) => item.id == id);
        if (index < 0) throw StateError('记录不存在');
        items[index] = items[index].copyWith(done: done);
        await saveEntries(items);
        return items[index];
      });

  Future<void> deleteEntry(String id) => _enqueueMutation(() async {
    final items = await _readEntries();
    items.removeWhere((item) => item.id == id);
    await saveEntries(items);
  });

  Future<void> upsertKnowledge(KnowledgeItem item) =>
      _enqueueMutation(() async {
        final stored = await _readKnowledge();
        stored.removeWhere((existing) => existing.id == item.id);
        stored.insert(0, item);
        await saveKnowledge(stored);
      });

  Future<void> deleteKnowledge(String id) => _enqueueMutation(() async {
    final items = await _readKnowledge();
    items.removeWhere((item) => item.id == id);
    await saveKnowledge(items);
  });

  Future<T> _enqueueMutation<T>(Future<T> Function() operation) {
    final completer = Completer<T>();
    _mutationTail = _mutationTail.then((_) async {
      try {
        completer.complete(await operation());
      } catch (error, stackTrace) {
        completer.completeError(error, stackTrace);
      }
    });
    return completer.future;
  }

  Future<void> clear() async {
    await _mutationTail;
    await _preferences.remove(_entriesKey);
    await _preferences.remove(_knowledgeKey);
    await _preferences.remove(_migrationKey);
  }
}
