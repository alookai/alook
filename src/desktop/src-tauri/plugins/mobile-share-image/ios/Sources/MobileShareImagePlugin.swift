import CoreGraphics
import Foundation
import ImageIO
import Photos
import SwiftRs
import Tauri
import UIKit
import UniformTypeIdentifiers

struct CopyImageArgs: Decodable {
  let attemptId: String
  let pngBase64: String
}

struct SaveImageArgs: Decodable {
  let attemptId: String
  let pngBase64: String
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
private let mobileShareImageMaxDimension = 16_384
private let mobileShareImageMaxPixels = 16_777_216
private let mobileShareImageMaxOutputBytes = 64 * 1024 * 1024

enum MobileShareImageValidator {
  struct Dimensions: Equatable {
    let width: Int
    let height: Int
  }

  private static let signature: [UInt8] = [137, 80, 78, 71, 13, 10, 26, 10]
  private static let crcTable: [UInt32] = (0..<256).map { value in
    var result = UInt32(value)
    for _ in 0..<8 {
      result = (result & 1) == 1 ? 0xedb88320 ^ (result >> 1) : result >> 1
    }
    return result
  }

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

  static func decode(_ value: String) throws -> Data {
    let maxEncoded = ((mobileShareImageMaxBytes + 2) / 3) * 4
    guard !value.isEmpty, value.utf8.count % 4 == 0 else {
      throw MobileShareImageFailure(code: "invalid_png", message: "Image payload is invalid")
    }
    guard value.utf8.count <= maxEncoded else {
      throw MobileShareImageFailure(code: "image_too_large", message: "Image exceeds the mobile limit")
    }
    guard let data = Data(base64Encoded: value, options: []), data.base64EncodedString() == value else {
      throw MobileShareImageFailure(code: "invalid_png", message: "Image payload is not canonical base64")
    }
    guard !data.isEmpty else {
      throw MobileShareImageFailure(code: "invalid_png", message: "Image payload is empty")
    }
    guard data.count <= mobileShareImageMaxBytes else {
      throw MobileShareImageFailure(code: "image_too_large", message: "Image exceeds the mobile limit")
    }
    let dimensions = try validateStructure(data)
    try forceDecode(data, dimensions: dimensions)
    return data
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

  static func validateStructure(_ data: Data) throws -> Dimensions {
    let bytes = [UInt8](data)
    guard bytes.count >= signature.count, Array(bytes[0..<8]) == signature else {
      throw invalidPNG()
    }
    var offset = 8
    var dimensions: Dimensions?
    var sawData = false
    var sawEnd = false
    while offset < bytes.count {
      guard offset <= bytes.count - 12 else { throw invalidPNG() }
      let lengthValue = readUInt32(bytes, at: offset)
      let dataStart = offset + 8
      let dataEndValue = UInt64(dataStart) + UInt64(lengthValue)
      let chunkEndValue = dataEndValue + 4
      guard chunkEndValue <= UInt64(bytes.count), !sawEnd else { throw invalidPNG() }
      let dataEnd = Int(dataEndValue)
      let chunkEnd = Int(chunkEndValue)
      let type = Array(bytes[(offset + 4)..<(offset + 8)])
      let storedCRC = readUInt32(bytes, at: dataEnd)
      guard crc32(bytes, range: (offset + 4)..<dataEnd) == storedCRC else { throw invalidPNG() }

      if type == [73, 72, 68, 82] { // IHDR
        guard dimensions == nil, offset == 8, lengthValue == 13 else { throw invalidPNG() }
        let width = Int(readUInt32(bytes, at: dataStart))
        let height = Int(readUInt32(bytes, at: dataStart + 4))
        let pixels = UInt64(width) * UInt64(height)
        guard width > 0, height > 0,
              width <= mobileShareImageMaxDimension,
              height <= mobileShareImageMaxDimension,
              pixels <= UInt64(mobileShareImageMaxPixels)
        else { throw invalidPNG() }
        let bitDepth = Int(bytes[dataStart + 8])
        let colorType = Int(bytes[dataStart + 9])
        let legal: Bool
        switch colorType {
        case 0: legal = [1, 2, 4, 8, 16].contains(bitDepth)
        case 2, 4, 6: legal = [8, 16].contains(bitDepth)
        case 3: legal = [1, 2, 4, 8].contains(bitDepth)
        default: legal = false
        }
        guard legal,
              bytes[dataStart + 10] == 0,
              bytes[dataStart + 11] == 0,
              bytes[dataStart + 12] <= 1
        else { throw invalidPNG() }
        dimensions = Dimensions(width: width, height: height)
      } else if type == [73, 68, 65, 84] { // IDAT
        guard dimensions != nil, !sawEnd else { throw invalidPNG() }
        sawData = true
      } else if type == [73, 69, 78, 68] { // IEND
        guard dimensions != nil, sawData, lengthValue == 0, chunkEnd == bytes.count else {
          throw invalidPNG()
        }
        sawEnd = true
      } else if type == [97, 99, 84, 76] || // acTL
                  type == [102, 99, 84, 76] || // fcTL
                  type == [102, 100, 65, 84] { // fdAT
        throw invalidPNG()
      }
      offset = chunkEnd
    }
    guard sawEnd, let dimensions = dimensions else { throw invalidPNG() }
    return dimensions
  }

  private static func forceDecode(_ data: Data, dimensions: Dimensions) throws {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
          CGImageSourceGetStatus(source) == .statusComplete,
          CGImageSourceGetStatusAtIndex(source, 0) == .statusComplete,
          CGImageSourceGetCount(source) == 1,
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
          image.width == dimensions.width,
          image.height == dimensions.height
    else { throw invalidPNG() }
    let byteCount = dimensions.width * dimensions.height * 4
    guard byteCount <= mobileShareImageMaxOutputBytes else { throw invalidPNG() }
    var pixels = [UInt8](repeating: 0, count: byteCount)
    let decoded = pixels.withUnsafeMutableBytes { buffer -> Bool in
      guard let context = CGContext(
        data: buffer.baseAddress,
        width: dimensions.width,
        height: dimensions.height,
        bitsPerComponent: 8,
        bytesPerRow: dimensions.width * 4,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
      ) else { return false }
      context.draw(image, in: CGRect(x: 0, y: 0, width: dimensions.width, height: dimensions.height))
      return true
    }
    guard decoded else { throw invalidPNG() }
  }

  private static func readUInt32(_ bytes: [UInt8], at offset: Int) -> UInt32 {
    UInt32(bytes[offset]) << 24 |
      UInt32(bytes[offset + 1]) << 16 |
      UInt32(bytes[offset + 2]) << 8 |
      UInt32(bytes[offset + 3])
  }

  private static func crc32(_ bytes: [UInt8], range: Range<Int>) -> UInt32 {
    var crc = UInt32.max
    for index in range {
      crc = crcTable[Int((crc ^ UInt32(bytes[index])) & 0xff)] ^ (crc >> 8)
    }
    return crc ^ UInt32.max
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
  private let state = DispatchQueue(label: "ai.alook.mobile-share-image.state")
  private var activeAttemptId: String?

  init(
    worker: DispatchQueue = DispatchQueue(label: "ai.alook.mobile-share-image.worker"),
    main: @escaping (@escaping () -> Void) -> Void = { DispatchQueue.main.async(execute: $0) },
    pasteboard: MobileShareImagePasteboardWriting = SystemMobileShareImagePasteboard(),
    photos: MobileShareImagePhotoLibraryAdding = SystemMobileShareImagePhotoLibrary()
  ) {
    self.worker = worker
    self.main = main
    self.pasteboard = pasteboard
    self.photos = photos
  }

  func copy(_ args: CopyImageArgs, completion: @escaping Completion) {
    guard acquire(args.attemptId) else {
      completion(.failure(MobileShareImageFailure(code: "busy", message: "Another image action is active")))
      return
    }
    worker.async {
      do {
        let data = try MobileShareImageValidator.decode(args.pngBase64)
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
        let data = try MobileShareImageValidator.decode(args.pngBase64)
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
