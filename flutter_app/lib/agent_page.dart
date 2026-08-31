import 'package:flutter/material.dart';
import 'api_client.dart';

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
  static const groups = <(String, String, IconData)>[
    ('awaiting_confirmation', '待确认', Icons.pan_tool_outlined),
    ('executing', '执行中', Icons.sync_rounded),
    ('verifying', '验收中', Icons.fact_check_outlined),
    ('failed', '验收失败', Icons.error_outline_rounded),
    ('follow_up', '待跟进', Icons.notifications_active_outlined),
    ('verified', '已完成', Icons.check_circle_outline_rounded),
  ];
  @override
  void initState() {
    super.initState();
    load();
  }

  Future<void> load() async {
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

  Future<void> act(
    String id,
    Future<Map<String, dynamic>> Function(String) request,
  ) async {
    try {
      await request(id);
      await load();
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    }
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
            Icon(group.$3, size: 20, color: const Color(0xff9a4f06)),
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
          child: Padding(
            padding: const EdgeInsets.all(13),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  task['capability']?.toString() ?? 'Agent 任务',
                  style: const TextStyle(
                    fontSize: 11,
                    color: Color(0xff8a8680),
                  ),
                ),
                const SizedBox(height: 5),
                Text(
                  (task['input'] as Map?)?['title']?.toString() ?? '未命名任务',
                  style: const TextStyle(fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 5),
                Text(
                  task['nextAction']?.toString() ?? group.$2,
                  style: const TextStyle(
                    fontSize: 12,
                    color: Color(0xff57534e),
                  ),
                ),
                if (group.$1 == 'awaiting_confirmation')
                  Align(
                    alignment: Alignment.centerRight,
                    child: FilledButton(
                      onPressed: () => act(
                        task['id'] as String,
                        widget.api.confirmAgentTask,
                      ),
                      child: const Text('确认执行'),
                    ),
                  ),
                if (group.$1 == 'failed')
                  Align(
                    alignment: Alignment.centerRight,
                    child: FilledButton(
                      onPressed: () =>
                          act(task['id'] as String, widget.api.retryAgentTask),
                      child: const Text('重试'),
                    ),
                  ),
                if (group.$1 == 'follow_up')
                  Align(
                    alignment: Alignment.centerRight,
                    child: FilledButton(
                      onPressed: () => act(
                        task['id'] as String,
                        widget.api.followUpAgentTask,
                      ),
                      child: const Text('继续处理'),
                    ),
                  ),
              ],
            ),
          ),
        ),
    ];
  }
}
