import CryptoKit
import Foundation
import Photos
import SwiftRs
import Tauri
import UIKit
import UniformTypeIdentifiers

struct CopyImageArgs: Decodable {
  let attemptId: String
  let path: String
  let bytes: UInt64
  let sha256: String
}

struct SaveImageArgs: Decodable {
  let attemptId: String
  let path: String
  let bytes: UInt64
  let sha256: String
  let filename: String
}

struct MobileShareImageResult: Encodable, Equatable {
  let attemptId: String
  let status: String
  let destination: String
}

struct MobileShareImageFailure: Error, Equatable {
  let code: String
  let message: String
}

private let mobileShareImageMaxBytes = 10 * 1024 * 1024
private let mobileShareImageStagingDir = "mobile-share-image-staging"

enum MobileShareImageValidator {
  private static let signature: [UInt8] = [137, 80, 78, 71, 13, 10, 26, 10]

  static func validateAttemptId(_ value: String) throws {
    let utf8 = Array(value.utf8)
    let canonical = UUID(uuidString: value)?.uuidString.lowercased()
    guard canonical == value,
          utf8.count == 36,
          utf8[14] == 52,
          [56, 57, 97, 98].contains(utf8[19])
    else {
      throw MobileShareImageFailure(code: "invalid_png", message: "Invalid attempt identifier")
    }
  }

  static func defaultStagingRoot() -> URL {
    FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent(mobileShareImageStagingDir, isDirectory: true)
  }

  static func loadValidatedFile(
    attemptId: String,
    path: String,
    expectedBytes: UInt64,
    sha256: String,
    allowedRoot: URL = defaultStagingRoot()
  ) throws -> Data {
    try validateAttemptId(attemptId)
    guard expectedBytes > 0 else {
      throw MobileShareImageFailure(code: "invalid_png", message: "Image payload is empty")
    }
    guard expectedBytes <= UInt64(mobileShareImageMaxBytes) else {
      throw MobileShareImageFailure(code: "image_too_large", message: "Image exceeds the mobile limit")
    }
    guard isCanonicalSha256(sha256) else {
      throw MobileShareImageFailure(code: "invalid_png", message: "Image digest is invalid")
    }
    let resolvedRoot = allowedRoot.resolvingSymlinksInPath().standardizedFileURL
    let resolvedSource = URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL
    guard resolvedSource.deletingLastPathComponent().path == resolvedRoot.path,
          resolvedSource.lastPathComponent == "\(attemptId).png"
    else {
      throw MobileShareImageFailure(code: "invalid_png", message: "Staged image path is invalid")
    }
    let data: Data
    do {
      data = try Data(contentsOf: resolvedSource)
    } catch {
      throw MobileShareImageFailure(code: "write_failed", message: "Could not read staged image")
    }
    guard UInt64(data.count) == expectedBytes else {
      throw MobileShareImageFailure(code: "invalid_png", message: "Staged image size mismatch")
    }
    guard data.count >= signature.count, Array(data.prefix(signature.count)) == signature else {
      throw invalidPNG()
    }
    let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    guard digest == sha256 else {
      throw MobileShareImageFailure(code: "invalid_png", message: "Staged image digest mismatch")
    }
    return data
  }

  private static func isCanonicalSha256(_ value: String) -> Bool {
    guard value.utf8.count == 64 else { return false }
    return value.utf8.allSatisfy { byte in
      (byte >= 48 && byte <= 57) || (byte >= 97 && byte <= 102)
    }
  }

  static func sanitizeFilename(_ value: String) -> String {
    let normalized = value.precomposedStringWithCanonicalMapping
    let basename = normalized.components(separatedBy: CharacterSet(charactersIn: "/\\")).last ?? ""
    var scalars = Array(basename.unicodeScalars)
    while let first = scalars.first,
          first == "." || CharacterSet.whitespacesAndNewlines.contains(first) {
      scalars.removeFirst()
    }
    scalars.removeAll {
      CharacterSet.controlCharacters.contains($0) || $0 == "/" || $0 == "\\"
    }
    var stem = String(String.UnicodeScalarView(scalars))
      .trimmingCharacters(in: .whitespacesAndNewlines)
    while stem.lowercased().hasSuffix(".png") {
      stem.removeLast(4)
    }
    if stem.isEmpty { stem = "alook-message-share" }
    while (stem + ".png").utf8.count > 180, !stem.isEmpty {
      stem.removeLast()
    }
    return stem.isEmpty ? "alook-message-share.png" : stem + ".png"
  }

  private static func invalidPNG() -> MobileShareImageFailure {
    MobileShareImageFailure(code: "invalid_png", message: "Image payload is not a valid PNG")
  }
}

protocol MobileShareImagePasteboardWriting {
  func setPNG(_ data: Data) throws
}

