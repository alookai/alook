#include "../firmware/touch/update_protocol.h"
#include "../firmware/touch/ownership.h"
#include <cassert>
#include <iostream>
using namespace alook_touch;
int main() {
  std::array<uint32_t, 3> a, b;
  assert(numeric_version("1.10.0", a) && numeric_version("1.9.9", b) && a > b);
  for (const auto* invalid : {"", "v1.0.0", "1.0", "01.0.0", "1.0.0-beta", "999999999.0.0", "1.0.0/path"}) assert(!numeric_version(invalid, a));
  JsonDocument document;
  deserializeJson(document, R"({"schemaVersion":1,"component":"touch","version":"1.0.1","tag":"v1.0.1","sourceCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","hardware":"board","partitionLayout":"layout","binary":{"name":"alook-touch-1.0.1.bin","bytes":5000000,"sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}})");
  FirmwareManifest manifest;
  JsonDocument valid(document);
  assert(read_manifest(document.as<JsonVariantConst>(), "v1.0.1", "board", "layout", manifest));
  assert(manifest.bytes == 5000000);
  assert(!read_manifest(document.as<JsonVariantConst>(), "v1.0.2", "board", "layout", manifest));
  assert(!read_manifest(document.as<JsonVariantConst>(), "v1.0.1", "wrong board", "layout", manifest));
  assert(!read_manifest(document.as<JsonVariantConst>(), "v1.0.1", "board", "old layout", manifest));
  document["binary"]["bytes"] = 0xc80001;
  assert(!read_manifest(document.as<JsonVariantConst>(), "v1.0.1", "board", "layout", manifest));
  document["binary"]["bytes"] = 1;
  document["binary"]["name"] = "../../other.bin";
  assert(!read_manifest(document.as<JsonVariantConst>(), "v1.0.1", "board", "layout", manifest));
  JsonDocument release;
  deserializeJson(release, R"({"tag_name":"v1.0.1","draft":false,"prerelease":false,"assets":[{"name":"other-component.bin","state":"uploaded","browser_download_url":"https://github.com/alookai/alook/releases/download/v1.0.1/other-component.bin"}]})");
  std::string tag;
  assert(!touch_release(release.as<JsonVariantConst>(), tag));
  assert(!has_touch_assets(release.as<JsonVariantConst>()));
  auto assets = release["assets"].as<JsonArray>();
  for (const auto* name : {"alook-touch-manifest.json", "alook-touch-1.0.1.bin"}) {
    auto asset = assets.add<JsonObject>();
    asset["name"] = name; asset["state"] = "uploaded";
    asset["browser_download_url"] = release_base("v1.0.1") + name;
  }
  assert(touch_release(release.as<JsonVariantConst>(), tag) && tag == "v1.0.1");
  assert(has_touch_assets(release.as<JsonVariantConst>()));
  assets.remove(1);
  assert(has_touch_assets(release.as<JsonVariantConst>()) && !touch_release(release.as<JsonVariantConst>(), tag));
  auto manifest_asset = assets.add<JsonObject>();
  manifest_asset["name"] = "alook-touch-manifest.json"; manifest_asset["state"] = "uploaded";
  manifest_asset["browser_download_url"] = release_base("v1.0.1") + "alook-touch-manifest.json";
  release["draft"] = true;
  assert(!touch_release(release.as<JsonVariantConst>(), tag));
  release["draft"] = false;
  release["assets"][2]["browser_download_url"] = "https://other.invalid/manifest.json";
  assert(!touch_release(release.as<JsonVariantConst>(), tag));
  Interaction app; app.sign_in("me"); app.enter(Page::FirmwareUpdate);
  UpdateData data; data.firmware_version = "1.0.0"; data.update_phase = UpdatePhase::Checking;
  const auto check_owner = app.owner();
  app.enter(Page::Settings);
  assert(app.accepts_account(check_owner));
  assert(finish_update_check(data, true, valid.as<JsonVariantConst>(), "v1.0.1", data.firmware_version, "board", "layout"));
  assert(app.page == Page::Settings && data.update_phase == UpdatePhase::Available && data.available_version == "1.0.1" && data.firmware_version == "1.0.0");
  app.enter(Page::FirmwareUpdate);
  assert(data.update_phase == UpdatePhase::Available);
  data.update_phase = UpdatePhase::Checking; app.enter(Page::Home);
  assert(!finish_update_check(data, false, valid.as<JsonVariantConst>(), "v1.0.1", data.firmware_version, "board", "layout"));
  assert(app.page == Page::Home && data.update_phase == UpdatePhase::CheckFailed && data.available_version.empty() && data.firmware_version == "1.0.0");
  assert(finish_update_check(data, true, valid.as<JsonVariantConst>(), "v1.0.1", "1.0.1", "board", "layout") && data.update_phase == UpdatePhase::Current);
  assert(!finish_update_check(data, true, valid.as<JsonVariantConst>(), "v1.0.1", "1.0.0", "wrong board", "layout") && data.update_phase == UpdatePhase::CheckFailed);
  app.sign_out(); app.sign_in("replacement");
  assert(!app.accepts_account(check_owner));
  std::cout << "touch release skips missing assets and binds version, source, hardware, partition and image\n";
}
