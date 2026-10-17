#pragma once
#include <cstdint>
#include <string>

namespace alook_touch {
enum class Page { Startup, Network, Authorization, Character, Home, Profile, Bots, Conversation, RecordReady, Recording, Transcribing, Review, Settings, LogoutConfirmation, DmList, FirmwareUpdate };
enum class VoicePhase { Empty, Recording, Transcribing, Review, Sending, Failed };

struct Owner {
  uint32_t account;
  uint32_t recipient;
  uint32_t profile;
};

class Interaction {
public:
  Page page = Page::Startup;
  VoicePhase voice = VoicePhase::Empty;
  std::string user_id;
  std::string recipient_id;
  std::string channel_id;
  std::string draft;
  std::string draft_recipient;
  std::string nonce;
  bool authenticated = false;
  bool profile_requests_only = false;

  Owner owner() const { return {account_, recipient_, profile_}; }
  bool accepts_account(Owner value) const { return authenticated && value.account == account_; }
  bool accepts_recipient(Owner value) const { return accepts_account(value) && value.recipient == recipient_; }
  bool accepts_profile(Owner value) const { return accepts_account(value) && page == Page::Profile && value.profile == profile_; }

  void sign_in(const std::string& id) {
    sign_out();
    authenticated = true;
    user_id = id;
    page = Page::DmList;
  }

  void sign_out() {
    ++account_;
    ++recipient_;
    ++profile_;
    authenticated = false;
    profile_requests_only = false;
    user_id.clear();
    recipient_id.clear();
    channel_id.clear();
    clear_draft();
    page = Page::Authorization;
  }

  bool select_recipient(const std::string& id, const std::string& channel = "") {
    if (!authenticated || voice != VoicePhase::Empty || id.empty()) return false;
    if (recipient_id != id || channel_id != channel) ++recipient_;
    recipient_id = id;
    channel_id = channel;
    enter(Page::Character);
    return true;
  }

  void invalidate_recipient(bool clear_selection = false) {
    ++recipient_;
    clear_draft();
    if (clear_selection) { recipient_id.clear(); channel_id.clear(); }
  }

  bool enter(Page next) {
    if (!authenticated && next != Page::Startup && next != Page::Network && next != Page::Authorization) return false;
    if (next != page && (next == Page::Profile || page == Page::Profile)) { ++profile_; profile_requests_only = false; }
    page = next;
    return true;
  }

  bool show_requests() {
    if (!authenticated || page != Page::Profile || voice != VoicePhase::Empty || profile_requests_only) return false;
    ++profile_;
    profile_requests_only = true;
    return true;
  }

  bool prepare_recording() {
    if (!authenticated || recipient_id.empty() || voice == VoicePhase::Sending) return false;
    if (!cancel_draft()) return false;
    enter(Page::RecordReady);
    return true;
  }

  bool home() {
    if (!authenticated || voice == VoicePhase::Sending) return false;
    const Page destination = page == Page::Character || recipient_id.empty() ? Page::Home : Page::Character;
    if (voice != VoicePhase::Empty) cancel_draft();
    return enter(destination);
  }

  bool start_recording() {
    if (!authenticated || recipient_id.empty() || voice == VoicePhase::Sending || voice == VoicePhase::Transcribing) return false;
    clear_draft();
    draft_recipient = recipient_id;
    voice = VoicePhase::Recording;
    enter(Page::Recording);
    return true;
  }

  bool finish_recording() {
    if (voice != VoicePhase::Recording) return false;
    voice = VoicePhase::Transcribing;
    enter(Page::Transcribing);
    return true;
  }

  bool transcript(Owner original, const std::string& text) {
    if (!accepts_recipient(original) || voice != VoicePhase::Transcribing || draft_recipient != recipient_id) return false;
    if (text.empty()) { voice = VoicePhase::Failed; enter(Page::Review); return false; }
    draft = text;
    voice = VoicePhase::Review;
    enter(Page::Review);
    return true;
  }

  bool confirm(const std::string& intent_nonce) {
    if (voice != VoicePhase::Review || draft.empty() || draft_recipient != recipient_id || intent_nonce.empty()) return false;
    nonce = intent_nonce;
    voice = VoicePhase::Sending;
    return true;
  }

  bool failed_send(Owner original) {
    if (!accepts_recipient(original) || voice != VoicePhase::Sending) return false;
    voice = VoicePhase::Failed;
    return true;
  }

  bool retry() {
    if (voice != VoicePhase::Failed || draft.empty() || nonce.empty() || draft_recipient != recipient_id) return false;
    voice = VoicePhase::Sending;
    return true;
  }

  bool sent(Owner original, const std::string& echoed_nonce) {
    if (!accepts_recipient(original) || voice != VoicePhase::Sending || echoed_nonce != nonce) return false;
    clear_draft();
    enter(Page::Conversation);
    return true;
  }

  bool cancel_draft() {
    if (voice == VoicePhase::Sending) return false;
    ++recipient_;
    clear_draft();
    enter(Page::Character);
    return true;
  }

private:
  uint32_t account_ = 1;
  uint32_t recipient_ = 1;
  uint32_t profile_ = 1;
  void clear_draft() {
    voice = VoicePhase::Empty;
    draft.clear();
    draft_recipient.clear();
    nonce.clear();
  }
};
}
