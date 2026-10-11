import 'dart:async';

import 'package:firebase_crashlytics/firebase_crashlytics.dart';
import 'package:flutter/foundation.dart';

import 'firebase_bootstrap.dart';

const _sendCrashlyticsTestEvent = bool.fromEnvironment(
  'CRASHLYTICS_TEST_EVENT',
  defaultValue: false,
);
const _triggerCrashlyticsTestCrash = bool.fromEnvironment(
  'CRASHLYTICS_TEST_CRASH',
  defaultValue: false,
);

bool get _supportsFirebaseCrashlytics =>
    !kIsWeb &&
    (defaultTargetPlatform == TargetPlatform.iOS ||
        defaultTargetPlatform == TargetPlatform.android);

Future<void> initializeFirebaseCrashReporting() async {
  if (!_supportsFirebaseCrashlytics) return;

  await ensureFirebaseInitialized();

  final crashlytics = FirebaseCrashlytics.instance;
  await crashlytics.setCrashlyticsCollectionEnabled(true);

  // SentryFlutter.init has already installed its handlers before appRunner is
  // called. Preserve and forward to them so both reporting systems receive the
  // same uncaught Flutter and asynchronous errors.
  final previousFlutterErrorHandler = FlutterError.onError;
  FlutterError.onError = (details) {
    unawaited(crashlytics.recordFlutterFatalError(details));
    previousFlutterErrorHandler?.call(details);
  };

  final previousPlatformErrorHandler = PlatformDispatcher.instance.onError;
  PlatformDispatcher.instance.onError = (error, stackTrace) {
    unawaited(crashlytics.recordError(error, stackTrace, fatal: true));
    return previousPlatformErrorHandler?.call(error, stackTrace) ?? true;
  };

  if (_sendCrashlyticsTestEvent) {
    await crashlytics.recordError(
      StateError('Firebase Crashlytics integration test'),
      StackTrace.current,
      reason: 'Explicit fatal integration test',
      fatal: true,
    );
  }

  if (_triggerCrashlyticsTestCrash) {
    crashlytics.crash();
  }
}
