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
    expect(find.text('已安排自动续办 · 2 张图片'), findsOneWidget);
    expect(find.text('提交反馈'), findsOneWidget);
  });

  testWidgets('提交页只保留图片、语音和提交，不要求用户填写标题', (tester) async {
    final api = ApiClient(
      httpClient: MockClient((request) async => http.Response('{}', 200)),
    );
    await tester.pumpWidget(MaterialApp(home: NewFeedbackTicketPage(api: api)));
    await tester.pumpAndSettle();
    expect(find.text('问题标题'), findsNothing);
    expect(find.text('详细说明'), findsNothing);
    expect(find.text('按住说话'), findsOneWidget);
    expect(find.text('添加图片（0/9）'), findsOneWidget);
    expect(find.textContaining('标题、问题摘要和复现线索由 Agent 自动整理'), findsOneWidget);
    expect(find.textContaining('像持续对话一样直接检查、处理并验收'), findsOneWidget);
    expect(find.textContaining('不可逆、高风险'), findsOneWidget);
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

  testWidgets('已解决工单展示满意度闭环和可批准的标准提案', (tester) async {
    final api = ApiClient(
      httpClient: MockClient((request) async {
        return http.Response(
          jsonEncode({
            'id': 'ticket-3',
            'title': '日期依据错误',
            'description': '不能只靠模型猜测',
            'status': 'resolved',
            'canConfirm': true,
            'attachments': [],
            'events': [],
            'standardProposals': [
              {
                'id': 'proposal-1',
                'capability': 'date_resolution',
                'baseVersion': '1.0',
                'candidateVersion': '1.0-evo.demo',
                'status': 'ready',
                'rationale': '要求日期依据包含官方来源',
                'replay': {
                  'ready': true,
                  'negativeBlocked': 1,
                  'negativeTotal': 1,
                  'positivePassed': 3,
                  'positiveTotal': 3,
                  'fixturePassed': 2,
                  'fixtureTotal': 2,
                  'reasons': [],
                },
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
        home: FeedbackTicketDetailPage(api: api, ticketId: 'ticket-3'),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('确认已经解决'), findsOneWidget);
    expect(find.text('仍有问题，让 Agent 继续处理并学习'), findsOneWidget);
    expect(find.text('Agent 验收标准升级提案'), findsOneWidget);
    expect(find.text('批准并仅用于新任务'), findsOneWidget);
    expect(find.textContaining('负例拦截 1/1'), findsOneWidget);
  });
}
