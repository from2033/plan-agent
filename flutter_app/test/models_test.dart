import 'dart:typed_data';

import 'package:assistant/models.dart';
import 'package:assistant/persistent_meeting_recorder.dart';
import 'package:assistant/voice_service.dart';
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
      scheduledDate: '2026-07-22',
      reminderAt: DateTime.parse('2026-07-22T00:00:00Z').toLocal(),
    );

    final restored = AssistantEntry.fromJson(original.toJson());

    expect(restored.id, original.id);
    expect(restored.type, EntryType.memo);
    expect(original.displayDescription, '吃药');
    expect(restored.description, '吃药');
    expect(restored.scheduledDate, '2026-07-22');
    expect(restored.reminderAt?.toUtc(), original.reminderAt?.toUtc());
  });

  test('scheduled descriptions hide stale relative dates', () {
    final entry = AssistantEntry.fromJson({
      'id': 'entry-relative-date',
      'type': 'memo',
      'description': '明天带孩子理发',
      'category': '备忘',
      'scheduledDate': '2026-08-29',
      'timestamp': '2026-08-29T04:00:00.000Z',
    });

    expect(entry.displayDescription, '带孩子理发');
    expect(entry.toJson()['description'], '带孩子理发');
  });

  test('scheduled activities remain todo items until completed', () {
    final scheduled = AssistantEntry.fromJson({
      'id': 'scheduled-activity',
      'type': 'activity',
      'description': '带孩子理发',
      'category': '日常',
      'scheduledDate': '2026-08-29',
      'timestamp': '2026-08-29T04:00:00.000Z',
    });
    final recorded = AssistantEntry.fromJson({
      'id': 'recorded-activity',
      'type': 'activity',
      'description': '进行了学习',
      'category': '学习',
      'timestamp': '2026-08-29T01:00:00.000Z',
    });

    expect(scheduled.isTodoItem, isTrue);
    expect(recorded.isTodoItem, isFalse);
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

  test('shared family knowledge is read only for another member', () {
    final item = KnowledgeItem.fromJson({
      'id': 'shared-note-1',
      'title': '孩子体检',
      'content': '年度体检记录',
      'ownerUserId': 'primary',
      'sharedWithFamily': true,
      'canEdit': false,
    });

    expect(item.sharedWithFamily, isTrue);
    expect(item.canEdit, isFalse);
    expect(item.ownerUserId, 'primary');
  });

  test('AI conversation messages retain status and cited sources', () {
    final message = AiConversationMessage.fromJson({
      'id': 'message-1',
      'conversationId': 'conversation-1',
      'senderType': 'assistant',
      'kind': 'answer',
      'content': '家长会主要讲了开学适应。',
      'status': 'complete',
      'metadata': {
        'sources': [
          {'id': 'document-1', 'title': '秋季开学家长会'},
        ],
      },
      'createdAt': '2026-08-29T13:00:00.000Z',
    });

    expect(message.isMineFor('current@example.com'), isFalse);
    expect(message.isPending, isFalse);
    expect(message.content, contains('开学适应'));
    expect((message.metadata['sources'] as List).length, 1);
  });

  test('long WAV recordings are split into valid transcription chunks', () {
    final payload = Uint8List(120);
    final wav = Uint8List(44 + payload.length);
    wav.setRange(0, 4, 'RIFF'.codeUnits);
    wav.setRange(8, 12, 'WAVE'.codeUnits);
    wav.setRange(12, 16, 'fmt '.codeUnits);
    ByteData.sublistView(wav).setUint32(16, 16, Endian.little);
    wav.setRange(36, 40, 'data'.codeUnits);
    ByteData.sublistView(wav).setUint32(40, payload.length, Endian.little);
    wav.setRange(44, wav.length, payload);

    final chunks = splitWavForTranscription(
      wav,
      maxSeconds: 1,
      bytesPerSecond: 50,
    );

    expect(chunks.length, 3);
    expect(String.fromCharCodes(chunks.first.sublist(0, 4)), 'RIFF');
    expect(ByteData.sublistView(chunks.first).getUint32(40, Endian.little), 50);
    expect(ByteData.sublistView(chunks.last).getUint32(40, Endian.little), 20);
  });

  test(
    'persistent PCM becomes a valid WAV and splits without losing bytes',
    () {
      final pcm = Uint8List.fromList(List<int>.generate(125, (index) => index));
      final chunks = splitPcm(pcm, chunkSeconds: 1, bytesPerSecond: 50);
      final rebuilt = chunks.expand((chunk) => chunk).toList();
      final wav = pcmToWav(pcm);

      expect(chunks.map((chunk) => chunk.length), [50, 50, 25]);
      expect(rebuilt, pcm);
      expect(String.fromCharCodes(wav.sublist(0, 4)), 'RIFF');
      expect(
        ByteData.sublistView(wav).getUint32(40, Endian.little),
        pcm.length,
      );
      expect(wav.sublist(44), pcm);
    },
  );
}
