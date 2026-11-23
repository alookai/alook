#include <CoreFoundation/CoreFoundation.h>
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/proc_info.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

enum { CONTROL = 3, START_TIMEOUT_MS = 3000, MAX_PAYLOAD = 4 * 1024 * 1024, LAUNCH_ERROR = 125 };

static int transfer(int fd, void *buffer, size_t size, int writing) {
    char *cursor = buffer;
    while (size) {
        ssize_t count = writing ? write(fd, cursor, size) : read(fd, cursor, size);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return -1;
        cursor += count;
        size -= (size_t)count;
    }
    return 0;
}

static int set_socket_timeout(int fd) {
    const struct timeval deadline = {.tv_sec = 3};
    const int no_sigpipe = 1;
    return setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &deadline, sizeof(deadline))
        || setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &deadline, sizeof(deadline))
        || setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &no_sigpipe, sizeof(no_sigpipe));
}

static int local_address(struct sockaddr_un *address, const char *path) {
    memset(address, 0, sizeof(*address));
    address->sun_family = AF_UNIX;
    if (strlcpy(address->sun_path, path, sizeof(address->sun_path)) >= sizeof(address->sun_path)) return -1;
    address->sun_len = SUN_LEN(address);
    return 0;
}

static int configure_terminal(int socket_fd, int sending) {
    char tag = 'S';
    struct iovec payload = {.iov_base = &tag, .iov_len = 1};
    union { struct cmsghdr aligned; unsigned char bytes[CMSG_SPACE(3 * sizeof(int))]; } ancillary;
    memset(&ancillary, 0, sizeof(ancillary));
    struct msghdr message = {.msg_iov = &payload, .msg_iovlen = 1,
        .msg_control = ancillary.bytes, .msg_controllen = sizeof(ancillary.bytes)};
    if (sending) {
        struct cmsghdr *control = CMSG_FIRSTHDR(&message);
        const int descriptors[] = {STDIN_FILENO, STDOUT_FILENO, STDERR_FILENO};
        control->cmsg_level = SOL_SOCKET;
        control->cmsg_type = SCM_RIGHTS;
        control->cmsg_len = CMSG_LEN(sizeof(descriptors));
        memcpy(CMSG_DATA(control), descriptors, sizeof(descriptors));
        return sendmsg(socket_fd, &message, 0) == 1 ? 0 : -1;
    }
    if (recvmsg(socket_fd, &message, 0) != 1 || tag != 'S' || (message.msg_flags & MSG_CTRUNC)) return -1;
    struct cmsghdr *control = CMSG_FIRSTHDR(&message);
    int descriptors[3];
    if (!control || control->cmsg_level != SOL_SOCKET || control->cmsg_type != SCM_RIGHTS
        || control->cmsg_len != CMSG_LEN(sizeof(descriptors))) return -1;
    memcpy(descriptors, CMSG_DATA(control), sizeof(descriptors));
    for (int target = 0; target < 3; target++) {
        if (dup2(descriptors[target], target) != target) return -1;
        if (descriptors[target] != target) close(descriptors[target]);
    }
    return 0;
}

static char *read_field(char **cursor, char *end) {
    if (*cursor >= end) return NULL;
    char *field = *cursor;
    char *terminator = memchr(field, '\0', (size_t)(end - field));
    if (!terminator) return NULL;
    *cursor = terminator + 1;
    return field;
}

static char **read_vector(char **cursor, char *end) {
    if ((size_t)(end - *cursor) < sizeof(uint32_t)) return NULL;
    uint32_t count;
    memcpy(&count, *cursor, sizeof(count));
    *cursor += sizeof(count);
    if (count > 16384) return NULL;
    char **items = calloc((size_t)count + 1, sizeof(*items));
    if (!items) return NULL;
    for (uint32_t index = 0; index < count; index++) {
        items[index] = read_field(cursor, end);
        if (!items[index]) { free(items); return NULL; }
    }
    return items;
}

