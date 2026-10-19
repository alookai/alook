import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


class ProvisioningRuntime(unittest.TestCase):
    def test_vendor_lifecycle_and_protected_endpoint(self):
        manager = r'''
#pragma once
#include <cstdint>
#include <cstddef>
#include <sys/types.h>
#include <string>
#include <vector>
#include <set>
inline std::set<std::string> muted;
using esp_err_t = int;
constexpr int ESP_OK=0, ESP_ERR_INVALID_ARG=1, ESP_ERR_NO_MEM=2;
enum network_prov_cb_event_t { NETWORK_PROV_WIFI_CRED_SUCCESS, NETWORK_PROV_WIFI_CRED_FAIL, NETWORK_PROV_END };
struct network_prov_event_handler_t { void(*event_cb)(void*,network_prov_cb_event_t,void*); void* user_data; };
#define NETWORK_PROV_EVENT_HANDLER_NONE {nullptr,nullptr}
struct network_prov_mgr_config_t { int scheme; network_prov_event_handler_t scheme_event_handler,app_event_handler; };
using Endpoint=esp_err_t(*)(uint32_t,const uint8_t*,ssize_t,uint8_t**,ssize_t*,void*);
inline network_prov_mgr_config_t configuration{};
inline Endpoint endpoint=nullptr;
inline void* endpoint_context=nullptr;
inline std::vector<std::string> calls;
inline std::string failed_call,pop,name;
inline uint32_t clock_ms=100;
inline int call(const char* value) { calls.push_back(value); return failed_call==value ? 7 : ESP_OK; }
inline void emit(network_prov_cb_event_t event) { configuration.app_event_handler.event_cb(configuration.app_event_handler.user_data,event,nullptr); }
inline int network_prov_mgr_init(network_prov_mgr_config_t value) { configuration=value; if(!muted.count("network_prov_mgr") || !muted.count("network_prov_handlers") || !muted.count("protocomm_security1") || !muted.count("wifi")) return 9; return call("init"); }
inline int network_prov_mgr_disable_auto_stop(uint32_t delay) { if(delay!=1000) return 9; return call("disable-stop"); }
inline int network_prov_mgr_endpoint_create(const char* value) { if(std::string(value)!="alook-auth") return 9; return call("create"); }
constexpr int NETWORK_PROV_SECURITY_1=1;
inline int network_prov_mgr_start_provisioning(int security,const void* proof,const char* device,const char* key) { if(security!=1 || key) return 9; pop=static_cast<const char*>(proof); name=device; return call("start"); }
inline int network_prov_mgr_endpoint_register(const char*,Endpoint callback,void* context) { endpoint=callback; endpoint_context=context; return call("register"); }
inline void network_prov_mgr_stop_provisioning() { call("stop"); }
inline void network_prov_mgr_deinit() { call("deinit"); emit(NETWORK_PROV_END); endpoint=nullptr; }
inline int network_prov_mgr_reset_wifi_sm_state_on_failure() { return call("reset-failure"); }
'''
        files = {
            'network_provisioning/manager.h': manager,
            'network_provisioning/scheme_ble.h': '#pragma once\n#include "manager.h"\ninline int network_prov_scheme_ble=42;\ninline int network_prov_scheme_ble_set_service_uuid(uint8_t*) { return call("uuid"); }\n',
            'Arduino.h': '#pragma once\n#include <string>\n#include <network_provisioning/manager.h>\nusing String=std::string;\ninline uint32_t millis(){return clock_ms;}\n',
            'WiFi.h': '#pragma once\nstruct { struct { bool begin(bool persist){ return !persist; } } STA; } WiFi;\n',
            'BLEUUID.h': '#pragma once\n#include <Arduino.h>\nstruct Native { union {uint8_t uuid128[16];} uuid; };\nclass BLEUUID { Native native{}; public: explicit BLEUUID(String){} Native* getNative(){return &native;} };\n',
            'esp_log.h': '#pragma once\nconstexpr int ESP_LOG_NONE=0;\ninline void esp_log_level_set(const char* tag,int level){if(level==ESP_LOG_NONE)muted.insert(tag);}\n',
            'esp_random.h': '#pragma once\n#include <cstdint>\n#include <cstddef>\ninline void esp_fill_random(void* out,size_t size){for(size_t i=0;i<size;++i)static_cast<uint8_t*>(out)[i]=static_cast<uint8_t>(i);}\n',
        }
        harness = r'''
#include "provisioning.cpp"
#include <cassert>
#include <algorithm>
using namespace alook_touch;
std::string exchange(const std::string& request,int expected=ESP_OK) {
  uint8_t* output=nullptr; ssize_t size=0;
  assert(endpoint && endpoint(7,reinterpret_cast<const uint8_t*>(request.data()),request.size(),&output,&size,endpoint_context)==expected);
  std::string response; if(output) { response.assign(reinterpret_cast<char*>(output),size); free(output); }
  return response;
}
unsigned count(const std::string& value) { return std::count(calls.begin(),calls.end(),value); }
int main() {
  Provisioning setup;
  assert(!setup.start("ALOOK_TOUCH_bad") && calls.empty());
  assert(setup.start("ALOOK_TOUCH_A1B2C3") && setup.active());
  assert((calls==std::vector<std::string>{"init","uuid","disable-stop","create","start","register"}));
  assert(configuration.scheme==42 && configuration.scheme_event_handler.event_cb==nullptr);
  JsonDocument qr; assert(!deserializeJson(qr,setup.qr()));
  assert(qr["security"]==1 && qr["name"]==name && qr["pop"]==pop && pop.size()==32);
  assert(qr["service_uuid"]==provision_service_uuid && qr["transport"]=="ble");
  assert(exchange(R"({"action":"code"})")==R"({"state":"pending"})");
  emit(NETWORK_PROV_WIFI_CRED_FAIL); assert(setup.take_failure() && !setup.take_failure()); assert(count("reset-failure")==1);
  emit(NETWORK_PROV_WIFI_CRED_SUCCESS); assert(setup.take_configured() && !setup.take_configured());
  assert(setup.set_code("ABCD1234",clock_ms,1000));
  exchange(R"({"action":"ack","user_code":"WXYZ-5678"})",ESP_ERR_INVALID_ARG); assert(count("stop")==0);
  assert(exchange(R"({"action":"code"})")==R"({"state":"ready","user_code":"ABCD1234"})");
  exchange(R"({"action":"code","token":"must-reject"})",ESP_ERR_INVALID_ARG);
  assert(exchange(R"({"action":"ack","user_code":"ABCD1234"})")==R"({"state":"ready","user_code":"ABCD1234"})");
  assert(count("stop")==1 && setup.active() && count("deinit")==0);
  setup.tick(clock_ms); assert(setup.active());
  emit(NETWORK_PROV_END); setup.tick(clock_ms); assert(!setup.active() && setup.qr().empty() && count("deinit")==1);
  calls.clear(); assert(setup.start("ALOOK_TOUCH_000001")); clock_ms+=300000; setup.tick(clock_ms); setup.tick(clock_ms);
  assert(count("stop")==1 && setup.active()); emit(NETWORK_PROV_END); setup.tick(clock_ms); assert(!setup.active());
  for(const auto stage : {"uuid","disable-stop","create","start","register"}) {
    calls.clear(); failed_call=stage; assert(!setup.start("ALOOK_TOUCH_000001"));
    assert(!setup.active() && setup.qr().empty() && count("deinit")==1);
  }
  calls.clear(); failed_call="init"; assert(!setup.start("ALOOK_TOUCH_000001") && count("deinit")==0);
  failed_call.clear(); assert(setup.start("ALOOK_TOUCH_000001")); setup.stop(); setup.stop();
  assert(!setup.active());
}
'''
        compiler = os.environ.get('CXX') or shutil.which('clang++') or shutil.which('g++')
        self.assertIsNotNone(compiler)
        with tempfile.TemporaryDirectory(prefix='alook-touch-provisioning-') as directory:
            root = pathlib.Path(directory)
            for name, text in files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text)
            (root / 'runtime.cpp').write_text(harness)
            binary = root / 'runtime'
            subprocess.run([compiler, '-std=c++17', '-Wall', '-Wextra', '-Werror', '-pedantic', '-I' + str(root), '-I' + str(ROOT / 'firmware/touch'), '-I' + str(ROOT / '.cache/sketchbook/libraries/ArduinoJson-7.4.3/src'), str(root / 'runtime.cpp'), '-o', str(binary)], check=True)
            subprocess.run([str(binary)], check=True)


if __name__ == '__main__':
    unittest.main()
