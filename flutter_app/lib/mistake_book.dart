import 'package:flutter/material.dart';

import 'api_client.dart';
import 'models.dart';

class MistakeBookPane extends StatefulWidget {
  const MistakeBookPane({super.key, required this.api, required this.isGuest});

  final ApiClient api;
  final bool isGuest;

  @override
  State<MistakeBookPane> createState() => _MistakeBookPaneState();
}

class _MistakeBookPaneState extends State<MistakeBookPane> {
  List<MistakeItem> items = [];
  bool loading = true;
  String? error;

  @override
  void initState() {
    super.initState();
    load();
  }

  Future<void> load() async {
    if (widget.isGuest) {
      setState(() => loading = false);
      return;
    }
    try {
      final value = await widget.api.mistakes();
      if (mounted) setState(() => items = value);
    } catch (exception) {
      if (mounted) setState(() => error = exception.toString());
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  Future<void> add() async {
    final draft = await showDialog<MistakeDraft>(
      context: context,
      builder: (_) => const _MistakeEditor(),
    );
    if (draft == null || !mounted) return;
    try {
      final created = await widget.api.createMistake(draft);
      setState(() => items = [created, ...items]);
    } catch (exception) {
      if (mounted) setState(() => error = exception.toString());
    }
  }

  Future<void> review(MistakeItem item, MistakeReviewResult result) async {
    try {
      final updated = await widget.api.reviewMistake(item.id, result);
      if (mounted) {
        setState(() {
          items = items
              .map((value) => value.id == item.id ? updated : value)
              .toList();
        });
      }
    } catch (exception) {
      if (mounted) setState(() => error = exception.toString());
    }
  }

  Future<void> remove(MistakeItem item) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('删除这道错题？'),
        content: Text(item.problem),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    final previous = items;
    setState(
      () => items = items.where((value) => value.id != item.id).toList(),
    );
    try {
      await widget.api.deleteMistake(item.id);
    } catch (exception) {
      if (mounted) {
        setState(() {
          items = previous;
          error = exception.toString();
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    if (widget.isGuest) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(28),
          child: Text('登录后可以使用家庭错题本，并按账号安全保存。', textAlign: TextAlign.center),
        ),
      );
    }
    if (loading) return const Center(child: CircularProgressIndicator());
    final pending = items
        .where((item) => item.mastery != MistakeMastery.mastered)
        .length;
    return RefreshIndicator(
      onRefresh: load,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 20),
        children: [
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      '家庭错题本',
                      style: TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    Text(
                      '${items.length} 道错题 · $pending 道待巩固',
                      style: const TextStyle(
                        fontSize: 12,
                        color: Color(0xff8a8680),
                      ),
                    ),
                  ],
                ),
              ),
              FilledButton.icon(
                onPressed: add,
                icon: const Icon(Icons.add_rounded),
                label: const Text('录入'),
              ),
            ],
          ),
          if (error != null)
            Container(
              margin: const EdgeInsets.only(top: 12),
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: const Color(0xffffe4e4),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Text(
                error!,
                style: const TextStyle(color: Color(0xffb42318)),
              ),
            ),
          if (items.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 70),
              child: Center(
                child: Text(
                  '还没有错题，点击右上角开始录入',
                  style: TextStyle(color: Color(0xff8a8680)),
                ),
              ),
            )
          else
            for (final item in items)
              _MistakeCard(
                item: item,
                onReview: (result) => review(item, result),
                onDelete: () => remove(item),
              ),
        ],
      ),
    );
  }
}

class _MistakeCard extends StatelessWidget {
  const _MistakeCard({
    required this.item,
    required this.onReview,
    required this.onDelete,
  });

