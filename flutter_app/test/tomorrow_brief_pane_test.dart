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
  testWidgets('empty report response shows a visible fallback', (tester) async {
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

    expect(find.text('暂时没有可展示的明日安排，请稍后下拉刷新'), findsOneWidget);
  });
}
