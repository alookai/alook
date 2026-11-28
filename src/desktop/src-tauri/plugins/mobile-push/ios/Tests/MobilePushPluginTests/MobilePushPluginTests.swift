import XCTest
import UserNotifications
@testable import tauri_plugin_mobile_push

final class MobilePushPluginTests: XCTestCase {
  func testPresentationRequiresViewerAndUsesOnlyIdentityInThePureScript() {
    let route = MobilePushRoute(notificationId: "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e", messageId: "message_1", targetId: "channel_1")
    XCTAssertNil(mobilePushPresentationScript(route))
    let script = mobilePushPresentationScript(MobilePushRoute(notificationId: route.notificationId, messageId: route.messageId, targetId: route.targetId, viewerUserId: "viewer_1"))!
    XCTAssertTrue(script.contains("alookNativeNotificationPresentationV1"))
    XCTAssertTrue(script.contains("===true"))
    XCTAssertFalse(script.contains(route.notificationId))
    XCTAssertFalse(script.contains(route.messageId))
  }

  func testPresentationAuthorizationCompletesOnceAndCancelsFallback() {
    let completed = expectation(description: "one empty completion")
    completed.assertForOverFulfill = true
    let decision = MobilePushPresentationCompletion { options in
      XCTAssertTrue(options.isEmpty)
      completed.fulfill()
    }
    XCTAssertTrue(decision.finish(suppress: true))
    XCTAssertFalse(decision.finish(suppress: false))
    wait(for: [completed], timeout: 1)
  }

  func testPresentationTimeoutUsesNormalOptionsAndRejectsLateAuthorization() {
    let completed = expectation(description: "normal deadline completion")
    completed.assertForOverFulfill = true
    let decision = MobilePushPresentationCompletion { options in
      XCTAssertEqual(options, [.banner, .list, .sound])
      completed.fulfill()
    }
    wait(for: [completed], timeout: 2)
    XCTAssertFalse(decision.finish(suppress: true))
  }

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

  func testStoreUsesOneStableInstallationAndPersistsActivationUntilAcknowledged() {
    let suite = "mobile-push-tests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let store = MobilePushStore(defaults: defaults)
    XCTAssertEqual(store.installationId(), store.installationId())

    let first = MobilePushRoute(
      notificationId: "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
      messageId: "message_1",
      targetId: "channel_2",
      viewerUserId: "viewer_a"
    )
    let second = MobilePushRoute(
      notificationId: "5f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
      messageId: "message_2",
      targetId: "channel_3",
      viewerUserId: "viewer_b"
    )
    store.saveActivation(first, deliveredNotificationIdentifier: "apns-delivered-1")
    store.saveActivation(second, deliveredNotificationIdentifier: "apns-delivered-2")
    XCTAssertEqual(store.peekActivation(), first)
    XCTAssertEqual(store.peekActivation(), first)
    XCTAssertTrue(store.ackActivation(first.notificationId))
    XCTAssertEqual(store.peekActivation(), second)
    store.clearViewerPending("viewer_b")
    XCTAssertNil(store.peekActivation())

    XCTAssertNil(store.deliveredNotificationIdentifier(for: "another-notification"))
    XCTAssertEqual(
      store.deliveredNotificationIdentifier(for: first.notificationId),
      "apns-delivered-1"
    )
    XCTAssertEqual(
      store.deliveredNotificationIdentifier(for: second.notificationId),
      "apns-delivered-2"
    )
    store.completeDeliveredNotificationIdentifier(for: first.notificationId)
    XCTAssertNil(store.deliveredNotificationIdentifier(for: first.notificationId))
    XCTAssertEqual(
      store.deliveredNotificationIdentifier(for: second.notificationId),
      "apns-delivered-2"
    )
  }

