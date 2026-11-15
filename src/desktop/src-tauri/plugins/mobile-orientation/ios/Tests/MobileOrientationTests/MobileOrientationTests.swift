import XCTest
import CoreMotion
@testable import tauri_plugin_mobile_orientation

final class MobileOrientationTests: XCTestCase {
  func testGravityAxesUsePhysicalClockwiseDirections() {
    XCTAssertEqual(mobileOrientationAngle(0, -1, previous: nil), 0)
    XCTAssertEqual(mobileOrientationAngle(1, 0, previous: nil), 90)
    XCTAssertEqual(mobileOrientationAngle(0, 1, previous: nil), 180)
    XCTAssertEqual(mobileOrientationAngle(-1, 0, previous: nil), 270)
  }
  func testFlatAndInvalidValuesRetainOnlyThisSessionsPreviousDirection() {
    XCTAssertNil(mobileOrientationAngle(0, 0, previous: nil))
    XCTAssertEqual(mobileOrientationAngle(0.1, 0.1, previous: 90), 90)
    XCTAssertEqual(mobileOrientationAngle(.nan, 0, previous: 270), 270)
  }
  func testHysteresisDoesNotFlapAtTheDiagonal() {
    for degrees in [44.0, 46, 59] {
      let angle = degrees * .pi / 180
      XCTAssertEqual(mobileOrientationAngle(sin(angle), -cos(angle), previous: 0), 0)
    }
    let turn = 61.0 * .pi / 180
    XCTAssertEqual(mobileOrientationAngle(sin(turn), -cos(turn), previous: 0), 90)
    let returning = 39.0 * .pi / 180
    XCTAssertEqual(mobileOrientationAngle(sin(returning), -cos(returning), previous: 90), 90)
  }
  func testSystemDeviceOrientationUsesOppositeLandscapeNamesFromInterfaceOrientation() {
    XCTAssertEqual(mobileSystemOrientationAngle(.portrait), 0)
    XCTAssertEqual(mobileSystemOrientationAngle(.portraitUpsideDown), 180)
    XCTAssertEqual(mobileSystemOrientationAngle(.landscapeLeft), 270)
    XCTAssertEqual(mobileSystemOrientationAngle(.landscapeRight), 90)
    XCTAssertNil(mobileSystemOrientationAngle(.unknown))
    XCTAssertNil(mobileSystemOrientationAngle(.faceUp))
    XCTAssertNil(mobileSystemOrientationAngle(.faceDown))
  }

  func testExplicitAuthorizationFailureIsDistinctFromUnavailableHardware() {
    for code in [CMErrorNotAuthorized, CMErrorMotionActivityNotAuthorized] {
      XCTAssertTrue(mobileMotionAccessDenied(NSError(domain: CMErrorDomain, code: Int(code.rawValue))))
    }
    XCTAssertFalse(mobileMotionAccessDenied(NSError(domain: CMErrorDomain, code: Int(CMErrorNotAvailable.rawValue))))
    XCTAssertFalse(mobileMotionAccessDenied(NSError(domain: "other", code: Int(CMErrorNotAuthorized.rawValue))))
    XCTAssertFalse(mobileMotionAccessDenied(nil))
  }

  func testUnknownInterfaceDoesNotInventPortraitWhilePhysicalDirectionIsKnown() {
    XCTAssertNil(mobileInterfaceOrientationAngle(nil))
    XCTAssertNil(mobileInterfaceOrientationAngle(.unknown))
    XCTAssertEqual(mobileInterfaceOrientationAngle(.portrait), 0)
    XCTAssertEqual(mobileInterfaceOrientationAngle(.landscapeLeft), 90)
    XCTAssertEqual(mobileInterfaceOrientationAngle(.landscapeRight), 270)
    XCTAssertEqual(mobileInterfaceOrientationAngle(.portraitUpsideDown), 180)
  }

}