final class SystemMobileShareImagePasteboard: MobileShareImagePasteboardWriting {
  func setPNG(_ data: Data) throws {
    UIPasteboard.general.setData(data, forPasteboardType: UTType.png.identifier)
  }
}

enum MobileShareImagePhotoAuthorization {
  case notDetermined
  case authorized
  case limited
  case denied
  case restricted
  case unavailable
}

protocol MobileShareImagePhotoLibraryAdding {
  func authorizationStatus() -> MobileShareImagePhotoAuthorization
  func requestAuthorization(_ completion: @escaping (MobileShareImagePhotoAuthorization) -> Void)
  func addPNG(_ data: Data, filename: String, completion: @escaping (Result<Void, Error>) -> Void)
}

final class SystemMobileShareImagePhotoLibrary: MobileShareImagePhotoLibraryAdding {
  func authorizationStatus() -> MobileShareImagePhotoAuthorization {
    map(PHPhotoLibrary.authorizationStatus(for: .addOnly))
  }

  func requestAuthorization(_ completion: @escaping (MobileShareImagePhotoAuthorization) -> Void) {
    PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in completion(self.map(status)) }
  }

  func addPNG(_ data: Data, filename: String, completion: @escaping (Result<Void, Error>) -> Void) {
    PHPhotoLibrary.shared().performChanges({
      let options = PHAssetResourceCreationOptions()
      options.originalFilename = filename
      options.uniformTypeIdentifier = UTType.png.identifier
      PHAssetCreationRequest.forAsset().addResource(with: .photo, data: data, options: options)
    }) { success, error in
      if success {
        completion(.success(()))
      } else {
        completion(.failure(error ?? MobileShareImageFailure(
          code: "write_failed",
          message: "Could not save image to Photos"
        )))
      }
    }
  }

  private func map(_ status: PHAuthorizationStatus) -> MobileShareImagePhotoAuthorization {
    switch status {
    case .notDetermined: return .notDetermined
    case .authorized: return .authorized
    case .limited: return .limited
    case .denied: return .denied
    case .restricted: return .restricted
    @unknown default: return .unavailable
    }
  }
}

final class MobileShareImageOperations {
  typealias Completion = (Result<MobileShareImageResult, MobileShareImageFailure>) -> Void

  private let worker: DispatchQueue
  private let main: (@escaping () -> Void) -> Void
  private let pasteboard: MobileShareImagePasteboardWriting
  private let photos: MobileShareImagePhotoLibraryAdding
  private let stagingRoot: URL
  private let state = DispatchQueue(label: "ai.alook.mobile-share-image.state")
  private var activeAttemptId: String?

  init(
    worker: DispatchQueue = DispatchQueue(label: "ai.alook.mobile-share-image.worker"),
    main: @escaping (@escaping () -> Void) -> Void = { DispatchQueue.main.async(execute: $0) },
    pasteboard: MobileShareImagePasteboardWriting = SystemMobileShareImagePasteboard(),
    photos: MobileShareImagePhotoLibraryAdding = SystemMobileShareImagePhotoLibrary(),
    stagingRoot: URL = MobileShareImageValidator.defaultStagingRoot()
  ) {
    self.worker = worker
    self.main = main
    self.pasteboard = pasteboard
    self.photos = photos
    self.stagingRoot = stagingRoot
  }

  func copy(_ args: CopyImageArgs, completion: @escaping Completion) {
    guard acquire(args.attemptId) else {
      completion(.failure(MobileShareImageFailure(code: "busy", message: "Another image action is active")))
      return
    }
    worker.async {
      do {
        let data = try MobileShareImageValidator.loadValidatedFile(
          attemptId: args.attemptId,
          path: args.path,
          expectedBytes: args.bytes,
          sha256: args.sha256,
          allowedRoot: self.stagingRoot
        )
        self.main {
          do {
            try self.pasteboard.setPNG(data)
            self.finish(args.attemptId, completion: completion, result: .success(MobileShareImageResult(
              attemptId: args.attemptId,
              status: "copied",
              destination: "clipboard"
            )))
          } catch {
            self.finish(args.attemptId, completion: completion, result: .failure(self.failure(
              error,
              fallback: "Could not copy image"
            )))
          }
        }
      } catch {
        self.finish(args.attemptId, completion: completion, result: .failure(self.failure(
          error,
          fallback: "Could not copy image"
        )))
      }
    }
  }

  func save(_ args: SaveImageArgs, completion: @escaping Completion) {
    guard acquire(args.attemptId) else {
      completion(.failure(MobileShareImageFailure(code: "busy", message: "Another image action is active")))
      return
    }
    worker.async {
      do {
        let data = try MobileShareImageValidator.loadValidatedFile(
          attemptId: args.attemptId,
          path: args.path,
          expectedBytes: args.bytes,
          sha256: args.sha256,
          allowedRoot: self.stagingRoot
        )
        let filename = MobileShareImageValidator.sanitizeFilename(args.filename)
        self.authorizeAndSave(data, filename: filename, attemptId: args.attemptId, completion: completion)
      } catch {
        self.finish(args.attemptId, completion: completion, result: .failure(self.failure(
          error,
          fallback: "Could not save image"
        )))
      }
    }
  }

