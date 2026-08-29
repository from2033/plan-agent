import AppIntents
import Foundation

enum DaynoteShortcutBridge {
  static let startRecordingNotification = Notification.Name(
    "com.from2033.assistant.startRecording"
  )
  private static let pendingStartRecordingKey =
    "com.from2033.assistant.pendingStartRecording"

  @MainActor
  static func requestStartRecording() {
    UserDefaults.standard.set(true, forKey: pendingStartRecordingKey)
    NotificationCenter.default.post(name: startRecordingNotification, object: nil)
  }

  static func consumeStartRecording() -> Bool {
    let defaults = UserDefaults.standard
    let pending = defaults.bool(forKey: pendingStartRecordingKey)
    if pending {
      defaults.removeObject(forKey: pendingStartRecordingKey)
    }
    return pending
  }
}

@available(iOS 16.0, *)
struct StartDaynoteRecordingIntent: AppIntent {
  static var title: LocalizedStringResource = "开始 Daynote 录音"
  static var description = IntentDescription(
    "打开 Daynote 并立即开始一段快速录音。"
  )
  static var openAppWhenRun: Bool = true

  @MainActor
  func perform() async throws -> some IntentResult {
    DaynoteShortcutBridge.requestStartRecording()
    return .result()
  }
}

@available(iOS 16.0, *)
struct DaynoteAppShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: StartDaynoteRecordingIntent(),
      phrases: [
        "在 \(.applicationName) 开始录音",
        "用 \(.applicationName) 开始录音",
      ],
      shortTitle: "开始录音",
      systemImageName: "mic.fill"
    )
  }

  static var shortcutTileColor: ShortcutTileColor = .orange
}
