#include "../firmware/touch/provisioning_grant.h"
#include <cassert>
#include <iostream>
#include <limits>
using namespace alook_touch;
int main() {
  ProvisioningGrant grant;
  std::string output;
  const auto exchange = [&](const std::string& input, uint32_t now) { return grant.exchange(reinterpret_cast<const uint8_t*>(input.data()), input.size(), now, output); };
  assert(exchange(R"({"action":"code"})", 0) && output == R"({"state":"pending"})");
  assert(!grant.set("bad", 0, 1000));
  for (const auto& code : {"ABCDEFG", "ABCDEFGHI", "ABC-23456", "ABCD--2345", "abcd2345", "ABCD2345\n"}) assert(!grant.set(code, 0, 1000));
  assert(!grant.set("ABCD1234", 0, 0));
  assert(grant.set("ABCD1234", 100, 1000));
  assert(exchange(R"({"action":"code"})", 1099) && output == R"({"state":"ready","user_code":"ABCD1234"})");
  assert(!exchange(R"({"action":"ack"})", 100));
  assert(!exchange(R"({"action":"ack","user_code":"OLD1-CODE"})", 100));
  assert(!exchange(R"({"action":"ack","user_code":"ABCD-1234"})", 100));
  assert(!exchange(R"({"action":"code","token":"forbidden"})", 100));
  assert(!exchange(std::string(97, 'x'), 100));
  assert(!grant.acknowledged());
  assert(grant.set("NEXT-5678", 200, 1000));
  assert(!exchange(R"({"action":"ack","user_code":"ABCD1234"})", 201));
  assert(!grant.acknowledged());
  assert(exchange(R"({"action":"ack","user_code":"NEXT-5678"})", 201));
  assert(grant.acknowledged());
  grant.clear();
  assert(!grant.acknowledged() && exchange(R"({"action":"code"})", 201) && output == R"({"state":"pending"})");
  const auto near_wrap = std::numeric_limits<uint32_t>::max() - 100;
  assert(grant.set("WRAP-1234", near_wrap, 1000));
  assert(exchange(R"({"action":"code"})", near_wrap + 999) && output.find("ready") != std::string::npos);
  assert(exchange(R"({"action":"code"})", near_wrap + 1000) && output == R"({"state":"pending"})");
  assert(!exchange(R"({"action":"ack","user_code":"WRAP-1234"})", near_wrap + 1000));
  std::cout << "Provisioning endpoint code lifetime, exact acknowledgement, refresh and input boundaries passed\n";
}
