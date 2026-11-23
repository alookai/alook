#include <dlfcn.h>
#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

extern char **environ;
enum { LAUNCH_ERROR = 125 };

int alook_macos_agent_exec(char *const argv[]) {
    if (!argv[0] || argv[0][0] != '/') return LAUNCH_ERROR;

    // Rust ignores SIGPIPE before main. A direct Node child starts with the default.
    if (signal(SIGPIPE, SIG_DFL) == SIG_ERR) {
        perror("Unable to restore SIGPIPE for the macOS agent");
        return LAUNCH_ERROR;
    }

    // macOS records the responsible executable at spawn. SETEXEC keeps the
    // same PID and process group already owned by the daemon's process host.
    int (*disclaim)(posix_spawnattr_t *, int) =
        dlsym(RTLD_DEFAULT, "responsibility_spawnattrs_setdisclaim");
    int error = ENOTSUP;
    if (disclaim) {
        posix_spawnattr_t attributes;
        error = posix_spawnattr_init(&attributes);
        if (!error) {
            error = posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETEXEC);
            if (!error) error = disclaim(&attributes, 1);
            if (!error) error = posix_spawn(NULL, argv[0], NULL, &attributes, argv, environ);
            posix_spawnattr_destroy(&attributes);
        }
    }
    if (error == ENOTSUP || error == ENOSYS) {
        fputs("Independent macOS agent identity is unavailable\n", stderr);
        execve(argv[0], argv, environ);
        error = errno;
    }
    fprintf(stderr, "Unable to execute the macOS agent: %s\n", strerror(error));
    return LAUNCH_ERROR;
}

#ifdef ALOOK_AGENT_LAUNCHER_STANDALONE
int main(int argc, char **argv) {
    return argc >= 3 && !strcmp(argv[1], "--alook-agent-exec")
        ? alook_macos_agent_exec(argv + 2) : LAUNCH_ERROR;
}
#endif
