import 'package:firebase_core/firebase_core.dart';

import 'firebase_options.dart';

typedef OptionalServiceInitializer = Future<void> Function();
typedef OptionalServiceErrorHandler =
    Future<void> Function(Object error, StackTrace stackTrace);

Future<void> ensureFirebaseInitialized() async {
  if (Firebase.apps.isNotEmpty) return;

  await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
}

Future<void> runBestEffortInitializers({
  required Iterable<OptionalServiceInitializer> initializers,
  required OptionalServiceErrorHandler onError,
}) async {
  for (final initialize in initializers) {
    try {
      await initialize();
    } catch (error, stackTrace) {
      await onError(error, stackTrace);
    }
  }
}
