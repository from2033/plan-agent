import 'dart:async';
import 'package:flutter/material.dart';
import 'api_client.dart';

String agentCapabilityLabel(String? capability) => switch (capability) {
  'input_orchestration' => '计划型 Agent',
  'input_processing' => '提问与录入',
  'date_resolution' => '日期确认',
  'feedback' => '结果反馈',
  'desktop_intake' => '电脑资料投递',
  'document_ingest' => '资料识别与归档',
  'tomorrow_brief' => '明日管家',
  'document_action' => '资料后续动作',
  'todo' => '待办',
  'reminder' => '提醒',
  'research' => '研究',
  'qq_task_sync' => 'QQ 群同步',
  'desktop_action' => '电脑操作',
  _ => capability ?? 'Agent 任务',
};

String agentStandardLabel(String? capability, String? version) =>
    switch (capability) {
      'input_orchestration' => '行动覆盖标准 v${version ?? '-'}',
      'reminder' => '日期与闹钟完整性 v${version ?? '-'}',
      'tomorrow_brief' => '原文事项覆盖标准 v${version ?? '-'}',
      _ => '能力验收标准 v${version ?? '-'}',
    };

String agentStageLabel(String? stage) => switch (stage) {
  'received' => '刚刚收到',
  'planned' => '已规划',
  'classified' => '正在判断',
  'extracted' => '已提取目标',
  'awaiting_confirmation' => '等待你确认',
  'executing' => '执行中',
  'verifying' => '验收中',
  'retrying' => '重试中',
  'awaiting_user' => '等待你补充',
  'failed' => '处理或验收失败',
  'follow_up' => '等待后续处理',
  'verified' => '已完成并通过验收',
  _ => stage ?? '未知状态',
};

Color agentStageColor(String? stage) => switch (stage) {
  'verified' => const Color(0xff267046),
  'failed' => const Color(0xffb42318),
  'awaiting_confirmation' || 'awaiting_user' => const Color(0xff9a4f06),
  _ => const Color(0xff52645b),
};

IconData agentStageIcon(String? stage) => switch (stage) {
  'verified' => Icons.check_circle_outline_rounded,
  'failed' => Icons.error_outline_rounded,
  'awaiting_confirmation' => Icons.pan_tool_outlined,
  'awaiting_user' => Icons.help_outline_rounded,
  'follow_up' => Icons.notifications_active_outlined,
  'verifying' => Icons.fact_check_outlined,
  _ => Icons.sync_rounded,
};

class AgentPage extends StatefulWidget {
  const AgentPage({super.key, required this.api});
  final ApiClient api;
  @override
  State<AgentPage> createState() => _AgentPageState();
}

class _AgentPageState extends State<AgentPage> {
  bool loading = true;
  String? error;
  List<Map<String, dynamic>> tasks = [];
  Timer? refreshTimer;
  static const groups = <(String, String, IconData)>[
    ('awaiting_confirmation', '待确认', Icons.pan_tool_outlined),
    ('awaiting_user', '等待补充', Icons.help_outline_rounded),
    ('failed', '处理或验收失败', Icons.error_outline_rounded),
    ('received', '刚刚收到', Icons.inbox_outlined),
    ('classified', '正在判断', Icons.account_tree_outlined),
    ('extracted', '已提取目标', Icons.filter_alt_outlined),
    ('executing', '执行中', Icons.sync_rounded),
    ('verifying', '验收中', Icons.fact_check_outlined),
    ('retrying', '重试中', Icons.refresh_rounded),
    ('follow_up', '待跟进', Icons.notifications_active_outlined),
    ('verified', '已完成', Icons.check_circle_outline_rounded),
  ];

  @override
  void initState() {
    super.initState();
    load();
    refreshTimer = Timer.periodic(
      const Duration(seconds: 2),
      (_) => load(silent: true),
    );
  }

  @override
  void dispose() {
    refreshTimer?.cancel();
    super.dispose();
  }

