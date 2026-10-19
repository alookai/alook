import Foundation
import CoreBluetooth
import ESPProvision
import Tauri
import WebKit

struct ConnectArgs: Decodable { let attemptId: String; let name: String; let pop: String; let serviceUuid: String }
struct AttemptArgs: Decodable { let attemptId: String }
struct ProvisionArgs: Decodable { let attemptId: String; let ssid: String; let password: String }
struct ExchangeArgs: Decodable { let attemptId: String; let action: String; let userCode: String? }
struct TouchNetwork: Encodable { let ssid: String; let rssi: Int32; let secured: Bool }
struct NetworksResponse: Encodable { let networks: [TouchNetwork] }
struct ExchangeResponse: Encodable { let response: String }

final class TouchAttempt: NSObject, ESPDeviceConnectionDelegate, ESPBLEDelegate {
  let args: ConnectArgs
  let connectInvoke: Invoke
  weak var owner: TouchSetupPlugin?
  var device: ESPDevice?
  var pending: Invoke?
  var timeout: DispatchWorkItem?
  var scanning = true
  var ready = false
  var suppliedProof = false
  init(_ args: ConnectArgs, _ invoke: Invoke, _ owner: TouchSetupPlugin) { self.args = args; self.connectInvoke = invoke; self.pending = invoke; self.owner = owner }
  func secureVersion(_ device: ESPDevice) -> Bool {
    guard let info = device.versionInfo?["prov"] as? NSDictionary, let version = info["sec_ver"] as? Int else { return false }
    return version == 1 && device.security == .secure && !(device.capabilities ?? []).contains("no_pop")
  }
  func getProofOfPossesion(forDevice: ESPDevice, completionHandler: @escaping (String) -> Void) {
    guard owner?.current === self, device === forDevice, secureVersion(forDevice) else { owner?.finish(self, connectInvoke, error: true); return }
    suppliedProof = true
    completionHandler(args.pop)
  }
  func getUsername(forDevice: ESPDevice, completionHandler: @escaping (String?) -> Void) { completionHandler(nil) }
  func peripheralConnected() {}
  func peripheralDisconnected(peripheral: CBPeripheral, error: Error?) { owner?.disconnected(self) }
  func peripheralFailedToConnect(peripheral: CBPeripheral?, error: Error?) { owner?.disconnected(self) }
}

