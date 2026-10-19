#include "../firmware/touch/ownership.h"
#include <cassert>
#include <iostream>

using namespace alook_touch;

int main() {
  {
    Interaction navigation;
    navigation.sign_in("human"); navigation.select_recipient("peer", "dm");
    navigation.enter(Page::Settings); navigation.enter(Page::LogoutConfirmation);
    assert(navigation.back() && navigation.page == Page::Settings);
    navigation.enter(Page::Conversation);
    assert(navigation.back() && navigation.page == Page::Character);
    navigation.enter(Page::Network);
    assert(navigation.back() && navigation.page == Page::Settings);
    navigation.sign_out();
    assert(!navigation.back() && navigation.page == Page::Authorization);
  }
  Interaction app;
  assert(!app.enter(Page::Profile));
  assert(!app.start_recording());
  app.sign_in("human-a");
  assert(app.select_recipient("bot-a"));
  assert(app.enter(Page::Profile));
  const auto profile = app.owner();
  assert(app.accepts_profile(profile));
  app.enter(Page::Home);
  assert(!app.accepts_profile(profile));
  app.enter(Page::Profile);
  assert(!app.accepts_profile(profile));
  assert(app.start_recording());
  auto recording = app.owner();
  assert(!app.select_recipient("bot-b"));
  assert(!app.confirm("nonce-1"));
  assert(app.finish_recording());
  assert(!app.confirm("nonce-1"));
  assert(app.transcript(recording, "完整的中文草稿，with English"));
  assert(app.page == Page::Review);
  assert(app.prepare_recording());
  assert(app.page == Page::RecordReady && app.voice == VoicePhase::Empty && app.draft.empty());
  assert(!app.finish_recording());
  assert(!app.transcript(recording, "late old transcript"));
  assert(app.start_recording());
  recording = app.owner();
  assert(app.finish_recording());
  assert(app.transcript(recording, "new recording after BOOT press and release"));
  assert(app.confirm("nonce-1"));
  assert(!app.prepare_recording());
  assert(!app.confirm("nonce-2"));
  assert(!app.cancel_draft());
  assert(!app.sent(recording, "nonce-other"));
  assert(app.failed_send(recording));
  assert(app.retry());
  assert(app.nonce == "nonce-1");
  assert(app.sent(recording, "nonce-1"));
  assert(app.page == Page::Conversation && app.draft.empty());
  assert(app.select_recipient("bot-b"));
  assert(!app.accepts_recipient(recording));
  assert(app.start_recording());
  recording = app.owner();
  assert(app.finish_recording());
  assert(app.cancel_draft());
  assert(!app.transcript(recording, "late transcript"));
  assert(app.start_recording());
  recording = app.owner();
  assert(app.finish_recording());
  app.sign_out();
  app.sign_in("human-b");
  assert(app.select_recipient("bot-a"));
  assert(!app.transcript(recording, "previous account secret"));
  assert(!app.sent(recording, "nonce-1"));
  assert(!app.accepts_account(profile));
  assert(app.user_id == "human-b" && app.draft.empty());
  app.enter(Page::Profile);
  const auto discovered = app.owner();
  assert(!app.profile_requests_only && app.show_requests());
  assert(app.page == Page::Profile && app.profile_requests_only);
  assert(!app.accepts_profile(discovered));
  const auto requests_owner = app.owner();
  assert(!app.show_requests());
  assert(app.accepts_profile(requests_owner));
  app.enter(Page::Profile);
  assert(app.profile_requests_only);
  assert(app.home() && !app.profile_requests_only);
  app.enter(Page::Profile);
  assert(!app.profile_requests_only && !app.accepts_profile(requests_owner));
  assert(app.show_requests());
  app.sign_out();
  assert(!app.profile_requests_only && !app.show_requests());
  for (int phase = 0; phase < 5; ++phase) {
    Interaction navigation;
    navigation.sign_in("human"); navigation.select_recipient("bot");
    navigation.start_recording();
    const auto original = navigation.owner();
    if (phase >= 1) navigation.finish_recording();
    if (phase >= 2) navigation.transcript(original, "draft");
    if (phase >= 3) navigation.confirm("nonce");
    if (phase == 4) navigation.failed_send(original);
    if (phase == 3) {
      assert(!navigation.home());
      assert(navigation.voice == VoicePhase::Sending && navigation.page == Page::Review);
      assert(navigation.draft == "draft" && navigation.nonce == "nonce");
    } else {
      assert(navigation.home());
      assert(navigation.page == Page::Character && navigation.voice == VoicePhase::Empty);
      assert(navigation.draft.empty() && !navigation.accepts_recipient(original));
      assert(navigation.home() && navigation.page == Page::Home);
    }
  }
  std::cout << "touch ownership journeys passed\n";
}
