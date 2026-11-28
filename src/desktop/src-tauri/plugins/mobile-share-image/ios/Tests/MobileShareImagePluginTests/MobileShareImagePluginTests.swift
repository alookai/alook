import CryptoKit
import XCTest
@testable import tauri_plugin_mobile_share_image

final class MobileShareImagePluginTests: XCTestCase {
  private let attempt = "123e4567-e89b-42d3-a456-426614174000"
  private let pngData = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")!
  private var cachesRoot: URL!

  override func setUpWithError() throws {
    cachesRoot = FileManager.default.temporaryDirectory
      .appendingPathComponent("mobile-share-image-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: cachesRoot, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    if let cachesRoot {
      try? FileManager.default.removeItem(at: cachesRoot)
    }
  }

  private func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  private func stageFile(
    _ data: Data,
    attemptId: String? = nil,
    appSubdir: String? = "ai.alook.app"
  ) throws -> (path: String, bytes: UInt64, sha256: String) {
    let id = attemptId ?? attempt
    let base = appSubdir.map { cachesRoot.appendingPathComponent($0, isDirectory: true) } ?? cachesRoot!
    let stagingDir = base.appendingPathComponent("mobile-share-image-staging", isDirectory: true)
    try FileManager.default.createDirectory(at: stagingDir, withIntermediateDirectories: true)
    let url = stagingDir.appendingPathComponent("\(id).png")
    try data.write(to: url, options: .atomic)
    return (url.path, UInt64(data.count), sha256Hex(data))
  }

  func testValidatorLoadsVerifiedStagedPNGAndRejectsTamperingOrTraversal() throws {
    try MobileShareImageValidator.validateAttemptId(attempt)

    let scoped = try stageFile(pngData, appSubdir: "ai.alook.app")
    let loadedScoped = try MobileShareImageValidator.loadValidatedFile(
      attemptId: attempt,
      path: scoped.path,
      expectedBytes: scoped.bytes,
      sha256: scoped.sha256,
      cachesRoot: cachesRoot
    )
    XCTAssertEqual(loadedScoped, pngData)

    let direct = try stageFile(pngData, appSubdir: nil)
    let loadedDirect = try MobileShareImageValidator.loadValidatedFile(
      attemptId: attempt,
      path: direct.path,
      expectedBytes: direct.bytes,
      sha256: direct.sha256,
      cachesRoot: cachesRoot
    )
    XCTAssertEqual(loadedDirect, pngData)

    XCTAssertThrowsError(try MobileShareImageValidator.loadValidatedFile(
      attemptId: attempt,
      path: scoped.path,
      expectedBytes: scoped.bytes + 1,
      sha256: scoped.sha256,
      cachesRoot: cachesRoot
    )) { error in
      XCTAssertEqual((error as? MobileShareImageFailure)?.code, "invalid_png")
    }

    XCTAssertThrowsError(try MobileShareImageValidator.loadValidatedFile(
      attemptId: attempt,
      path: scoped.path,
      expectedBytes: scoped.bytes,
      sha256: String(repeating: "0", count: 64),
      cachesRoot: cachesRoot
    )) { error in
      XCTAssertEqual((error as? MobileShareImageFailure)?.code, "invalid_png")
    }

    let tooDeepDir = cachesRoot
      .appendingPathComponent("a", isDirectory: true)
      .appendingPathComponent("b", isDirectory: true)
      .appendingPathComponent("mobile-share-image-staging", isDirectory: true)
    try FileManager.default.createDirectory(at: tooDeepDir, withIntermediateDirectories: true)
    let tooDeep = tooDeepDir.appendingPathComponent("\(attempt).png")
    try pngData.write(to: tooDeep, options: .atomic)
    XCTAssertThrowsError(try MobileShareImageValidator.loadValidatedFile(
      attemptId: attempt,
      path: tooDeep.path,
      expectedBytes: scoped.bytes,
      sha256: scoped.sha256,
      cachesRoot: cachesRoot
    )) { error in
      XCTAssertEqual((error as? MobileShareImageFailure)?.code, "invalid_png")
    }

    let wrongDir = cachesRoot
      .appendingPathComponent("ai.alook.app", isDirectory: true)
      .appendingPathComponent("other-staging", isDirectory: true)
    try FileManager.default.createDirectory(at: wrongDir, withIntermediateDirectories: true)
    let wrongDirFile = wrongDir.appendingPathComponent("\(attempt).png")
    try pngData.write(to: wrongDirFile, options: .atomic)
    XCTAssertThrowsError(try MobileShareImageValidator.loadValidatedFile(
      attemptId: attempt,
      path: wrongDirFile.path,
      expectedBytes: scoped.bytes,
      sha256: scoped.sha256,
      cachesRoot: cachesRoot
    )) { error in
      XCTAssertEqual((error as? MobileShareImageFailure)?.code, "invalid_png")
    }

    let outsideDir = cachesRoot.deletingLastPathComponent()
      .appendingPathComponent("mobile-share-image-staging", isDirectory: true)
    try FileManager.default.createDirectory(at: outsideDir, withIntermediateDirectories: true)
    let escaped = outsideDir.appendingPathComponent("\(attempt).png")
    try pngData.write(to: escaped, options: .atomic)
    defer { try? FileManager.default.removeItem(at: escaped) }
    XCTAssertThrowsError(try MobileShareImageValidator.loadValidatedFile(
      attemptId: attempt,
      path: escaped.path,
      expectedBytes: scoped.bytes,
      sha256: scoped.sha256,
      cachesRoot: cachesRoot
    )) { error in
      XCTAssertEqual((error as? MobileShareImageFailure)?.code, "invalid_png")
    }

    let symlinkDir = cachesRoot
      .appendingPathComponent("symlink-app", isDirectory: true)
      .appendingPathComponent("mobile-share-image-staging", isDirectory: true)
    try FileManager.default.createDirectory(at: symlinkDir, withIntermediateDirectories: true)
    let symlink = symlinkDir.appendingPathComponent("\(attempt).png")
    try FileManager.default.createSymbolicLink(at: symlink, withDestinationURL: escaped)
    XCTAssertThrowsError(try MobileShareImageValidator.loadValidatedFile(
      attemptId: attempt,
      path: symlink.path,
      expectedBytes: scoped.bytes,
      sha256: scoped.sha256,
      cachesRoot: cachesRoot
    )) { error in
      XCTAssertEqual((error as? MobileShareImageFailure)?.code, "invalid_png")
    }
  }

