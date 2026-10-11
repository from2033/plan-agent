import 'package:flutter_test/flutter_test.dart';
import 'package:assistant/qq_homework.dart';

void main() {
  test('一条多学科消息按学科拆分当日作业', () {
    final items = extractQqHomework([
      {
        'id': 12,
        'type': 'homework',
        'content': '语文作业：背诵古诗。数学：完成口算第3页\n英语练习：默写1-20号单词',
        'teacher': '王老师',
        'time': '17:30',
        'group_name': '四年级',
      },
    ]);

    expect(items.map((item) => item.subject), ['语文', '数学', '英语']);
    expect(items[0].content, contains('背诵古诗'));
    expect(items[1].content, contains('口算第3页'));
    expect(items[2].teacher, '王老师');
  });

  test('没有显式学科时使用作业内容推断', () {
    final items = extractQqHomework([
      {'id': 1, 'type': 'notice', 'content': '今晚完成20道口算题'},
      {'id': 2, 'type': 'notice', 'content': '明天记得带水杯'},
    ]);

    expect(items, hasLength(1));
    expect(items.single.subject, '数学');
  });
}
