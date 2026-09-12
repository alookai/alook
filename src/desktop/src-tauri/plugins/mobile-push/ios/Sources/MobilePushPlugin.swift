import Foundation
import ObjectiveC
import Tauri
import UIKit
import UserNotifications
import WebKit

struct MobilePushRoute: Codable, Equatable {
  let notificationId: String
  let messageId: String
  let targetId: String

  private static let safeId = try! NSRegularExpression(
    pattern: "^[A-Za-z0-9_-]{1,128}$"
  )

  static func create(
    notificationId: String?,
    messageId: String?,
    targetId: String?
  ) -> MobilePushRoute? {
    guard let notificationId = notificationId,
          let messageId = messageId,
          let targetId = targetId,
          let uuid = UUID(uuidString: notificationId),
          uuid.uuidString.lowercased() == notificationId.lowercased(),
          matchesSafeId(messageId),
          matchesSafeId(targetId)
    else { return nil }
    return MobilePushRoute(
      notificationId: uuid.uuidString.lowercased(),
      messageId: messageId,
      targetId: targetId
    )
  }

  static func from(_ values: [AnyHashable: Any]) -> MobilePushRoute? {
    create(
      notificationId: values["notificationId"] as? String,
      messageId: values["messageId"] as? String,
      targetId: values["targetId"] as? String
    )
  }

  private static func matchesSafeId(_ value: String) -> Bool {
    let range = NSRange(value.startIndex..<value.endIndex, in: value)
    return safeId.firstMatch(in: value, range: range)?.range == range
  }
}

struct MobilePushRegistrationState: Equatable {
  let currentToken: String?
  let acknowledgedToken: String?

  init(currentToken: String? = nil, acknowledgedToken: String? = nil) {
    self.currentToken = currentToken
    self.acknowledgedToken = acknowledgedToken
  }

  func withCurrentToken(_ token: String) -> MobilePushRegistrationState {
    token == currentToken ? self : .init(
      currentToken: token,
      acknowledgedToken: acknowledgedToken
    )
  }

  func acknowledging(_ token: String) -> MobilePushRegistrationState {
    .init(
      currentToken: currentToken,
      acknowledgedToken: token
    )
  }

  var previousToken: String? {
    acknowledgedToken == currentToken ? nil : acknowledgedToken
  }
}

final class MobilePushStore {
  private let defaults: UserDefaults
  private let lock = NSLock()

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
  }

  func installationId() -> String {
    lock.lock()
    defer { lock.unlock() }
    if let existing = defaults.string(forKey: Keys.installationId) { return existing }
    let created = UUID().uuidString.lowercased()
    defaults.set(created, forKey: Keys.installationId)
    return created
  }

  func registration() -> MobilePushRegistrationState {
    lock.lock()
    defer { lock.unlock() }
    return unlockedRegistration()
  }

  @discardableResult
  func updateCurrentToken(_ token: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard token.utf8.count >= 16, token.utf8.count <= 4096 else { return false }
    let current = unlockedRegistration()
    let next = current.withCurrentToken(token)
    guard next != current else { return false }
    defaults.set(next.currentToken, forKey: Keys.currentToken)
    return true
  }

  func acknowledge(_ token: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard token.utf8.count >= 16, token.utf8.count <= 4096 else { return false }
    let current = unlockedRegistration()
    let next = current.acknowledging(token)
    defaults.set(next.acknowledgedToken, forKey: Keys.acknowledgedToken)
    return true
  }

  func saveActivation(_ route: MobilePushRoute) {
    lock.lock()
    defer { lock.unlock() }
    defaults.set(route.notificationId, forKey: Keys.pendingNotificationId)
    defaults.set(route.messageId, forKey: Keys.pendingMessageId)
    defaults.set(route.targetId, forKey: Keys.pendingTargetId)
  }

  func takeActivation() -> MobilePushRoute? {
    lock.lock()
    defer { lock.unlock() }
    let route = MobilePushRoute.create(
      notificationId: defaults.string(forKey: Keys.pendingNotificationId),
      messageId: defaults.string(forKey: Keys.pendingMessageId),
      targetId: defaults.string(forKey: Keys.pendingTargetId)
    )
    defaults.removeObject(forKey: Keys.pendingNotificationId)
    defaults.removeObject(forKey: Keys.pendingMessageId)
    defaults.removeObject(forKey: Keys.pendingTargetId)
    return route
  }

  private func unlockedRegistration() -> MobilePushRegistrationState {
    MobilePushRegistrationState(
      currentToken: defaults.string(forKey: Keys.currentToken),
      acknowledgedToken: defaults.string(forKey: Keys.acknowledgedToken)
    )
  }

  private enum Keys {
    static let installationId = "alook.mobilePush.installationId"
    static let currentToken = "alook.mobilePush.currentToken"
    static let acknowledgedToken = "alook.mobilePush.acknowledgedToken"
    static let pendingNotificationId = "alook.mobilePush.pendingNotificationId"
    static let pendingMessageId = "alook.mobilePush.pendingMessageId"
    static let pendingTargetId = "alook.mobilePush.pendingTargetId"
  }
}

