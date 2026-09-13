import XCTest
@testable import tauri_plugin_mobile_push

final class MobilePushPluginTests: XCTestCase {
  func testRouteAcceptsOnlyCanonicalAllowlistedValues() {
    XCTAssertEqual(
      MobilePushRoute.create(
        notificationId: "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
        messageId: "message_1",
        targetId: "channel-2"
      ),
      MobilePushRoute(
        notificationId: "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
        messageId: "message_1",
        targetId: "channel-2"
      )
    )
    XCTAssertNil(MobilePushRoute.create(
      notificationId: "bad",
      messageId: "message_1",
      targetId: "channel-2"
    ))
    XCTAssertNil(MobilePushRoute.create(
      notificationId: "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
      messageId: "../message",
      targetId: "channel-2"
    ))
  }

  func testRouteIgnoresTransportExtrasAndStoresOnlyThreeFields() {
    let route = MobilePushRoute.from([
      "notificationId": "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
      "messageId": "message_1",
      "targetId": "channel_2",
      "aps": ["transport": true],
    ])
    XCTAssertEqual(route?.messageId, "message_1")
    XCTAssertEqual(route?.targetId, "channel_2")
  }

  func testSuccessfulPostedTokenBecomesProofAcrossAConcurrentRotation() {
    let t0 = "token-00000000000"
    let t1 = "token-11111111111"
    let t2 = "token-22222222222"
    let initial = MobilePushRegistrationState(currentToken: t0).acknowledging(t0)
    XCTAssertNil(initial.previousToken)

    let failedT1 = initial.withCurrentToken(t1)
    XCTAssertEqual(failedT1.previousToken, t0)

    let failedT2 = failedT1.withCurrentToken(t2)
    XCTAssertEqual(failedT2.previousToken, t0)
    let acknowledgedT1 = failedT2.acknowledging(t1)
    XCTAssertEqual(acknowledgedT1.previousToken, t1)

    let acknowledgedT2 = acknowledgedT1.acknowledging(t2)
    XCTAssertNil(acknowledgedT2.previousToken)
    XCTAssertEqual(acknowledgedT2.acknowledgedToken, t2)
  }

  func testStoreUsesOneStableInstallationAndConsumesActivationOnce() {
    let suite = "mobile-push-tests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let store = MobilePushStore(defaults: defaults)
    XCTAssertEqual(store.installationId(), store.installationId())

    let route = MobilePushRoute(
      notificationId: "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
      messageId: "message_1",
      targetId: "channel_2"
    )
    store.saveActivation(route)
    XCTAssertEqual(store.takeActivation(), route)
    XCTAssertNil(store.takeActivation())
  }
}
