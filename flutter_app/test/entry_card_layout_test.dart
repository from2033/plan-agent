import 'package:assistant/main.dart';
import 'package:assistant/models.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';

void main() {
  testWidgets('长待办在窄屏上保持分层且操作不占文本空间', (tester) async {
    await initializeDateFormatting('zh_CN');
    var toggled = false;
    var deleted = false;
    final entry = AssistantEntry(
      id: 'todo-layout',
      type: EntryType.memo,
      description: '这是一条很长的待办内容，需要完整显示所有文字，并且不能和完成、删除操作挤在一起。',
      category: '学习安排',
      timestamp: DateTime(2026, 9, 6, 19),
      scheduledDate: '2026-09-07',
      reminderAt: DateTime(2026, 9, 7, 8, 30),
    );

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 375,
            child: EntryCard(
              entry: entry,
              reminderScheduled: true,
              onToggleDone: () => toggled = true,
              onDelete: () => deleted = true,
            ),
          ),
        ),
      ),
    );

    expect(tester.takeException(), isNull);
    expect(find.textContaining('这是一条很长的待办内容'), findsOneWidget);
    expect(find.byTooltip('更多操作'), findsOneWidget);

    await tester.tap(find.bySemanticsLabel('标记完成'));
    expect(toggled, isTrue);

    await tester.tap(find.byTooltip('更多操作'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('删除'));
    expect(deleted, isTrue);
  });
}
