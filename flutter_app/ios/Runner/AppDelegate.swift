import Flutter
import PhotosUI
import UIKit
import UserNotifications
import UniformTypeIdentifiers
#if canImport(AlarmKit)
import AlarmKit
import SwiftUI

@available(iOS 26.0, *)
private struct ReminderAlarmMetadata: AlarmMetadata {
  let entryID: String
}
#endif

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate,
  UIDocumentPickerDelegate, PHPickerViewControllerDelegate,
  UIImagePickerControllerDelegate, UINavigationControllerDelegate {
  private var documentPickerResult: FlutterResult?
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
    let documentChannel = FlutterMethodChannel(
      name: "com.from2033.assistant/documents",
      binaryMessenger: registrar.messenger()
    )
    documentChannel.setMethodCallHandler { [weak self] call, result in
      guard call.method == "pick" else {
        result(FlutterMethodNotImplemented)
        return
      }
      self?.presentUploadSourcePicker(result: result)
    }
  }

  private func activeRootViewController() -> UIViewController? {
    (UIApplication.shared.connectedScenes.first as? UIWindowScene)?
      .windows.first(where: { $0.isKeyWindow })?.rootViewController
  }

  private func presentUploadSourcePicker(result: @escaping FlutterResult) {
    guard documentPickerResult == nil else {
      result(FlutterError(code: "document_picker_busy", message: "已有文件选择器正在打开", details: nil))
      return
    }
    documentPickerResult = result
    guard let root = activeRootViewController() else {
      documentPickerResult = nil
      result(FlutterError(code: "document_picker_unavailable", message: "无法打开上传选择器", details: nil))
      return
    }
    let sheet = UIAlertController(title: "上传家庭资料", message: nil, preferredStyle: .actionSheet)
    sheet.addAction(UIAlertAction(title: "从相册选择", style: .default) { [weak self] _ in
      self?.presentPhotoPicker(from: root)
    })
    if UIImagePickerController.isSourceTypeAvailable(.camera) {
      sheet.addAction(UIAlertAction(title: "拍照", style: .default) { [weak self] _ in
        self?.presentCamera(from: root)
      })
    }
    sheet.addAction(UIAlertAction(title: "从文件选择", style: .default) { [weak self] _ in
      self?.presentDocumentPicker(from: root)
    })
    sheet.addAction(UIAlertAction(title: "取消", style: .cancel) { [weak self] _ in
      self?.finishPicker(nil)
    })
    if let popover = sheet.popoverPresentationController {
      popover.sourceView = root.view
      popover.sourceRect = CGRect(x: root.view.bounds.midX, y: root.view.bounds.maxY, width: 1, height: 1)
    }
    root.present(sheet, animated: true)
  }

  private func presentPhotoPicker(from root: UIViewController) {
    var configuration = PHPickerConfiguration(photoLibrary: .shared())
    configuration.filter = .images
    configuration.selectionLimit = 1
    configuration.preferredAssetRepresentationMode = .current
    let picker = PHPickerViewController(configuration: configuration)
    picker.delegate = self
    root.present(picker, animated: true)
  }

  private func presentCamera(from root: UIViewController) {
    let picker = UIImagePickerController()
    picker.sourceType = .camera
    picker.cameraCaptureMode = .photo
    picker.delegate = self
    root.present(picker, animated: true)
  }

  private func presentDocumentPicker(from root: UIViewController) {
    var contentTypes: [UTType] = [.pdf, .plainText, .jpeg, .png, .heic]
    for fileExtension in ["docx", "md", "heif"] {
      if let type = UTType(filenameExtension: fileExtension) {
        contentTypes.append(type)
      }
    }
    let picker = UIDocumentPickerViewController(forOpeningContentTypes: contentTypes, asCopy: true)
    picker.delegate = self
    picker.allowsMultipleSelection = false
    root.present(picker, animated: true)
  }

  private func imageFileName() -> String {
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyyMMdd-HHmmss"
    return "照片-\(formatter.string(from: Date())).jpg"
  }

  private func finishPicker(_ value: Any?) {
    documentPickerResult?(value)
    documentPickerResult = nil
  }

  private func finishImage(_ image: UIImage) {
    guard let data = image.jpegData(compressionQuality: 0.9) else {
      finishPicker(FlutterError(code: "image_encode_failed", message: "图片处理失败", details: nil))
      return
    }
    if data.count > 30 * 1024 * 1024 {
      finishPicker(FlutterError(code: "document_too_large", message: "第一版单个文件不能超过 30MB", details: nil))
      return
    }
    finishPicker([
      "fileName": imageFileName(),
      "mimeType": "image/jpeg",
      "bytes": FlutterStandardTypedData(bytes: data),
    ])
  }

  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    picker.dismiss(animated: true)
    guard let provider = results.first?.itemProvider else {
      finishPicker(nil)
      return
    }
    guard provider.canLoadObject(ofClass: UIImage.self) else {
      finishPicker(FlutterError(code: "image_read_failed", message: "无法读取这张图片", details: nil))
      return
    }
    provider.loadObject(ofClass: UIImage.self) { [weak self] object, error in
      DispatchQueue.main.async {
        guard let self else { return }
        if let image = object as? UIImage {
          self.finishImage(image)
        } else {
          self.finishPicker(FlutterError(
            code: "image_read_failed",
            message: error?.localizedDescription ?? "无法读取这张图片",
            details: nil
          ))
        }
      }
    }
  }

  func imagePickerController(
    _ picker: UIImagePickerController,
    didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
  ) {
    picker.dismiss(animated: true)
    guard let image = info[.originalImage] as? UIImage else {
      finishPicker(FlutterError(code: "image_read_failed", message: "无法读取拍摄的图片", details: nil))
      return
    }
    finishImage(image)
  }

  func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
    picker.dismiss(animated: true)
    finishPicker(nil)
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    guard let result = documentPickerResult else { return }
    documentPickerResult = nil
    guard let url = urls.first else {
      result(nil)
      return
    }
    let accessing = url.startAccessingSecurityScopedResource()
    defer { if accessing { url.stopAccessingSecurityScopedResource() } }
    do {
      let data = try Data(contentsOf: url, options: [.mappedIfSafe])
      if data.count > 30 * 1024 * 1024 {
        result(FlutterError(code: "document_too_large", message: "第一版单个文件不能超过 30MB", details: nil))
        return
      }
      let fileExtension = url.pathExtension.lowercased()
      let knownMimeTypes = [
        "pdf": "application/pdf",
        "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "txt": "text/plain",
        "md": "text/markdown",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "png": "image/png",
        "heic": "image/heic",
        "heif": "image/heif",
      ]
      let type = UTType(filenameExtension: fileExtension)
      result([
        "fileName": url.lastPathComponent,
        "mimeType": knownMimeTypes[fileExtension] ?? type?.preferredMIMEType ?? "application/octet-stream",
        "bytes": FlutterStandardTypedData(bytes: data),
      ])
    } catch {
      result(FlutterError(code: "document_read_failed", message: error.localizedDescription, details: nil))
    }
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    finishPicker(nil)
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
