import 'package:assistant/feedback_center_page.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('反馈处理状态始终有用户可理解的文案', () {
    expect(feedbackStatusLabel('processing'), 'Agent 处理中');
    expect(feedbackStatusLabel('deferred'), '已安排自动续办');
    expect(feedbackStatusLabel('verifying'), '验收中');
  });
}
