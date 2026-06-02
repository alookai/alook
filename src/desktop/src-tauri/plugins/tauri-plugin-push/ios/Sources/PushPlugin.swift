import UIKit
import UserNotifications
import Tauri
import WebKit

class PushPlugin: Plugin {
    private var pushToken: String?

    override init() {
        super.init()
    }

    @objc override func load(webview: WKWebView) {
        super.load(webview: webview)
        requestPushPermission()
    }

    private func requestPushPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in
            if granted {
                DispatchQueue.main.async {
                    UIApplication.shared.registerForRemoteNotifications()
                }
            }
        }
    }

    func didRegisterForRemoteNotifications(deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02.2hhx", $0) }.joined()
        self.pushToken = token
        let event: [String: Any] = ["token": token, "platform": "ios"]
        self.trigger("token", data: event)
    }

    @objc func getToken(_ invoke: Invoke) {
        if let token = pushToken {
            invoke.resolve([
                "token": token,
                "platform": "ios"
            ])
        } else {
            invoke.reject("Push token not yet available")
        }
    }

    @objc func onNotification(_ invoke: Invoke) {
        invoke.resolve()
    }
}
