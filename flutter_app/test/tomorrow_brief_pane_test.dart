import 'dart:convert';

import 'package:assistant/api_client.dart';
import 'package:assistant/main.dart';
import 'package:assistant/models.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:intl/intl.dart';
import 'package:intl/date_symbol_data_local.dart';

void main() {
  testWidgets('empty report response falls back to tomorrow entries', (
    tester,
  ) async {
    await initializeDateFormatting('zh_CN');
    final api = ApiClient(
      httpClient: MockClient((request) async {
        expect(request.url.path, '/api/summary');
        return http.Response(jsonEncode(<String, dynamic>{}), 200);
      }),
    );
    final today = DateTime(2026, 8, 31);
    final tomorrow = today.add(const Duration(days: 1));
    final entry = AssistantEntry(
      id: 'tomorrow-1',
      type: EntryType.memo,
      description: '准备明天的资料',
      category: '待办',
      timestamp: today,
      scheduledDate: DateFormat('yyyy-MM-dd').format(tomorrow),
    );

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TomorrowBriefPane(
            api: api,
            entries: [entry],
            selectedDate: today,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('明天清单'), findsOneWidget);
    expect(find.textContaining('准备明天的资料'), findsOneWidget);
  });

  testWidgets('entries outside tomorrow do not appear in the fallback', (
    tester,
  ) async {
    await initializeDateFormatting('zh_CN');
    final api = ApiClient(
      httpClient: MockClient(
        (request) async => http.Response(jsonEncode(<String, dynamic>{}), 200),
      ),
    );
    final today = DateTime(2026, 8, 31);
    final entry = AssistantEntry(
      id: 'later-1',
      type: EntryType.activity,
      description: '后天的安排',
      category: '日程',
      timestamp: today,
      scheduledDate: '2026-09-02',
    );

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TomorrowBriefPane(
            api: api,
            entries: [entry],
            selectedDate: today,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('明天还没有安排'), findsOneWidget);
    expect(find.text('后天的安排'), findsNothing);
  });
}
