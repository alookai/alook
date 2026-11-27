import Foundation
import ObjectiveC
import Tauri
import UIKit
import UserNotifications
import WebKit

private let mobilePushSafeId = try! NSRegularExpression(
  pattern: "^[A-Za-z0-9_-]{1,128}$"
)

func mobilePushValidTargetId(_ value: String) -> Bool {
  let range = NSRange(value.startIndex..<value.endIndex, in: value)
  return mobilePushSafeId.firstMatch(in: value, range: range)?.range == range
}

struct MobilePushRoute: Codable, Equatable {
  let notificationId: String
  let messageId: String
  let targetId: String
  let viewerUserId: String?

  init(
    notificationId: String,
    messageId: String,
    targetId: String,
    viewerUserId: String? = nil
  ) {
    self.notificationId = notificationId
    self.messageId = messageId
    self.targetId = targetId
    self.viewerUserId = viewerUserId
  }

  static func create(
    notificationId: String?,
    messageId: String?,
    targetId: String?,
    viewerUserId: String? = nil
  ) -> MobilePushRoute? {
    guard let notificationId = notificationId,
          let messageId = messageId,
          let targetId = targetId,
          let uuid = UUID(uuidString: notificationId),
          uuid.uuidString.lowercased() == notificationId.lowercased(),
          matchesSafeId(messageId),
          matchesSafeId(targetId),
          viewerUserId == nil || matchesSafeId(viewerUserId!)
    else { return nil }
    return MobilePushRoute(
      notificationId: uuid.uuidString.lowercased(),
      messageId: messageId,
      targetId: targetId,
      viewerUserId: viewerUserId
    )
  }

  static func from(_ values: [AnyHashable: Any]) -> MobilePushRoute? {
    let viewerUserId = values["viewerUserId"]
    guard viewerUserId == nil || viewerUserId is String else { return nil }
    return create(
      notificationId: values["notificationId"] as? String,
      messageId: values["messageId"] as? String,
      targetId: values["targetId"] as? String,
      viewerUserId: viewerUserId as? String
    )
  }

  private static func matchesSafeId(_ value: String) -> Bool {
    mobilePushValidTargetId(value)
  }
}

func mobilePushDeliveredNotificationIdentifiers(
  viewerUserId: String,
  targetId: String,
  delivered: [(String, [AnyHashable: Any])]
) -> [String] {
  guard mobilePushValidTargetId(viewerUserId),
        mobilePushValidTargetId(targetId)
  else { return [] }
  return delivered.compactMap { identifier, userInfo in
    guard let route = MobilePushRoute.from(userInfo),
          route.viewerUserId == viewerUserId,
          route.targetId == targetId
    else { return nil }
    return identifier
  }
}

