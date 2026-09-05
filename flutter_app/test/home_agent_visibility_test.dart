import 'package:flutter_test/flutter_test.dart';

import 'package:assistant/main.dart';

void main() {
  final now = DateTime.utc(2026, 9, 5, 8);

  test('主导航只保留 Agent、事项和资料', () {
    expect(primaryNavigationLabels, ['Agent', '事项', '资料']);
  });

  test('首页不展示已完成、失败和跟进历史', () {
    final visible = selectHomeAgentTasks([
      {
        'id': 'verified',
        'stage': 'verified',
        'updatedAt': now.toIso8601String(),
      },
      {'id': 'failed', 'stage': 'failed', 'updatedAt': now.toIso8601String()},
      {
        'id': 'follow-up',
        'stage': 'follow_up',
        'updatedAt': now.toIso8601String(),
      },
    ], now: now);

    expect(visible, isEmpty);
  });

  test('首页优先且只展示一个正在处理的任务', () {
    final visible = selectHomeAgentTasks([
      {
        'id': 'confirmation',
        'stage': 'awaiting_confirmation',
        'updatedAt': now.toIso8601String(),
      },
      {
        'id': 'active-1',
        'stage': 'executing',
        'updatedAt': now.toIso8601String(),
      },
      {
        'id': 'active-2',
        'stage': 'verifying',
        'updatedAt': now.toIso8601String(),
      },
    ], now: now);

    expect(visible.map((task) => task['id']), ['active-1']);
  });

  test('等待用户的状态超过一天后不再占用首页', () {
    final visible = selectHomeAgentTasks([
      {
        'id': 'stale',
        'stage': 'awaiting_user',
        'updatedAt': now.subtract(const Duration(hours: 25)).toIso8601String(),
      },
    ], now: now);

    expect(visible, isEmpty);
  });
}
