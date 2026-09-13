import Foundation
import CryptoKit

enum FileSaveCopy {
  static func write(source: URL, destination: URL, bytes expectedBytes: UInt64, sha256: String, cancelled: () -> Bool) throws {
    guard FileManager.default.createFile(atPath: destination.path, contents: nil) else { throw CocoaError(.fileWriteUnknown) }
    let input = try FileHandle(forReadingFrom: source)
    let output = try FileHandle(forWritingTo: destination)
    defer { try? input.close(); try? output.close() }
    var bytes: UInt64 = 0
    var hash = SHA256()
    while true {
      guard !cancelled() else { throw CocoaError(.userCancelled) }
      guard let data = try input.read(upToCount: 65_536), !data.isEmpty else { break }
      bytes += UInt64(data.count)
      guard bytes <= expectedBytes else { throw CocoaError(.fileReadCorruptFile) }
      try output.write(contentsOf: data)
      hash.update(data: data)
    }
    guard !cancelled(), bytes == expectedBytes,
          hash.finalize().map({ String(format: "%02x", $0) }).joined() == sha256 else { throw CocoaError(.fileReadCorruptFile) }
    try output.synchronize()
    try output.close()
    try input.close()
  }
}