func mobilePushDeliveredNotificationIdentifiersForViewer(
  viewerUserId: String,
  delivered: [(String, [AnyHashable: Any])]
) -> [String] {
  guard mobilePushValidTargetId(viewerUserId) else { return [] }
  return delivered.compactMap { identifier, userInfo in
    guard let route = MobilePushRoute.from(userInfo),
          route.viewerUserId == viewerUserId
    else { return nil }
    return identifier
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
  private var currentToken: String?

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    defaults.removeObject(forKey: Keys.currentToken)
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
    currentToken = next.currentToken
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

  func saveActivation(
    _ route: MobilePushRoute,
    deliveredNotificationIdentifier: String? = nil
  ) {
    lock.lock()
    defer { lock.unlock() }
    var queue = readPendingUnlocked()
    if !queue.contains(where: { $0.notificationId == route.notificationId }) {
      queue.append(route)
      if queue.count > Self.maxPendingActivations {
        queue = Array(queue.suffix(Self.maxPendingActivations))
      }
      writePendingUnlocked(queue)
    }
    if let deliveredNotificationIdentifier = deliveredNotificationIdentifier {
      var map = readDeliveredMapUnlocked()
      map[route.notificationId] = deliveredNotificationIdentifier
      if map.count > Self.maxDeliveredIdentifiers {
        let excess = map.count - Self.maxDeliveredIdentifiers
        for key in map.keys.sorted().prefix(excess) {
          map.removeValue(forKey: key)
        }
      }
      defaults.set(map, forKey: Keys.deliveredNotificationIdentifiers)
    }
  }

  func peekActivation() -> MobilePushRoute? {
    lock.lock()
    defer { lock.unlock() }
    return readPendingUnlocked().first
  }

  @discardableResult
  func ackActivation(_ notificationId: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    let normalized = notificationId.lowercased()
    var queue = readPendingUnlocked()
    let before = queue.count
    queue.removeAll { $0.notificationId == normalized }
    guard queue.count != before else { return false }
    writePendingUnlocked(queue)
    return true
  }

  func clearViewerPending(_ viewerUserId: String) {
    lock.lock()
    defer { lock.unlock() }
    var queue = readPendingUnlocked()
    let before = queue.count
    queue.removeAll { $0.viewerUserId == viewerUserId }
    if queue.count != before {
      writePendingUnlocked(queue)
    }
  }

  func deliveredNotificationIdentifier(for notificationId: String) -> String? {
    lock.lock()
    defer { lock.unlock() }
    let normalized = notificationId.lowercased()
    if let mapped = readDeliveredMapUnlocked()[normalized] {
      return mapped
    }
    guard defaults.string(forKey: Keys.dismissNotificationId) == normalized else {
      return nil
    }
    return defaults.string(forKey: Keys.deliveredNotificationIdentifier)
  }

  func completeDeliveredNotificationIdentifier(for notificationId: String) {
    lock.lock()
    defer { lock.unlock() }
    let normalized = notificationId.lowercased()
    var map = readDeliveredMapUnlocked()
    if map.removeValue(forKey: normalized) != nil {
      if map.isEmpty {
        defaults.removeObject(forKey: Keys.deliveredNotificationIdentifiers)
      } else {
        defaults.set(map, forKey: Keys.deliveredNotificationIdentifiers)
      }
    }
    if defaults.string(forKey: Keys.dismissNotificationId) == normalized {
      defaults.removeObject(forKey: Keys.dismissNotificationId)
      defaults.removeObject(forKey: Keys.deliveredNotificationIdentifier)
    }
  }

  private func readPendingUnlocked() -> [MobilePushRoute] {
    var queue: [MobilePushRoute] = []
    if let data = defaults.data(forKey: Keys.pendingActivations),
       let decoded = try? JSONDecoder().decode([MobilePushRoute].self, from: data)
    {
      queue = decoded.compactMap { route in
        MobilePushRoute.create(
          notificationId: route.notificationId,
          messageId: route.messageId,
          targetId: route.targetId,
          viewerUserId: route.viewerUserId
        )
      }
    }
    if let legacy = MobilePushRoute.create(
      notificationId: defaults.string(forKey: Keys.pendingNotificationId),
      messageId: defaults.string(forKey: Keys.pendingMessageId),
      targetId: defaults.string(forKey: Keys.pendingTargetId),
      viewerUserId: defaults.string(forKey: Keys.pendingViewerUserId)
    ) {
      if !queue.contains(where: { $0.notificationId == legacy.notificationId }) {
        queue.append(legacy)
      }
      writePendingUnlocked(Array(queue.suffix(Self.maxPendingActivations)))
    }
    return Array(queue.suffix(Self.maxPendingActivations))
  }

  private func writePendingUnlocked(_ routes: [MobilePushRoute]) {
    defaults.removeObject(forKey: Keys.pendingNotificationId)
    defaults.removeObject(forKey: Keys.pendingMessageId)
    defaults.removeObject(forKey: Keys.pendingTargetId)
    defaults.removeObject(forKey: Keys.pendingViewerUserId)
    if routes.isEmpty {
      defaults.removeObject(forKey: Keys.pendingActivations)
    } else if let encoded = try? JSONEncoder().encode(routes) {
      defaults.set(encoded, forKey: Keys.pendingActivations)
    }
  }

  private func readDeliveredMapUnlocked() -> [String: String] {
    defaults.dictionary(forKey: Keys.deliveredNotificationIdentifiers) as? [String: String] ?? [:]
  }

  private func unlockedRegistration() -> MobilePushRegistrationState {
    MobilePushRegistrationState(
      currentToken: currentToken,
      acknowledgedToken: defaults.string(forKey: Keys.acknowledgedToken)
    )
  }

  private static let maxPendingActivations = 32
  private static let maxDeliveredIdentifiers = 256

  private enum Keys {
    static let installationId = "alook.mobilePush.installationId"
    static let currentToken = "alook.mobilePush.currentToken"
    static let acknowledgedToken = "alook.mobilePush.acknowledgedToken"
    static let pendingActivations = "alook.mobilePush.pendingActivations"
    static let pendingNotificationId = "alook.mobilePush.pendingNotificationId"
    static let pendingMessageId = "alook.mobilePush.pendingMessageId"
    static let pendingTargetId = "alook.mobilePush.pendingTargetId"
    static let pendingViewerUserId = "alook.mobilePush.pendingViewerUserId"
    static let dismissNotificationId = "alook.mobilePush.dismissNotificationId"
    static let deliveredNotificationIdentifier = "alook.mobilePush.deliveredNotificationIdentifier"
    static let deliveredNotificationIdentifiers = "alook.mobilePush.deliveredNotificationIdentifiers"
  }
}

func mobilePushPresentationScript(_ route: MobilePushRoute) -> String? {
  guard let viewer = route.viewerUserId,
        let data = try? JSONSerialization.data(withJSONObject: ["viewerUserId": viewer, "targetId": route.targetId]),
        let identity = String(data: data, encoding: .utf8)
  else { return nil }
  return "(()=>{try{return window.alookNativeNotificationPresentationV1?.(\(identity))===true?'suppress':'present'}catch{return 'present'}})()"
}

final class MobilePushPresentationCompletion: @unchecked Sendable {
  private let lock = NSLock()
  private var completion: (@Sendable (UNNotificationPresentationOptions) -> Void)?
  private var deadline: DispatchWorkItem?

  init(_ completion: @escaping @Sendable (UNNotificationPresentationOptions) -> Void) {
    self.completion = completion
    let deadline = DispatchWorkItem { [weak self] in self?.finish(suppress: false) }
    self.deadline = deadline
    DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + .milliseconds(500), execute: deadline)
  }

  @discardableResult
  func finish(suppress: Bool) -> Bool {
    lock.lock()
    let callback = completion
    completion = nil
    let timeout = deadline
    deadline = nil
    lock.unlock()
    guard let callback else { return false }
    timeout?.cancel()
    callback(suppress ? [] : [.banner, .list, .sound])
    return true
  }

  deinit { finish(suppress: false) }
}

