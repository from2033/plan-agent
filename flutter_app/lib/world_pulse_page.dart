import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:url_launcher/url_launcher.dart';

import 'api_client.dart';

class WorldPulsePage extends StatefulWidget {
  const WorldPulsePage({super.key, required this.api, this.initialData});

  final ApiClient api;
  final Map<String, dynamic>? initialData;

  @override
  State<WorldPulsePage> createState() => _WorldPulsePageState();
}

class _WorldPulsePageState extends State<WorldPulsePage> {
  Map<String, dynamic>? data;
  bool loading = false;
  String? error;

  @override
  void initState() {
    super.initState();
    data = widget.initialData;
    if (data == null) refresh();
  }

  Future<void> refresh() async {
    if (loading) return;
    setState(() {
      loading = true;
      error = null;
    });
    try {
      final value = await widget.api.worldPulse(force: true);
      if (mounted) setState(() => data = value);
    } catch (exception) {
      if (mounted) setState(() => error = exception.toString());
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  IconData iconFor(String id) => switch (id) {
    'ai' => Icons.memory_rounded,
    'macro' => Icons.account_balance_rounded,
    'markets' => Icons.show_chart_rounded,
    _ => Icons.public_rounded,
  };

  Color colorFor(String id) => switch (id) {
    'ai' => const Color(0xff6d28d9),
    'macro' => const Color(0xff1d4ed8),
    'markets' => const Color(0xffb7791f),
    _ => const Color(0xff047857),
  };

  String timeLabel(String? value) {
    final time = DateTime.tryParse(value ?? '')?.toLocal();
    if (time == null) return '';
    final now = DateTime.now();
    if (DateUtils.isSameDay(time, now)) {
      return DateFormat('HH:mm').format(time);
    }
    return DateFormat('M月d日 HH:mm', 'zh_CN').format(time);
  }

  Future<void> openArticle(String? value) async {
    final uri = Uri.tryParse(value ?? '');
    if (uri == null ||
        !await launchUrl(uri, mode: LaunchMode.externalApplication)) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('暂时无法打开新闻来源')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final sections = (data?['sections'] as List<dynamic>? ?? const [])
        .whereType<Map<String, dynamic>>()
        .toList();
    return Scaffold(
      appBar: AppBar(
        title: const Text('全球脉搏'),
        actions: [
          IconButton(
            onPressed: loading ? null : refresh,
            tooltip: '刷新新闻',
            icon: loading
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: refresh,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 30),
          children: [
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                gradient: const LinearGradient(
                  colors: [Color(0xff1f2937), Color(0xff111827)],
                ),
                borderRadius: BorderRadius.circular(18),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    '看趋势，不刷信息流',
                    style: TextStyle(
                      color: Colors.white,
                      fontSize: 20,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 6),
                  const Text(
                    '聚合过去 24 小时的重要公开报道。先看发生了什么，再判断它会不会形成持续影响。',
                    style: TextStyle(color: Color(0xffd1d5db), height: 1.45),
                  ),
                  const SizedBox(height: 10),
                  Text(
                    '更新于 ${timeLabel(data?['updatedAt'] as String?)}${data?['stale'] == true ? ' · 部分来源暂未更新' : ''}',
                    style: const TextStyle(
                      color: Color(0xff9ca3af),
                      fontSize: 11,
                    ),
                  ),
                ],
              ),
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
            if (sections.isEmpty && loading)
              const Padding(
                padding: EdgeInsets.only(top: 100),
                child: Center(child: CircularProgressIndicator()),
              )
            else
              for (final section in sections) ...[
                const SizedBox(height: 16),
                _sectionCard(section),
              ],
            const SizedBox(height: 16),
            const Text(
              '新闻标题来自公开聚合源，仅作为趋势线索。涉及投资、政策或安全的重要决定，请打开原文并交叉核实。',
              style: TextStyle(
                color: Color(0xff8a8680),
                fontSize: 11,
                height: 1.4,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _sectionCard(Map<String, dynamic> section) {
    final id = section['id'] as String? ?? 'world';
    final color = colorFor(id);
    final items = (section['items'] as List<dynamic>? ?? const [])
        .whereType<Map<String, dynamic>>()
        .toList();
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: Colors.black.withValues(alpha: .06)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Container(
                      width: 38,
                      height: 38,
                      decoration: BoxDecoration(
                        color: color.withValues(alpha: .1),
                        borderRadius: BorderRadius.circular(11),
                      ),
                      child: Icon(iconFor(id), color: color, size: 21),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        section['title'] as String? ?? '全球动态',
                        style: const TextStyle(
                          fontSize: 17,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                Text(
                  section['summary'] as String? ?? '',
                  style: const TextStyle(height: 1.5),
                ),
                const SizedBox(height: 12),
                _insightLine('为什么重要', section['whyItMatters'] as String? ?? ''),
                const SizedBox(height: 7),
                _insightLine('接下来关注', section['watchNext'] as String? ?? ''),
              ],
            ),
          ),
          if (items.isNotEmpty) const Divider(height: 1),
          for (var index = 0; index < items.length; index++) ...[
            InkWell(
              onTap: () => openArticle(items[index]['url'] as String?),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 13,
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            items[index]['title'] as String? ?? '新闻',
                            style: const TextStyle(
                              fontWeight: FontWeight.w600,
                              height: 1.35,
                            ),
                          ),
                          const SizedBox(height: 5),
                          Text(
                            '${items[index]['source'] ?? '来源'} · ${timeLabel(items[index]['publishedAt'] as String?)}',
                            style: const TextStyle(
                              color: Color(0xff8a8680),
                              fontSize: 11,
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 8),
                    const Icon(
                      Icons.open_in_new_rounded,
                      size: 17,
                      color: Color(0xff9a948b),
                    ),
                  ],
                ),
              ),
            ),
            if (index != items.length - 1)
              const Divider(height: 1, indent: 16, endIndent: 16),
          ],
        ],
      ),
    );
  }

  Widget _insightLine(String label, String value) => Row(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      SizedBox(
        width: 72,
        child: Text(
          label,
          style: const TextStyle(color: Color(0xff8a8680), fontSize: 12),
        ),
      ),
      Expanded(
        child: Text(value, style: const TextStyle(fontSize: 12, height: 1.4)),
      ),
    ],
  );
}