private final class MobilePushNotificationHandler: NSObject, UNUserNotificationCenterDelegate {
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .list, .sound])
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    defer { completionHandler() }
    guard let route = MobilePushRoute.from(response.notification.request.content.userInfo) else {
      return
    }
    MobilePushBridge.shared.acceptActivation(route)
  }
}

private final class MobilePushBridge {
  static let shared = MobilePushBridge()

  let store = MobilePushStore()
  let notificationHandler = MobilePushNotificationHandler()
  weak var plugin: MobilePushPlugin?

  func acceptDeviceToken(_ data: Data) {
    let token = data.map { String(format: "%02x", $0) }.joined()
    if store.updateCurrentToken(token) { plugin?.signal() }
  }

  func acceptRegistrationFailure() {
    plugin?.signal()
  }

  func acceptActivation(_ route: MobilePushRoute) {
    store.saveActivation(route)
    plugin?.signal()
  }
}

private enum MobilePushDelegateHooks {
  private static let lock = NSLock()
  private static var installedClasses = Set<String>()

  static func install() {
    dispatchPrecondition(condition: .onQueue(.main))
    guard let delegate = UIApplication.shared.delegate,
          let delegateClass = object_getClass(delegate)
    else { return }
    let className = NSStringFromClass(delegateClass)
    lock.lock()
    defer { lock.unlock() }
    guard installedClasses.insert(className).inserted else { return }
    installDeviceToken(on: delegateClass)
    installFailure(on: delegateClass)
  }

  private static func installDeviceToken(on delegateClass: AnyClass) {
    let selector = #selector(
      UIApplicationDelegate.application(_:didRegisterForRemoteNotificationsWithDeviceToken:)
    )
    typealias Callback = @convention(c) (AnyObject, Selector, UIApplication, Data) -> Void
    let original = class_getInstanceMethod(delegateClass, selector)
      .map { unsafeBitCast(method_getImplementation($0), to: Callback.self) }
    let block: @convention(block) (AnyObject, UIApplication, Data) -> Void = {
      receiver, application, token in
      original?(receiver, selector, application, token)
      MobilePushBridge.shared.acceptDeviceToken(token)
    }
    let implementation = imp_implementationWithBlock(block)
    let encoding = class_getInstanceMethod(delegateClass, selector)
      .flatMap { method_getTypeEncoding($0) }
    addOrReplace(
      selector,
      on: delegateClass,
      implementation: implementation,
      encoding: encoding
    )
  }

  private static func installFailure(on delegateClass: AnyClass) {
    let selector = #selector(
      UIApplicationDelegate.application(_:didFailToRegisterForRemoteNotificationsWithError:)
    )
    typealias Callback = @convention(c) (AnyObject, Selector, UIApplication, Error) -> Void
    let original = class_getInstanceMethod(delegateClass, selector)
      .map { unsafeBitCast(method_getImplementation($0), to: Callback.self) }
    let block: @convention(block) (AnyObject, UIApplication, Error) -> Void = {
      receiver, application, error in
      original?(receiver, selector, application, error)
      MobilePushBridge.shared.acceptRegistrationFailure()
    }
    let implementation = imp_implementationWithBlock(block)
    let encoding = class_getInstanceMethod(delegateClass, selector)
      .flatMap { method_getTypeEncoding($0) }
    addOrReplace(
      selector,
      on: delegateClass,
      implementation: implementation,
      encoding: encoding
    )
  }

  private static func addOrReplace(
    _ selector: Selector,
    on delegateClass: AnyClass,
    implementation: IMP,
    encoding: UnsafePointer<CChar>?
  ) {
    let added: Bool
    if let encoding = encoding {
      added = class_addMethod(delegateClass, selector, implementation, encoding)
    } else {
      added = "v@:@@".withCString {
        class_addMethod(delegateClass, selector, implementation, $0)
      }
    }
    if !added, let method = class_getInstanceMethod(delegateClass, selector) {
      method_setImplementation(method, implementation)
    }
  }
}

