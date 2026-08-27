enum EntryType { activity, expense, memo, wish }

class AssistantEntry {
  const AssistantEntry({
    required this.id,
    required this.type,
    required this.description,
    required this.category,
    required this.timestamp,
    this.time = '',
    this.amount,
    this.done = false,
    this.priority,
    this.timeStart,
    this.timeEnd,
    this.reminderAt,
  });

  final String id;
  final EntryType type;
  final String description;
  final String category;
  final DateTime timestamp;
  final String time;
  final double? amount;
  final bool done;
  final String? priority;
  final String? timeStart;
  final String? timeEnd;
  final DateTime? reminderAt;

  bool get hasTimeRange => timeStart != null && timeEnd != null;

  factory AssistantEntry.fromJson(Map<String, dynamic> json) {
    final timeRange = json['timeRange'] as Map<String, dynamic>?;
    return AssistantEntry(
      id: json['id'] as String,
      type: EntryType.values.firstWhere(
        (value) => value.name == json['type'],
        orElse: () => EntryType.activity,
      ),
      description: (json['description'] as String?) ?? '',
      category: (json['category'] as String?) ?? '日常',
      timestamp: DateTime.parse(json['timestamp'] as String).toLocal(),
      time: (json['time'] as String?) ?? '',
      amount: (json['amount'] as num?)?.toDouble(),
      done: (json['done'] as bool?) ?? false,
      priority: json['priority'] as String?,
      timeStart: timeRange?['start'] as String?,
      timeEnd: timeRange?['end'] as String?,
      reminderAt: json['reminderAt'] == null
          ? null
          : DateTime.parse(json['reminderAt'] as String).toLocal(),
    );
  }

  Map<String, dynamic> toJson() => {
    'id': id,
    'type': type.name,
    'description': description,
    'category': category,
    'timestamp': timestamp.toUtc().toIso8601String(),
    'time': time,
    if (amount != null) 'amount': amount,
    'done': done,
    if (priority != null) 'priority': priority,
    if (hasTimeRange) 'timeRange': {'start': timeStart, 'end': timeEnd},
    if (reminderAt != null) 'reminderAt': reminderAt!.toUtc().toIso8601String(),
  };

  AssistantEntry copyWith({bool? done}) => AssistantEntry(
    id: id,
    type: type,
    description: description,
    category: category,
    timestamp: timestamp,
    time: time,
    amount: amount,
    done: done ?? this.done,
    priority: priority,
    timeStart: timeStart,
    timeEnd: timeEnd,
    reminderAt: reminderAt,
  );
}

class AssistantReport {
  const AssistantReport({
    required this.highlights,
    required this.improvements,
    required this.suggestions,
  });

  final List<String> highlights;
  final List<String> improvements;
  final List<String> suggestions;

  factory AssistantReport.fromJson(
    Map<String, dynamic> json,
  ) => AssistantReport(
    highlights: List<String>.from(json['highlights'] as List? ?? const []),
    improvements: List<String>.from(json['improvements'] as List? ?? const []),
    suggestions: List<String>.from(json['suggestions'] as List? ?? const []),
  );
}

class ReportLoadResult {
  const ReportLoadResult({
    required this.report,
    this.stale = false,
    this.refreshJobId,
    this.updatedAt,
  });

  final AssistantReport report;
  final bool stale;
  final String? refreshJobId;
  final DateTime? updatedAt;
}

class KnowledgeItem {
  const KnowledgeItem({
    required this.id,
    required this.title,
    required this.content,
  });

  final String id;
  final String title;
  final String content;

  factory KnowledgeItem.fromJson(Map<String, dynamic> json) => KnowledgeItem(
    id: json['id'] as String,
    title: json['title'] as String,
    content: json['content'] as String,
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'title': title,
    'content': content,
  };
}
