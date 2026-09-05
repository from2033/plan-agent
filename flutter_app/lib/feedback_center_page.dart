import 'dart:async';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import 'api_client.dart';

String feedbackStatusLabel(String? status) => switch (status) {
  'draft' => '草稿',
  'submitted' => '已提交',
  'triaging' => 'Agent 分析中',
  'processing' => 'Agent 处理中',
  'awaiting_confirmation' => '等待主账号确认',
  'deferred' => '已安排自动续办',
  'verifying' => '验收中',
  'resolved' => '已解决',
  'closed' => '已关闭',
  'failed' => '处理失败',
  _ => status ?? '未知状态',
};

Color feedbackStatusColor(String? status) => switch (status) {
  'resolved' || 'closed' => const Color(0xff267046),
  'failed' => const Color(0xffb42318),
  'awaiting_confirmation' => const Color(0xff9a4f06),
  _ => const Color(0xff52645b),
};

class FeedbackCenterPage extends StatefulWidget {
  const FeedbackCenterPage({super.key, required this.api});
  final ApiClient api;

  @override
  State<FeedbackCenterPage> createState() => _FeedbackCenterPageState();
}

class _FeedbackCenterPageState extends State<FeedbackCenterPage> {
  List<Map<String, dynamic>> tickets = [];
  bool loading = true;
  String? error;
  Timer? timer;

  @override
  void initState() {
    super.initState();
    unawaited(load());
    timer = Timer.periodic(
      const Duration(seconds: 4),
      (_) => load(silent: true),
    );
  }

  @override
  void dispose() {
    timer?.cancel();
    super.dispose();
  }

  Future<void> load({bool silent = false}) async {
    if (!silent && mounted) setState(() => loading = true);
    try {
      final value = await widget.api.feedbackTickets();
      if (mounted) {
        setState(() {
          tickets = value;
          error = null;
        });
      }
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  Future<void> create() async {
    final created = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (_) => NewFeedbackTicketPage(api: widget.api)),
    );
    if (created == true) await load();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('反馈中心')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: create,
        icon: const Icon(Icons.add_comment_outlined),
        label: const Text('提交反馈'),
      ),
      body: loading && tickets.isEmpty
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: load,
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 96),
                children: [
                  if (error != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Text(
                        error!,
                        style: const TextStyle(color: Color(0xffb42318)),
                      ),
                    ),
                  if (tickets.isEmpty)
                    const Padding(
                      padding: EdgeInsets.only(top: 90),
                      child: Column(
                        children: [
                          Icon(
                            Icons.mark_unread_chat_alt_outlined,
                            size: 48,
                            color: Color(0xffa8a29e),
                          ),
                          SizedBox(height: 12),
                          Text('还没有反馈工单'),
                          SizedBox(height: 5),
                          Text(
                            '提交后 Agent 会持续跟踪，直到解决或明确关闭',
                            style: TextStyle(
                              fontSize: 12,
                              color: Color(0xff78716c),
                            ),
                          ),
                        ],
                      ),
                    ),
                  for (final ticket in tickets)
                    Card(
                      elevation: 0,
                      child: ListTile(
                        onTap: () async {
                          await Navigator.of(context).push(
                            MaterialPageRoute(
                              builder: (_) => FeedbackTicketDetailPage(
                                api: widget.api,
                                ticketId: ticket['id'].toString(),
                              ),
                            ),
                          );
                          await load();
                        },
                        leading: Icon(
                          Icons.confirmation_number_outlined,
                          color: feedbackStatusColor(
                            ticket['status']?.toString(),
                          ),
                        ),
                        title: Text(
                          ticket['title']?.toString() ?? '反馈工单',
                          style: const TextStyle(fontWeight: FontWeight.w700),
                        ),
                        subtitle: Text(
                          '${feedbackStatusLabel(ticket['status']?.toString())}${ticket['attachments'] is List ? ' · ${(ticket['attachments'] as List).length} 张截图' : ''}',
                        ),
                        trailing: const Icon(Icons.chevron_right_rounded),
                      ),
                    ),
                ],
              ),
            ),
    );
  }
}

