import XCTest
@testable import tauri_plugin_mobile_share_image

final class MobileShareImagePluginTests: XCTestCase {
  private let attempt = "123e4567-e89b-42d3-a456-426614174000"
  private let pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

  func testValidatorAcceptsCompletePNGAndRejectsCorruption() throws {
    try MobileShareImageValidator.validateAttemptId(attempt)
    let data = try MobileShareImageValidator.decode(pngBase64)
    XCTAssertEqual(try MobileShareImageValidator.validateStructure(data), .init(width: 1, height: 1))

    var corrupted = data
    corrupted[corrupted.index(corrupted.startIndex, offsetBy: 32)] ^= 1
    XCTAssertThrowsError(try MobileShareImageValidator.validateStructure(corrupted)) { error in
      XCTAssertEqual(error as? MobileShareImageFailure, .init(
        code: "invalid_png",
        message: "Image payload is not a valid PNG"
      ))
    }
  }

  func testValidatorRejectsNonCanonicalBase64NonPNGAndTrailingBytes() throws {
    for invalid in ["", "AA", "A===", "****", "aGVsbG8="] {
      XCTAssertThrowsError(try MobileShareImageValidator.decode(invalid))
    }

    var trailing = Data(base64Encoded: pngBase64)!
    trailing.append(0)
    XCTAssertThrowsError(try MobileShareImageValidator.validateStructure(trailing))
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
      MobileShareImageValidator.sanitizeFilename(String(repeating: "界", count: 100)).utf8.count,
      180
    )
    XCTAssertEqual(MobileShareImageValidator.sanitizeFilename(String(repeating: "a", count: 175)).utf8.count, 179)
    XCTAssertEqual(MobileShareImageValidator.sanitizeFilename(String(repeating: "a", count: 176)).utf8.count, 180)
    XCTAssertEqual(MobileShareImageValidator.sanitizeFilename(String(repeating: "a", count: 177)).utf8.count, 180)
  }

  func testCopySettlesOnlyAfterMainThreadPasteboardPublicationAndReleasesBusy() {
    let pasteboard = FakePasteboard()
    let photos = FakePhotos(status: .denied)
    let queued = expectation(description: "main publication queued")
    var publication: (() -> Void)?
    let operations = MobileShareImageOperations(
      worker: DispatchQueue(label: "test.copy.worker"),
      main: { block in publication = block; queued.fulfill() },
      pasteboard: pasteboard,
      photos: photos
    )
    let success = expectation(description: "copy success")
    var result: Result<MobileShareImageResult, MobileShareImageFailure>?
    operations.copy(.init(attemptId: attempt, pngBase64: pngBase64)) {
      result = $0
      success.fulfill()
    }
    wait(for: [queued], timeout: 2)
    XCTAssertEqual(pasteboard.writes, 0)
    XCTAssertNil(result)

    let busy = expectation(description: "second call busy")
    operations.copy(.init(attemptId: "223e4567-e89b-42d3-a456-426614174000", pngBase64: pngBase64)) {
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

  func testPhotosDenialRejectsWithoutAdding() {
    let photos = FakePhotos(status: .denied)
    let operations = MobileShareImageOperations(
      worker: DispatchQueue(label: "test.photos.denied"),
      main: { $0() },
      pasteboard: FakePasteboard(),
      photos: photos
    )
    let settled = expectation(description: "denied")
    operations.save(.init(attemptId: attempt, pngBase64: pngBase64, filename: "card.png")) { result in
      if case .failure(let failure) = result { XCTAssertEqual(failure.code, "permission_denied") }
      settled.fulfill()
    }
    wait(for: [settled], timeout: 2)
    XCTAssertEqual(photos.addCalls, 0)
  }

  func testPhotosSuccessWaitsForAuthorizationAndWriteCompletion() {
    let photos = FakePhotos(status: .notDetermined)
    let operations = MobileShareImageOperations(
      worker: DispatchQueue(label: "test.photos.success"),
      main: { $0() },
      pasteboard: FakePasteboard(),
      photos: photos
    )
    let authorizationRequested = expectation(description: "authorization requested")
    photos.onRequest = { authorizationRequested.fulfill() }
    let settled = expectation(description: "saved")
    var result: Result<MobileShareImageResult, MobileShareImageFailure>?
    operations.save(.init(attemptId: attempt, pngBase64: pngBase64, filename: "..card.PNG.png")) {
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

  func testPasteboardFailureReleasesBusyForImmediateRetry() {
    let pasteboard = FakePasteboard()
    pasteboard.failuresRemaining = 1
    let operations = MobileShareImageOperations(
      worker: DispatchQueue(label: "test.copy.retry"),
      main: { $0() },
      pasteboard: pasteboard,
      photos: FakePhotos(status: .denied)
    )
    let first = expectation(description: "copy failure")
    operations.copy(.init(attemptId: attempt, pngBase64: pngBase64)) { result in
      if case .failure(let failure) = result { XCTAssertEqual(failure.code, "write_failed") }
      first.fulfill()
    }
    wait(for: [first], timeout: 2)

    let second = expectation(description: "copy retry")
    operations.copy(.init(attemptId: attempt, pngBase64: pngBase64)) { result in
      XCTAssertEqual(try? result.get().destination, "clipboard")
      second.fulfill()
    }
    wait(for: [second], timeout: 2)
    XCTAssertEqual(pasteboard.writes, 1)
  }

  func testDuplicatePhotoCompletionSettlesOnceAndReleasesForRetry() {
    let photos = FakePhotos(status: .authorized)
    let operations = MobileShareImageOperations(
      worker: DispatchQueue(label: "test.photos.duplicate"),
      main: { $0() },
      pasteboard: FakePasteboard(),
      photos: photos
    )
    let firstAdd = expectation(description: "first add")
    photos.onAdd = { firstAdd.fulfill() }
    let firstSettle = expectation(description: "first settle")
    var settleCount = 0
    operations.save(.init(attemptId: attempt, pngBase64: pngBase64, filename: "card.png")) { _ in
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
    operations.save(.init(attemptId: attempt, pngBase64: pngBase64, filename: "card.png")) { result in
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
