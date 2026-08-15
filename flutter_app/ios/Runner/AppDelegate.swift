import Flutter
import UIKit
import UserNotifications
#if canImport(AlarmKit)
import AlarmKit
import SwiftUI

@available(iOS 26.0, *)
private struct ReminderAlarmMetadata: AlarmMetadata {
  let entryID: String
}
#endif

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    UNUserNotificationCenter.current().delegate = self
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    guard let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "ReminderChannel") else { return }
    let channel = FlutterMethodChannel(
      name: "com.from2033.assistant/reminders",
      binaryMessenger: registrar.messenger()
    )
    channel.setMethodCallHandler { [weak self] call, result in
      guard call.method == "sync",
            let arguments = call.arguments as? [String: Any],
            let reminders = arguments["reminders"] as? [[String: Any]] else {
        result(FlutterMethodNotImplemented)
        return
      }
      self?.syncReminders(reminders, result: result)
    }
  }

  private func syncReminders(_ reminders: [[String: Any]], result: @escaping FlutterResult) {
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *) {
      Task {
        do {
          if let scheduledIDs = try await syncAlarmKitReminders(reminders) {
            UNUserNotificationCenter.current().removeAllPendingNotificationRequests()
            let count = (try? AlarmManager.shared.alarms.count) ?? scheduledIDs.count
            NSLog("Assistant AlarmKit sync complete: requested=%d scheduled=%d", reminders.count, count)
            await MainActor.run {
              result([
                "mode": "alarm",
                "count": count,
                "scheduledEntryIds": scheduledIDs,
              ])
            }
            return
          }
        } catch {
          // AlarmKit 被拒绝或调度失败时，继续使用普通本地通知兜底。
        }
        syncNotificationReminders(reminders, result: result)
      }
      return
    }
    #endif
    syncNotificationReminders(reminders, result: result)
  }

  private func syncNotificationReminders(_ reminders: [[String: Any]], result: @escaping FlutterResult) {
    let center = UNUserNotificationCenter.current()
    center.getPendingNotificationRequests { requests in
      let managed = requests.map(\.identifier).filter { $0.hasPrefix("memo-") }
      center.removePendingNotificationRequests(withIdentifiers: managed)

      guard !reminders.isEmpty else {
        DispatchQueue.main.async {
          result(["mode": "none", "count": 0, "scheduledEntryIds": []])
        }
        return
      }

      let schedule: () -> Void = { [weak self] in
        self?.schedule(reminders, center: center) { error in
          DispatchQueue.main.async {
            if let error {
              result(FlutterError(code: "reminder_schedule_failed", message: error.localizedDescription, details: nil))
            } else {
              result([
                "mode": "notification",
                "count": reminders.count,
                "scheduledEntryIds": reminders.compactMap { $0["id"] as? String },
              ])
            }
          }
        }
      }

      center.getNotificationSettings { settings in
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
          schedule()
        case .notDetermined:
          center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            if let error {
              DispatchQueue.main.async {
                result(FlutterError(code: "reminder_permission_failed", message: error.localizedDescription, details: nil))
              }
            } else if granted {
              schedule()
            } else {
              DispatchQueue.main.async {
                result(["mode": "denied", "count": 0, "scheduledEntryIds": []])
              }
            }
          }
        case .denied:
          DispatchQueue.main.async {
            result(["mode": "denied", "count": 0, "scheduledEntryIds": []])
          }
        @unknown default:
          DispatchQueue.main.async {
            result(["mode": "denied", "count": 0, "scheduledEntryIds": []])
          }
        }
      }
    }
  }

  #if canImport(AlarmKit)
  @available(iOS 26.0, *)
  private func syncAlarmKitReminders(_ reminders: [[String: Any]]) async throws -> [String]? {
    let manager = AlarmManager.shared
    let state: AlarmManager.AuthorizationState
    if manager.authorizationState == .notDetermined && !reminders.isEmpty {
      state = try await manager.requestAuthorization()
    } else {
      state = manager.authorizationState
    }
    guard state == .authorized else {
      NSLog("Assistant AlarmKit authorization denied")
      return nil
    }

    for alarm in try manager.alarms {
      try manager.cancel(id: alarm.id)
    }
    guard !reminders.isEmpty else { return [] }

    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    var scheduledEntryIDs: [String] = []
    for reminder in reminders {
      guard let entryID = reminder["id"] as? String,
            let dateString = reminder["date"] as? String,
            let date = formatter.date(from: dateString),
            date.timeIntervalSinceNow > 1 else { continue }
      let body = reminder["body"] as? String ?? "你有一条待办事项"
      let stopButton = AlarmButton(
        text: "停止",
        textColor: .white,
        systemImageName: "stop.circle.fill"
      )
      let presentation = AlarmPresentation(
        alert: AlarmPresentation.Alert(
          title: LocalizedStringResource(stringLiteral: body),
          stopButton: stopButton
        )
      )
      let attributes = AlarmAttributes(
        presentation: presentation,
        metadata: ReminderAlarmMetadata(entryID: entryID),
        tintColor: .orange
      )
      let configuration = AlarmManager.AlarmConfiguration.alarm(
        schedule: .fixed(date),
        attributes: attributes
      )
      _ = try await manager.schedule(id: UUID(), configuration: configuration)
      scheduledEntryIDs.append(entryID)
    }
    return scheduledEntryIDs
  }
  #endif

  private func schedule(
    _ reminders: [[String: Any]],
    center: UNUserNotificationCenter,
    completion: @escaping (Error?) -> Void
  ) {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let group = DispatchGroup()
    var firstError: Error?
    let lock = NSLock()

    for reminder in reminders {
      guard let id = reminder["id"] as? String,
            let dateString = reminder["date"] as? String,
            let date = formatter.date(from: dateString),
            date.timeIntervalSinceNow > 1 else { continue }
      let content = UNMutableNotificationContent()
      content.title = reminder["title"] as? String ?? "备忘提醒"
      content.body = reminder["body"] as? String ?? "你有一条待办事项"
      content.sound = .default
      content.userInfo = ["entryId": id]
      let components = Calendar.current.dateComponents(
        [.year, .month, .day, .hour, .minute, .second],
        from: date
      )
      let request = UNNotificationRequest(
        identifier: "memo-\(id)",
        content: content,
        trigger: UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
      )
      group.enter()
      center.add(request) { error in
        if let error {
          lock.lock()
          if firstError == nil { firstError = error }
          lock.unlock()
        }
        group.leave()
      }
    }
    group.notify(queue: .global()) { completion(firstError) }
  }

  override func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    if #available(iOS 14.0, *) {
      completionHandler([.banner, .sound])
    } else {
      completionHandler([.alert, .sound])
    }
  }
}
