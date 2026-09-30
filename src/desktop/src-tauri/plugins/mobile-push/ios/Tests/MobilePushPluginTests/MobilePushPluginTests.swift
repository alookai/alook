import XCTest
@testable import tauri_plugin_mobile_push

final class MobilePushPluginTests: XCTestCase {
  func testRouteAcceptsOnlyCanonicalAllowlistedValues() {
    XCTAssertEqual(
      MobilePushRoute.create(
        notificationId: "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
        messageId: "message_1",
        targetId: "channel-2",
        viewerUserId: "viewer_1"
      ),
      MobilePushRoute(
        notificationId: "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
        messageId: "message_1",
        targetId: "channel-2",
        viewerUserId: "viewer_1"
      )
    )
    XCTAssertNil(MobilePushRoute.create(
      notificationId: "bad",
      messageId: "message_1",
      targetId: "channel-2",
      viewerUserId: "viewer_1"
    ))
    XCTAssertNil(MobilePushRoute.create(
      notificationId: "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
      messageId: "../message",
      targetId: "channel-2",
      viewerUserId: "viewer_1"
    ))
    XCTAssertNil(MobilePushRoute.create(
      notificationId: "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
      messageId: "message_1",
      targetId: "channel-2",
      viewerUserId: "../viewer"
    ))
  }

  func testRouteIgnoresTransportExtrasAndStoresOnlyThreeFields() {
    let route = MobilePushRoute.from([
      "notificationId": "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
      "messageId": "message_1",
      "targetId": "channel_2",
      "viewerUserId": "viewer_1",
      "aps": ["transport": true],
    ])
    XCTAssertEqual(route?.messageId, "message_1")
    XCTAssertEqual(route?.targetId, "channel_2")
    XCTAssertEqual(route?.viewerUserId, "viewer_1")
    XCTAssertNil(MobilePushRoute.from([
      "notificationId": "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
      "messageId": "message_1",
      "targetId": "channel_2",
      "viewerUserId": 7,
    ]))
    XCTAssertNil(MobilePushRoute.from([
      "notificationId": "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
      "messageId": "message_1",
      "targetId": "channel_2",
    ])?.viewerUserId)
  }

  func testDeliveredRouteSelectionMatchesOnlyExactViewerAndConversation() {
    let b1: [AnyHashable: Any] = [
      "notificationId": "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
      "messageId": "message_1",
      "targetId": "channel_1",
      "viewerUserId": "viewer_b",
    ]
    let b2: [AnyHashable: Any] = [
      "notificationId": "5f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
      "messageId": "message_2",
      "targetId": "channel_1",
      "viewerUserId": "viewer_b",
    ]
    let a1: [AnyHashable: Any] = [
      "notificationId": "6f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
      "messageId": "message_3",
      "targetId": "channel_1",
      "viewerUserId": "viewer_a",
    ]
    let a2: [AnyHashable: Any] = [
      "notificationId": "7f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
      "messageId": "message_4",
      "targetId": "channel_1",
      "viewerUserId": "viewer_a",
    ]
    let other: [AnyHashable: Any] = [
      "notificationId": "8f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
      "messageId": "message_5",
      "targetId": "channel_2",
      "viewerUserId": "viewer_b",
    ]
    let legacy: [AnyHashable: Any] = [
      "notificationId": "9f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
      "messageId": "message_6",
      "targetId": "channel_1",
    ]

    XCTAssertEqual(
      mobilePushDeliveredNotificationIdentifiers(
        viewerUserId: "viewer_b",
        targetId: "channel_1",
        delivered: [
          ("ios-b1", b1),
          ("ios-b2", b2),
          ("ios-a1", a1),
          ("ios-a2", a2),
          ("ios-other", other),
          ("ios-legacy", legacy),
        ]
      ),
      ["ios-b1", "ios-b2"]
    )
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
    store.saveActivation(route, deliveredNotificationIdentifier: "apns-delivered-1")
    XCTAssertEqual(store.takeActivation(), route)
    XCTAssertNil(store.takeActivation())
    XCTAssertNil(store.deliveredNotificationIdentifier(for: "another-notification"))
    XCTAssertEqual(
      store.deliveredNotificationIdentifier(for: route.notificationId),
      "apns-delivered-1"
    )
    XCTAssertEqual(
      store.deliveredNotificationIdentifier(for: route.notificationId),
      "apns-delivered-1"
    )
    store.completeDeliveredNotificationIdentifier(for: route.notificationId)
    XCTAssertNil(store.deliveredNotificationIdentifier(for: route.notificationId))
  }
}