  func testValidatorRejectsNonPNGSignatureAndOversizeMetadata() throws {
    let nonPng = try stageFile(Data("hello world".utf8))
    XCTAssertThrowsError(try MobileShareImageValidator.loadValidatedFile(
      attemptId: attempt,
      path: nonPng.path,
      expectedBytes: nonPng.bytes,
      sha256: nonPng.sha256,
      cachesRoot: cachesRoot
    )) { error in
      XCTAssertEqual((error as? MobileShareImageFailure)?.code, "invalid_png")
    }

    XCTAssertThrowsError(try MobileShareImageValidator.loadValidatedFile(
      attemptId: attempt,
      path: nonPng.path,
      expectedBytes: UInt64(10 * 1024 * 1024 + 1),
      sha256: nonPng.sha256,
      cachesRoot: cachesRoot
    )) { error in
      XCTAssertEqual((error as? MobileShareImageFailure)?.code, "image_too_large")
    }
  }

  func testAttemptIdMustBeCanonicalVersionFourUUID() {
    for invalid in [
      "123e4567-e89b-12d3-a456-426614174000",
      "123E4567-E89B-42D3-A456-426614174000",
      "bad\nlog",
    ] {
      XCTAssertThrowsError(try MobileShareImageValidator.validateAttemptId(invalid))
    }
  }

  func testFilenameNormalizationAndUTF8Boundary() {
    XCTAssertEqual(
      MobileShareImageValidator.sanitizeFilename(" ../a/b/..re\u{301}sume\u{301}.PNG.png"),
      "r\u{e9}sum\u{e9}.png"
    )
    XCTAssertEqual(MobileShareImageValidator.sanitizeFilename("..."), "alook-message-share.png")
    XCTAssertEqual(MobileShareImageValidator.sanitizeFilename("x\u{0}/name.png"), "name.png")
    XCTAssertLessThanOrEqual(
      MobileShareImageValidator.sanitizeFilename(String(repeating: "€", count: 100)).utf8.count,
      180
    )
    XCTAssertEqual(MobileShareImageValidator.sanitizeFilename(String(repeating: "a", count: 175)).utf8.count, 179)
    XCTAssertEqual(MobileShareImageValidator.sanitizeFilename(String(repeating: "a", count: 176)).utf8.count, 180)
    XCTAssertEqual(MobileShareImageValidator.sanitizeFilename(String(repeating: "a", count: 177)).utf8.count, 180)
  }

