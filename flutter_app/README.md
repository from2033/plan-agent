# Daynote Flutter App

Personal Assistant 的 iOS/Android 客户端。

## Install on the paired iPhone

Build the signed release, then use CoreDevice for an in-place upgrade:

```bash
flutter build ios --release
xcrun devicectl device install app --device <core-device-identifier> build/ios/iphoneos/Runner.app
```

Do not use `flutter install` for routine updates. It uninstalls the existing
app first and can clear local app state, including the remembered login.

## Development

```bash
flutter pub get
flutter analyze
flutter test
```

Production API defaults to `https://assistant.5656ai.com/api`. Override it for a build with `--dart-define=API_BASE=...`.