  func testDeliveredViewerSelectionMatchesOnlyExactViewerAcrossConversations() {
    let b1: [AnyHashable: Any] = [
      "notificationId": "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
      "messageId": "message_1",
      "targetId": "channel_1",
      "viewerUserId": "viewer_b",
    ]
    let b2: [AnyHashable: Any] = [
      "notificationId": "5f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
      "messageId": "message_2",
      "targetId": "channel_2",
      "viewerUserId": "viewer_b",
    ]
    let a1: [AnyHashable: Any] = [
      "notificationId": "6f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
      "messageId": "message_3",
      "targetId": "channel_1",
      "viewerUserId": "viewer_a",
    ]
    XCTAssertEqual(
      mobilePushDeliveredNotificationIdentifiersForViewer(
        viewerUserId: "viewer_b",
        delivered: [
          ("ios-b1", b1),
          ("ios-b2", b2),
          ("ios-a1", a1),
        ]
      ),
      ["ios-b1", "ios-b2"]
    )
  }

  func testRelaunchRequiresASystemTokenAndRetainsInstallationAndOwnershipProof() {
    let suite = "mobile-push-tests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let old = "token-00000000000"
    let current = "token-11111111111"
    let newer = "token-22222222222"
    defaults.set(old, forKey: "alook.mobilePush.currentToken")
    defaults.set(old, forKey: "alook.mobilePush.acknowledgedToken")
    let store = MobilePushStore(defaults: defaults)
    let installation = store.installationId()
    XCTAssertNil(store.registration().currentToken)
    XCTAssertNil(defaults.string(forKey: "alook.mobilePush.currentToken"))
    XCTAssertEqual(store.registration().acknowledgedToken, old)

    XCTAssertTrue(store.updateCurrentToken(current))
    XCTAssertFalse(store.updateCurrentToken(current))
    XCTAssertEqual(store.registration().currentToken, current)
    XCTAssertEqual(store.registration().previousToken, old)
    XCTAssertTrue(store.updateCurrentToken(newer))
    XCTAssertTrue(store.acknowledge(current))
    XCTAssertEqual(store.registration().currentToken, newer)
    XCTAssertEqual(store.registration().previousToken, current)

    let relaunched = MobilePushStore(defaults: defaults)
    XCTAssertEqual(relaunched.installationId(), installation)
    XCTAssertNil(relaunched.registration().currentToken)
    XCTAssertEqual(relaunched.registration().acknowledgedToken, current)
    XCTAssertTrue(relaunched.updateCurrentToken(newer))
    XCTAssertEqual(relaunched.registration().currentToken, newer)
    XCTAssertEqual(relaunched.registration().previousToken, current)
  }

  func testDelegateRefreshRetainsWeakDelegateWhenOriginalOwnerReleasesOnNil() {
    final class FakeDelegate: NSObject {}

    var strongOwner: FakeDelegate? = FakeDelegate()
    weak var weakDelegate = strongOwner
    weak var applicationDelegate: FakeDelegate? = strongOwner
    var retained: [FakeDelegate] = []
    var assignedNil = false

    func runRefresh() {
      guard let delegate = applicationDelegate else {
        XCTFail("Expected initial delegate")
        return
      }
      MobilePushDelegateHooks.refreshDelegateSelectorCache(
        current: { applicationDelegate },
        assign: { next in
          if next == nil {
            assignedNil = true
            strongOwner = nil
          }
          applicationDelegate = next
        },
        expected: delegate,
        retain: { retained.append($0) }
      )
    }

    runRefresh()

    XCTAssertTrue(assignedNil)
    XCTAssertNil(strongOwner)
    XCTAssertNotNil(weakDelegate)
    XCTAssertTrue(applicationDelegate === weakDelegate)
    XCTAssertEqual(retained.count, 1)
    XCTAssertTrue(retained.first === weakDelegate)

    let replacement = FakeDelegate()
    applicationDelegate = replacement
    var clobbered = false
    MobilePushDelegateHooks.refreshDelegateSelectorCache(
      current: { applicationDelegate },
      assign: { _ in clobbered = true },
      expected: weakDelegate!,
      retain: { retained.append($0) }
    )
    XCTAssertFalse(clobbered)
    XCTAssertTrue(applicationDelegate === replacement)
    XCTAssertEqual(retained.count, 1)
  }
}