  func testCopySettlesOnlyAfterMainThreadPasteboardPublicationAndReleasesBusy() throws {
    let staged = try stageFile(pngData)
    let secondAttempt = "223e4567-e89b-42d3-a456-426614174000"
    let secondStaged = try stageFile(pngData, attemptId: secondAttempt)
    let pasteboard = FakePasteboard()
    let photos = FakePhotos(status: .denied)
    let queued = expectation(description: "main publication queued")
    var publication: (() -> Void)?
    let operations = MobileShareImageOperations(
      worker: DispatchQueue(label: "test.copy.worker"),
      main: { block in publication = block; queued.fulfill() },
      pasteboard: pasteboard,
      photos: photos,
      cachesRoot: cachesRoot
    )
    let success = expectation(description: "copy success")
    var result: Result<MobileShareImageResult, MobileShareImageFailure>?
    operations.copy(.init(attemptId: attempt, path: staged.path, bytes: staged.bytes, sha256: staged.sha256)) {
      result = $0
      success.fulfill()
    }
    wait(for: [queued], timeout: 2)
    XCTAssertEqual(pasteboard.writes, 0)
    XCTAssertNil(result)

    let busy = expectation(description: "second call busy")
    operations.copy(.init(attemptId: secondAttempt, path: secondStaged.path, bytes: secondStaged.bytes, sha256: secondStaged.sha256)) {
      XCTAssertEqual(try? $0.get(), nil)
      if case .failure(let failure) = $0 { XCTAssertEqual(failure.code, "busy") }
      busy.fulfill()
    }
    wait(for: [busy], timeout: 1)
    publication?()
    wait(for: [success], timeout: 2)
    XCTAssertEqual(pasteboard.writes, 1)
    XCTAssertEqual(try? result?.get().destination, "clipboard")
  }

  func testPhotosDenialRejectsWithoutAdding() throws {
    let staged = try stageFile(pngData)
    let photos = FakePhotos(status: .denied)
    let operations = MobileShareImageOperations(
      worker: DispatchQueue(label: "test.photos.denied"),
      main: { $0() },
      pasteboard: FakePasteboard(),
      photos: photos,
      cachesRoot: cachesRoot
    )
    let settled = expectation(description: "denied")
    operations.save(.init(attemptId: attempt, path: staged.path, bytes: staged.bytes, sha256: staged.sha256, filename: "card.png")) { result in
      switch result {
      case .failure(let failure): XCTAssertEqual(failure.code, "permission_denied")
      case .success: XCTFail("Expected permission_denied failure")
      }
      settled.fulfill()
    }
    wait(for: [settled], timeout: 2)
    XCTAssertEqual(photos.addCalls, 0)
  }

  func testPhotosSuccessWaitsForAuthorizationAndWriteCompletion() throws {
    let staged = try stageFile(pngData)
    let photos = FakePhotos(status: .notDetermined)
    let operations = MobileShareImageOperations(
      worker: DispatchQueue(label: "test.photos.success"),
      main: { $0() },
      pasteboard: FakePasteboard(),
      photos: photos,
      cachesRoot: cachesRoot
    )
    let authorizationRequested = expectation(description: "authorization requested")
    photos.onRequest = { authorizationRequested.fulfill() }
    let settled = expectation(description: "saved")
    var result: Result<MobileShareImageResult, MobileShareImageFailure>?
    operations.save(.init(attemptId: attempt, path: staged.path, bytes: staged.bytes, sha256: staged.sha256, filename: "..card.PNG.png")) {
      result = $0
      settled.fulfill()
    }
    wait(for: [authorizationRequested], timeout: 2)
    XCTAssertNil(result)
    photos.completeAuthorization(.authorized)
    XCTAssertNil(result)
    XCTAssertEqual(photos.filename, "card.png")
    photos.completeAdd(.success(()))
    wait(for: [settled], timeout: 2)
    XCTAssertEqual(try? result?.get().destination, "photos")
  }

