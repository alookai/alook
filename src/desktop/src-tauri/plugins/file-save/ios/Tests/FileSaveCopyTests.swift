import Foundation
import CryptoKit
import XCTest
@testable import FileSaveCopyCore

final class FileSaveCopyTests: XCTestCase {
  func fixture(_ action: (URL) throws -> Void) throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    try action(root)
  }
  func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
  func testExactLargeAndEmptyFile() throws {
    try fixture { root in
      for size in [0, 1, 65_537, 25 * 1024 * 1024] {
        let data = Data(repeating: 42, count: size)
        let source = root.appendingPathComponent("source")
        let target = root.appendingPathComponent("target")
        try data.write(to: source)
        try FileSaveCopy.write(source: source, destination: target, bytes: UInt64(size), sha256: hash(data)) { false }
        XCTAssertEqual(try Data(contentsOf: target), data)
      }
    }
  }
  func testRejectsLengthAndHashMismatch() throws {
    try fixture { root in
      let data = Data("abc".utf8)
      let source = root.appendingPathComponent("source")
      try data.write(to: source)
      for (size, sha) in [(UInt64(2), hash(data)), (4, hash(data)), (3, "bad")] {
        XCTAssertThrowsError(try FileSaveCopy.write(source: source, destination: root.appendingPathComponent("target"), bytes: size, sha256: sha) { false })
      }
    }
  }
  func testCancellationStopsBetweenChunks() throws {
    try fixture { root in
      let data = Data(repeating: 1, count: 131_072)
      let source = root.appendingPathComponent("source")
      let target = root.appendingPathComponent("target")
      try data.write(to: source)
      var reads = 0
      XCTAssertThrowsError(try FileSaveCopy.write(source: source, destination: target, bytes: UInt64(data.count), sha256: hash(data)) { reads += 1; return reads > 1 })
      XCTAssertEqual(try Data(contentsOf: target).count, 65_536)
    }
  }
  func testUnwritableDestinationFails() throws {
    try fixture { root in
      let source = root.appendingPathComponent("source")
      try Data().write(to: source)
      XCTAssertThrowsError(try FileSaveCopy.write(source: source, destination: root.appendingPathComponent("missing/target"), bytes: 0, sha256: hash(Data())) { false })
    }
  }
}
