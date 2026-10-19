#include "../firmware/touch/requests_protocol.h"
#include "../firmware/touch/ownership.h"
#include <cassert>
#include <iostream>
using namespace alook_touch;
int main() {
  JsonDocument document;
  assert(!deserializeJson(document, R"({"pending":[{"id":"new","userId":"human","name":"Human","kind":"incoming","needsOwnerApproval":null},{"id":"out","userId":"bot","name":"Bot","kind":"outgoing","needsOwnerApproval":null},{"id":"old","userId":"other","name":"Other","kind":"incoming","needsOwnerApproval":"owner"}]})"));
  std::vector<FriendRequestItem> rows;
  assert(read_requests(document.as<JsonVariantConst>(), rows));
  assert(rows.size() == 2 && rows[0].id == "new" && rows[1].id == "old" && rows[1].needs_owner_approval);
  document["stale"] = true;
  assert(!read_requests(document.as<JsonVariantConst>(), rows) && rows.size() == 2);
  document.remove("stale");
  document["pending"][1]["id"] = "new";
  assert(!read_requests(document.as<JsonVariantConst>(), rows) && rows[0].id == "new");
  document["pending"][1]["id"] = "out";
  document["pending"][1]["needsOwnerApproval"] = false;
  assert(!read_requests(document.as<JsonVariantConst>(), rows) && rows.size() == 2);
  document["pending"].to<JsonArray>();
  assert(read_requests(document.as<JsonVariantConst>(), rows) && rows.empty());
  document["pending"] = nullptr;
  assert(!read_requests(document.as<JsonVariantConst>(), rows));
  deserializeJson(document, R"({"id":"accepted","status":"accepted","addresseeId":"me"})");
  assert(accepted_request(document.as<JsonVariantConst>(), "accepted", "me"));
  assert(!accepted_request(document.as<JsonVariantConst>(), "other", "me"));
  assert(!accepted_request(document.as<JsonVariantConst>(), "accepted", "other"));
  document["status"] = "pending";
  assert(!accepted_request(document.as<JsonVariantConst>(), "accepted", "me"));
  Interaction app; app.sign_in("me"); app.enter(Page::Profile);
  const auto card = app.owner();
  assert(app.show_requests() && !app.accepts_profile(card));
  const auto list = app.owner();
  app.enter(Page::Home); app.enter(Page::Profile);
  assert(!app.accepts_profile(list) && !app.profile_requests_only);
  std::cout << "touch received requests preserve canonical order, reject stale/error and retire visits\n";
}