class _PickedScreenshot {
  const _PickedScreenshot(this.name, this.mimeType, this.bytes);
  final String name;
  final String mimeType;
  final Uint8List bytes;
}

class NewFeedbackTicketPage extends StatefulWidget {
  const NewFeedbackTicketPage({
    super.key,
    required this.api,
    this.sourceTaskId,
  });
  final ApiClient api;
  final String? sourceTaskId;

  @override
  State<NewFeedbackTicketPage> createState() => _NewFeedbackTicketPageState();
}

class _NewFeedbackTicketPageState extends State<NewFeedbackTicketPage> {
  final title = TextEditingController();
  final description = TextEditingController();
  final screenshots = <_PickedScreenshot>[];
  bool busy = false;
  String? error;
  String? ticketId;
  int uploadedScreenshotCount = 0;

  @override
  void dispose() {
    title.dispose();
    description.dispose();
    super.dispose();
  }

  Future<void> pickScreenshots() async {
    final result = await FilePicker.platform.pickFiles(
      allowMultiple: true,
      type: FileType.image,
      withData: true,
    );
    if (result == null) return;
    final available = 9 - screenshots.length;
    final selected = result.files
        .take(available)
        .where((file) => file.bytes != null);
    setState(() {
      for (final file in selected) {
        final ext = (file.extension ?? '').toLowerCase();
        final mime = ext == 'jpg' || ext == 'jpeg'
            ? 'image/jpeg'
            : ext == 'heic'
            ? 'image/heic'
            : ext == 'heif'
            ? 'image/heif'
            : 'image/png';
        screenshots.add(_PickedScreenshot(file.name, mime, file.bytes!));
      }
    });
  }

  Future<void> submit() async {
    if (title.text.trim().length < 2 || description.text.trim().length < 2) {
      setState(() => error = '请填写标题和具体问题');
      return;
    }
    setState(() {
      busy = true;
      error = null;
    });
    try {
      if (ticketId == null) {
        final ticket = await widget.api.createFeedbackTicket(
          title: title.text,
          description: description.text,
          sourceTaskId: widget.sourceTaskId,
        );
        ticketId = ticket['id'].toString();
      }
      for (
        var index = uploadedScreenshotCount;
        index < screenshots.length;
        index++
      ) {
        final screenshot = screenshots[index];
        await widget.api.uploadFeedbackAttachment(
          ticketId: ticketId!,
          fileName: screenshot.name,
          mimeType: screenshot.mimeType,
          bytes: screenshot.bytes,
        );
        uploadedScreenshotCount = index + 1;
      }
      await widget.api.submitFeedbackTicket(ticketId!);
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('提交反馈')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          TextField(
            enabled: ticketId == null && !busy,
            controller: title,
            maxLength: 160,
            decoration: const InputDecoration(
              labelText: '问题标题',
              hintText: '例如：明日管家漏掉了物品',
            ),
          ),
          const SizedBox(height: 10),
          TextField(
            enabled: ticketId == null && !busy,
            controller: description,
            minLines: 5,
            maxLines: 10,
            maxLength: 10000,
            decoration: const InputDecoration(
              labelText: '详细说明',
              hintText: '请说明期望结果、实际结果和复现步骤',
            ),
          ),
          const SizedBox(height: 10),
          OutlinedButton.icon(
            onPressed: busy || ticketId != null || screenshots.length >= 9
                ? null
                : pickScreenshots,
            icon: const Icon(Icons.add_photo_alternate_outlined),
            label: Text('添加截图（${screenshots.length}/9）'),
          ),
          if (screenshots.isNotEmpty) ...[
            const SizedBox(height: 10),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (var index = 0; index < screenshots.length; index++)
                  Stack(
                    children: [
                      ClipRRect(
                        borderRadius: BorderRadius.circular(8),
                        child: Image.memory(
                          screenshots[index].bytes,
                          width: 92,
                          height: 92,
                          fit: BoxFit.cover,
                        ),
                      ),
                      Positioned(
                        right: 0,
                        top: 0,
                        child: IconButton.filledTonal(
                          visualDensity: VisualDensity.compact,
                          onPressed: busy || ticketId != null
                              ? null
                              : () =>
                                    setState(() => screenshots.removeAt(index)),
                          icon: const Icon(Icons.close, size: 16),
                        ),
                      ),
                    ],
                  ),
              ],
            ),
          ],
          if (error != null) ...[
            const SizedBox(height: 10),
            Text(error!, style: const TextStyle(color: Color(0xffb42318))),
          ],
          if (ticketId != null && error != null) ...[
            const SizedBox(height: 6),
            Text(
              '已保留当前草稿，再次提交会从第 ${uploadedScreenshotCount + 1} 张截图继续。',
              style: const TextStyle(fontSize: 12, color: Color(0xff78716c)),
            ),
          ],
          const SizedBox(height: 18),
          FilledButton.icon(
            onPressed: busy ? null : submit,
            icon: busy
                ? const SizedBox.square(
                    dimension: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.send_rounded),
            label: const Text('提交给 Agent 持续处理'),
          ),
          const SizedBox(height: 8),
          const Text(
            '提交后 Agent 会像持续对话一样直接检查、处理并验收；只有不可逆、高风险或需要你做关键选择时，才会暂停等待主账号确认。',
            style: TextStyle(fontSize: 12, color: Color(0xff78716c)),
          ),
        ],
      ),
    );
  }
}

