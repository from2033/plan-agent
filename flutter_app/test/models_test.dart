import 'package:assistant/models.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('parses an expense returned by the API', () {
    final entry = AssistantEntry.fromJson({
      'id': 'entry-1',
      'type': 'expense',
      'description': '午饭',
      'category': '餐饮',
      'amount': 28.5,
      'timestamp': '2026-07-19T12:00:00.000Z',
    });

    expect(entry.type, EntryType.expense);
    expect(entry.amount, 28.5);
    expect(entry.description, '午饭');
  });

  test('parses completion and a start/end time range', () {
    final entry = AssistantEntry.fromJson({
      'id': 'entry-2',
      'type': 'memo',
      'description': '开会',
      'category': '备忘',
      'done': true,
      'timeRange': {'start': '14:00', 'end': '16:00'},
      'reminderAt': '2026-07-20T06:00:00.000Z',
      'timestamp': '2026-07-20T06:00:00.000Z',
    });

    expect(entry.done, isTrue);
    expect(entry.hasTimeRange, isTrue);
    expect(entry.timeStart, '14:00');
    expect(entry.timeEnd, '16:00');
    expect(entry.reminderAt, isNotNull);
  });

  test('parses a generated report', () {
    final report = AssistantReport.fromJson({
      'highlights': ['完成了重要事项'],
      'improvements': ['还有一条备忘未完成'],
      'suggestions': ['明天先处理待办'],
    });

    expect(report.highlights, ['完成了重要事项']);
    expect(report.improvements.length, 1);
    expect(report.suggestions.length, 1);
  });

  test('guest entries survive a local JSON round trip', () {
    final original = AssistantEntry(
      id: 'guest-entry-1',
      type: EntryType.memo,
      description: '明早吃药',
      category: '备忘',
      timestamp: DateTime.parse('2026-07-22T00:00:00Z').toLocal(),
      time: '08:00',
      done: false,
      priority: 'medium',
      reminderAt: DateTime.parse('2026-07-22T00:00:00Z').toLocal(),
    );

    final restored = AssistantEntry.fromJson(original.toJson());

    expect(restored.id, original.id);
    expect(restored.type, EntryType.memo);
    expect(restored.description, '明早吃药');
    expect(restored.reminderAt?.toUtc(), original.reminderAt?.toUtc());
  });

  test('guest knowledge survives a local JSON round trip', () {
    const original = KnowledgeItem(
      id: 'guest-note-1',
      title: '番茄炒蛋',
      content: '先炒鸡蛋，再炒番茄。',
    );

    final restored = KnowledgeItem.fromJson(original.toJson());

    expect(restored.id, original.id);
    expect(restored.title, original.title);
    expect(restored.content, original.content);
  });
}