private struct PermissionResponse: Encodable {
  let permissionState: String
}

private struct RegistrationSnapshot: Encodable {
  let installationId: String
  let platform: String
  let providerEnvironment: String
  let providerToken: String?
  let previousProviderToken: String?
  let appVersion: String?
}

private struct AcknowledgeRegistrationArgs: Decodable {
  let providerToken: String
}

private struct ListenArgs: Decodable {
  let channel: Channel
}

private struct UnlistenArgs: Decodable {
  let registrationId: UInt64
}

final class MobilePushPlugin: Plugin {
  private let bridge = MobilePushBridge.shared
  private var listener: Channel?
  private var lifecycleObserver: NSObjectProtocol?

  override init() {
    super.init()
    bridge.plugin = self
    UNUserNotificationCenter.current().delegate = bridge.notificationHandler
    DispatchQueue.main.async {
      MobilePushDelegateHooks.install()
      UIApplication.shared.registerForRemoteNotifications()
    }
    lifecycleObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.didBecomeActiveNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      UIApplication.shared.registerForRemoteNotifications()
      self?.signal()
    }
  }

  deinit {
    if let lifecycleObserver = lifecycleObserver {
      NotificationCenter.default.removeObserver(lifecycleObserver)
    }
  }

  @objc override public func checkPermissions(_ invoke: Invoke) {
    UNUserNotificationCenter.current().getNotificationSettings { settings in
      invoke.resolve(PermissionResponse(permissionState: self.permissionState(settings)))
    }
  }

  @objc override public func requestPermissions(_ invoke: Invoke) {
    UNUserNotificationCenter.current().requestAuthorization(
      options: [.alert, .sound, .badge]
    ) { _, error in
      guard error == nil else {
        invoke.reject("Notification permission is unavailable", code: "permission_unavailable")
        return
      }
      DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
      self.checkPermissions(invoke)
    }
  }

  @objc public func snapshot(_ invoke: Invoke) {
    let registration = bridge.store.registration()
    invoke.resolve(RegistrationSnapshot(
      installationId: bridge.store.installationId(),
      platform: "ios",
      providerEnvironment: providerEnvironment(),
      providerToken: registration.currentToken,
      previousProviderToken: registration.previousToken,
      appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    ))
  }

  @objc public func acknowledgeRegistration(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(AcknowledgeRegistrationArgs.self)
      guard bridge.store.acknowledge(args.providerToken) else {
        invoke.reject("Registration token changed", code: "stale_token")
        return
      }
      invoke.resolve()
    } catch {
      invoke.reject("Registration acknowledgement is invalid", code: "invalid_request")
    }
  }

  @objc public func takeActivation(_ invoke: Invoke) {
    guard let activation = bridge.store.takeActivation() else {
      invoke.resolve()
      return
    }
    invoke.resolve(activation)
  }

  @objc public func listen(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(ListenArgs.self)
      listener = args.channel
      invoke.resolve(args.channel.id)
    } catch {
      invoke.reject("Notification listener is invalid", code: "invalid_request")
    }
  }

  @objc public func unlisten(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(UnlistenArgs.self)
      if listener?.id == args.registrationId { listener = nil }
      invoke.resolve()
    } catch {
      invoke.reject("Notification listener is invalid", code: "invalid_request")
    }
  }

  func signal() {
    listener?.send([:])
  }

  private func permissionState(_ settings: UNNotificationSettings) -> String {
    switch settings.authorizationStatus {
    case .authorized, .ephemeral, .provisional:
      return "granted"
    case .denied:
      return "denied"
    case .notDetermined:
      return "prompt"
    @unknown default:
      return "prompt"
    }
  }

  private func providerEnvironment() -> String {
    #if DEBUG
    return "sandbox"
    #else
    return "production"
    #endif
  }
}

@_cdecl("init_plugin_mobile_push")
func initPlugin() -> Plugin {
  MobilePushPlugin()
}
