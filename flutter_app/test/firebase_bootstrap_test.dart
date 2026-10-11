import 'package:assistant/firebase_bootstrap.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('optional service failures do not block later initializers', () async {
    final calls = <String>[];
    final errors = <Object>[];

    await runBestEffortInitializers(
      initializers: [
        () async {
          calls.add('messaging');
          throw StateError('Firebase Messaging unavailable');
        },
        () async {
          calls.add('crash-reporting');
        },
      ],
      onError: (error, stackTrace) async {
        errors.add(error);
      },
    );

    expect(calls, ['messaging', 'crash-reporting']);
    expect(errors, hasLength(1));
  });
}
