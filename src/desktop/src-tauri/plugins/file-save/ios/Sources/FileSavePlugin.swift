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

private enum FileSaveShareCache {
  static let directoryName = "alook-files"
  static let ttlSeconds: TimeInterval = 60 * 60
  static let maxTotalBytes: UInt64 = 256 * 1024 * 1024

  static func rootURL() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent(directoryName, isDirectory: true)
  }

  static func sweep(
    root: URL = rootURL(),
    now: Date = Date(),
    ttl: TimeInterval = ttlSeconds,
    maxBytes: UInt64 = maxTotalBytes,
    keepName: String? = nil
  ) {
    let fm = FileManager.default
    guard let entries = try? fm.contentsOfDirectory(
      at: root,
      includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey, .isDirectoryKey],
      options: []
    ) else { return }

    let cutoff = now.addingTimeInterval(-ttl)
    var retained: [(url: URL, modified: Date, size: UInt64)] = []
    var totalBytes: UInt64 = 0

    for entry in entries {
      if let keepName = keepName, entry.lastPathComponent == keepName { continue }
      let values = try? entry.resourceValues(forKeys: [.contentModificationDateKey])
      let modified = values?.contentModificationDate ?? Date.distantPast
      if modified < cutoff {
        try? fm.removeItem(at: entry)
        continue
      }
      let size = directorySize(entry)
      totalBytes += size
      retained.append((entry, modified, size))
    }

    guard totalBytes > maxBytes else { return }
    retained.sort { $0.modified < $1.modified }
    for item in retained {
      if totalBytes <= maxBytes { break }
      try? fm.removeItem(at: item.url)
      totalBytes = totalBytes > item.size ? totalBytes - item.size : 0
    }
  }

  private static func directorySize(_ url: URL) -> UInt64 {
    let fm = FileManager.default
    guard let enumerator = fm.enumerator(
      at: url,
      includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey],
      options: []
    ) else { return 0 }
    var total: UInt64 = 0
    for case let fileURL as URL in enumerator {
      let values = try? fileURL.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
      if values?.isRegularFile == true, let size = values?.fileSize, size > 0 {
        total += UInt64(size)
      }
    }
    return total
  }
}

final class ExportSession: NSObject, UIAdaptivePresentationControllerDelegate {
  let args: ExportArgs
  let invoke: Invoke
  let directory: URL
  var picker: UIActivityViewController?
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
    if !Thread.isMainThread {
      DispatchQueue.main.async { self.finish(status) }
      return
    }
    guard !finished else { return }
    finished = true
    picker?.completionWithItemsHandler = nil
    picker?.presentationController?.delegate = nil
    if status == "error" { invoke.reject("File export failed", code: "write_failed") }
    else { invoke.resolve(ExportResult(attemptId: args.attemptId, status: status, destination: status == "started" ? "share" : "")) }
    if status != "started" {
      let directoryToDelete = directory
      DispatchQueue.global(qos: .utility).async {
        try? FileManager.default.removeItem(at: directoryToDelete)
      }
    }
    release?()
  }
  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { finish("cancelled") }
  func cancel() {
    if !Thread.isMainThread {
      DispatchQueue.main.async { self.cancel() }
      return
    }
    cancelled = true
    if let picker = picker {
      if picker.presentingViewController != nil && !picker.isBeingPresented {
        picker.dismiss(animated: true) { self.finish("cancelled") }
      } else {
        self.finish("cancelled")
      }
    }
  }
}

final class FileSavePlugin: Plugin {
  private var session: ExportSession?
  private let queue = DispatchQueue(label: "ai.alook.file-save")
  private var cancelledAttempts = Set<String>()
  override func load(webview: WKWebView) {
    let activeId = session?.args.attemptId
    queue.async {
      FileSaveShareCache.sweep(keepName: activeId)
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
      let root = FileSaveShareCache.rootURL()
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
          FileSaveShareCache.sweep(root: root, keepName: args.attemptId)
          try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
          let destination = directory.appendingPathComponent(args.name)
          try FileSaveCopy.write(source: source, destination: destination, bytes: args.bytes, sha256: args.sha256) { session.cancelled }
          DispatchQueue.main.async {
            if session.cancelled { session.finish("cancelled"); return }
            guard let presenter = self.manager.viewController, presenter.presentedViewController == nil,
                  presenter.view.window != nil else { session.finish("error"); return }
            let picker = UIActivityViewController(activityItems: [destination], applicationActivities: nil)
            session.picker = picker
            picker.completionWithItemsHandler = { [weak session] _, completed, _, error in
              session?.finish(error != nil ? "error" : completed ? "started" : "cancelled")
            }
            if let popover = picker.popoverPresentationController {
              popover.sourceView = presenter.view
              popover.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 1, height: 1)
              popover.permittedArrowDirections = []
            }
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
