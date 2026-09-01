import 'dart:convert';

import 'package:assistant/api_client.dart';
import 'package:assistant/feedback_center_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  testWidgets('反馈中心展示持续处理状态和截图数量', (tester) async {
    final api = ApiClient(
      httpClient: MockClient((request) async {
        expect(request.url.path, '/api/feedback/tickets');
        return http.Response(
          jsonEncode([
            {
              'id': 'ticket-1',
              'title': '明日管家漏项',
              'status': 'deferred',
              'attachments': [
                {'id': 'one'},
                {'id': 'two'},
              ],
            },
          ]),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    await tester.pumpWidget(MaterialApp(home: FeedbackCenterPage(api: api)));
    await tester.pumpAndSettle();

    expect(find.text('反馈中心'), findsOneWidget);
    expect(find.text('明日管家漏项'), findsOneWidget);
    expect(find.text('已安排自动续办 · 2 张截图'), findsOneWidget);
    expect(find.text('提交反馈'), findsOneWidget);
  });

  testWidgets('工单详情显示主账号确认方案和处理日志', (tester) async {
    final api = ApiClient(
      httpClient: MockClient((request) async {
        expect(request.url.path, '/api/feedback/tickets/ticket-2');
        return http.Response(
          jsonEncode({
            'id': 'ticket-2',
            'title': '回答结果不完整',
            'description': '漏掉截图中的第二项',
            'status': 'awaiting_confirmation',
            'canConfirm': true,
            'confirmationQuestion': '是否同意修改验收标准并重新处理？',
            'attachments': [],
            'plan': {
              'diagnosis': '原验收只检查结果是否存在',
              'proposedPlan': ['增加原文逐项覆盖检查'],
            },
            'events': [
              {
                'message': 'Agent 已形成处理方案，等待主账号确认',
                'toStatus': 'awaiting_confirmation',
              },
            ],
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    await tester.pumpWidget(
      MaterialApp(
        home: FeedbackTicketDetailPage(api: api, ticketId: 'ticket-2'),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('等待主账号确认'), findsWidgets);
    expect(find.text('Agent 处理方案'), findsOneWidget);
    expect(find.text('原验收只检查结果是否存在'), findsOneWidget);
    expect(find.text('是否同意修改验收标准并重新处理？'), findsOneWidget);
    expect(find.text('Agent 已形成处理方案，等待主账号确认'), findsOneWidget);
  });
}
