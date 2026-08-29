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
    if (data == null) {
      refresh();
    }
  }

  Future<void> refresh({bool force = false}) async {
    if (loading) return;
    setState(() {
      loading = true;
      error = null;
    });
    try {
      final value = await widget.api.worldPulse(force: force);
      if (mounted) {
        setState(() => data = value);
      }
    } catch (exception) {
      if (mounted) setState(() => error = exception.toString());
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

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
    final dailyBriefing = data?['dailyBriefing'] as Map<String, dynamic>?;
    return Scaffold(
      appBar: AppBar(
        title: const Text('趋势观察'),
        actions: [
          IconButton(
            onPressed: loading ? null : () => refresh(force: true),
            tooltip: '刷新趋势',
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
        onRefresh: () => refresh(force: true),
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
                    '看懂趋势，不刷新闻',
                    style: TextStyle(
                      color: Colors.white,
                      fontSize: 20,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    data?['overview'] as String? ??
                        '每天从政策、楼市、黄金、AI、职场和国际变化中筛选真正重要的事情，并用普通话解释与你的关系。',
                    style: const TextStyle(
                      color: Color(0xffd1d5db),
                      height: 1.45,
                    ),
                  ),
                  const SizedBox(height: 10),
                  if (data?['discoveryStatus'] == 'QUEUED' ||
                      data?['discoveryStatus'] == 'PROCESSING') ...[
                    const Row(
                      children: [
                        SizedBox(
                          width: 13,
                          height: 13,
                          child: CircularProgressIndicator(
                            strokeWidth: 1.8,
                            color: Color(0xffd1d5db),
                          ),
                        ),
                        SizedBox(width: 7),
                        Text(
                          '正在生成今日重点，本次由本地模型处理…',
                          style: TextStyle(
                            color: Color(0xffd1d5db),
                            fontSize: 11,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                  ],
                  Text(
                    '新闻源更新于 ${timeLabel(data?['updatedAt'] as String?)} · 每天 06:30 自动生成重点${data?['stale'] == true ? ' · 部分来源暂未更新' : ''}',
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
            if (dailyBriefing != null) ...[
              const SizedBox(height: 16),
              _dailyBriefingCard(dailyBriefing),
            ] else if (loading)
              const Padding(
                padding: EdgeInsets.only(top: 100),
                child: Center(child: CircularProgressIndicator()),
              )
            else
              const Padding(
                padding: EdgeInsets.only(top: 60),
                child: Center(child: Text('今日简报尚未生成，请稍后再看')),
              ),
            const SizedBox(height: 16),
            const Text(
              '简报根据公开来源自动筛选和解读。涉及投资、政策或安全的重要决定，请打开原文并交叉核实。',
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

  Widget _dailyBriefingCard(Map<String, dynamic> briefing) {
    final events = (briefing['events'] as List<dynamic>? ?? const [])
        .whereType<Map<String, dynamic>>()
        .toList();
    final radar = (briefing['radar'] as List<dynamic>? ?? const [])
        .whereType<Map<String, dynamic>>()
        .toList();
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: const Color(0xfffffbeb),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: const Color(0xfff4d58d)),
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
                    const Icon(
                      Icons.auto_awesome_rounded,
                      color: Color(0xffa16207),
                    ),
                    const SizedBox(width: 8),
                    const Expanded(
                      child: Text(
                        '重大变化',
                        style: TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                    ),
                    Text(
                      briefing['dayKey'] as String? ?? '',
                      style: const TextStyle(
                        color: Color(0xff8a6a28),
                        fontSize: 11,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                Text(
                  briefing['overview'] as String? ?? '',
                  style: const TextStyle(height: 1.5, color: Color(0xff55431d)),
                ),
                if (briefing['coverage']
                    case final Map<String, dynamic> coverage) ...[
                  const SizedBox(height: 9),
                  Text(
                    '已检查 ${coverage['sections'] ?? 0} 个领域 · ${coverage['candidates'] ?? 0} 条线索 · ${coverage['sources'] ?? 0} 个来源',
                    style: const TextStyle(
                      color: Color(0xff9a7629),
                      fontSize: 11,
                    ),
                  ),
                  if ((coverage['configuredSources'] as num? ?? 0) > 0) ...[
                    const SizedBox(height: 4),
                    Text(
                      '三层采集：${coverage['authorityCandidates'] ?? 0} 条官网 · ${coverage['newsCandidates'] ?? 0} 条新闻 · ${coverage['hotspotCandidates'] ?? 0} 条热点${(coverage['failedSources'] as num? ?? 0) > 0 ? ' · ${coverage['failedSources']} 个渠道暂时失败' : ''}',
                      style: const TextStyle(
                        color: Color(0xff927243),
                        fontSize: 11,
                        height: 1.35,
                      ),
                    ),
                  ],
                ],
              ],
            ),
          ),
          if (events.isNotEmpty)
            const Divider(height: 1, color: Color(0xfff0dca7)),
          for (var index = 0; index < events.length; index++) ...[
            InkWell(
              onTap: () {
                final sources = _eventSources(events[index]);
                if (sources.isNotEmpty) {
                  openArticle(sources.first['url'] as String?);
                }
              },
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 14,
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      events[index]['title'] as String? ?? '今日变化',
                      style: const TextStyle(
                        fontWeight: FontWeight.w700,
                        height: 1.35,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      '发生内容：${events[index]['summary'] ?? ''}',
                      style: const TextStyle(
                        fontSize: 12,
                        height: 1.45,
                        color: Color(0xff5f5a53),
                      ),
                    ),
                    const SizedBox(height: 7),
                    Text(
                      '为什么重要：${events[index]['whyItMatters'] ?? ''}',
                      style: const TextStyle(
                        fontSize: 12,
                        height: 1.4,
                        color: Color(0xff7a5b17),
                      ),
                    ),
                    if ((events[index]['watchNext'] as String? ?? '')
                        .isNotEmpty) ...[
                      const SizedBox(height: 5),
                      Text(
                        '接下来关注：${events[index]['watchNext']}',
                        style: const TextStyle(
                          fontSize: 12,
                          height: 1.4,
                          color: Color(0xff7a5b17),
                        ),
                      ),
                    ],
                    const SizedBox(height: 5),
                    Text(
                      _sourceVerificationLabel(events[index]),
                      style: const TextStyle(
                        fontSize: 11,
                        color: Color(0xff9a7629),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            if (index != events.length - 1)
              const Divider(
                height: 1,
                indent: 16,
                endIndent: 16,
                color: Color(0xfff0dca7),
              ),
          ],
          if (radar.isNotEmpty) ...[
            const Divider(height: 1, color: Color(0xfff0dca7)),
            Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    '领域雷达',
                    style: TextStyle(fontSize: 15, fontWeight: FontWeight.w800),
                  ),
                  const SizedBox(height: 9),
                  for (final item in radar) ...[
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Container(
                          width: 7,
                          height: 7,
                          margin: const EdgeInsets.only(top: 6),
                          decoration: BoxDecoration(
                            color: item['hasReliableSignal'] == true
                                ? const Color(0xffb7791f)
                                : const Color(0xffb8a77c),
                            shape: BoxShape.circle,
                          ),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            '${_radarLabel(item['id'] as String?)}：${item['summary'] ?? ''}',
                            style: const TextStyle(
                              fontSize: 12,
                              height: 1.45,
                              color: Color(0xff5f5a53),
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 7),
                  ],
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }

  String _radarLabel(String? value) => switch (value) {
    'gold' => '黄金',
    'housing' => '楼市',
    'ai' => 'AI',
    'programmer' => '程序员',
    'policy' => '政策',
    'international' => '国际',
    _ => '其他',
  };

  String _verificationLabel(String? value) => switch (value) {
    'official' => ' · 一手来源核验',
    'multi_source' => ' · 多来源核验',
    'single_source' => ' · 单一来源',
    'unverified' => ' · 尚待核实',
    _ => '',
  };

  List<Map<String, dynamic>> _eventSources(Map<String, dynamic> event) =>
      (event['sources'] as List<dynamic>? ?? const [])
          .whereType<Map<String, dynamic>>()
          .toList();

  String _sourceVerificationLabel(Map<String, dynamic> event) {
    final sources = _eventSources(event);
    final publishers = sources
        .map((source) => source['publisher'] as String? ?? '')
        .where((publisher) => publisher.isNotEmpty)
        .toSet()
        .take(3)
        .join('、');
    final verification = _verificationLabel(
      event['verification'] as String?,
    ).replaceFirst(' · ', '');
    final sourceSummary = sources.isEmpty
        ? '暂无可打开来源'
        : '${sources.length} 个来源${publishers.isEmpty ? '' : '（$publishers）'} · 点击查看';
    return '来源核验：${verification.isEmpty ? '尚待核实' : verification} · $sourceSummary';
  }
}
