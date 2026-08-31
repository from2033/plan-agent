import Flutter
import AVFAudio
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
  private var capturedCameraImages: [UIImage] = []
  private var recordingProcessingTask: UIBackgroundTaskIdentifier = .invalid
  private var recordingProcessingReferences = 0
  private var shortcutChannel: FlutterMethodChannel?
  private var shortcutObserver: NSObjectProtocol?
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
      guard let arguments = call.arguments as? [String: Any] else {
        result(FlutterMethodNotImplemented)
        return
      }
      if call.method == "sync", let reminders = arguments["reminders"] as? [[String: Any]] {
        self?.syncReminders(reminders, result: result)
      } else if call.method == "notifyAgent",
                let id = arguments["id"] as? String,
                let title = arguments["title"] as? String,
                let body = arguments["body"] as? String {
        self?.notifyAgent(id: id, title: title, body: body, result: result)
      } else {
        result(FlutterMethodNotImplemented)
      }
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
    let recordingChannel = FlutterMethodChannel(
      name: "com.from2033.assistant/recording",
      binaryMessenger: registrar.messenger()
    )
    recordingChannel.setMethodCallHandler { [weak self] call, result in
      let session = AVAudioSession.sharedInstance()
      do {
        switch call.method {
        case "activate":
          try session.setCategory(
            .record,
            mode: .measurement,
            options: [.allowBluetoothHFP]
          )
          try session.setActive(true)
          result(nil)
        case "deactivate":
          try session.setActive(false, options: [.notifyOthersOnDeactivation])
          result(nil)
        case "beginProcessing":
          self?.beginRecordingProcessingTask()
          result(nil)
        case "endProcessing":
          self?.endRecordingProcessingTask()
          result(nil)
        default:
          result(FlutterMethodNotImplemented)
        }
      } catch {
        result(FlutterError(
          code: "audio_session_failed",
          message: "无法配置后台录音: \(error.localizedDescription)",
          details: nil
        ))
      }
    }
    let shortcutChannel = FlutterMethodChannel(
      name: "com.from2033.assistant/shortcuts",
      binaryMessenger: registrar.messenger()
    )
    self.shortcutChannel = shortcutChannel
    shortcutChannel.setMethodCallHandler { call, result in
      guard call.method == "consumeStartRecording" else {
        result(FlutterMethodNotImplemented)
        return
      }
      result(DaynoteShortcutBridge.consumeStartRecording())
    }
    shortcutObserver = NotificationCenter.default.addObserver(
      forName: DaynoteShortcutBridge.startRecordingNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.shortcutChannel?.invokeMethod("startRecording", arguments: nil)
    }
  }

  private func beginRecordingProcessingTask() {
    recordingProcessingReferences += 1
    guard recordingProcessingTask == .invalid else { return }
    recordingProcessingTask = UIApplication.shared.beginBackgroundTask(
      withName: "Finish recording upload"
    ) { [weak self] in
      self?.expireRecordingProcessingTask()
    }
  }

  private func endRecordingProcessingTask() {
    guard recordingProcessingReferences > 0 else { return }
    recordingProcessingReferences -= 1
    guard recordingProcessingReferences == 0 else { return }
    finishRecordingProcessingTask()
  }

  private func expireRecordingProcessingTask() {
    recordingProcessingReferences = 0
    finishRecordingProcessingTask()
  }

  private func finishRecordingProcessingTask() {
    guard recordingProcessingTask != .invalid else { return }
    UIApplication.shared.endBackgroundTask(recordingProcessingTask)
    recordingProcessingTask = .invalid
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
        self?.capturedCameraImages = []
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
    configuration.selectionLimit = 20
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

  private func archiveFileName(extension fileExtension: String, multiple: Bool) -> String {
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyyMMdd-HHmmss"
    let prefix = multiple ? "多页资料" : "照片"
    return "\(prefix)-\(formatter.string(from: Date())).\(fileExtension)"
  }

  private func finishPicker(_ value: Any?) {
    documentPickerResult?(value)
    documentPickerResult = nil
  }

  private func scaledImage(_ image: UIImage, maxDimension: CGFloat) -> UIImage {
    let pixelSize = CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale)
    let longest = max(pixelSize.width, pixelSize.height)
    guard longest > maxDimension else { return image }
    let ratio = maxDimension / longest
    let targetSize = CGSize(width: pixelSize.width * ratio, height: pixelSize.height * ratio)
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    return UIGraphicsImageRenderer(size: targetSize, format: format).image { _ in
      image.draw(in: CGRect(origin: .zero, size: targetSize))
    }
  }

  private func preparedImages(_ images: [UIImage], maxDimension: CGFloat, quality: CGFloat) -> [UIImage] {
    images.compactMap { image in
      scaledImage(image, maxDimension: maxDimension)
        .jpegData(compressionQuality: quality)
        .flatMap(UIImage.init(data:))
    }
  }

  private func pdfData(from images: [UIImage]) -> Data {
    let portraitPage = CGRect(x: 0, y: 0, width: 595, height: 842)
    let landscapePage = CGRect(x: 0, y: 0, width: 842, height: 595)
    return UIGraphicsPDFRenderer(bounds: portraitPage).pdfData { context in
      for image in images {
        let page = image.size.width > image.size.height ? landscapePage : portraitPage
        context.beginPage(withBounds: page, pageInfo: [:])
        let content = page.insetBy(dx: 18, dy: 18)
        let ratio = min(content.width / image.size.width, content.height / image.size.height)
        let size = CGSize(width: image.size.width * ratio, height: image.size.height * ratio)
        let rect = CGRect(
          x: content.midX - size.width / 2,
          y: content.midY - size.height / 2,
          width: size.width,
          height: size.height
        )
        image.draw(in: rect)
      }
    }
  }

  private func finishImages(_ images: [UIImage]) {
    guard !images.isEmpty else {
      finishPicker(nil)
      return
    }
    if images.count == 1 {
      guard let data = preparedImages(images, maxDimension: 2400, quality: 0.88).first?
        .jpegData(compressionQuality: 0.88) else {
        finishPicker(FlutterError(code: "image_encode_failed", message: "图片处理失败", details: nil))
        return
      }
      finishPicker([
        "fileName": archiveFileName(extension: "jpg", multiple: false),
        "mimeType": "image/jpeg",
        "bytes": FlutterStandardTypedData(bytes: data),
      ])
      return
    }
    var data = pdfData(from: preparedImages(images, maxDimension: 2000, quality: 0.8))
    if data.count > 30 * 1024 * 1024 {
      data = pdfData(from: preparedImages(images, maxDimension: 1400, quality: 0.62))
    }
    if data.count > 30 * 1024 * 1024 {
      finishPicker(FlutterError(code: "document_too_large", message: "合并后的资料超过 30MB，请减少图片数量", details: nil))
      return
    }
    guard !data.isEmpty else {
      finishPicker(FlutterError(code: "image_encode_failed", message: "图片处理失败", details: nil))
      return
    }
    finishPicker([
      "fileName": archiveFileName(extension: "pdf", multiple: true),
      "mimeType": "application/pdf",
      "bytes": FlutterStandardTypedData(bytes: data),
    ])
  }

  private func finishCapturedCameraImages() {
    let images = capturedCameraImages
    capturedCameraImages = []
    finishImages(images)
  }

  private func presentCameraContinuation() {
    guard capturedCameraImages.count < 20, let root = activeRootViewController() else {
      finishCapturedCameraImages()
      return
    }
    let sheet = UIAlertController(
      title: "已拍 \(capturedCameraImages.count) 张",
      message: "这些照片会合并成同一份资料",
      preferredStyle: .actionSheet
    )
    sheet.addAction(UIAlertAction(title: "继续拍", style: .default) { [weak self] _ in
      self?.presentCamera(from: root)
    })
    sheet.addAction(UIAlertAction(title: "完成并上传", style: .default) { [weak self] _ in
      self?.finishCapturedCameraImages()
    })
    sheet.addAction(UIAlertAction(title: "放弃本次拍摄", style: .destructive) { [weak self] _ in
      self?.capturedCameraImages = []
      self?.finishPicker(nil)
    })
    if let popover = sheet.popoverPresentationController {
      popover.sourceView = root.view
      popover.sourceRect = CGRect(x: root.view.bounds.midX, y: root.view.bounds.maxY, width: 1, height: 1)
    }
    root.present(sheet, animated: true)
  }

  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    picker.dismiss(animated: true)
    guard !results.isEmpty else {
      finishPicker(nil)
      return
    }
    let group = DispatchGroup()
    let lock = NSLock()
    var images = Array<UIImage?>(repeating: nil, count: results.count)
    for (index, result) in results.enumerated() {
      let provider = result.itemProvider
      guard provider.canLoadObject(ofClass: UIImage.self) else { continue }
      group.enter()
      provider.loadObject(ofClass: UIImage.self) { object, _ in
        if let image = object as? UIImage {
          lock.lock()
          images[index] = image
          lock.unlock()
        }
        group.leave()
      }
    }
    group.notify(queue: .main) { [weak self] in
      guard let self else { return }
      let loaded = images.compactMap { $0 }
      if loaded.count == results.count {
        self.finishImages(loaded)
      } else {
          self.finishPicker(FlutterError(
            code: "image_read_failed",
            message: "有图片无法读取，请重新选择",
            details: nil
          ))
      }
    }
  }

  func imagePickerController(
    _ picker: UIImagePickerController,
    didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
  ) {
    guard let image = info[.originalImage] as? UIImage else {
      picker.dismiss(animated: true)
      finishPicker(FlutterError(code: "image_read_failed", message: "无法读取拍摄的图片", details: nil))
      return
    }
    capturedCameraImages.append(image)
    picker.dismiss(animated: true) { [weak self] in
      self?.presentCameraContinuation()
    }
  }

  func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
    picker.dismiss(animated: true) { [weak self] in
      guard let self else { return }
      if self.capturedCameraImages.isEmpty {
        self.finishPicker(nil)
      } else {
        self.finishCapturedCameraImages()
      }
    }
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

  private func notifyAgent(id: String, title: String, body: String, result: @escaping FlutterResult) {
    let center = UNUserNotificationCenter.current()
    center.getNotificationSettings { settings in
      guard settings.authorizationStatus == .authorized ||
              settings.authorizationStatus == .provisional ||
              settings.authorizationStatus == .ephemeral else {
        DispatchQueue.main.async { result(false) }
        return
      }
      let content = UNMutableNotificationContent()
      content.title = String(title.prefix(80))
      content.body = String(body.prefix(300))
      content.sound = .default
      let request = UNNotificationRequest(
        identifier: "agent-\(id)",
        content: content,
        trigger: nil
      )
      center.add(request) { error in
        DispatchQueue.main.async { result(error == nil) }
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
