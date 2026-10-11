import 'dart:async';

import 'package:assistant/api_client.dart';
import 'package:assistant/main.dart';
import 'package:assistant/models.dart';
import 'package:assistant/persistent_meeting_recorder.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class _ActionApi extends ApiClient {
  final dismissResult = Completer<void>();
  int dismissCalls = 0;

  @override
  Future<List<KnowledgeItem>> knowledge() async => [];

  @override
  Future<List<Map<String, dynamic>>> documents() async => [];

  @override
  Future<List<Map<String, dynamic>>> assistantActions() async => [
    {'id': 'action-1', 'status': 'PENDING', 'title': '测试后续动作'},
  ];

  @override
  Future<void> dismissAssistantAction(String id) {
    dismissCalls += 1;
    return dismissResult.future;
  }
}

class _MeetingRecorder extends PersistentMeetingRecorder {
  _MeetingRecorder(super.api);

  @override
  Future<int> pendingCount() async => 0;
}

void main() {
  testWidgets('成功忽略后，旧的列表响应不会让动作重新出现', (tester) async {
    final api = _ActionApi();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: KnowledgePane(
            api: api,
            meetingRecorder: _MeetingRecorder(api),
            startRecordingRequest: 0,
            onStartRecordingRequestHandled: () {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('忽略'));
    await tester.pump();
    api.dismissResult.complete();
    await tester.pump();
    expect(find.text('测试后续动作'), findsNothing);
    expect(find.text('已忽略后续动作'), findsOneWidget);

    // The fake API deliberately returns the stale PENDING row again.
    await tester.drag(find.byType(ListView), const Offset(0, 300));
    await tester.pumpAndSettle();
    expect(find.text('测试后续动作'), findsNothing);
  });

  testWidgets('忽略立即隐藏动作，失败时恢复', (tester) async {
    final api = _ActionApi();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: KnowledgePane(
            api: api,
            meetingRecorder: _MeetingRecorder(api),
            startRecordingRequest: 0,
            onStartRecordingRequestHandled: () {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('测试后续动作'), findsOneWidget);

    await tester.tap(find.text('忽略'));
    await tester.pump();
    expect(find.text('测试后续动作'), findsNothing);
    expect(api.dismissCalls, 1);

    api.dismissResult.completeError(const ApiException('网络暂时不可用'));
    await tester.pump();
    expect(find.text('测试后续动作'), findsOneWidget);
    expect(find.textContaining('忽略失败'), findsOneWidget);
  });
}