  Future<void> load({bool silent = false}) async {
    if (!silent && mounted) setState(() => loading = true);
    try {
      final value = await widget.api.agentTasks();
      if (mounted) {
        setState(() {
          tasks = value;
          error = null;
        });
      }
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  Future<void> _openTask(Map<String, dynamic> task) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) =>
            AgentTaskDetailPage(api: widget.api, taskId: task['id'].toString()),
      ),
    );
    await load(silent: true);
  }

  @override
  Widget build(BuildContext context) => loading
      ? const Center(child: CircularProgressIndicator())
      : RefreshIndicator(
          onRefresh: load,
          child: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              if (error != null)
                Text(error!, style: const TextStyle(color: Colors.red)),
              if (tasks.isEmpty)
                const Padding(
                  padding: EdgeInsets.only(top: 80),
                  child: Column(
                    children: [
                      Icon(
                        Icons.auto_awesome_outlined,
                        size: 42,
                        color: Color(0xffd97706),
                      ),
                      SizedBox(height: 12),
                      Text(
                        '还没有 Agent 处理记录',
                        style: TextStyle(fontWeight: FontWeight.w700),
                      ),
                      SizedBox(height: 6),
                      Text(
                        '电脑投递、提问或录入后，这里会显示处理、验收和后续动作。',
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          fontSize: 12,
                          color: Color(0xff8a8680),
                        ),
                      ),
                    ],
                  ),
                ),
              for (final group in groups) ..._section(group),
            ],
          ),
        );

  List<Widget> _section((String, String, IconData) group) {
    final values = tasks.where((task) => task['stage'] == group.$1).toList();
    if (values.isEmpty) return [];
    return [
      Padding(
        padding: const EdgeInsets.only(top: 8, bottom: 8),
        child: Row(
          children: [
            Icon(group.$3, size: 20, color: agentStageColor(group.$1)),
            const SizedBox(width: 8),
            Text(
              '${group.$2}  ${values.length}',
              style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16),
            ),
          ],
        ),
      ),
      for (final task in values)
        Card(
          elevation: 0,
          margin: const EdgeInsets.only(bottom: 9),
          child: InkWell(
            borderRadius: BorderRadius.circular(12),
            onTap: () => _openTask(task),
            child: Padding(
              padding: const EdgeInsets.all(13),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    agentStageIcon(group.$1),
                    size: 21,
                    color: agentStageColor(group.$1),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '${agentCapabilityLabel(task['capability']?.toString())} · ${agentStandardLabel(task['capability']?.toString(), task['standardVersion']?.toString())}',
                          style: const TextStyle(
                            fontSize: 11,
                            color: Color(0xff8a8680),
                          ),
                        ),
                        const SizedBox(height: 5),
                        Text(
                          (task['input'] as Map?)?['title']?.toString() ??
                              '未命名任务',
                          style: const TextStyle(fontWeight: FontWeight.w700),
                        ),
                        const SizedBox(height: 5),
                        Text(
                          task['nextAction']?.toString() ?? group.$2,
                          style: TextStyle(
                            fontSize: 12,
                            color: agentStageColor(group.$1),
                          ),
                        ),
                      ],
                    ),
                  ),
                  const Icon(
                    Icons.chevron_right_rounded,
                    color: Color(0xffa8a29e),
                  ),
                ],
              ),
            ),
          ),
        ),
    ];
  }
}

class AgentTaskDetailPage extends StatefulWidget {
  const AgentTaskDetailPage({
    super.key,
    required this.api,
    required this.taskId,
  });
  final ApiClient api;
  final String taskId;
  @override
  State<AgentTaskDetailPage> createState() => _AgentTaskDetailPageState();
}

class _AgentTaskDetailPageState extends State<AgentTaskDetailPage> {
  Map<String, dynamic>? task;
  String? error;
  bool busy = false;
  @override
  void initState() {
    super.initState();
    unawaited(load());
  }

  Future<void> load() async {
    try {
      final value = await widget.api.agentTask(widget.taskId);
      if (mounted) {
        setState(() {
          task = value;
          error = null;
        });
      }
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    }
  }

