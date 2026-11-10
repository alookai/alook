#include <os/log.h>
#include <pthread.h>
#include <stddef.h>
#include <stdint.h>

static os_log_t startup_logger;
static pthread_once_t startup_logger_once = PTHREAD_ONCE_INIT;

static void initialize_startup_logger(void) {
    startup_logger = os_log_create("ai.alook.startup", "startup");
}

void alook_startup_system_log(const uint8_t *bytes, size_t length) {
    pthread_once(&startup_logger_once, initialize_startup_logger);
    os_log_with_type(startup_logger, OS_LOG_TYPE_DEFAULT, "alook_startup %{public}.*s",
        (int)length, (const char *)bytes);
}
