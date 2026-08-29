import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:printing/printing.dart';

import 'api_client.dart';

class QqGroupCenterPage extends StatefulWidget {
  const QqGroupCenterPage({super.key, required this.api});

  final ApiClient api;

  @override
  State<QqGroupCenterPage> createState() => _QqGroupCenterPageState();
}

class _QqGroupCenterPageState extends State<QqGroupCenterPage> {
  DateTime day = DateTime.now();
  bool loading = true;
  bool printing = false;
  String? error;
  int tab = 0;
  String? groupId;
  List<Map<String, dynamic>> messages = const [];
  List<Map<String, dynamic>> downloads = const [];
  final selected = <int>{};

  String get dayKey => DateFormat('yyyy-MM-dd').format(day);

  @override
  void initState() {
    super.initState();
    load();
  }

  Future<void> load() async {
    setState(() {
      loading = true;
      error = null;
    });
    try {
      final values = await Future.wait([
        widget.api.studyMessages(dayKey),
        widget.api.studyDownloads(dayKey),
      ]);
      if (!mounted) return;
      setState(() {
        messages = values[0];
        downloads = values[1];
        selected.clear();
        if (!_groups.any((entry) => entry.key == groupId)) groupId = null;
      });
    } catch (value) {
      if (!mounted) return;
      setState(() {
        error = value is ApiException ? value.message : '加载失败，请稍后重试';
      });
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  List<MapEntry<String, String>> get _groups {
    final values = <String, String>{};
    for (final item in [...messages, ...downloads]) {
      final id = item['group_id']?.toString();
      if (id != null && id.isNotEmpty) {
        values[id] = item['group_name']?.toString() ?? 'QQ群 $id';
      }
    }
    return values.entries.toList();
  }

  List<Map<String, dynamic>> get visibleMessages => groupId == null
      ? messages
      : messages
            .where((item) => item['group_id']?.toString() == groupId)
            .toList();

  List<Map<String, dynamic>> get visibleDownloads => groupId == null
      ? downloads
      : downloads
            .where((item) => item['group_id']?.toString() == groupId)
            .toList();

  Future<void> pickDay() async {
    final value = await showDatePicker(
      context: context,
      initialDate: day,
      firstDate: DateTime.now().subtract(const Duration(days: 90)),
      lastDate: DateTime.now(),
      locale: const Locale('zh', 'CN'),
    );
    if (value == null || DateUtils.isSameDay(value, day)) return;
    setState(() => day = value);
    await load();
  }

  Future<void> printSelected() async {
    if (selected.isEmpty) return;
    setState(() => printing = true);
    try {
      final Uint8List pdf = await widget.api.studyPrintBundle(
        selected.toList(),
      );
      await Printing.layoutPdf(
        name: 'QQ群资料-$dayKey.pdf',
        onLayout: (_) async => pdf,
      );
    } catch (value) {
      if (!mounted) return;
      final message = value is ApiException ? value.message : '生成打印文件失败';
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(message)));
    } finally {
      if (mounted) setState(() => printing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xfff7f4ef),
      appBar: AppBar(
        title: const Text('QQ群消息'),
        backgroundColor: const Color(0xfff7f4ef),
        actions: [
          IconButton(
            onPressed: loading ? null : load,
            tooltip: '刷新',
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: Column(
        children: [
          _toolbar(),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 10),
            child: SegmentedButton<int>(
              segments: const [
                ButtonSegment(
                  value: 0,
                  icon: Icon(Icons.forum_outlined),
                  label: Text('群消息'),
                ),
                ButtonSegment(
                  value: 1,
                  icon: Icon(Icons.print_outlined),
                  label: Text('今日打印'),
                ),
              ],
              selected: {tab},
              onSelectionChanged: (value) {
                setState(() => tab = value.first);
              },
            ),
          ),
          Expanded(child: _body()),
        ],
      ),
      bottomNavigationBar: tab == 1 && visibleDownloads.isNotEmpty
          ? SafeArea(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
                child: FilledButton.icon(
                  onPressed: selected.isEmpty || printing
                      ? null
                      : printSelected,
                  icon: printing
                      ? const SizedBox.square(
                          dimension: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.print_rounded),
                  label: Text(
                    selected.isEmpty
                        ? '选择需要打印的资料'
                        : '合并打印 ${selected.length} 份资料',
                  ),
                ),
              ),
            )
          : null,
    );
  }

