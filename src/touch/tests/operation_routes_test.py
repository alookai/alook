import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import unittest
from display_frame_test import function

ROOT = pathlib.Path(__file__).resolve().parents[1]


class OperationRoutes(unittest.TestCase):
    def test_actual_handlers_and_network_landing_pages(self):
        source = (ROOT / 'firmware/touch/application.cpp').read_text()
        ui = (ROOT / 'firmware/touch/ui.h').read_text()
        network = (ROOT / 'firmware/touch/alook_network.h').read_text()
        action = re.search(r'enum class Action \{[^}]+\};', ui).group()
        operation = re.search(r'enum class Operation \{[^}]+\};', network).group()
        data = ui[ui.index('struct BotItem'):ui.index('class Ui {')]
        harness = r'''
#include "ownership.h"
#include "pending.h"
#include "dm.h"
#include "history.h"
#include "requests.h"
#include "update_state.h"
#include <ArduinoJson.h>
#include <cassert>
#include <memory>
#include <utility>
#include <vector>
#include <functional>
using namespace alook_touch;
uint32_t millis() { return 1234; }
'''
        harness += action + '\n' + operation + '\n' + data
        harness += r'''
std::string json(const JsonDocument& doc) { std::string out; serializeJson(doc, out); return out; }
std::string encode(const std::string& value) { return value; }
std::string random_id() { return "test-nonce"; }
struct AudioClip {};
struct Request {
 Operation operation; Owner owner{}; std::string method,path,body,token,target; std::shared_ptr<AudioClip> audio; uint32_t id=0;
 explicit Request(Operation op) : operation(op) {}
};
struct Network {
 bool accept=true; std::vector<Request> commands;
 bool submit(Request command) { commands.push_back(std::move(command)); return accept; }
 unsigned count(Operation operation) const { return std::count_if(commands.begin(),commands.end(),[&](const auto& item) { return item.operation==operation; }); }
};
struct Audio {
  unsigned cancelled=0; bool available=true, long_enough=true;
  void cancel() { ++cancelled; }
  bool start() { return available; }
  std::shared_ptr<AudioClip> finish() { return long_enough ? std::make_shared<AudioClip>() : nullptr; }
};
struct Portal {
  bool active=false, available=true; unsigned starts=0, stops=0;
  bool startConfigPortal(const char*, const char*) { ++starts; active=available; return false; }
  bool getConfigPortalActive() { return active; }
  void stopConfigPortal() { ++stops; active=false; }
};
struct Nearby { std::string peer() { return "Peer#0042"; } };
struct Ui { unsigned latest=0; std::string notice; void scroll_to_latest() { ++latest; } void notify(std::string text) { notice=std::move(text); } };
struct Storage { uint8_t value=240; uint8_t brightness() { return value; } void brightness(uint8_t next) { value=next; } };
void board_brightness(uint8_t) {}
class Application {
public:
  Interaction state_; UiData data_; Audio audio_; Portal provisioning_; Nearby nearby_; Ui ui_; Storage storage_;
  bool online_=true,portal_=false,network_attempted_=false, checking_session_=false;
  std::string hotspot_="TestTouch",hotspot_password_="test-only",device_code_,device_name_="Touch firmware/test";
  std::string older_cursor_,newer_cursor_,peer_id_="peer",peer_code_="Peer#0042",friendship_="friendship";
  std::string update_manifest_,update_tag_; uint32_t auth_lifetime_=0,boot_=0,dms_at_=0;
  struct Session { std::string token; } session_;
  unsigned rendered=0,profiles_left=0,dms=0,metadata=0,requests=0,history=0,authorized=0,validated=0,selected=99,sends=0;
  std::string history_window,visible_error;
  Network network_;
  PendingRequests<static_cast<size_t>(Operation::SocketClosed)+1> pending_;
  void render() { ++rendered; visible_error=state_.page==Page::DmList ? data_.dm_error : data_.error; }
  void leave_profile() { ++profiles_left; }
  void refresh_requests() { ++requests; }
  void refresh_dms();
  void refresh_dm() { ++metadata; }
  void select_dm(size_t index) { selected=index; if(index<data_.dms.size()) state_.select_recipient(data_.dms[index].user_id,data_.dms[index].id); }
  void request_history(const std::string& window="tail",const std::string& ="") { ++history; history_window=window; }
  void authorize() { ++authorized; state_.page=Page::Authorization; }
  void validate_session() { ++validated; }
  void retire_session(bool) { state_.sign_out(); }
  bool request(Operation,const std::string&,const std::string&,const std::string& ="",const std::string& ="",std::shared_ptr<AudioClip> =nullptr,bool=false);
  void enter(Page); void start_network_setup(); void finish_network_setup(); void clear_dm_access();
  void action(Action,int=0); void recording_start(); void recording_finish(); void send();
  void network_tick(uint32_t now);
  void transcript(const std::string& text);
};
'''
        for name in ['request(Operation operation, const std::string& method, const std::string& path, const std::string& body, const std::string& target, std::shared_ptr<AudioClip> audio, bool show_failure)', 'refresh_dms()', 'enter(Page page)', 'start_network_setup()', 'finish_network_setup()', 'clear_dm_access()', 'action(Action command, int argument)', 'recording_start()', 'recording_finish()', 'send()']:
            harness += function(source, ('bool' if name.startswith('request(') else 'void') + ' Application::' + name) + '\n'
        start = source.index('  if (state_.page == Page::Network) {', source.index('void Application::tick()'))
        end = source.index('  if (state_.page == Page::Authorization', start)
        harness += '#define time(...) 1800000000\nvoid Application::network_tick(uint32_t now) {\n' + source[start:end] + '}\n#undef time\n'
        start = source.index('    case Operation::Transcribe: {')
        end = source.index('    case Operation::Send:', start)
        harness += 'void Application::transcript(const std::string& input) { JsonDocument document; document["text"] = input; struct { Owner owner; } result{state_.owner()}; switch(Operation::Transcribe) {\n' + source[start:end] + 'default: assert(false); } }\n'
        harness += r'''
Application ready() {
  Application app; app.state_.sign_in("human"); app.state_.select_recipient("peer","dm");
  app.data_.dm_can_read=app.data_.dm_can_send=true;
  app.data_.dms={{"dm","peer","Peer#0042","",false,false,false,"","",true},{"other-dm","other","Other#0043","",false,false,false,"","",true}};
  return app;
}
int main() {
  for(const auto command : {Action::AddFriend,Action::AcceptFriend,Action::AcceptRequest}) {
    auto rejected=ready(); rejected.state_.enter(Page::Profile);
    rejected.data_.requests={{"request","peer","Peer","incoming"}};
    rejected.network_.accept=false; const auto before=rejected.rendered;
    rejected.action(command,0);
    assert(rejected.network_.commands.size()==1 && rejected.rendered>before);
    assert(rejected.visible_error=="Connection busy. Try again." && rejected.data_.request_busy.empty());
    rejected.network_.accept=true; rejected.data_.error.clear(); rejected.action(command,0);
    assert(rejected.network_.commands.size()==2);
    const auto waiting=rejected.rendered;
    rejected.action(command,0);
    assert(rejected.network_.commands.size()==2 && rejected.rendered==waiting && rejected.data_.error.empty());
  }
  {
    auto list=ready(); list.data_.dms_loaded=true; list.network_.accept=false;
    list.action(Action::Dms);
    assert(list.state_.page==Page::DmList && list.data_.dms.size()==2);
    assert(list.visible_error=="Connection busy. Refresh to try again.");
    list.network_.accept=true; list.action(Action::Dms);
    assert(list.data_.dm_error.empty() && list.network_.commands.size()==2);
    list.action(Action::Dms);
    assert(list.data_.dm_error.empty() && list.network_.commands.size()==2);
  }
  auto app=ready(); app.action(Action::Settings); assert(app.state_.page==Page::Settings);
  app.action(Action::Logout); assert(app.state_.page==Page::LogoutConfirmation);
  app.action(Action::Back); assert(app.state_.page==Page::Settings);
  app.action(Action::SetupNetwork); assert(app.state_.page==Page::Network && app.portal_);
  app.network_tick(20000); assert(app.portal_ && app.state_.page==Page::Network && !app.validated && !app.authorized);
  app.recording_start(); assert(app.state_.page==Page::Network && app.state_.voice==VoicePhase::Empty && app.portal_);
  assert(app.ui_.notice=="Finish Wi-Fi setup before recording.");
  auto late=ready(); late.portal_=true; late.provisioning_.active=false;
  late.state_.start_recording(); late.finish_network_setup();
  assert(late.state_.page==Page::Recording && late.state_.voice==VoicePhase::Recording && !late.portal_);
  app.action(Action::SetupNetwork); assert(app.provisioning_.starts==2 && app.provisioning_.stops==1);
  app.action(Action::Back); assert(!app.portal_ && app.state_.page==Page::Settings && app.data_.qr.empty());
  app.action(Action::SetupNetwork); app.provisioning_.active=false; app.finish_network_setup();
  assert(app.state_.page==Page::Settings && !app.portal_ && app.state_.authenticated);
  app.action(Action::SetupNetwork); app.online_=false; app.finish_network_setup();
  assert(app.state_.page==Page::Settings && app.data_.status=="Wi-Fi: offline");
  app.provisioning_.available=false; app.action(Action::SetupNetwork);
  assert(!app.portal_ && app.state_.page==Page::Settings && !app.data_.error.empty());
  Application initial; initial.online_=false; initial.state_.page=Page::Network;
  initial.network_tick(12000); assert(initial.portal_ && initial.network_attempted_);
  initial.action(Action::Back); assert(!initial.portal_ && initial.state_.page==Page::Network && initial.data_.qr.empty());
  initial.network_tick(13000); assert(!initial.portal_ && initial.provisioning_.starts==1);
  initial.action(Action::SetupNetwork); assert(initial.portal_ && initial.provisioning_.starts==2);
  initial.provisioning_.active=false; initial.finish_network_setup(); initial.online_=true; initial.network_tick(14000);
  assert(initial.state_.page==Page::Authorization && initial.authorized==1);
  app=ready(); app.action(Action::Chat); assert(app.state_.page==Page::Conversation && app.history==1);
  app.action(Action::Back); assert(app.state_.page==Page::Character);
  app.action(Action::AdjacentBot,1); assert(app.selected==1 && app.state_.recipient_id=="other");
  app.action(Action::Dms); assert(app.state_.page==Page::DmList && app.network_.count(Operation::Dms)==1);
  app.action(Action::OpenDm,0); assert(app.state_.page==Page::Character && app.selected==0);
  app.action(Action::Older); assert(app.history==1);
  app.older_cursor_="older"; app.action(Action::Older); assert(app.history_window=="before");
  app.newer_cursor_="newer"; app.action(Action::Newer); assert(app.history_window=="after");
  app.data_.has_newer=true; app.action(Action::Latest); assert(app.history_window=="tail");
  app.data_.has_newer=false; app.action(Action::Latest); assert(app.ui_.latest==1);
  app.action(Action::Profile); assert(app.state_.page==Page::Profile);
  app.action(Action::Requests); assert(app.state_.profile_requests_only);
  app.data_.requests={{"request","peer","Peer","incoming"}};
  app.online_=false; app.action(Action::AcceptRequest,0); assert(!app.data_.requests_error.empty() && app.data_.request_busy.empty());
  app.online_=true; app.action(Action::AcceptRequest,0); assert(app.data_.request_busy=="request" && app.network_.commands.back().operation==Operation::AcceptRequest);
  app=ready(); app.action(Action::Update); assert(app.state_.page==Page::FirmwareUpdate);
  app.online_=false; app.action(Action::CheckUpdate); assert(app.data_.update_phase==UpdatePhase::CheckFailed);
  app.online_=true; app.action(Action::CheckUpdate); assert(app.data_.update_phase==UpdatePhase::Checking);
  app.data_.update_phase=UpdatePhase::Available; app.update_manifest_="manifest";
  app.action(Action::InstallUpdate); assert(app.data_.update_phase==UpdatePhase::Installing);
  app.action(Action::Settings); app.action(Action::Cancel); app.recording_start(); assert(app.state_.page==Page::FirmwareUpdate);
  app=ready(); app.recording_start(); assert(app.state_.page==Page::Recording);
  app.recording_finish(); assert(app.state_.page==Page::Transcribing);
  app.transcript(std::string(16001,'x')); assert(app.state_.page==Page::Review && app.state_.voice==VoicePhase::Failed);
  app.action(Action::Rerecord); assert(app.state_.page==Page::RecordReady);
  app.recording_start(); app.recording_finish(); app.transcript("draft");
  app.action(Action::Send); assert(app.state_.voice==VoicePhase::Sending && app.network_.count(Operation::Send)==1);
  app.action(Action::Cancel); assert(app.state_.voice==VoicePhase::Sending);
  app.pending_.complete(static_cast<size_t>(Operation::Send),app.network_.commands.back().id); app.state_.failed_send(app.state_.owner()); app.action(Action::Retry); assert(app.network_.count(Operation::Send)==2 && app.state_.nonce=="test-nonce");
  for(int phase=0;phase<5;++phase) {
    app=ready(); app.recording_start(); const auto owner=app.state_.owner();
    if(phase>=1) app.recording_finish(); if(phase>=2) app.transcript("draft");
    if(phase>=3) app.action(Action::Send); if(phase==4) app.state_.failed_send(owner);
    app.data_.messages={{"message","Peer","private",false,1,"cursor"}}; app.older_cursor_="old"; app.newer_cursor_="new";
    app.clear_dm_access(); assert(app.state_.page==Page::Conversation && app.state_.voice==VoicePhase::Empty);
    assert(app.data_.messages.empty() && !app.data_.dm_can_read && !app.data_.dm_can_send);
    assert(app.older_cursor_.empty() && app.newer_cursor_.empty() && !app.state_.transcript(owner,"late"));
  }
  app=ready(); app.audio_.available=false; app.recording_start(); assert(app.state_.page==Page::Review && app.state_.voice==VoicePhase::Failed);
  app=ready(); app.audio_.long_enough=false; app.recording_start(); app.recording_finish(); assert(app.state_.page==Page::Review);
  app=ready(); app.network_.accept=false; app.recording_start(); app.recording_finish(); assert(app.state_.page==Page::Review);
}
'''
        compiler = os.environ.get('CXX') or shutil.which('clang++') or shutil.which('g++')
        self.assertIsNotNone(compiler)
        with tempfile.TemporaryDirectory(prefix='alook-touch-routes-') as directory:
            root = pathlib.Path(directory)
            test = root / 'routes.cpp'
            binary = root / 'routes'
            test.write_text(harness)
            subprocess.run([compiler, '-std=c++17', '-Wall', '-Wextra', '-Werror', '-pedantic', '-I' + str(ROOT / 'firmware/touch'), '-I' + str(ROOT / '.cache/sketchbook/libraries/ArduinoJson-7.4.3/src'), str(test), '-o', str(binary)], check=True)
            subprocess.run([str(binary)], check=True)


if __name__ == '__main__':
    unittest.main()