static int run_backend(const char *path) {
    struct sockaddr_un address;
    if (local_address(&address, path)) return LAUNCH_ERROR;
    int connection = socket(AF_UNIX, SOCK_STREAM, 0);
    if (connection < 0 || set_socket_timeout(connection)
        || connect(connection, (struct sockaddr *)&address, address.sun_len) || configure_terminal(connection, 0)) return LAUNCH_ERROR;
    uint32_t size;
    if (transfer(connection, &size, sizeof(size), 0) || !size || size > MAX_PAYLOAD) return LAUNCH_ERROR;
    char *payload = malloc(size);
    if (!payload || transfer(connection, payload, size, 0)) return LAUNCH_ERROR;
    close(connection);
    char *cursor = payload;
    char *end = payload + size;
    const char *directory = read_field(&cursor, end);
    char **arguments = read_vector(&cursor, end);
    char **environment = arguments ? read_vector(&cursor, end) : NULL;
    if (!directory || !arguments || !arguments[0] || arguments[0][0] != '/' || !environment
        || cursor != end || chdir(directory)) return LAUNCH_ERROR;
    execve(arguments[0], arguments, environment);
    perror("Alook macOS backend exec");
    return LAUNCH_ERROR;
}

static int create_job(const char *job_file, const char *label, const char *launcher, const char *socket_path) {
    CFStringRef program = CFStringCreateWithFileSystemRepresentation(NULL, launcher);
    CFStringRef endpoint = CFStringCreateWithFileSystemRepresentation(NULL, socket_path);
    CFStringRef name = CFStringCreateWithCString(NULL, label, kCFStringEncodingUTF8);
    if (!program || !endpoint || !name) {
        if (program) CFRelease(program);
        if (endpoint) CFRelease(endpoint);
        if (name) CFRelease(name);
        return -1;
    }
    const void *values[] = {program, CFSTR("--alook-agent-exec"), endpoint};
    CFArrayRef arguments = CFArrayCreate(NULL, values, 3, &kCFTypeArrayCallBacks);
    const void *keys[] = {CFSTR("Label"), CFSTR("ProgramArguments"), CFSTR("RunAtLoad")};
    const void *properties[] = {name, arguments, kCFBooleanTrue};
    CFDictionaryRef job = CFDictionaryCreate(NULL, keys, properties, 3, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    CFDataRef plist = CFPropertyListCreateData(NULL, job, kCFPropertyListXMLFormat_v1_0, 0, NULL);
    int file = open(job_file, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    int result = file < 0 || !plist ? -1 : transfer(file, (void *)CFDataGetBytePtr(plist), (size_t)CFDataGetLength(plist), 1);
    if (file >= 0) close(file);
    if (plist) CFRelease(plist);
    CFRelease(job);
    CFRelease(arguments);
    CFRelease(name);
    CFRelease(endpoint);
    CFRelease(program);
    return result;
}

static int system_tool(char *const argv[], uint32_t max_ms) {
    char *const env[] = {"PATH=/usr/bin:/bin", NULL};
    posix_spawn_file_actions_t files;
    posix_spawn_file_actions_init(&files);
    for (int fd = 0; fd < 3; fd++) posix_spawn_file_actions_addopen(&files, fd, "/dev/null", O_RDWR, 0);
    pid_t child;
    int error = posix_spawn(&child, argv[0], &files, NULL, argv, env);
    posix_spawn_file_actions_destroy(&files);
    if (error) return -1;
    int status;
    for (uint32_t elapsed = 0; elapsed <= max_ms; elapsed += 10) {
        pid_t waited = waitpid(child, &status, WNOHANG);
        if (waited == child) return WIFEXITED(status) ? WEXITSTATUS(status) : -1;
        if (waited < 0 && errno != EINTR) return -1;
        usleep(10000);
    }
    kill(child, SIGKILL);
    while (waitpid(child, &status, 0) < 0 && errno == EINTR) { }
    return -1;
}

static int launchctl(const char *action, const char *service, const char *path) {
    char *const argv[] = {"/bin/launchctl", (char *)action, (char *)service, (char *)path, NULL};
    return system_tool(argv, !strcmp(action, "print") ? 150 : START_TIMEOUT_MS);
}

static int process_identity(pid_t pid, struct proc_bsdinfo *identity) {
    return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, identity, sizeof(*identity)) == sizeof(*identity);
}

static int cleanup_backend(const char *node, const char *entrypoint, pid_t pid, const struct proc_bsdinfo *identity, uint32_t grace) {
    struct proc_bsdinfo current;
    if (!process_identity(pid, &current) || current.pbi_start_tvsec != identity->pbi_start_tvsec
        || current.pbi_start_tvusec != identity->pbi_start_tvusec) return 0;
    char process_id[16], grace_ms[16];
    snprintf(process_id, sizeof(process_id), "%d", pid);
    snprintf(grace_ms, sizeof(grace_ms), "%u", grace);
    char *const argv[] = {(char *)node, (char *)entrypoint, "--alook-macos-agent-cleanup", process_id, grace_ms, NULL};
    return system_tool(argv, grace + 3000);
}

static pid_t verified_peer(int connection, const char *launcher) {
    pid_t peer = -1;
    socklen_t length = sizeof(peer);
    uid_t uid;
    gid_t gid;
    char executable[PROC_PIDPATHINFO_MAXSIZE];
    if (getpeereid(connection, &uid, &gid) || uid != getuid()
        || getsockopt(connection, SOL_LOCAL, LOCAL_PEERPID, &peer, &length) || peer < 2
        || getpgid(peer) != peer || proc_pidpath(peer, executable, sizeof(executable)) <= 0
        || strcmp(executable, launcher)) return -1;
    return peer;
}

static int supervise(const char *launcher, const char *node, const char *entrypoint) {
    if (node[0] != '/' || entrypoint[0] != '/') return LAUNCH_ERROR;
    if (fcntl(CONTROL, F_SETFD, FD_CLOEXEC) || set_socket_timeout(CONTROL)) return LAUNCH_ERROR;
    uint32_t size;
    if (transfer(CONTROL, &size, sizeof(size), 0) || !size || size > MAX_PAYLOAD) return LAUNCH_ERROR;
    char *payload = malloc(size);
    if (!payload || transfer(CONTROL, payload, size, 0)) { free(payload); return LAUNCH_ERROR; }

    char working[] = "/private/tmp/alook-agent.XXXXXX";
    if (!mkdtemp(working)) { free(payload); return LAUNCH_ERROR; }
    char socket_path[108], job[128], domain[32], label[64], service[100];
    snprintf(socket_path, sizeof(socket_path), "%s/control", working);
    snprintf(job, sizeof(job), "%s/job.plist", working);
    snprintf(domain, sizeof(domain), "gui/%u", getuid());
    snprintf(label, sizeof(label), "ai.alook.agent.%s", strrchr(working, '.') + 1);
    snprintf(service, sizeof(service), "%s/%s", domain, label);

    int listener = -1, connection = -1, queue = -1, status = LAUNCH_ERROR << 8, registered = 0, cleaned = 1;
    struct sockaddr_un address;
    if (local_address(&address, socket_path)) goto cleanup;
    listener = socket(AF_UNIX, SOCK_STREAM, 0);
    if (listener < 0 || fcntl(listener, F_SETFD, FD_CLOEXEC)
        || bind(listener, (struct sockaddr *)&address, address.sun_len) || listen(listener, 1)
        || create_job(job, label, launcher, socket_path)) goto cleanup;
    registered = 1;
    if (launchctl("bootstrap", domain, job)) goto cleanup;

    struct pollfd readiness[] = {{listener, POLLIN, 0}, {CONTROL, POLLIN, 0}};
    if (poll(readiness, 2, START_TIMEOUT_MS) <= 0 || readiness[1].revents || !(readiness[0].revents & POLLIN)) goto cleanup;
    connection = accept(listener, NULL, NULL);
    if (connection < 0 || set_socket_timeout(connection)) goto cleanup;
    pid_t peer = verified_peer(connection, launcher);
    struct proc_bsdinfo identity;
    if (peer < 2 || !process_identity(peer, &identity)) goto cleanup;

    queue = kqueue();
    if (queue < 0) goto cleanup;
    struct kevent watch[2];
    EV_SET(&watch[0], peer, EVFILT_PROC, EV_ADD | EV_ENABLE, NOTE_EXIT | NOTE_EXITSTATUS, 0, NULL);
    EV_SET(&watch[1], CONTROL, EVFILT_READ, EV_ADD | EV_ENABLE, 0, 0, NULL);
    if (kevent(queue, watch, 2, NULL, 0, NULL) < 0) goto cleanup;
    char message[32];
    int message_length = snprintf(message, sizeof(message), "%d\n", peer);
    char ack;
    if (transfer(CONTROL, message, (size_t)message_length, 1)
        || transfer(CONTROL, &ack, 1, 0) || ack != 'A'
        || configure_terminal(connection, 1)
        || transfer(connection, &size, sizeof(size), 1) || transfer(connection, payload, size, 1)) goto cleanup;
    free(payload);
    payload = NULL;
    close(connection);
    connection = -1;
    close(listener);
    listener = -1;

    struct kevent event;
    int result;
    do { result = kevent(queue, NULL, 0, &event, 1, NULL); } while (result < 0 && errno == EINTR);
    if (result == 1 && event.filter == EVFILT_PROC && (event.fflags & NOTE_EXITSTATUS)) {
        status = (int)event.data;
    } else {
        uint32_t grace;
        if (transfer(CONTROL, &grace, sizeof(grace), 0) || grace > 99999) grace = 2000;
        cleaned = cleanup_backend(node, entrypoint, peer, &identity, grace) == 0;
        if (cleaned) status = 0;
    }

cleanup:
    if (connection >= 0) close(connection);
    if (listener >= 0) close(listener);
    if (queue >= 0) close(queue);
    if (registered) {
        launchctl("bootout", service, NULL);
        for (int attempt = 0; attempt < 5; attempt++) {
            if (launchctl("print", service, NULL) > 0) break;
            if (attempt == 4) cleaned = 0;
            else usleep(25000);
        }
    }
    unlink(socket_path);
    unlink(job);
    rmdir(working);
    free(payload);
    if (cleaned) {
        char complete = 'C';
        transfer(CONTROL, &complete, 1, 1);
    } else {
        fprintf(stderr, "Alook macOS agent failed to finish process cleanup\n");
        status = LAUNCH_ERROR << 8;
    }
    if (WIFSIGNALED(status)) {
        int sig = WTERMSIG(status);
        signal(sig, SIG_DFL);
        raise(sig);
        return 128 + sig;
    }
    return WIFEXITED(status) ? WEXITSTATUS(status) : LAUNCH_ERROR;
}

int alook_macos_agent_main(int argc, const char *const *argv) {
    if (argc < 2) return -1;
    if (!strcmp(argv[1], "--alook-agent-exec")) return argc == 3 ? run_backend(argv[2]) : LAUNCH_ERROR;
    if (!strcmp(argv[1], "--alook-agent-supervise")) return argc == 4 ? supervise(argv[0], argv[2], argv[3]) : LAUNCH_ERROR;
    return -1;
}

#ifdef ALOOK_AGENT_LAUNCHER_STANDALONE
int main(int argc, char **argv) {
    return alook_macos_agent_main(argc, (const char *const *)argv);
}
#endif
