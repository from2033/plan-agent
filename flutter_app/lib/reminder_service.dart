import 'package:flutter/services.dart';

import 'models.dart';

class ReminderService {
  static const _channel = MethodChannel('com.from2033.assistant/reminders');

  Future<ReminderSyncResult> sync(List<AssistantEntry> entries) async {
    final now = DateTime.now();
    final reminders = entries
        .where(
          (entry) =>
              entry.type == EntryType.memo &&
              !entry.done &&
              entry.reminderAt != null &&
              entry.reminderAt!.isAfter(now),
        )
        .map(
          (entry) => {
            'id': entry.id,
            'title': '备忘提醒',
            'body': entry.description,
            'date': entry.reminderAt!.toUtc().toIso8601String(),
          },
        )
        .toList();
    final result = await _channel.invokeMapMethod<String, dynamic>('sync', {
      'reminders': reminders,
    });
    return ReminderSyncResult(
      mode: result?['mode'] as String? ?? 'none',
      scheduledEntryIds: Set<String>.from(
        (result?['scheduledEntryIds'] as List? ?? const []).whereType<String>(),
      ),
    );
  }
}

class ReminderSyncResult {
  const ReminderSyncResult({
    required this.mode,
    required this.scheduledEntryIds,
  });

  final String mode;
  final Set<String> scheduledEntryIds;
}