private final class MobilePushNotificationHandler: NSObject, UNUserNotificationCenterDelegate {
  var previousDelegate: UNUserNotificationCenterDelegate?

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping @Sendable (UNNotificationPresentationOptions) -> Void
  ) {
    guard let route = MobilePushRoute.from(notification.request.content.userInfo) else {
      if let previous = previousDelegate,
         previous.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:willPresent:withCompletionHandler:)))
      {
        previous.userNotificationCenter?(center, willPresent: notification, withCompletionHandler: completionHandler)
      } else {
        completionHandler([.banner, .list, .sound])
      }
      return
    }
    guard let script = mobilePushPresentationScript(route) else {
      completionHandler([.banner, .list, .sound])
      return
    }
    let decision = MobilePushPresentationCompletion(completionHandler)
    DispatchQueue.main.async {
      guard let webview = MobilePushBridge.shared.plugin?.presentationWebview else {
        decision.finish(suppress: false)
        return
      }
      webview.evaluateJavaScript(script) { result, error in
        decision.finish(suppress: error == nil && (result as? String) == "suppress")
      }
    }
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    guard let route = MobilePushRoute.from(response.notification.request.content.userInfo) else {
      if let previous = previousDelegate,
         previous.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:didReceive:withCompletionHandler:)))
      {
        previous.userNotificationCenter?(center, didReceive: response, withCompletionHandler: completionHandler)
      } else {
        completionHandler()
      }
      return
    }
    defer { completionHandler() }
    MobilePushBridge.shared.acceptActivation(
      route,
      deliveredNotificationIdentifier: response.notification.request.identifier
    )
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

  func acceptActivation(
    _ route: MobilePushRoute,
    deliveredNotificationIdentifier: String
  ) {
    store.saveActivation(
      route,
      deliveredNotificationIdentifier: deliveredNotificationIdentifier
    )
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
    if UIApplication.shared.delegate === delegate {
      UIApplication.shared.delegate = nil
      UIApplication.shared.delegate = delegate
    }
  }

  private static func installDeviceToken(on delegateClass: AnyClass) {
    let selector = #selector(
      UIApplicationDelegate.application(_:didRegisterForRemoteNotificationsWithDeviceToken:)
    )
    typealias Callback = @convention(c) (AnyObject, Selector, UIApplication, NSData) -> Void
    let original = class_getInstanceMethod(delegateClass, selector)
      .map { unsafeBitCast(method_getImplementation($0), to: Callback.self) }
    let block: @convention(block) (AnyObject, UIApplication, NSData) -> Void = {
      receiver, application, token in
      original?(receiver, selector, application, token)
      MobilePushBridge.shared.acceptDeviceToken(token as Data)
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
    typealias Callback = @convention(c) (AnyObject, Selector, UIApplication, NSError) -> Void
    let original = class_getInstanceMethod(delegateClass, selector)
      .map { unsafeBitCast(method_getImplementation($0), to: Callback.self) }
    let block: @convention(block) (AnyObject, UIApplication, NSError) -> Void = {
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

private struct AckActivationArgs: Decodable {
  let notificationId: String
}

private struct DismissNotificationArgs: Decodable {
  let notificationId: String
}

private struct DismissConversationArgs: Decodable {
  let viewerUserId: String
  let targetId: String
}

private struct ClearViewerArgs: Decodable {
  let viewerUserId: String
}

private struct ListenArgs: Decodable {
  let channel: Channel
}

private struct UnlistenArgs: Decodable {
  let registrationId: UInt64
}

final class MobilePushPlugin: Plugin {
  private let bridge = MobilePushBridge.shared
  private let listenerLock = NSLock()
  private var listener: Channel?
  private var lifecycleObserver: NSObjectProtocol?
  weak var presentationWebview: WKWebView?

  override public func load(webview: WKWebView) {
    super.load(webview: webview)
    presentationWebview = webview
  }

  override init() {
    super.init()
    bridge.plugin = self
    let center = UNUserNotificationCenter.current()
    if let existing = center.delegate, existing !== bridge.notificationHandler {
      bridge.notificationHandler.previousDelegate = existing
    }
    center.delegate = bridge.notificationHandler
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
      options: [.alert, .sound]
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
    if registration.currentToken == nil {
      DispatchQueue.main.async {
        MobilePushDelegateHooks.install()
        UIApplication.shared.registerForRemoteNotifications()
      }
    }
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

  @objc public func peekActivation(_ invoke: Invoke) {
    guard let activation = bridge.store.peekActivation() else {
      invoke.resolve()
      return
    }
    invoke.resolve(activation)
  }

  @objc public func ackActivation(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(AckActivationArgs.self)
      guard MobilePushRoute.create(
        notificationId: args.notificationId,
        messageId: "message",
        targetId: "target"
      ) != nil else {
        invoke.reject("Notification acknowledgement is invalid", code: "invalid_request")
        return
      }
      bridge.store.ackActivation(args.notificationId)
      invoke.resolve()
    } catch {
      invoke.reject("Notification acknowledgement is invalid", code: "invalid_request")
    }
  }

  @objc public func dismissNotification(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(DismissNotificationArgs.self)
      let identifier = bridge.store.deliveredNotificationIdentifier(
        for: args.notificationId
      ) ?? args.notificationId
      UNUserNotificationCenter.current().removeDeliveredNotifications(
        withIdentifiers: [identifier]
      )
      UNUserNotificationCenter.current().getDeliveredNotifications { delivered in
        if delivered.contains(where: { $0.request.identifier == identifier }) {
          invoke.reject("Notification remains delivered", code: "notification_unavailable")
        } else {
          self.bridge.store.completeDeliveredNotificationIdentifier(
            for: args.notificationId
          )
          invoke.resolve()
        }
      }
    } catch {
      invoke.reject("Notification dismissal is invalid", code: "invalid_request")
    }
  }

  @objc public func dismissConversation(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(DismissConversationArgs.self)
      guard mobilePushValidTargetId(args.viewerUserId),
            mobilePushValidTargetId(args.targetId)
      else {
        invoke.reject("Conversation dismissal is invalid", code: "invalid_request")
        return
      }
      let center = UNUserNotificationCenter.current()
      center.getDeliveredNotifications { delivered in
        let identifiers = mobilePushDeliveredNotificationIdentifiers(
          viewerUserId: args.viewerUserId,
          targetId: args.targetId,
          delivered: delivered.map {
            ($0.request.identifier, $0.request.content.userInfo)
          }
        )
        center.removeDeliveredNotifications(withIdentifiers: identifiers)
        center.getDeliveredNotifications { remaining in
          let stillDelivered = mobilePushDeliveredNotificationIdentifiers(
            viewerUserId: args.viewerUserId,
            targetId: args.targetId,
            delivered: remaining.map {
              ($0.request.identifier, $0.request.content.userInfo)
            }
          )
          if stillDelivered.isEmpty {
            invoke.resolve()
          } else {
            invoke.reject(
              "Conversation notifications remain delivered",
              code: "notification_unavailable"
            )
          }
        }
      }
    } catch {
      invoke.reject("Conversation dismissal is invalid", code: "invalid_request")
    }
  }

  @objc public func clearViewer(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(ClearViewerArgs.self)
      guard mobilePushValidTargetId(args.viewerUserId) else {
        invoke.reject("Viewer notification clear is invalid", code: "invalid_request")
        return
      }
      bridge.store.clearViewerPending(args.viewerUserId)
      let center = UNUserNotificationCenter.current()
      center.getDeliveredNotifications { delivered in
        let identifiers = mobilePushDeliveredNotificationIdentifiersForViewer(
          viewerUserId: args.viewerUserId,
          delivered: delivered.map {
            ($0.request.identifier, $0.request.content.userInfo)
          }
        )
        if !identifiers.isEmpty {
          center.removeDeliveredNotifications(withIdentifiers: identifiers)
        }
        invoke.resolve()
      }
    } catch {
      invoke.reject("Viewer notification clear is invalid", code: "invalid_request")
    }
  }

  @objc public func listen(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(ListenArgs.self)
      listenerLock.lock()
      listener = args.channel
      listenerLock.unlock()
      invoke.resolve(args.channel.id)
    } catch {
      invoke.reject("Notification listener is invalid", code: "invalid_request")
    }
  }

  @objc public func unlisten(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(UnlistenArgs.self)
      listenerLock.lock()
      if listener?.id == args.registrationId { listener = nil }
      listenerLock.unlock()
      invoke.resolve()
    } catch {
      invoke.reject("Notification listener is invalid", code: "invalid_request")
    }
  }

  @objc public func retireListener(_ invoke: Invoke) {
    listenerLock.lock()
    listener = nil
    listenerLock.unlock()
    invoke.resolve()
  }

  func signal() {
    listenerLock.lock()
    let current = listener
    listenerLock.unlock()
    current?.send([:])
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
