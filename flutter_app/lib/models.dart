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
    this.scheduledDate,
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
  final String? scheduledDate;
  final DateTime? reminderAt;

  bool get hasTimeRange => timeStart != null && timeEnd != null;

  bool get isTodoItem =>
      type == EntryType.memo ||
      (type == EntryType.activity &&
          (scheduledDate != null || reminderAt != null));

  String get displayDescription {
    if (scheduledDate == null && reminderAt == null) return description;
    final normalized = description
        .trim()
        .replaceFirst(
          RegExp(
            r'^(?:请\s*)?(?:(?:提醒我|记得|别忘(?:了)?)(?:在)?\s*)?(?:大后天|后天|明天|明日|明早|明晚|明晨|今天|今日|今早|今晚|今晨|(?:本|这|下|下下)(?:周|星期|礼拜)(?:[一二三四五六日天])?)\s*[，,、:：-]?\s*',
          ),
          '',
        )
        .trim();
    return normalized.isEmpty ? description.trim() : normalized;
  }

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
      scheduledDate: json['scheduledDate'] as String?,
      reminderAt: json['reminderAt'] == null
          ? null
          : DateTime.parse(json['reminderAt'] as String).toLocal(),
    );
  }

  Map<String, dynamic> toJson() => {
    'id': id,
    'type': type.name,
    'description': displayDescription,
    'category': category,
    'timestamp': timestamp.toUtc().toIso8601String(),
    'time': time,
    if (amount != null) 'amount': amount,
    'done': done,
    if (priority != null) 'priority': priority,
    if (hasTimeRange) 'timeRange': {'start': timeStart, 'end': timeEnd},
    if (scheduledDate != null) 'scheduledDate': scheduledDate,
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
    scheduledDate: scheduledDate,
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
    this.ownerUserId = '',
    this.sharedWithFamily = false,
    this.canEdit = true,
  });

  final String id;
  final String title;
  final String content;
  final String ownerUserId;
  final bool sharedWithFamily;
  final bool canEdit;

  factory KnowledgeItem.fromJson(Map<String, dynamic> json) => KnowledgeItem(
    id: json['id'] as String,
    title: json['title'] as String,
    content: json['content'] as String,
    ownerUserId: json['ownerUserId'] as String? ?? '',
    sharedWithFamily: json['sharedWithFamily'] as bool? ?? false,
    canEdit: json['canEdit'] as bool? ?? true,
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'title': title,
    'content': content,
    if (ownerUserId.isNotEmpty) 'ownerUserId': ownerUserId,
    'sharedWithFamily': sharedWithFamily,
    'canEdit': canEdit,
  };
}

class AiConversation {
  const AiConversation({
    required this.id,
    required this.type,
    required this.title,
    required this.memberCount,
    required this.updatedAt,
  });

  final String id;
  final String type;
  final String title;
  final int memberCount;
  final DateTime updatedAt;

  factory AiConversation.fromJson(Map<String, dynamic> json) => AiConversation(
    id: json['id'] as String,
    type: json['type'] as String? ?? 'direct_ai',
    title: json['title'] as String? ?? '我与 AI',
    memberCount: (json['memberCount'] as num?)?.toInt() ?? 1,
    updatedAt: DateTime.parse(json['updatedAt'] as String).toLocal(),
  );
}

class AiConversationMessage {
  const AiConversationMessage({
    required this.id,
    required this.conversationId,
    required this.senderType,
    required this.kind,
    required this.content,
    required this.status,
    required this.metadata,
    required this.createdAt,
  });

  final String id;
  final String conversationId;
  final String senderType;
  final String kind;
  final String content;
  final String status;
  final Map<String, dynamic> metadata;
  final DateTime createdAt;

  bool get isMine => senderType == 'user';
  bool get isPending => status == 'pending';
  bool get failed => status == 'failed';

  factory AiConversationMessage.fromJson(Map<String, dynamic> json) =>
      AiConversationMessage(
        id: json['id'] as String,
        conversationId: json['conversationId'] as String,
        senderType: json['senderType'] as String? ?? 'assistant',
        kind: json['kind'] as String? ?? 'text',
        content: json['content'] as String? ?? '',
        status: json['status'] as String? ?? 'complete',
        metadata: Map<String, dynamic>.from(
          json['metadata'] as Map? ?? const <String, dynamic>{},
        ),
        createdAt: DateTime.parse(json['createdAt'] as String).toLocal(),
      );
}
