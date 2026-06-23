import UIKit
import Capacitor
import AVFoundation

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // 进程内掌控 iOS 音频会话——这是相对网页 PWA 的唯一关键差别，
        // 也是为了消除"开始/停止录音"提示音、不打断背景音乐而做这个原生壳的根本原因。
        configureAudioSession()

        // WKWebView 在开始 getUserMedia 采集、或音频线路变化时会重置会话类别，
        // 提示音会"回潮"。监听这些事件并重新断言我们的类别。
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(reassertAudioSession),
                       name: AVAudioSession.routeChangeNotification, object: nil)
        nc.addObserver(self, selector: #selector(reassertAudioSession),
                       name: AVAudioSession.mediaServicesWereResetNotification, object: nil)
        return true
    }

    // .playAndRecord + .mixWithOthers：录音时不打断/不抢占其它 app 的声音；
    // 会话全程保持激活（不在每次说话时开关），从而不产生激活/停用的系统提示音。
    private func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(
                .playAndRecord,
                mode: .default,
                options: [.mixWithOthers, .defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP]
            )
            try session.setActive(true)
        } catch {
            NSLog("[Audio] 配置音频会话失败: \(error.localizedDescription)")
        }
    }

    @objc private func reassertAudioSession() {
        let session = AVAudioSession.sharedInstance()
        // 仅在类别被改掉时重设，避免和 WebKit 反复抢夺。
        if session.category != .playAndRecord {
            configureAudioSession()
        }
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // 从后台返回时 WebKit 可能已重置音频会话，重新断言一次。
        reassertAudioSession()
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // 退出时干净地停用会话，并通知其它 app 恢复（避免遗留的打断状态）。
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
