import CoreMotion
import Foundation
import Tauri
import UIKit
import WebKit

func mobileSystemOrientationAngle(_ orientation: UIDeviceOrientation) -> Int? {
  switch orientation {
  case .portrait: return 0
  case .portraitUpsideDown: return 180
  case .landscapeLeft: return 270
  case .landscapeRight: return 90
  default: return nil
  }
}

func mobileInterfaceOrientationAngle(_ orientation: UIInterfaceOrientation?) -> Int? {
  switch orientation {
  case .portrait: return 0
  case .landscapeLeft: return 90
  case .landscapeRight: return 270
  case .portraitUpsideDown: return 180
  default: return nil
  }
}

func mobileMotionAccessDenied(_ error: Error?) -> Bool {
  guard let error = error else { return false }
  let native = error as NSError
  return native.domain == CMErrorDomain && [CMErrorNotAuthorized, CMErrorMotionActivityNotAuthorized]
    .contains { Int($0.rawValue) == native.code }
}

private struct OrientationListenArgs: Decodable {
  let registrationId: UInt64
  let channel: Channel
}
private struct OrientationStopArgs: Decodable {
  let registrationId: UInt64
}

final class MobileOrientationPlugin: Plugin {
  private let motion = CMMotionManager()
  private var listener: Channel?
  private var highestId: UInt64 = 0
  private var currentId: UInt64?
  private var physicalAngle: Int?
  private var lastSnapshot: String?
  private var observers: [NSObjectProtocol] = []
  private var directionObserver: NSObjectProtocol?
  private var notificationsStarted = false
  private var motionFailed = false
  private var accessDenied = false
  private var samplingVersion: UInt64 = 0
  private weak var presentationWebview: WKWebView?

  override public func load(webview: WKWebView) {
    super.load(webview: webview)
    presentationWebview = webview
  }
  override init() {
    super.init()
    observers.append(NotificationCenter.default.addObserver(
      forName: UIApplication.willResignActiveNotification, object: nil, queue: .main
    ) { [weak self] _ in self?.pauseSampling() })
    observers.append(NotificationCenter.default.addObserver(
      forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
    ) { [weak self] _ in self?.start() })
  }
  deinit {
    motion.stopDeviceMotionUpdates()
    if let observer = directionObserver { NotificationCenter.default.removeObserver(observer) }
    if notificationsStarted { DispatchQueue.main.async { UIDevice.current.endGeneratingDeviceOrientationNotifications() } }
    observers.forEach { NotificationCenter.default.removeObserver($0) }
  }
  @objc public func listen(_ invoke: Invoke) {
    guard let args = try? invoke.parseArgs(OrientationListenArgs.self) else {
      invoke.reject("Orientation listener is invalid", code: "invalid_request"); return
    }
    DispatchQueue.main.async { [weak self] in
      guard let self = self else { invoke.reject("Orientation is unavailable"); return }
      guard args.registrationId > self.highestId else { invoke.resolve(); return }
      self.stop()
      self.highestId = args.registrationId
      self.currentId = args.registrationId
      self.listener = args.channel
      self.publish()
      self.start()
      invoke.resolve()
    }
  }
  @objc public func unlisten(_ invoke: Invoke) {
    guard let args = try? invoke.parseArgs(OrientationStopArgs.self) else {
      invoke.reject("Orientation listener is invalid", code: "invalid_request"); return
    }
    DispatchQueue.main.async { [weak self] in
      if self?.currentId == args.registrationId { self?.stop() }
      invoke.resolve()
    }
  }
  @objc public func retire(_ invoke: Invoke) {
    guard let args = try? invoke.parseArgs(OrientationStopArgs.self) else {
      invoke.reject("Orientation listener is invalid", code: "invalid_request"); return
    }
    DispatchQueue.main.async { [weak self] in
      if let self = self, args.registrationId >= self.highestId {
        self.highestId = args.registrationId
        self.stop()
      }
      invoke.resolve()
    }
  }
  private func start() {
    guard let id = currentId, listener != nil, UIApplication.shared.applicationState == .active else { return }
    if accessDenied { publish(available: false); return }
    if !motion.isDeviceMotionAvailable || motionFailed {
      startNotifications(id)
      return
    }
    guard !motion.isDeviceMotionActive else { return }
    samplingVersion &+= 1
    let generation = samplingVersion
    motion.deviceMotionUpdateInterval = 0.15
    motion.startDeviceMotionUpdates(to: .main) { [weak self] sample, error in
      guard let self = self, self.currentId == id, self.samplingVersion == generation,
            UIApplication.shared.applicationState == .active else { return }
      guard self.presentationWebview != nil else { self.stop(); return }
      if mobileMotionAccessDenied(error) {
        self.pauseSampling()
        self.accessDenied = true
        self.publish(available: false)
        return
      }
      guard let gravity = sample?.gravity else {
        self.pauseSampling()
        self.motionFailed = true
        self.start()
        return
      }
      self.physicalAngle = mobileOrientationAngle(gravity.x, gravity.y, previous: self.physicalAngle)
      self.publish(available: true)
    }
  }
  private func startNotifications(_ id: UInt64) {
    guard !accessDenied, !notificationsStarted else { return }
    samplingVersion &+= 1
    let generation = samplingVersion
    directionObserver = NotificationCenter.default.addObserver(
      forName: UIDevice.orientationDidChangeNotification, object: UIDevice.current, queue: .main
    ) { [weak self] _ in
      guard let self = self, self.currentId == id, self.samplingVersion == generation,
            UIApplication.shared.applicationState == .active else { return }
      guard self.presentationWebview != nil else { self.stop(); return }
      self.readSystemDirection()
    }
    UIDevice.current.beginGeneratingDeviceOrientationNotifications()
    notificationsStarted = true
    readSystemDirection()
  }
  private func readSystemDirection() {
    if let angle = mobileSystemOrientationAngle(UIDevice.current.orientation) { physicalAngle = angle }
    publish(available: UIDevice.current.isGeneratingDeviceOrientationNotifications)
  }
  private func pauseSampling() {
    samplingVersion &+= 1
    motion.stopDeviceMotionUpdates()
    if let observer = directionObserver { NotificationCenter.default.removeObserver(observer) }
    directionObserver = nil
    if notificationsStarted { UIDevice.current.endGeneratingDeviceOrientationNotifications() }
    notificationsStarted = false
  }
  private func stop() {
    pauseSampling()
    listener = nil
    currentId = nil
    physicalAngle = nil
    lastSnapshot = nil
    motionFailed = false
    accessDenied = false
  }
  private func publish(available: Bool? = nil) {
    guard let listener = listener else { return }
    guard let interfaceAngle = mobileInterfaceOrientationAngle(presentationWebview?.window?.windowScene?.interfaceOrientation) else { return }
    let supported = available ?? (notificationsStarted || (motion.isDeviceMotionAvailable && !motionFailed))
    let availability = accessDenied ? "denied" : supported ? "available" : "unavailable"
    let key = "\(availability):\(physicalAngle ?? -1):\(interfaceAngle)"
    guard key != lastSnapshot else { return }
    lastSnapshot = key
    listener.send([
      "availability": availability,
      "physicalAngle": physicalAngle.map { $0 as Any } ?? NSNull(),
      "interfaceAngle": interfaceAngle,
    ])
  }
}

@_cdecl("init_plugin_mobile_orientation")
func initPlugin() -> Plugin { MobileOrientationPlugin() }
