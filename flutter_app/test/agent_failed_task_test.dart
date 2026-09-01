import 'dart:convert';

import 'package:assistant/agent_page.dart';
import 'package:assistant/api_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  testWidgets('失败 Agent 任务详情不会因数组 result 白屏', (tester) async {
    final api = ApiClient(
      httpClient: MockClient(
        (request) async => http.Response(
          jsonEncode({
            'id': 'failed-1',
            'capability': 'input_processing',
            'standardVersion': '1.1',
            'stage': 'failed',
            'sourceType': 'text',
            'requiresConfirmation': false,
            'input': {'title': '用表格形式给我'},
            'result': ['回答没有覆盖用户要求的表格格式'],
            'nextAction': '请重试或查看失败原因',
            'passedChecks': [],
            'failedChecks': ['输入处理产生可用且非答非所问的结果'],
            'failures': ['输入处理产生可用且非答非所问的结果'],
            'children': [],
          }),
          200,
          headers: {'content-type': 'application/json'},
        ),
      ),
    );

    await tester.pumpWidget(
      MaterialApp(
        home: AgentTaskDetailPage(api: api, taskId: 'failed-1'),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('处理或验收失败'), findsOneWidget);
    expect(find.text('输入处理产生可用且非答非所问的结果'), findsWidgets);
    expect(find.text('用表格形式给我'), findsOneWidget);
    await tester.scrollUntilVisible(find.text('让 Agent 修复'), 300);
    expect(find.text('让 Agent 修复'), findsOneWidget);
    await tester.scrollUntilVisible(find.text('报告结果问题'), 200);
    expect(find.text('报告结果问题'), findsOneWidget);
  });
}