  private func authorizeAndSave(
    _ data: Data,
    filename: String,
    attemptId: String,
    completion: @escaping Completion
  ) {
    switch photos.authorizationStatus() {
    case .authorized, .limited:
      addToPhotos(data, filename: filename, attemptId: attemptId, completion: completion)
    case .notDetermined:
      photos.requestAuthorization { status in
        switch status {
        case .authorized, .limited:
          self.addToPhotos(data, filename: filename, attemptId: attemptId, completion: completion)
        case .denied, .restricted:
          self.finish(attemptId, completion: completion, result: .failure(MobileShareImageFailure(
            code: "permission_denied",
            message: "Photos add access was denied"
          )))
        case .notDetermined, .unavailable:
          self.finish(attemptId, completion: completion, result: .failure(MobileShareImageFailure(
            code: "unavailable",
            message: "Photos add access is unavailable"
          )))
        }
      }
    case .denied, .restricted:
      finish(attemptId, completion: completion, result: .failure(MobileShareImageFailure(
        code: "permission_denied",
        message: "Photos add access was denied"
      )))
    case .unavailable:
      finish(attemptId, completion: completion, result: .failure(MobileShareImageFailure(
        code: "unavailable",
        message: "Photos add access is unavailable"
      )))
    }
  }

  private func addToPhotos(
    _ data: Data,
    filename: String,
    attemptId: String,
    completion: @escaping Completion
  ) {
    photos.addPNG(data, filename: filename) { result in
      switch result {
      case .success:
        self.finish(attemptId, completion: completion, result: .success(MobileShareImageResult(
          attemptId: attemptId,
          status: "saved",
          destination: "photos"
        )))
      case .failure(let error):
        self.finish(attemptId, completion: completion, result: .failure(self.failure(
          error,
          fallback: "Could not save image to Photos"
        )))
      }
    }
  }

  private func acquire(_ attemptId: String) -> Bool {
    state.sync {
      guard activeAttemptId == nil else { return false }
      activeAttemptId = attemptId
      return true
    }
  }

  private func finish(
    _ attemptId: String,
    completion: @escaping Completion,
    result: Result<MobileShareImageResult, MobileShareImageFailure>
  ) {
    state.async {
      guard self.activeAttemptId == attemptId else { return }
      self.activeAttemptId = nil
      completion(result)
    }
  }

  private func failure(_ error: Error, fallback: String) -> MobileShareImageFailure {
    if let failure = error as? MobileShareImageFailure { return failure }
    return MobileShareImageFailure(code: "write_failed", message: error.localizedDescription.isEmpty
      ? fallback
      : error.localizedDescription)
  }
}

final class MobileShareImagePlugin: Plugin {
  private let operations = MobileShareImageOperations()

  @objc public func copyImage(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(CopyImageArgs.self)
      try MobileShareImageValidator.validateAttemptId(args.attemptId)
      logReceive(args.attemptId)
      operations.copy(args) { result in self.settle(invoke, result: result) }
    } catch {
      reject(invoke, failure: failure(error, fallback: "Image request is invalid"))
    }
  }

  @objc public func saveImage(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(SaveImageArgs.self)
      try MobileShareImageValidator.validateAttemptId(args.attemptId)
      logReceive(args.attemptId)
      operations.save(args) { result in self.settle(invoke, result: result) }
    } catch {
      reject(invoke, failure: failure(error, fallback: "Image request is invalid"))
    }
  }

  private func settle(
    _ invoke: Invoke,
    result: Result<MobileShareImageResult, MobileShareImageFailure>
  ) {
    switch result {
    case .success(let value):
      #if DEBUG
      print("mobile-share-image native-settle attempt=\(value.attemptId) t=\(ProcessInfo.processInfo.systemUptime)")
      #endif
      invoke.resolve(value)
    case .failure(let failure):
      reject(invoke, failure: failure)
    }
  }

  private func reject(_ invoke: Invoke, failure: MobileShareImageFailure) {
    invoke.reject(failure.message, code: failure.code)
  }

  private func failure(_ error: Error, fallback: String) -> MobileShareImageFailure {
    if let failure = error as? MobileShareImageFailure { return failure }
    return MobileShareImageFailure(code: "invalid_png", message: fallback)
  }

  private func logReceive(_ attemptId: String) {
    #if DEBUG
    print("mobile-share-image native-receive attempt=\(attemptId) t=\(ProcessInfo.processInfo.systemUptime)")
    #endif
  }
}

@_cdecl("init_plugin_mobile_share_image")
func initPlugin() -> Plugin {
  MobileShareImagePlugin()
}