  final MistakeItem item;
  final ValueChanged<MistakeReviewResult> onReview;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    final mastery = switch (item.mastery) {
      MistakeMastery.learning => '还不会',
      MistakeMastery.review => '有点难',
      MistakeMastery.mastered => '已掌握',
    };
    return Card(
      elevation: 0,
      color: Colors.white,
      margin: const EdgeInsets.only(top: 10),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    '${item.childName} · ${item.subject}${item.grade.isEmpty ? '' : ' · ${item.grade}'}',
                    style: const TextStyle(
                      fontSize: 12,
                      color: Color(0xff9a3412),
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                Chip(
                  label: Text(mastery),
                  visualDensity: VisualDensity.compact,
                ),
                IconButton(
                  onPressed: onDelete,
                  icon: const Icon(Icons.delete_outline_rounded, size: 19),
                ),
              ],
            ),
            if (item.knowledgePoint.isNotEmpty)
              Text(
                item.knowledgePoint,
                style: const TextStyle(fontSize: 11, color: Color(0xff8a8680)),
              ),
            const SizedBox(height: 7),
            Text(
              item.problem,
              style: const TextStyle(
                fontSize: 15,
                fontWeight: FontWeight.w700,
                height: 1.4,
              ),
            ),
            if (item.wrongAnswer.isNotEmpty)
              _line('错误答案', item.wrongAnswer, const Color(0xffb42318)),
            if (item.correctAnswer.isNotEmpty)
              _line('正确答案', item.correctAnswer, const Color(0xff15803d)),
            if (item.explanation.isNotEmpty)
              _line('解题说明', item.explanation, const Color(0xff5f5a53)),
            const SizedBox(height: 10),
            Row(
              children: [
                TextButton(
                  onPressed: () => onReview(MistakeReviewResult.again),
                  child: const Text('还不会'),
                ),
                TextButton(
                  onPressed: () => onReview(MistakeReviewResult.hard),
                  child: const Text('有点难'),
                ),
                TextButton(
                  onPressed: () => onReview(MistakeReviewResult.good),
                  child: const Text('已掌握'),
                ),
                const Spacer(),
                Text(
                  '复习 ${item.reviewCount} 次',
                  style: const TextStyle(
                    fontSize: 10,
                    color: Color(0xff8a8680),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _line(String label, String value, Color color) => Padding(
    padding: const EdgeInsets.only(top: 7),
    child: Text(
      '$label：$value',
      style: TextStyle(fontSize: 12, color: color, height: 1.4),
    ),
  );
}

class _MistakeEditor extends StatefulWidget {
  const _MistakeEditor();

  @override
  State<_MistakeEditor> createState() => _MistakeEditorState();
}

class _MistakeEditorState extends State<_MistakeEditor> {
  final child = TextEditingController();
  final subject = TextEditingController();
  final grade = TextEditingController();
  final point = TextEditingController();
  final problem = TextEditingController();
  final wrong = TextEditingController();
  final correct = TextEditingController();
  final explanation = TextEditingController();
  String errorType = '概念不清';

  @override
  void dispose() {
    for (final controller in [
      child,
      subject,
      grade,
      point,
      problem,
      wrong,
      correct,
      explanation,
    ]) {
      controller.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('录入错题'),
      content: SizedBox(
        width: 440,
        child: SingleChildScrollView(
          child: Column(
            children: [
              Row(
                children: [
                  Expanded(child: _field(child, '孩子 *')),
                  const SizedBox(width: 8),
                  Expanded(child: _field(subject, '学科 *')),
                ],
              ),
              Row(
                children: [
                  Expanded(child: _field(grade, '年级')),
                  const SizedBox(width: 8),
                  Expanded(child: _field(point, '知识点')),
                ],
              ),
              _field(problem, '题目 *', lines: 3),
              _field(wrong, '错误答案', lines: 2),
              _field(correct, '正确答案', lines: 2),
              _field(explanation, '解题说明', lines: 2),
              DropdownButtonFormField<String>(
                initialValue: errorType,
                decoration: const InputDecoration(labelText: '错误原因'),
                items: const ['概念不清', '审题错误', '计算失误', '方法不会', '粗心', '其他']
                    .map(
                      (value) =>
                          DropdownMenuItem(value: value, child: Text(value)),
                    )
                    .toList(),
                onChanged: (value) => errorType = value ?? errorType,
              ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('取消'),
        ),
        FilledButton(
          onPressed: () {
            if (child.text.trim().isEmpty ||
                subject.text.trim().isEmpty ||
                problem.text.trim().isEmpty) {
              return;
            }
            Navigator.pop(
              context,
              MistakeDraft(
                childName: child.text.trim(),
                subject: subject.text.trim(),
                grade: grade.text.trim(),
                knowledgePoint: point.text.trim(),
                problem: problem.text.trim(),
                wrongAnswer: wrong.text.trim(),
                correctAnswer: correct.text.trim(),
                explanation: explanation.text.trim(),
                errorType: errorType,
              ),
            );
          },
          child: const Text('保存'),
        ),
      ],
    );
  }

  Widget _field(
    TextEditingController controller,
    String label, {
    int lines = 1,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: TextField(
      controller: controller,
      maxLines: lines,
      decoration: InputDecoration(
        labelText: label,
        border: const OutlineInputBorder(),
      ),
    ),
  );
}
