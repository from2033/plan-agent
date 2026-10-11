import 'package:flutter_test/flutter_test.dart';

import 'package:assistant/main.dart';

void main() {
  test('主导航只保留 Agent、事项和资料', () {
    expect(primaryNavigationLabels, ['Agent', '事项', '资料']);
  });
}
