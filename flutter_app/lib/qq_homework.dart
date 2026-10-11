class QqHomeworkItem {
  const QqHomeworkItem({
    required this.subject,
    required this.content,
    required this.teacher,
    required this.time,
    required this.groupName,
    required this.messageId,
  });

  final String subject;
  final String content;
  final String teacher;
  final String time;
  final String groupName;
  final int messageId;
}

const qqHomeworkSubjects = <String>[
  '语文',
  '数学',
  '英语',
  '物理',
  '化学',
  '生物',
  '道法',
  '历史',
  '地理',
  '科学',
  '音乐',
  '美术',
  '体育',
  '信息',
  '劳技',
  '其他',
];

final _subjectMarker = RegExp(
  r'(语文|数学|英语|物理|化学|生物|道德与法治|道法|历史|地理|科学|音乐|美术|体育|信息(?:技术)?|劳技|劳动)\s*(?:作业|练习|预习|复习|任务|要求)?\s*[：:]?',
);

final _homeworkSignal = RegExp(
  r'作业|练习|预习|复习|背诵|朗读|默写|听写|订正|抄写|口算|计算题|阅读|课本|试卷|打卡|完成|上交|提交',
);

String _normalizeSubject(String value) {
  if (value == '道德与法治') return '道法';
  if (value == '信息技术') return '信息';
  if (value == '劳动') return '劳技';
  return value;
}

String _inferSubject(String content) {
  if (RegExp(r'单词|英语|拼读').hasMatch(content)) return '英语';
  if (RegExp(r'口算|计算|方程|数学').hasMatch(content)) return '数学';
  if (RegExp(r'生字|词语|古诗|作文|习作|语文').hasMatch(content)) {
    return '语文';
  }
  return '其他';
}

String _cleanTask(String value) => value
    .replaceFirst(RegExp(r'^[\s：:、,，.。—-]+'), '')
    .replaceAll(RegExp(r'\s+'), ' ')
    .trim();

List<QqHomeworkItem> extractQqHomework(List<Map<String, dynamic>> messages) {
  final result = <QqHomeworkItem>[];
  final seen = <String>{};

  for (final message in messages) {
    final content = message['content']?.toString().trim() ?? '';
    final type = message['type']?.toString() ?? '';
    if (content.isEmpty ||
        (type != 'homework' && !_homeworkSignal.hasMatch(content))) {
      continue;
    }
    final matches = _subjectMarker.allMatches(content).toList();
    final parts = <({String subject, String content})>[];
    if (matches.isEmpty) {
      parts.add((subject: _inferSubject(content), content: content));
    } else {
      for (var index = 0; index < matches.length; index += 1) {
        final match = matches[index];
        final end = index + 1 < matches.length
            ? matches[index + 1].start
            : content.length;
        final task = _cleanTask(content.substring(match.end, end));
        final markerText = match.group(0) ?? '';
        final fallback = _cleanTask(content.substring(match.start, end));
        parts.add((
          subject: _normalizeSubject(match.group(1) ?? '其他'),
          content: task.isEmpty ? fallback : task,
        ));
        if (index == 0 && match.start > 0) {
          final intro = _cleanTask(content.substring(0, match.start));
          if (intro.isNotEmpty &&
              _homeworkSignal.hasMatch(intro) &&
              markerText.isNotEmpty) {
            parts.insert(0, (subject: _inferSubject(intro), content: intro));
          }
        }
      }
    }

    final messageId = (message['id'] as num?)?.toInt() ?? 0;
    for (final part in parts) {
      if (part.content.isEmpty) continue;
      final fingerprint = '$messageId|${part.subject}|${part.content}';
      if (!seen.add(fingerprint)) continue;
      result.add(
        QqHomeworkItem(
          subject: part.subject,
          content: part.content,
          teacher: message['teacher']?.toString() ?? '群成员',
          time: message['time']?.toString() ?? '',
          groupName: message['group_name']?.toString() ?? '',
          messageId: messageId,
        ),
      );
    }
  }
  result.sort((a, b) {
    final subject = qqHomeworkSubjects
        .indexOf(a.subject)
        .compareTo(qqHomeworkSubjects.indexOf(b.subject));
    return subject != 0 ? subject : a.time.compareTo(b.time);
  });
  return result;
}