  Future<void> act(
    Future<Map<String, dynamic>> Function(String) request,
  ) async {
    setState(() => busy = true);
    try {
      await request(widget.taskId);
      await load();
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> reportProblem() async {
    final controller = TextEditingController();
    final description = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('告诉 Agent 哪里不对'),
        content: TextField(
          controller: controller,
          autofocus: true,
          minLines: 3,
          maxLines: 6,
          decoration: const InputDecoration(hintText: '例如：漏掉了第二份资料里的截止时间'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, controller.text.trim()),
            child: const Text('提交'),
          ),
        ],
      ),
    );
    controller.dispose();
    if (description == null || description.length < 2) return;
    setState(() => busy = true);
    try {
      await widget.api.correctAgentTask(widget.taskId, description);
      await load();
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('已记录问题，并立即交给 Agent 重新处理')));
      }
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  List<String> strings(dynamic value) =>
      value is List ? value.map((item) => item.toString()).toList() : const [];

  @override
  Widget build(BuildContext context) {
    final value = task;
    return Scaffold(
      appBar: AppBar(title: const Text('Agent 任务详情')),
      body: value == null
          ? Center(
              child: error == null
                  ? const CircularProgressIndicator()
                  : Text(error!),
            )
          : RefreshIndicator(
              onRefresh: load,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  _statusCard(value),
                  const SizedBox(height: 12),
                  _infoCard(value),
                  if ((value['planItems'] as List?)?.isNotEmpty == true) ...[
                    const SizedBox(height: 12),
                    _planCard(value),
                  ],
                  if (strings(value['passedChecks']).isNotEmpty ||
                      strings(value['failedChecks']).isNotEmpty) ...[
                    const SizedBox(height: 12),
                    _acceptanceCard(value),
                  ],
                  if (strings(value['failures']).isNotEmpty) ...[
                    const SizedBox(height: 12),
                    _failureCard(value),
                  ],
                  if ((value['children'] as List?)?.isNotEmpty == true) ...[
                    const SizedBox(height: 12),
                    _childrenCard(value),
                  ],
                  const SizedBox(height: 18),
                  ..._actions(value),
                ],
              ),
            ),
    );
  }

  Widget _statusCard(Map<String, dynamic> value) {
    final stage = value['stage']?.toString();
    final input = value['input'] as Map?;
    final result = value['result'] is Map ? value['result'] as Map : null;
    final summary = result?['summary']?.toString();
    return Card(
      elevation: 0,
      color: const Color(0xfffffbeb),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(agentStageIcon(stage), color: agentStageColor(stage)),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    agentStageLabel(stage),
                    style: TextStyle(
                      fontWeight: FontWeight.w800,
                      color: agentStageColor(stage),
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            Text(
              input?['title']?.toString() ?? 'Agent 任务',
              style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18),
            ),
            if (summary?.isNotEmpty == true) ...[
              const SizedBox(height: 9),
              Text(summary!),
            ],
            const SizedBox(height: 9),
            Text(
              value['nextAction']?.toString() ?? '等待状态更新',
              style: const TextStyle(fontSize: 12, color: Color(0xff78716c)),
            ),
          ],
        ),
      ),
    );
  }

  Widget _infoCard(Map<String, dynamic> value) {
    final input = value['input'] as Map?;
    final reason = input?['confirmationReason']?.toString();
    return Card(
      elevation: 0,
      child: Padding(
        padding: const EdgeInsets.all(15),
        child: Column(
          children: [
            _row('能力', agentCapabilityLabel(value['capability']?.toString())),
            _row(
              '验收标准',
              agentStandardLabel(
                value['capability']?.toString(),
                value['standardVersion']?.toString(),
              ),
            ),
            _row('来源', _sourceLabel(value['sourceType']?.toString())),
            _row('是否需确认', value['requiresConfirmation'] == true ? '是' : '否'),
            if (reason?.isNotEmpty == true) _row('确认原因', reason!),
          ],
        ),
      ),
    );
  }

  Widget _row(String label, String text) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 5),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 78,
          child: Text(
            label,
            style: const TextStyle(fontSize: 12, color: Color(0xff8a8680)),
          ),
        ),
        Expanded(
          child: Text(
            text,
            style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
          ),
        ),
      ],
    ),
  );

  Widget _acceptanceCard(Map<String, dynamic> value) => _listCard('验收结果', [
    for (final item in strings(value['passedChecks']))
      (Icons.check_rounded, const Color(0xff267046), item),
    for (final item in strings(value['failedChecks']))
      (Icons.close_rounded, const Color(0xffb42318), item),
  ]);

  Widget _planCard(Map<String, dynamic> value) {
    final items = (value['planItems'] as List? ?? const [])
        .whereType<Map>()
        .toList();
    final goals = strings(value['goals']);
    final missing = strings(value['missingRequirements']);
    return Card(
      elevation: 0,
      child: Padding(
        padding: const EdgeInsets.all(15),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Expanded(
                  child: Text(
                    'Agent 行动计划',
                    style: TextStyle(fontWeight: FontWeight.w800),
                  ),
                ),
                Text(
                  '第 ${value['planVersion'] ?? 1} 版',
                  style: const TextStyle(
                    fontSize: 11,
                    color: Color(0xff8a8680),
                  ),
                ),
              ],
            ),
            if (goals.isNotEmpty) ...[
              const SizedBox(height: 8),
              Text(
                goals.join('；'),
                style: const TextStyle(fontSize: 12, color: Color(0xff57534e)),
              ),
            ],
            const SizedBox(height: 8),
            for (final item in items)
              ListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                leading: Icon(
                  agentStageIcon(item['status']?.toString()),
                  color: agentStageColor(item['status']?.toString()),
                  size: 20,
                ),
                title: Text(
                  item['title']?.toString() ?? '未命名行动',
                  style: const TextStyle(fontWeight: FontWeight.w700),
                ),
                subtitle: Text(
                  '${agentCapabilityLabel(item['capability']?.toString())} · ${agentStageLabel(item['status']?.toString())}',
                  style: const TextStyle(fontSize: 11),
                ),
              ),
            if (missing.isNotEmpty) ...[
              const Divider(),
              Text(
                '尚未完成：${missing.join('、')}',
                style: const TextStyle(fontSize: 12, color: Color(0xffb42318)),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _failureCard(Map<String, dynamic> value) => _listCard('失败原因', [
    for (final item in strings(value['failures']))
      (Icons.error_outline_rounded, const Color(0xffb42318), item),
  ]);
  Widget _listCard(String title, List<(IconData, Color, String)> items) => Card(
    elevation: 0,
    child: Padding(
      padding: const EdgeInsets.all(15),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: const TextStyle(fontWeight: FontWeight.w800)),
          const SizedBox(height: 9),
          for (final item in items)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(item.$1, size: 17, color: item.$2),
                  const SizedBox(width: 7),
                  Expanded(
                    child: Text(item.$3, style: const TextStyle(fontSize: 12)),
                  ),
                ],
              ),
            ),
        ],
      ),
    ),
  );

  Widget _childrenCard(Map<String, dynamic> value) {
    final children = (value['children'] as List).whereType<Map>().toList();
    return Card(
      elevation: 0,
      child: Padding(
        padding: const EdgeInsets.all(15),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '关联子任务 ${children.length} 项',
              style: const TextStyle(fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 8),
            for (final child in children)
              ListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                leading: Icon(
                  agentStageIcon(child['stage']?.toString()),
                  color: agentStageColor(child['stage']?.toString()),
                ),
                title: Text(
                  (child['input'] as Map?)?['title']?.toString() ?? '资料',
                ),
                subtitle: Text(agentStageLabel(child['stage']?.toString())),
              ),
          ],
        ),
      ),
    );
  }

  List<Widget> _actions(Map<String, dynamic> value) {
    if (busy) return const [Center(child: CircularProgressIndicator())];
    final stage = value['stage']?.toString();
    final feedback = OutlinedButton.icon(
      onPressed: reportProblem,
      icon: const Icon(Icons.flag_outlined),
      label: const Text('报告结果问题'),
    );
    if (stage == 'awaiting_confirmation') {
      return [
        FilledButton.icon(
          onPressed: () => act(widget.api.confirmAgentTask),
          icon: const Icon(Icons.check_rounded),
          label: const Text('确认执行'),
        ),
        TextButton(
          onPressed: () => act(widget.api.dismissAgentTask),
          child: const Text('暂不处理'),
        ),
        feedback,
      ];
    }
    if (stage == 'failed') {
      return [
        FilledButton.icon(
          onPressed: () => act(widget.api.retryAgentTask),
          icon: const Icon(Icons.refresh_rounded),
          label: const Text('重试'),
        ),
        feedback,
      ];
    }
    if (stage == 'follow_up') {
      return [
        FilledButton.icon(
          onPressed: () => act(widget.api.followUpAgentTask),
          icon: const Icon(Icons.play_arrow_rounded),
          label: const Text('现在处理'),
        ),
        TextButton(
          onPressed: () => act(
            (id) => widget.api.followUpAgentTask(
              id,
              remindAt: DateTime.now().add(const Duration(days: 1)),
            ),
          ),
          child: const Text('明天提醒我'),
        ),
        feedback,
      ];
    }
    if (stage == 'awaiting_user') {
      return [
        OutlinedButton(
          onPressed: () => act(widget.api.dismissAgentTask),
          child: const Text('稍后处理'),
        ),
        feedback,
      ];
    }
    return [feedback];
  }

  String _sourceLabel(String? source) => switch (source) {
    'desktop' => '电脑投递',
    'qq_message' => 'QQ 群消息',
    'voice' => '语音',
    'image' => '图片',
    'document' => '资料',
    _ => source ?? 'App',
  };
}
