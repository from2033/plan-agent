import 'dart:convert';

import 'package:assistant/agent_page.dart';
import 'package:assistant/api_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  testWidgets('电脑投递详情显示结果、验收和子资料状态', (tester) async {
    final api = ApiClient(
      httpClient: MockClient((request) async {
        expect(request.url.path, '/api/agent/tasks/task-1');
        return http.Response(
          jsonEncode({
            'id': 'task-1',
            'capability': 'desktop_intake',
            'standardVersion': '1.0',
            'stage': 'verified',
            'sourceType': 'desktop',
            'requiresConfirmation': false,
            'input': {'title': '整理三份合同'},
            'result': {'summary': '已完成 3 项资料的归档和联合整理。'},
            'nextAction': '已完成并通过验收',
            'passedChecks': ['全部资料均已完成处理', '没有失败资料'],
            'failedChecks': [],
            'failures': [],
            'children': [
              {
                'stage': 'verified',
                'input': {'title': '合同一.pdf'},
              },
              {
                'stage': 'verified',
                'input': {'title': '合同二.pdf'},
              },
              {
                'stage': 'verified',
                'input': {'title': '补充说明.txt'},
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
        home: AgentTaskDetailPage(api: api, taskId: 'task-1'),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('电脑资料投递'), findsOneWidget);
    expect(find.text('已完成 3 项资料的归档和联合整理。'), findsOneWidget);
    expect(find.text('全部资料均已完成处理'), findsOneWidget);
    expect(find.text('关联子任务 3 项'), findsOneWidget);
    expect(find.text('合同一.pdf'), findsOneWidget);
    expect(find.text('已完成并通过验收'), findsWidgets);
  });

  testWidgets('计划型 Agent 展示逐项行动和缺失要求', (tester) async {
    final api = ApiClient(
      httpClient: MockClient(
        (_) async => http.Response(
          jsonEncode({
            'id': 'plan-1',
            'capability': 'input_orchestration',
            'standardVersion': '1.0',
            'stage': 'executing',
            'sourceType': 'voice',
            'requiresConfirmation': false,
            'input': {'title': '宝宝生日准备安排在中秋'},
            'nextAction': '正在处理',
            'passedChecks': [],
            'failedChecks': [],
            'failures': [],
            'planVersion': 1,
            'facts': ['宝宝生日计划安排在中秋'],
            'goals': ['确认中秋日期', '形成地点方案并反馈'],
            'coverageStatus': 'pending',
            'missingRequirements': ['调研南京大厂周边宝宝生日场地'],
            'planItems': [
              {
                'title': '确认2026年中秋日期',
                'capability': 'date_resolution',
                'status': 'verified',
              },
              {
                'title': '调研南京大厂周边宝宝生日场地',
                'capability': 'research',
                'status': 'executing',
              },
            ],
            'children': [],
          }),
          200,
          headers: {'content-type': 'application/json'},
        ),
      ),
    );

    await tester.pumpWidget(
      MaterialApp(
        home: AgentTaskDetailPage(api: api, taskId: 'plan-1'),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Agent 行动计划'), findsOneWidget);
    expect(find.text('行动覆盖标准 v1.0'), findsOneWidget);
    expect(find.text('确认2026年中秋日期'), findsOneWidget);
    expect(find.text('调研南京大厂周边宝宝生日场地'), findsWidgets);
    expect(find.textContaining('尚未完成'), findsOneWidget);
  });
}
