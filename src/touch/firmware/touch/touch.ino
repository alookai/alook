#include "board.h"
#include "application.h"
SET_LOOP_TASK_STACK_SIZE(16 * 1024);

alook_touch::Application application;
bool display_ready = false;

void setup() {
  display_ready = alook_touch::board_begin();
  if (!display_ready) { Serial.println("Display initialization failed"); return; }
  if (!application.begin()) { Serial.println("Application initialization failed"); display_ready = false; }
}

void loop() {
  if (!display_ready) { delay(100); return; }
  alook_touch::board_tick();
  application.tick();
  delay(5);
}