final class TouchSetupPlugin: Plugin {
  fileprivate var current: TouchAttempt?
  private var closing: TouchAttempt?
  private var retired = [String]()
  private func remember(_ id: String) { if !retired.contains(id) { retired.append(id) }; if retired.count > 256 { retired.removeFirst() } }
  private let service = "b4df5a1c-3f6b-f4bf-ea4a-820304901a02"
  override func load(webview: WKWebView) { ESPProvisionManager.shared.enableLogs(false) }
  private func fail(_ invoke: Invoke) { invoke.reject("Touch setup failed", code: "setup_failed") }
  fileprivate func finish(_ attempt: TouchAttempt, _ invoke: Invoke, error: Bool = false, resolve: (() -> Void)? = nil) {
    guard current === attempt, attempt.pending === invoke else { return }
    attempt.timeout?.cancel(); attempt.timeout = nil; attempt.pending = nil
    if error { fail(invoke); close(attempt) }
    else { if let resolve = resolve { resolve() } else { invoke.resolve() } }
  }
  private func arm(_ attempt: TouchAttempt, _ invoke: Invoke, seconds: Double) {
    attempt.timeout?.cancel()
    let timeout = DispatchWorkItem { [weak self, weak attempt] in
      guard let attempt = attempt else { return }
      self?.finish(attempt, invoke, error: true)
    }
    attempt.timeout = timeout; DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: timeout)
  }
  private func close(_ attempt: TouchAttempt) {
    guard current === attempt else { return }
    remember(attempt.args.attemptId)
    current = nil
    attempt.timeout?.cancel(); attempt.timeout = nil
    if let pending = attempt.pending { fail(pending); attempt.pending = nil }
    if attempt.scanning { attempt.scanning = false; ESPProvisionManager.shared.stopESPDevicesSearch() }
    if let device = attempt.device { closing = attempt; device.disconnect() }
  }
  fileprivate func disconnected(_ attempt: TouchAttempt) {
    if current === attempt { close(attempt) }
    if closing === attempt {
      closing = nil; attempt.device?.delegate = nil; attempt.device?.bleDelegate = nil; attempt.device = nil
    }
  }
  private func use(_ invoke: Invoke, _ id: String, run: (TouchAttempt) throws -> Void) {
    guard let attempt = current, attempt.args.attemptId == id, attempt.ready, attempt.pending == nil else { fail(invoke); return }
    attempt.pending = invoke; arm(attempt, invoke, seconds: 65)
    do { try run(attempt) } catch { finish(attempt, invoke, error: true) }
  }
  @objc public func connect(_ invoke: Invoke) {
    DispatchQueue.main.async {
      do {
        let args = try invoke.parseArgs(ConnectArgs.self)
        guard args.attemptId.range(of: "^[0-9a-f-]{36}$", options: .regularExpression) != nil,
          args.name.range(of: "^ALOOK_TOUCH_[A-F0-9]{6}$", options: .regularExpression) != nil,
          args.pop.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil, args.serviceUuid == self.service else { self.fail(invoke); return }
        guard !self.retired.contains(args.attemptId) else { self.fail(invoke); return }
        if let old = self.current { self.close(old) }
        guard self.closing == nil else { self.fail(invoke); return }
        ESPProvisionManager.shared.enableLogs(false)
        let attempt = TouchAttempt(args, invoke, self); self.current = attempt; self.arm(attempt, invoke, seconds: 30)
        ESPProvisionManager.shared.createESPDevice(deviceName: args.name, transport: .ble, security: .secure, proofOfPossession: nil) { [weak self, weak attempt] device, _ in
          DispatchQueue.main.async {
            guard let self = self, let attempt = attempt, self.current === attempt, attempt.scanning else { return }
            guard let device = device else { return }
            let services = device.advertisementData?[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] ?? []
            guard device.name == args.name, services.contains(CBUUID(string: self.service)) else { return }
            attempt.scanning = false
            ESPProvisionManager.shared.stopESPDevicesSearch()
            attempt.device = device; device.bleDelegate = attempt
            device.connect(delegate: attempt) { status in
              DispatchQueue.main.async {
                guard self.current === attempt, attempt.pending === invoke else { return }
                switch status {
                case .connected:
                  guard attempt.suppliedProof, attempt.secureVersion(device), device.isSessionEstablished() else { self.finish(attempt, invoke, error: true); return }
                  attempt.ready = true; self.finish(attempt, invoke)
                case .failedToConnect, .disconnected: self.finish(attempt, invoke, error: true)
                }
              }
            }
          }
        }
      } catch { self.fail(invoke) }
    }
  }
  @objc public func scanNetworks(_ invoke: Invoke) {
    DispatchQueue.main.async {
      do { let args = try invoke.parseArgs(AttemptArgs.self); self.use(invoke, args.attemptId) { attempt in
        attempt.device!.scanWifiList { rows, error in
          DispatchQueue.main.async {
            guard error == nil else { self.finish(attempt, invoke, error: true); return }
            var seen = Set<String>()
            let networks = (rows ?? []).sorted { $0.rssi > $1.rssi }.filter { !$0.ssid.isEmpty && $0.ssid.utf8.count <= 32 && !$0.ssid.contains("\0") && seen.insert($0.ssid).inserted }.prefix(100).map { TouchNetwork(ssid: $0.ssid, rssi: $0.rssi, secured: $0.auth != .open) }
            self.finish(attempt, invoke, resolve: { invoke.resolve(NetworksResponse(networks: networks)) })
          }
        }
      } } catch { self.fail(invoke) }
    }
  }
  @objc public func provision(_ invoke: Invoke) {
    DispatchQueue.main.async {
      do { let args = try invoke.parseArgs(ProvisionArgs.self); self.use(invoke, args.attemptId) { attempt in
        guard (1...32).contains(args.ssid.utf8.count), !args.ssid.contains("\0"), !args.password.contains("\0"), args.password.isEmpty || (8...63).contains(args.password.utf8.count) else { self.finish(attempt, invoke, error: true); return }
        attempt.device!.provision(ssid: args.ssid, passPhrase: args.password) { status in
          DispatchQueue.main.async {
            switch status {
            case .success: self.finish(attempt, invoke)
            case .failure: self.finish(attempt, invoke, error: true)
            case .configApplied: break
            }
          }
        }
      } } catch { self.fail(invoke) }
    }
  }
  @objc public func exchange(_ invoke: Invoke) {
    DispatchQueue.main.async {
      do { let args = try invoke.parseArgs(ExchangeArgs.self); self.use(invoke, args.attemptId) { attempt in
        var request = ["action": args.action]
        if args.action == "ack" {
          guard let code = args.userCode, code.range(of: "\\A[A-Z0-9]{4}-?[A-Z0-9]{4}\\z", options: .regularExpression) != nil else { self.finish(attempt, invoke, error: true); return }
          request["user_code"] = code
        } else if args.action != "code" { self.finish(attempt, invoke, error: true); return }
        let data = try JSONSerialization.data(withJSONObject: request)
        attempt.device!.sendData(path: "alook-auth", data: data) { response, error in
          DispatchQueue.main.async {
            guard error == nil, let response = response, response.count <= 256, let text = String(data: response, encoding: .utf8) else { self.finish(attempt, invoke, error: true); return }
            self.finish(attempt, invoke, resolve: { invoke.resolve(ExchangeResponse(response: text)) })
          }
        }
      } } catch { self.fail(invoke) }
    }
  }
  @objc public func cancel(_ invoke: Invoke) {
    DispatchQueue.main.async {
      do { let args = try invoke.parseArgs(AttemptArgs.self); self.remember(args.attemptId); if let attempt = self.current, attempt.args.attemptId == args.attemptId { self.close(attempt) }; invoke.resolve() }
      catch { self.fail(invoke) }
    }
  }
}
@_cdecl("init_plugin_touch_setup")
func initPlugin() -> Plugin { TouchSetupPlugin() }