  func testPasteboardFailureReleasesBusyForImmediateRetry() throws {
    let staged = try stageFile(pngData)
    let pasteboard = FakePasteboard()
    pasteboard.failuresRemaining = 1
    let operations = MobileShareImageOperations(
      worker: DispatchQueue(label: "test.copy.retry"),
      main: { $0() },
      pasteboard: pasteboard,
      photos: FakePhotos(status: .denied),
      cachesRoot: cachesRoot
    )
    let first = expectation(description: "copy failure")
    operations.copy(.init(attemptId: attempt, path: staged.path, bytes: staged.bytes, sha256: staged.sha256)) { result in
      switch result {
      case .failure(let failure): XCTAssertEqual(failure.code, "write_failed")
      case .success: XCTFail("Expected write_failed failure")
      }
      first.fulfill()
    }
    wait(for: [first], timeout: 2)

    let second = expectation(description: "copy retry")
    operations.copy(.init(attemptId: attempt, path: staged.path, bytes: staged.bytes, sha256: staged.sha256)) { result in
      XCTAssertEqual(try? result.get().destination, "clipboard")
      second.fulfill()
    }
    wait(for: [second], timeout: 2)
    XCTAssertEqual(pasteboard.writes, 1)
  }

  func testDuplicatePhotoCompletionSettlesOnceAndReleasesForRetry() throws {
    let staged = try stageFile(pngData)
    let photos = FakePhotos(status: .authorized)
    let operations = MobileShareImageOperations(
      worker: DispatchQueue(label: "test.photos.duplicate"),
      main: { $0() },
      pasteboard: FakePasteboard(),
      photos: photos,
      cachesRoot: cachesRoot
    )
    let firstAdd = expectation(description: "first add")
    photos.onAdd = { firstAdd.fulfill() }
    let firstSettle = expectation(description: "first settle")
    var settleCount = 0
    operations.save(.init(attemptId: attempt, path: staged.path, bytes: staged.bytes, sha256: staged.sha256, filename: "card.png")) { _ in
      settleCount += 1
      firstSettle.fulfill()
    }
    wait(for: [firstAdd], timeout: 2)
    photos.completeAdd(.success(()))
    photos.completeAdd(.success(()))
    wait(for: [firstSettle], timeout: 2)

    let secondAdd = expectation(description: "retry add")
    photos.onAdd = { secondAdd.fulfill() }
    let secondSettle = expectation(description: "retry settle")
    operations.save(.init(attemptId: attempt, path: staged.path, bytes: staged.bytes, sha256: staged.sha256, filename: "card.png")) { result in
      XCTAssertEqual(try? result.get().destination, "photos")
      secondSettle.fulfill()
    }
    wait(for: [secondAdd], timeout: 2)
    photos.completeAdd(.success(()))
    wait(for: [secondSettle], timeout: 2)
    XCTAssertEqual(settleCount, 1)
  }
}

private final class FakePasteboard: MobileShareImagePasteboardWriting {
  var writes = 0
  var failuresRemaining = 0
  func setPNG(_ data: Data) throws {
    XCTAssertFalse(data.isEmpty)
    if failuresRemaining > 0 {
      failuresRemaining -= 1
      throw NSError(domain: "MobileShareImageTests", code: 1)
    }
    writes += 1
  }
}

private final class FakePhotos: MobileShareImagePhotoLibraryAdding {
  var status: MobileShareImagePhotoAuthorization
  var addCalls = 0
  var filename: String?
  var onRequest: (() -> Void)?
  var onAdd: (() -> Void)?
  private var authorizationCompletion: ((MobileShareImagePhotoAuthorization) -> Void)?
  private var addCompletion: ((Result<Void, Error>) -> Void)?

  init(status: MobileShareImagePhotoAuthorization) {
    self.status = status
  }

  func authorizationStatus() -> MobileShareImagePhotoAuthorization { status }

  func requestAuthorization(_ completion: @escaping (MobileShareImagePhotoAuthorization) -> Void) {
    authorizationCompletion = completion
    onRequest?()
  }

  func addPNG(_ data: Data, filename: String, completion: @escaping (Result<Void, Error>) -> Void) {
    XCTAssertFalse(data.isEmpty)
    addCalls += 1
    self.filename = filename
    addCompletion = completion
    onAdd?()
  }

  func completeAuthorization(_ status: MobileShareImagePhotoAuthorization) {
    self.status = status
    authorizationCompletion?(status)
  }

  func completeAdd(_ result: Result<Void, Error>) {
    addCompletion?(result)
  }
}