  Widget _toolbar() => SingleChildScrollView(
    scrollDirection: Axis.horizontal,
    padding: const EdgeInsets.fromLTRB(16, 4, 16, 10),
    child: Row(
      children: [
        ActionChip(
          avatar: const Icon(Icons.calendar_today_outlined, size: 17),
          label: Text(DateUtils.isSameDay(day, DateTime.now()) ? '今天' : dayKey),
          onPressed: pickDay,
        ),
        const SizedBox(width: 8),
        ChoiceChip(
          label: const Text('全部群'),
          selected: groupId == null,
          onSelected: (_) => setState(() => groupId = null),
        ),
        for (final group in _groups) ...[
          const SizedBox(width: 8),
          ChoiceChip(
            label: Text(group.value),
            selected: groupId == group.key,
            onSelected: (_) => setState(() => groupId = group.key),
          ),
        ],
      ],
    ),
  );

  Widget _body() {
    if (loading) return const Center(child: CircularProgressIndicator());
    if (error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(error!, textAlign: TextAlign.center),
        ),
      );
    }
    return tab == 0 ? _messageList() : _downloadList();
  }

  Widget _messageList() {
    if (visibleMessages.isEmpty) {
      return const Center(child: Text('这一天还没有群消息'));
    }
    return ListView.builder(
      padding: const EdgeInsets.fromLTRB(16, 2, 16, 24),
      itemCount: visibleMessages.length,
      itemBuilder: (context, index) {
        final item = visibleMessages[index];
        final images = item['images'] as List<dynamic>? ?? const [];
        return Card(
          elevation: 0,
          margin: const EdgeInsets.only(bottom: 10),
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        item['teacher']?.toString() ?? '群成员',
                        style: const TextStyle(fontWeight: FontWeight.w800),
                      ),
                    ),
                    Text(
                      item['time']?.toString() ?? '',
                      style: const TextStyle(
                        color: Color(0xff8a8680),
                        fontSize: 12,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 3),
                Text(
                  item['group_name']?.toString() ?? '',
                  style: const TextStyle(
                    color: Color(0xffb45f06),
                    fontSize: 12,
                  ),
                ),
                const SizedBox(height: 9),
                Text(
                  item['content']?.toString() ?? '',
                  style: const TextStyle(height: 1.55),
                ),
                for (final path in images) ...[
                  const SizedBox(height: 10),
                  ClipRRect(
                    borderRadius: BorderRadius.circular(10),
                    child: Image.network(
                      'https://sutyd.5656ai.com$path',
                      fit: BoxFit.cover,
                    ),
                  ),
                ],
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _downloadList() {
    if (visibleDownloads.isEmpty) {
      return const Center(child: Text('这一天还没有可打印的群资料'));
    }
    return ListView.builder(
      padding: const EdgeInsets.fromLTRB(16, 2, 16, 24),
      itemCount: visibleDownloads.length,
      itemBuilder: (context, index) {
        final item = visibleDownloads[index];
        final id = item['id'] as int;
        final bytes = item['size_bytes'] as int? ?? 0;
        return Card(
          elevation: 0,
          margin: const EdgeInsets.only(bottom: 10),
          child: CheckboxListTile(
            value: selected.contains(id),
            onChanged: (value) {
              setState(() {
                value == true ? selected.add(id) : selected.remove(id);
              });
            },
            title: Text(
              item['name']?.toString() ?? '群资料',
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
            subtitle: Text(
              '${item['group_name'] ?? ''}  ·  ${_fileSize(bytes)}',
            ),
            secondary: const Icon(
              Icons.description_outlined,
              color: Color(0xffb45f06),
            ),
          ),
        );
      },
    );
  }

  String _fileSize(int bytes) {
    if (bytes >= 1024 * 1024) {
      return '${(bytes / 1024 / 1024).toStringAsFixed(1)} MB';
    }
    if (bytes >= 1024) return '${(bytes / 1024).toStringAsFixed(0)} KB';
    return '$bytes B';
  }
}
