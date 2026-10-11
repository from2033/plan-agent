import 'dart:async';

import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:sentry_flutter/sentry_flutter.dart';

import 'firebase_bootstrap.dart';

@pragma('vm:entry-point')
Future<void> firebaseMessagingBackgroundHandler(RemoteMessage message) async {
  await ensureFirebaseInitialized();
}

bool get _supportsFirebaseMessaging =>
    !kIsWeb && defaultTargetPlatform == TargetPlatform.iOS;

Future<void> initializeFirebaseMessaging() async {
  if (!_supportsFirebaseMessaging) return;

  await ensureFirebaseInitialized();
  FirebaseMessaging.onBackgroundMessage(firebaseMessagingBackgroundHandler);

  await FirebaseMessaging.instance.setForegroundNotificationPresentationOptions(
    alert: true,
    badge: true,
    sound: true,
  );
}

Future<void> activateFirebaseMessaging({
  required Future<void> Function(String token) registerToken,
}) async {
  if (!_supportsFirebaseMessaging) return;

  try {
    final messaging = FirebaseMessaging.instance;
    final settings = await messaging.requestPermission(
      alert: true,
      badge: true,
      sound: true,
    );

    await Sentry.addBreadcrumb(
      Breadcrumb(
        category: 'firebase.messaging',
        message: 'Notification permission: ${settings.authorizationStatus}',
        level: SentryLevel.info,
      ),
    );

    if (settings.authorizationStatus == AuthorizationStatus.authorized ||
        settings.authorizationStatus == AuthorizationStatus.provisional) {
      messaging.onTokenRefresh.listen((token) {
        unawaited(_registerFcmToken(token, registerToken));
      });

      // APNs registration can finish shortly after the permission dialog.
      // Avoid asking Firebase for an FCM token until Apple has issued one;
      // onTokenRefresh will provide it when registration completes.
      final apnsToken = await messaging.getAPNSToken();
      if (apnsToken != null) {
        final token = await messaging.getToken();
        if (token != null) await _registerFcmToken(token, registerToken);
      }
    }

    FirebaseMessaging.onMessage.listen(_recordForegroundMessage);
    FirebaseMessaging.onMessageOpenedApp.listen(_recordOpenedMessage);

    final initialMessage = await messaging.getInitialMessage();
    if (initialMessage != null) {
      await _recordOpenedMessage(initialMessage);
    }
  } catch (error, stackTrace) {
    await Sentry.captureException(error, stackTrace: stackTrace);
  }
}

Future<void> deactivateFirebaseMessaging({
  required Future<void> Function(String token) unregisterToken,
}) async {
  if (!_supportsFirebaseMessaging) return;
  try {
    final token = await FirebaseMessaging.instance.getToken();
    if (token != null) await unregisterToken(token);
  } catch (error, stackTrace) {
    await Sentry.captureException(error, stackTrace: stackTrace);
  }
}

Future<void> _registerFcmToken(
  String token,
  Future<void> Function(String token) registerToken,
) async {
  if (kDebugMode) {
    debugPrint('FCM registration token: $token');
  }
  try {
    await registerToken(token);
  } catch (error, stackTrace) {
    await Sentry.captureException(error, stackTrace: stackTrace);
  }
}

Future<void> _recordForegroundMessage(RemoteMessage message) {
  return Sentry.addBreadcrumb(
    Breadcrumb(
      category: 'firebase.messaging',
      message: 'Foreground message received',
      data: {'messageId': message.messageId},
      level: SentryLevel.info,
    ),
  );
}

Future<void> _recordOpenedMessage(RemoteMessage message) {
  return Sentry.addBreadcrumb(
    Breadcrumb(
      category: 'firebase.messaging',
      message: 'Notification opened',
      data: {'messageId': message.messageId},
      level: SentryLevel.info,
    ),
  );
}
