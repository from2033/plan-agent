import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import 'api_client.dart';

class FinancePage extends StatefulWidget {
  const FinancePage({super.key, required this.api});
  final ApiClient api;
  @override
  State<FinancePage> createState() => _FinancePageState();
}

class _FinancePageState extends State<FinancePage> {
  int months = 3;
  Map<String, dynamic>? data;
  bool loading = true;
  bool uploading = false;
  String? error;

  @override
  void initState() { super.initState(); load(); }
  Future<void> load() async {
    setState(() { loading = true; error = null; });
    try { data = await widget.api.financeOverview(months: months); }
    catch (e) { error = e.toString(); }
    if (mounted) setState(() => loading = false);
  }

  Future<void> pickFile() async {
    final result = await FilePicker.platform.pickFiles(withData: true, type: FileType.custom, allowedExtensions: ['zip', 'csv']);
    if (result == null || result.files.single.bytes == null) return;
    final file = result.files.single;
    setState(() { uploading = true; error = null; });
    try {
      await widget.api.importFinanceFile(fileName: file.name, bytes: file.bytes!);
      await load();
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('支付宝账单已导入')));
    } catch (e) { if (mounted) setState(() => error = e.toString()); }
    if (mounted) setState(() => uploading = false);
  }

  String money(dynamic value) => '¥${((value as num?) ?? 0).toStringAsFixed(2)}';
  @override
  Widget build(BuildContext context) {
    final summary = (data?['summary'] as Map?)?.cast<String, dynamic>() ?? {};
    final categories = (data?['categories'] as List?)?.cast<Map>() ?? const [];
    return RefreshIndicator(onRefresh: load, child: ListView(padding: const EdgeInsets.fromLTRB(16, 4, 16, 20), children: [
      Row(children: [const Expanded(child: Text('支付宝消费分析', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700))), ElevatedButton.icon(onPressed: uploading ? null : pickFile, icon: uploading ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.upload_file, size: 16), label: Text(uploading ? '导入中' : '导入账单'))]),
      const SizedBox(height: 4), const Text('账单按账号独立归档，重复上传不会重复累计', style: TextStyle(fontSize: 11, color: Color(0xff8a8680))),
      const SizedBox(height: 12), SegmentedButton<int>(segments: const [ButtonSegment(value: 3, label: Text('近3个月')), ButtonSegment(value: 6, label: Text('近6个月')), ButtonSegment(value: 12, label: Text('近12个月'))], selected: {months}, onSelectionChanged: (v) { setState(() => months = v.first); load(); }),
      if (error != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(error!, style: const TextStyle(color: Colors.red))),
      if (loading) const Padding(padding: EdgeInsets.all(40), child: Center(child: CircularProgressIndicator())) else ...[
        const SizedBox(height: 12), Wrap(spacing: 8, runSpacing: 8, children: _metricCards(context, summary)),
        const SizedBox(height: 12), Card(child: Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [const Text('消费领域占比', style: TextStyle(fontWeight: FontWeight.w700)), const SizedBox(height: 8), for (final item in categories.take(8)) _CategoryRow(name: '${item['category']}', amount: money(item['amount']), share: ((item['share'] as num?) ?? 0).toDouble())]))),
        if ((data?['insights'] as List?)?.isNotEmpty == true) Card(child: Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [const Text('从账单里看到的规律', style: TextStyle(fontWeight: FontWeight.w700)), for (final insight in (data!['insights'] as List).take(5)) Padding(padding: const EdgeInsets.only(top: 8), child: Text('• $insight', style: const TextStyle(fontSize: 12)))]))),
      ],
    ]));
  }

  List<Widget> _metricCards(BuildContext context, Map<String, dynamic> summary) {
    const metrics = [_Metric('净支出', 'netExpense', Color(0xffd97706)), _Metric('已退款', 'refunds', Color(0xff16a34a)), _Metric('平均每笔', 'averagePayment', Color(0xff4f6ef7)), _Metric('消费笔数', 'paymentCount', Color(0xff7c3aed))];
    return metrics.map((m) => SizedBox(width: (MediaQuery.sizeOf(context).width - 48) / 2, child: Card(child: ListTile(title: Text(m.label, style: const TextStyle(fontSize: 12)), subtitle: Text(m.key == 'paymentCount' ? '${summary[m.key] ?? 0} 笔' : money(summary[m.key]), style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700, color: m.color)))))).toList();
  }
}

class _Metric { const _Metric(this.label, this.key, this.color); final String label, key; final Color color; }
class _CategoryRow extends StatelessWidget { const _CategoryRow({required this.name, required this.amount, required this.share}); final String name, amount; final double share; @override Widget build(BuildContext c) => Padding(padding: const EdgeInsets.only(top: 8), child: Column(children: [Row(children: [Expanded(child: Text(name, style: const TextStyle(fontSize: 12))), Text(amount, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600))]), const SizedBox(height: 4), LinearProgressIndicator(value: share, minHeight: 5, borderRadius: BorderRadius.circular(4), color: const Color(0xffd97706), backgroundColor: const Color(0xfff1ede5))])); }