class FeedbackTicketDetailPage extends StatefulWidget {
  const FeedbackTicketDetailPage({
    super.key,
    required this.api,
    required this.ticketId,
  });
  final ApiClient api;
  final String ticketId;

  @override
  State<FeedbackTicketDetailPage> createState() =>
      _FeedbackTicketDetailPageState();
}

class _FeedbackTicketDetailPageState extends State<FeedbackTicketDetailPage> {
  Map<String, dynamic>? ticket;
  bool busy = false;
  String? error;

  @override
  void initState() {
    super.initState();
    unawaited(load());
  }

  Future<void> load() async {
    try {
      final value = await widget.api.feedbackTicket(widget.ticketId);
      if (mounted) {
        setState(() {
          ticket = value;
          error = null;
        });
      }
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    }
  }

  Future<void> act(
    Future<Map<String, dynamic>> Function(String) callback,
  ) async {
    setState(() => busy = true);
    try {
      await callback(widget.ticketId);
      await load();
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> reportUnresolved() async {
    final controller = TextEditingController();
    final description = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('还有什么问题？'),
        content: TextField(
          controller: controller,
          autofocus: true,
          minLines: 3,
          maxLines: 7,
          maxLength: 2000,
          decoration: const InputDecoration(hintText: '说明仍不正确、遗漏或没有生效的地方'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () {
              if (controller.text.trim().length >= 2) {
                Navigator.pop(context, controller.text.trim());
              }
            },
            child: const Text('重新打开并让 Agent 学习'),
          ),
        ],
      ),
    );
    controller.dispose();
    if (description == null || !mounted) return;
    setState(() => busy = true);
    try {
      await widget.api.reopenFeedbackTicket(widget.ticketId, description);
      await load();
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> proposalAction(String proposalId, bool approve) async {
    setState(() => busy = true);
    try {
      if (approve) {
        await widget.api.approveStandardProposal(widget.ticketId, proposalId);
      } else {
        await widget.api.rejectStandardProposal(widget.ticketId, proposalId);
      }
      await load();
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final value = ticket;
    return Scaffold(
      appBar: AppBar(title: const Text('反馈工单')),
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
                  Card(
                    elevation: 0,
                    color: const Color(0xfffffbeb),
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            feedbackStatusLabel(value['status']?.toString()),
                            style: TextStyle(
                              fontWeight: FontWeight.w800,
                              color: feedbackStatusColor(
                                value['status']?.toString(),
                              ),
                            ),
                          ),
                          const SizedBox(height: 8),
                          Text(
                            value['title']?.toString() ?? '',
                            style: const TextStyle(
                              fontSize: 18,
                              fontWeight: FontWeight.w800,
                            ),
                          ),
                          const SizedBox(height: 8),
                          Text(value['description']?.toString() ?? ''),
                          if (value['nextAttemptAt'] != null) ...[
                            const SizedBox(height: 8),
                            Text(
                              '下次自动处理：${value['nextAttemptAt']}',
                              style: const TextStyle(fontSize: 12),
                            ),
                          ],
                        ],
                      ),
                    ),
                  ),
                  if ((value['attachments'] as List?)?.isNotEmpty == true) ...[
                    const SizedBox(height: 12),
                    Text(
                      '截图 ${(value['attachments'] as List).length} 张',
                      style: const TextStyle(fontWeight: FontWeight.w800),
                    ),
                    const SizedBox(height: 8),
                    SizedBox(
                      height: 112,
                      child: ListView.separated(
                        scrollDirection: Axis.horizontal,
                        itemCount: (value['attachments'] as List).length,
                        separatorBuilder: (_, _) => const SizedBox(width: 8),
                        itemBuilder: (_, index) {
                          final item =
                              (value['attachments'] as List)[index] as Map;
                          return FutureBuilder<Uint8List>(
                            future: widget.api.feedbackAttachment(
                              widget.ticketId,
                              item['id'].toString(),
                            ),
                            builder: (_, snapshot) => ClipRRect(
                              borderRadius: BorderRadius.circular(8),
                              child: snapshot.hasData
                                  ? Image.memory(
                                      snapshot.data!,
                                      width: 112,
                                      height: 112,
                                      fit: BoxFit.cover,
                                    )
                                  : const SizedBox(
                                      width: 112,
                                      child: Center(
                                        child: CircularProgressIndicator(),
                                      ),
                                    ),
                            ),
                          );
                        },
                      ),
                    ),
                  ],
                  if (value['plan'] is Map) ...[
                    const SizedBox(height: 12),
                    Card(
                      elevation: 0,
                      child: Padding(
                        padding: const EdgeInsets.all(15),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text(
                              'Agent 处理方案',
                              style: TextStyle(fontWeight: FontWeight.w800),
                            ),
                            const SizedBox(height: 8),
                            Text(
                              (value['plan'] as Map)['diagnosis']?.toString() ??
                                  '',
                            ),
                            for (final item
                                in ((value['plan'] as Map)['proposedPlan']
                                        as List? ??
                                    const []))
                              Padding(
                                padding: const EdgeInsets.only(top: 5),
                                child: Text('• $item'),
                              ),
                          ],
                        ),
                      ),
                    ),
                  ],
                  if (value['resolution'] is Map) ...[
                    const SizedBox(height: 12),
                    Card(
                      elevation: 0,
                      child: Padding(
                        padding: const EdgeInsets.all(15),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text(
                              '处理结果',
                              style: TextStyle(fontWeight: FontWeight.w800),
                            ),
                            const SizedBox(height: 8),
                            Text(
                              (value['resolution'] as Map)['summary']
                                      ?.toString() ??
                                  '',
                            ),
                          ],
                        ),
                      ),
                    ),
                  ],
                  if ((value['standardProposals'] as List?)?.isNotEmpty ==
                      true) ...[
                    const SizedBox(height: 12),
                    const Text(
                      'Agent 验收标准升级提案',
                      style: TextStyle(fontWeight: FontWeight.w800),
                    ),
                    const SizedBox(height: 8),
                    for (final proposal
                        in (value['standardProposals'] as List)
                            .whereType<Map>())
                      _proposalCard(proposal, value['canConfirm'] == true),
                  ],
                  if ((value['events'] as List?)?.isNotEmpty == true) ...[
                    const SizedBox(height: 12),
                    const Text(
                      '处理记录',
                      style: TextStyle(fontWeight: FontWeight.w800),
                    ),
                    for (final event
                        in (value['events'] as List).whereType<Map>())
                      ListTile(
                        dense: true,
                        contentPadding: EdgeInsets.zero,
                        leading: const Icon(Icons.circle, size: 9),
                        title: Text(event['message']?.toString() ?? ''),
                        subtitle: Text(
                          feedbackStatusLabel(event['toStatus']?.toString()),
                        ),
                      ),
                  ],
                  if (error != null)
                    Text(
                      error!,
                      style: const TextStyle(color: Color(0xffb42318)),
                    ),
                  const SizedBox(height: 16),
                  if (!busy &&
                      value['status'] == 'awaiting_confirmation' &&
                      value['canConfirm'] == true)
                    FilledButton.icon(
                      onPressed: () => act(widget.api.confirmFeedbackTicket),
                      icon: const Icon(Icons.check_rounded),
                      label: Text(
                        value['confirmationQuestion']?.toString() ?? '主账号确认方案',
                      ),
                    ),
                  if (value['status'] == 'awaiting_confirmation' &&
                      value['canConfirm'] != true)
                    const Text(
                      '此方案正在等待主账号确认。',
                      style: TextStyle(color: Color(0xff92400e)),
                    ),
                  if (!busy && ['deferred', 'failed'].contains(value['status']))
                    OutlinedButton.icon(
                      onPressed: () => act(widget.api.retryFeedbackTicket),
                      icon: const Icon(Icons.refresh_rounded),
                      label: const Text('继续处理'),
                    ),
                  if (!busy && value['status'] == 'resolved') ...[
                    FilledButton.icon(
                      onPressed: () => act(widget.api.satisfyFeedbackTicket),
                      icon: const Icon(Icons.thumb_up_alt_outlined),
                      label: const Text('确认已经解决'),
                    ),
                    const SizedBox(height: 8),
                    OutlinedButton.icon(
                      onPressed: reportUnresolved,
                      icon: const Icon(Icons.report_problem_outlined),
                      label: const Text('仍有问题，让 Agent 继续处理并学习'),
                    ),
                  ],
                  if (!busy && value['status'] != 'closed')
                    TextButton(
                      onPressed: () => act(widget.api.closeFeedbackTicket),
                      child: const Text('确认不再处理并关闭工单'),
                    ),
                  if (busy) const Center(child: CircularProgressIndicator()),
                ],
              ),
            ),
    );
  }

  Widget _proposalCard(Map proposal, bool canApprove) {
    final replay = proposal['replay'] is Map
        ? proposal['replay'] as Map
        : const {};
    final status = proposal['status']?.toString() ?? 'draft';
    final ready = status == 'ready' && replay['ready'] == true;
    final reasons = (replay['reasons'] as List? ?? const [])
        .map((item) => item.toString())
        .toList();
    return Card(
      elevation: 0,
      color: const Color(0xfff5f7f4),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    '${proposal['capability']} · ${proposal['baseVersion']} → ${proposal['candidateVersion']}',
                    style: const TextStyle(fontWeight: FontWeight.w800),
                  ),
                ),
                Text(
                  _proposalStatus(status),
                  style: TextStyle(
                    fontSize: 12,
                    color: ready
                        ? const Color(0xff267046)
                        : const Color(0xff9a4f06),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 7),
            Text(proposal['rationale']?.toString() ?? ''),
            const SizedBox(height: 8),
            Text(
              '负例拦截 ${replay['negativeBlocked'] ?? 0}/${replay['negativeTotal'] ?? 0} · 正例保留 ${replay['positivePassed'] ?? 0}/${replay['positiveTotal'] ?? 0} · 边界用例 ${replay['fixturePassed'] ?? 0}/${replay['fixtureTotal'] ?? 0}',
              style: const TextStyle(fontSize: 12),
            ),
            if (reasons.isNotEmpty) ...[
              const SizedBox(height: 6),
              for (final reason in reasons)
                Text(
                  '• $reason',
                  style: const TextStyle(
                    fontSize: 12,
                    color: Color(0xff92400e),
                  ),
                ),
            ],
            if (canApprove && ['draft', 'ready'].contains(status)) ...[
              const SizedBox(height: 10),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      onPressed: busy
                          ? null
                          : () => proposalAction(
                              proposal['id'].toString(),
                              false,
                            ),
                      child: const Text('拒绝'),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: FilledButton(
                      onPressed: busy || !ready
                          ? null
                          : () =>
                                proposalAction(proposal['id'].toString(), true),
                      child: const Text('批准并仅用于新任务'),
                    ),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }

  String _proposalStatus(String status) => switch (status) {
    'draft' => '证据不足',
    'replaying' => '影子回放中',
    'ready' => '待主账号批准',
    'approved' => '已批准',
    'active' => '观察中',
    'rejected' => '已拒绝',
    'rolled_back' => '已自动回滚',
    _ => status,
  };
}
