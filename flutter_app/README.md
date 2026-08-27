# assistant

A new Flutter project.

## Install on the paired iPhone

Build the signed release, then use CoreDevice for an in-place upgrade:

```bash
flutter build ios --release
xcrun devicectl device install app --device <core-device-identifier> build/ios/iphoneos/Runner.app
```

Do not use `flutter install` for routine updates. It uninstalls the existing
app first and can clear local app state, including the remembered login.

## Getting Started

This project is a starting point for a Flutter application.

A few resources to get you started if this is your first Flutter project:

- [Learn Flutter](https://docs.flutter.dev/get-started/learn-flutter)
- [Write your first Flutter app](https://docs.flutter.dev/get-started/codelab)
- [Flutter learning resources](https://docs.flutter.dev/reference/learning-resources)

For help getting started with Flutter development, view the
[online documentation](https://docs.flutter.dev/), which offers tutorials,
samples, guidance on mobile development, and a full API reference.
