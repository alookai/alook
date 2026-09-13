import Foundation
import Tauri
import UIKit
import WebKit

struct ExportArgs: Decodable {
  let attemptId: String
  let path: String
  let name: String
  let mime: String
  let bytes: UInt64
  let sha256: String
}
struct CancelArgs: Decodable { let attemptId: String }
struct ExportResult: Encodable { let attemptId: String; let status: String; let destination: String }

final class ExportSession: NSObject, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
  let args: ExportArgs
  let invoke: Invoke
  let directory: URL
  var picker: UIDocumentPickerViewController?
  private let lock = NSLock()
  private var stopped = false
  var cancelled: Bool {
    get { lock.lock(); defer { lock.unlock() }; return stopped }
    set { lock.lock(); stopped = newValue; lock.unlock() }
  }
  var finished = false
  var release: (() -> Void)?
  init(_ args: ExportArgs, _ invoke: Invoke, _ directory: URL) {
    self.args = args; self.invoke = invoke; self.directory = directory
  }
  func finish(_ status: String) {
    guard !finished else { return }
    finished = true
    picker?.delegate = nil
    if status == "error" { invoke.reject("File export failed", code: "write_failed") }
    else { invoke.resolve(ExportResult(attemptId: args.attemptId, status: status, destination: status == "saved" ? "files" : "")) }
    try? FileManager.default.removeItem(at: directory)
    release?()
  }
  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    finish(urls.isEmpty ? "error" : "saved")
  }
  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { finish("cancelled") }
  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { finish("cancelled") }
  func cancel() {
    cancelled = true
    if let picker = picker { picker.dismiss(animated: true) { self.finish("cancelled") } }
  }
}

final class FileSavePlugin: Plugin {
  private var session: ExportSession?
  private let queue = DispatchQueue(label: "ai.alook.file-save")
  private var cancelledAttempts = Set<String>()
  override func load(webview: WKWebView) {
    guard session == nil else { return }
    queue.async {
      try? FileManager.default.removeItem(at: FileManager.default.temporaryDirectory.appendingPathComponent("alook-files", isDirectory: true))
    }
  }
  @objc public func cancel(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(CancelArgs.self)
    DispatchQueue.main.async {
      if self.session?.args.attemptId == args.attemptId { self.session?.cancel() }
      else { if self.cancelledAttempts.count > 128 { self.cancelledAttempts.removeAll() }; self.cancelledAttempts.insert(args.attemptId) }
      invoke.resolve()
    }
  }
  @objc public func exportFile(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ExportArgs.self)
    DispatchQueue.main.async {
      guard self.session == nil else { invoke.reject("Another file is being saved", code: "busy"); return }
      if self.cancelledAttempts.remove(args.attemptId) != nil {
        invoke.resolve(ExportResult(attemptId: args.attemptId, status: "cancelled", destination: "")); return
      }
      self.cancelledAttempts.removeAll()
      let root = FileManager.default.temporaryDirectory.appendingPathComponent("alook-files", isDirectory: true)
      let directory = root.appendingPathComponent(args.attemptId, isDirectory: true)
      let session = ExportSession(args, invoke, directory)
      session.release = { [weak self] in self?.session = nil }
      self.session = session
      self.queue.async {
        do {
          guard UUID(uuidString: args.attemptId) != nil, args.name == URL(fileURLWithPath: args.name).lastPathComponent,
                !args.name.isEmpty, args.name != ".", args.name != ".." else { throw CocoaError(.fileReadInvalidFileName) }
          let source = URL(fileURLWithPath: args.path).resolvingSymlinksInPath()
          let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].resolvingSymlinksInPath().path + "/"
          guard source.path.hasPrefix(caches), source.deletingLastPathComponent().lastPathComponent == "user-file-save",
                source.lastPathComponent == args.attemptId + ".partial" else { throw CocoaError(.fileReadNoPermission) }
          try? FileManager.default.removeItem(at: root)
          try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
          let destination = directory.appendingPathComponent(args.name)
          try FileSaveCopy.write(source: source, destination: destination, bytes: args.bytes, sha256: args.sha256) { session.cancelled }
          DispatchQueue.main.async {
            if session.cancelled { session.finish("cancelled"); return }
            guard let presenter = self.manager.viewController, presenter.presentedViewController == nil,
                  presenter.view.window != nil else { session.finish("error"); return }
            let picker = UIDocumentPickerViewController(forExporting: [destination], asCopy: true)
            session.picker = picker; picker.delegate = session
            presenter.present(picker, animated: true)
            picker.presentationController?.delegate = session
          }
        } catch { DispatchQueue.main.async { session.finish(session.cancelled ? "cancelled" : "error") } }
      }
    }
  }
}
@_cdecl("init_plugin_file_save")
func initPlugin() -> Plugin { FileSavePlugin() }
