// SPDX-License-Identifier: Apache-2.0
// Experimental, process-local Termux prefix relocation for Arxd. No ptrace/root.
#define _GNU_SOURCE
#include "ExecIntercept.h"
#include "ExecVariantsIntercept.h"
#include "arxd_exec.h"
#include <dirent.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <spawn.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/statvfs.h>
#include <sys/syscall.h>
#include <sys/time.h>
#include <sys/types.h>
#include <unistd.h>

extern char **environ;
static const char virtual_root[] = "/data/data/com.termux/files";
static const char virtual_root_alias[] = "/data/user/0/com.termux/files";
static const char *context_keys[] = {"ARXD_TERMUX_ROOT", "ARXD_TERMUX_APP_ROOT", "LD_PRELOAD",
                                     "LD_LIBRARY_PATH", "PREFIX"};
static char *context_entries[5];
static char *context_executable;
static char context_root_alias[PATH_MAX];

static const char *context_value(size_t index) {
    return context_entries[index] ? context_entries[index] + strlen(context_keys[index]) + 1
                                  : getenv(context_keys[index]);
}

static bool context_variable(const char *entry) {
    for (size_t i = 0; i < 5; i++) {
        size_t length = strlen(context_keys[i]);
        if (!strncmp(entry, context_keys[i], length) && entry[length] == '=')
            return true;
    }
    return false;
}

static bool prefix(const char *s, const char *p) {
    size_t n = strlen(p);
    return s && !strncmp(s, p, n) && (!s[n] || s[n] == '/');
}

static const char *map_path(const char *path, char out[PATH_MAX]) {
    const char *root = context_value(0);
    if (!path || !root)
        return path;
    const char *tail = NULL;
    if (context_root_alias[0] && prefix(path, context_root_alias))
        tail = path + strlen(context_root_alias);
    else if (prefix(path, virtual_root))
        tail = path + strlen(virtual_root);
    else if (prefix(path, virtual_root_alias))
        tail = path + strlen(virtual_root_alias);
    if (tail) {
        if (snprintf(out, PATH_MAX, "%s%s", root, tail) >= PATH_MAX) {
            errno = ENAMETOOLONG;
            return NULL;
        }
        return out;
    }
    const char *app = context_value(1);
    if (app && (prefix(path, "/data/data/com.termux") || prefix(path, "/data/user/0/com.termux"))) {
        const char *base = prefix(path, "/data/data/com.termux") ? "/data/data/com.termux"
                                                                 : "/data/user/0/com.termux";
        if (snprintf(out, PATH_MAX, "%s%s", app, path + strlen(base)) >= PATH_MAX) {
            errno = ENAMETOOLONG;
            return NULL;
        }
        return out;
    }
    if (!strcmp(path, "/bin/sh") || !strcmp(path, "/usr/bin/sh")) {
        snprintf(out, PATH_MAX, "%s/usr/bin/bash", root);
        return out;
    }
    if (prefix(path, "/bin") || prefix(path, "/usr/bin")) {
        const char *name = strrchr(path, '/') + 1;
        snprintf(out, PATH_MAX, "%s/usr/bin/%s", root, name);
        return out;
    }
    return path;
}

#define REAL(name) __typeof__(&name) real = (__typeof__(&name))dlsym(RTLD_NEXT, #name)
#define PATH(name)                                                                                 \
    char name##_buf[PATH_MAX];                                                                     \
    name = map_path(name, name##_buf);                                                             \
    if (!name)                                                                                     \
    return -1

__attribute__((constructor)) static void init_job(void) {
    // libuv replaces environ before exec and package helpers blank LD_PRELOAD.
    // Cache immutable host context before either form of child setup happens.
    for (size_t key = 0; key < 5; key++) {
        size_t length = strlen(context_keys[key]);
        for (size_t i = 0; environ[i]; i++) {
            if (!strncmp(environ[i], context_keys[key], length) && environ[i][length] == '=') {
                context_entries[key] = strdup(environ[i]);
                break;
            }
        }
    }
    const char *executable = getenv("ARXD_EXECUTABLE");
    const char *root = context_value(0);
    if (root && stringStartsWith(root, "/data/user/0/"))
        snprintf(context_root_alias, sizeof(context_root_alias), "/data/data/%s",
                 root + strlen("/data/user/0/"));
    else if (root && stringStartsWith(root, "/data/data/"))
        snprintf(context_root_alias, sizeof(context_root_alias), "/data/user/0/%s",
                 root + strlen("/data/data/"));
    if (executable)
        context_executable = strdup(executable);
    const char *job = getenv("ARXD_JOB_FILE");
    if (!job)
        return;
    setpgid(0, 0);
    int fd = (int)syscall(SYS_openat, AT_FDCWD, job, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd >= 0) {
        char buffer[32];
        int n = snprintf(buffer, sizeof(buffer), "%d", getpid());
        syscall(SYS_write, fd, buffer, (size_t)n);
        syscall(SYS_close, fd);
    }
    unsetenv("ARXD_JOB_FILE");
}

int open(const char *path, int flags, ...) {
    mode_t mode = 0;
    if ((flags & O_CREAT) || (flags & O_TMPFILE) == O_TMPFILE) {
        va_list args;
        va_start(args, flags);
        mode = (mode_t)va_arg(args, int);
        va_end(args);
    }
    PATH(path);
    REAL(open);
    return real(path, flags, mode);
}
int open64(const char *path, int flags, ...) {
    mode_t mode = 0;
    if ((flags & O_CREAT) || (flags & O_TMPFILE) == O_TMPFILE) {
        va_list args;
        va_start(args, flags);
        mode = (mode_t)va_arg(args, int);
        va_end(args);
    }
    return open(path, flags, mode);
}
int openat(int dir, const char *path, int flags, ...) {
    mode_t mode = 0;
    if ((flags & O_CREAT) || (flags & O_TMPFILE) == O_TMPFILE) {
        va_list args;
        va_start(args, flags);
        mode = (mode_t)va_arg(args, int);
        va_end(args);
    }
    PATH(path);
    REAL(openat);
    return real(dir, path, flags, mode);
}
int openat64(int dir, const char *path, int flags, ...) {
    mode_t mode = 0;
    if ((flags & O_CREAT) || (flags & O_TMPFILE) == O_TMPFILE) {
        va_list args;
        va_start(args, flags);
        mode = (mode_t)va_arg(args, int);
        va_end(args);
    }
    return openat(dir, path, flags, mode);
}
int __open_2(const char *path, int flags) { return open(path, flags); }
int __openat_2(int dir, const char *path, int flags) { return openat(dir, path, flags); }

FILE *fopen(const char *path, const char *mode) {
    char out[PATH_MAX];
    path = map_path(path, out);
    if (!path)
        return NULL;
    REAL(fopen);
    return real(path, mode);
}
FILE *fopen64(const char *path, const char *mode) { return fopen(path, mode); }
FILE *freopen(const char *path, const char *mode, FILE *stream) {
    char out[PATH_MAX];
    path = map_path(path, out);
    REAL(freopen);
    return real(path, mode, stream);
}
DIR *opendir(const char *path) {
    char out[PATH_MAX];
    path = map_path(path, out);
    if (!path)
        return NULL;
    REAL(opendir);
    return real(path);
}
char *realpath(const char *path, char *resolved) {
    char out[PATH_MAX];
    path = map_path(path, out);
    if (!path)
        return NULL;
    REAL(realpath);
    return real(path, resolved);
}
int stat(const char *path, struct stat *st) {
    PATH(path);
    REAL(stat);
    return real(path, st);
}
int lstat(const char *path, struct stat *st) {
    PATH(path);
    REAL(lstat);
    return real(path, st);
}
int fstatat(int fd, const char *path, struct stat *st, int flags) {
    PATH(path);
    REAL(fstatat);
    return real(fd, path, st, flags);
}
int stat64(const char *path, struct stat64 *st) {
    PATH(path);
    REAL(stat64);
    return real(path, st);
}
int lstat64(const char *path, struct stat64 *st) {
    PATH(path);
    REAL(lstat64);
    return real(path, st);
}
int fstatat64(int fd, const char *path, struct stat64 *st, int flags) {
    PATH(path);
    REAL(fstatat64);
    return real(fd, path, st, flags);
}
int access(const char *path, int mode) {
    PATH(path);
    REAL(access);
    const char *root = context_value(0);
    if ((mode & X_OK) && root && prefix(path, root)) {
        struct stat st;
        if (stat(path, &st) == 0 && S_ISREG(st.st_mode) && (st.st_mode & 0111))
            mode = (mode & ~X_OK) | R_OK;
    }
    return real(path, mode);
}
int faccessat(int fd, const char *path, int mode, int flags) {
    PATH(path);
    REAL(faccessat);
    const char *root = context_value(0);
    if ((mode & X_OK) && root && prefix(path, root)) {
        struct stat st;
        if (stat(path, &st) == 0 && S_ISREG(st.st_mode) && (st.st_mode & 0111))
            mode = (mode & ~X_OK) | R_OK;
    }
    return real(fd, path, mode, flags);
}
int chdir(const char *path) {
    PATH(path);
    REAL(chdir);
    return real(path);
}
int mkdir(const char *path, mode_t mode) {
    PATH(path);
    REAL(mkdir);
    return real(path, mode);
}
int mkdirat(int fd, const char *path, mode_t mode) {
    PATH(path);
    REAL(mkdirat);
    return real(fd, path, mode);
}
int chmod(const char *path, mode_t mode) {
    PATH(path);
    REAL(chmod);
    return real(path, mode);
}
int fchmodat(int fd, const char *path, mode_t mode, int flags) {
    PATH(path);
    REAL(fchmodat);
    return real(fd, path, mode, flags);
}
int fchownat(int fd, const char *path, uid_t u, gid_t g, int flags) {
    PATH(path);
    REAL(fchownat);
    return real(fd, path, u, g, flags);
}
int chown(const char *path, uid_t u, gid_t g) {
    PATH(path);
    REAL(chown);
    return real(path, u, g);
}
int lchown(const char *path, uid_t u, gid_t g) {
    PATH(path);
    REAL(lchown);
    return real(path, u, g);
}
int unlink(const char *path) {
    PATH(path);
    REAL(unlink);
    return real(path);
}
int unlinkat(int fd, const char *path, int flags) {
    PATH(path);
    REAL(unlinkat);
    return real(fd, path, flags);
}
int rmdir(const char *path) {
    PATH(path);
    REAL(rmdir);
    return real(path);
}
int remove(const char *path) {
    PATH(path);
    REAL(remove);
    return real(path);
}
int rename(const char *old, const char *next) {
    PATH(old);
    PATH(next);
    REAL(rename);
    return real(old, next);
}
int renameat(int oldfd, const char *old, int newfd, const char *next) {
    PATH(old);
    PATH(next);
    REAL(renameat);
    return real(oldfd, old, newfd, next);
}
int symlink(const char *target, const char *path) {
    PATH(target);
    PATH(path);
    REAL(symlink);
    return real(target, path);
}
int symlinkat(const char *target, int fd, const char *path) {
    PATH(target);
    PATH(path);
    REAL(symlinkat);
    return real(target, fd, path);
}
int link(const char *old, const char *next) {
    PATH(old);
    PATH(next);
    REAL(link);
    return real(old, next);
}
int linkat(int oldfd, const char *old, int newfd, const char *next, int flags) {
    PATH(old);
    PATH(next);
    REAL(linkat);
    return real(oldfd, old, newfd, next, flags);
}
int utimensat(int fd, const char *path, const struct timespec times[2], int flags) {
    // Bionic futimens uses the Linux fd + NULL-path form. A NULL here is
    // an opened-file operation, not a failed prefix mapping.
    if (!path)
        return syscall(SYS_utimensat, fd, NULL, times, flags);
    PATH(path);
    REAL(utimensat);
    return real(fd, path, times, flags);
}
int futimens(int fd, const struct timespec times[2]) {
    return syscall(SYS_utimensat, fd, NULL, times, 0);
}
int utimes(const char *path, const struct timeval times[2]) {
    PATH(path);
    REAL(utimes);
    return real(path, times);
}
int statfs(const char *path, struct statfs *st) {
    PATH(path);
    REAL(statfs);
    return real(path, st);
}
int statvfs(const char *path, struct statvfs *st) {
    PATH(path);
    REAL(statvfs);
    return real(path, st);
}
int scandir(const char *path, struct dirent ***list, int (*filter)(const struct dirent *),
            int (*compare)(const struct dirent **, const struct dirent **)) {
    PATH(path);
    REAL(scandir);
    return real(path, list, filter, compare);
}

ssize_t readlink(const char *path, char *buffer, size_t size) {
    const char *exe = context_executable;
    char self[64];
    snprintf(self, sizeof(self), "/proc/%d/exe", getpid());
    if (exe && (!strcmp(path, "/proc/self/exe") || !strcmp(path, self))) {
        size_t n = strlen(exe);
        if (n > size)
            n = size;
        memcpy(buffer, exe, n);
        return (ssize_t)n;
    }
    PATH(path);
    // Bionic readlink delegates to readlinkat; routing its interposed
    // readlinkat back through libc readlink would recurse indefinitely.
    return syscall(SYS_readlinkat, AT_FDCWD, path, buffer, size);
}
ssize_t readlinkat(int fd, const char *path, char *buffer, size_t size) {
    if (path && path[0] == '/')
        return readlink(path, buffer, size);
    PATH(path);
    return syscall(SYS_readlinkat, fd, path, buffer, size);
}
ssize_t __readlink_chk(const char *path, char *buffer, size_t size, size_t capacity) {
    if (size > capacity) {
        errno = EOVERFLOW;
        return -1;
    }
    return readlink(path, buffer, size);
}
ssize_t __readlinkat_chk(int fd, const char *path, char *buffer, size_t size, size_t capacity) {
    if (size > capacity) {
        errno = EOVERFLOW;
        return -1;
    }
    return readlinkat(fd, path, buffer, size);
}
void *dlopen(const char *path, int flags) {
    char out[PATH_MAX];
    path = map_path(path, out);
    REAL(dlopen);
    return real(path, flags);
}

// Arxd adapters for the pinned upstream exec pipeline. File relocation and
// immutable host context stay here; upstream owns header/argv/PATH handling.
bool isFdPath(const char *path) {
    char current[64];
    snprintf(current, sizeof(current), "/proc/%d/fd/", getpid());
    return stringStartsWith(path, "/proc/self/fd/") || stringStartsWith(path, current);
}

const char *getRegularFileFdRealPath(const char *tag, const char *path, char *out, size_t size) {
    (void)tag;
    ssize_t length = readlink(path, out, size - 1);
    if (length < 0)
        return NULL;
    if ((size_t)length >= size - 1) {
        errno = ENAMETOOLONG;
        return NULL;
    }
    out[length] = 0;
    // /proc fd links use /data/data even when the App opened /data/user/0.
    // Normalize the owned runtime alias before upstream ownership decisions.
    char mapped[PATH_MAX];
    const char *translated = map_path(out, mapped);
    if (!translated)
        return NULL;
    if (strlen(translated) >= size) {
        errno = ENAMETOOLONG;
        return NULL;
    }
    if (translated != out)
        memcpy(out, translated, strlen(translated) + 1);
    struct stat st;
    if (stat(out, &st))
        return NULL;
    if (!S_ISREG(st.st_mode)) {
        errno = EACCES;
        return NULL;
    }
    return out;
}

char *normalizePath(char *path, bool allow_relative, bool unused) {
    (void)unused;
    if (!path || (!allow_relative && path[0] != '/')) {
        errno = EINVAL;
        return NULL;
    }
    size_t length = strlen(path);
    if (length >= PATH_MAX) {
        errno = ENAMETOOLONG;
        return NULL;
    }
    char buffer[PATH_MAX];
    size_t ends[PATH_MAX / 2], count = 0, used = 1;
    buffer[0] = '/';
    char *cursor = path, *part;
    while ((part = strsep(&cursor, "/"))) {
        if (!*part || !strcmp(part, "."))
            continue;
        if (!strcmp(part, "..")) {
            if (count)
                used = ends[--count];
            continue;
        }
        ends[count++] = used;
        if (used > 1)
            buffer[used++] = '/';
        size_t n = strlen(part);
        memcpy(buffer + used, part, n);
        used += n;
    }
    buffer[used] = 0;
    memcpy(path, buffer, used + 1);
    return path;
}

char *absolutizePath(const char *path, char *out, size_t size) {
    char cwd[PATH_MAX];
    if (!getcwd(cwd, sizeof(cwd)))
        return NULL;
    if (snprintf(out, size, "%s/%s", cwd, path) >= (int)size) {
        errno = ENAMETOOLONG;
        return NULL;
    }
    return out;
}

const char *termuxPrefixPath(const char *tag, const char *unused_prefix, const char *path,
                             char *out, size_t size) {
    (void)tag;
    (void)unused_prefix;
    char mapped[PATH_MAX];
    if (!strcmp(path, "/system/bin/sh") && context_value(0)) {
        if (snprintf(mapped, sizeof(mapped), "%s/usr/bin/bash", context_value(0)) >= PATH_MAX) {
            errno = ENAMETOOLONG;
            return NULL;
        }
        path = mapped;
    } else {
        path = map_path(path, mapped);
    }
    if (!path)
        return NULL;
    if (strlen(path) >= size) {
        errno = ENAMETOOLONG;
        return NULL;
    }
    memcpy(out, path, strlen(path) + 1);
    return out;
}

int shouldEnableSystemLinkerExecForFile(const char *path) {
    const char *root = context_value(0);
    return root && prefix(path, root) ? 0 : 1;
}

struct spawn_context {
    pid_t *pid;
    const posix_spawn_file_actions_t *actions;
    const posix_spawnattr_t *attributes;
};
static _Thread_local struct spawn_context *spawning;
static _Thread_local bool spawn_exec_ready;

int arxd_exec_final(const char *file, char *const argv[], char *const envp[]) {
    const char *program = file;
    size_t entries = 0;
    for (; envp && envp[entries]; entries++)
        if (stringStartsWith(envp[entries], ENV_PREFIX__TERMUX_EXEC__PROC_SELF_EXE))
            program = envp[entries] + strlen(ENV_PREFIX__TERMUX_EXEC__PROC_SELF_EXE);
    bool owned = context_value(0) && prefix(program, context_value(0));
    char **env = calloc(entries + 7, sizeof(char *));
    char *identity = NULL;
    if (!env || asprintf(&identity, "ARXD_EXECUTABLE=%s", program) < 0) {
        free(env);
        errno = ENOMEM;
        return -1;
    }
    size_t n = 0;
    for (size_t i = 0; i < entries; i++)
        if (!stringStartsWith(envp[i], "ARXD_EXECUTABLE=") && !(owned && context_variable(envp[i])))
            env[n++] = envp[i];
    env[n++] = identity;
    if (owned)
        for (size_t key = 0; key < 5; key++)
            if (context_entries[key])
                env[n++] = context_entries[key];
    int result;
    if (spawning) {
        int (*spawn)(pid_t *, const char *, const posix_spawn_file_actions_t *,
                     const posix_spawnattr_t *, char *const[], char *const[]) =
            dlsym(RTLD_NEXT, "posix_spawn");
        // Bionic spawn calls execve again in its (possibly vfork) child.
        // The arguments/environment are already prepared: that reentry must
        // perform only the raw syscall, without allocating or spawning again.
        bool previous_ready = spawn_exec_ready;
        spawn_exec_ready = true;
        int error = spawn(spawning->pid, file, spawning->actions, spawning->attributes, argv, env);
        spawn_exec_ready = previous_ready;
        result = error ? -1 : 0;
        if (error)
            errno = error;
    } else {
        result = (int)syscall(SYS_execve, file, argv, env);
    }
    int saved = errno;
    free(identity);
    free(env);
    errno = saved;
    return result;
}

int execve(const char *file, char *const argv[], char *const env[]) {
    if (spawn_exec_ready)
        return (int)syscall(SYS_execve, file, argv, env);
    if (!file || !argv || !argv[0]) {
        errno = EINVAL;
        return -1;
    }
    if (!strcmp(file, "/proc/self/exe") && context_executable)
        file = context_executable;
    char *const empty[] = {NULL};
    return execveIntercept(true, file, argv, env ? env : empty);
}
int execv(const char *file, char *const argv[]) { return execve(file, argv, environ); }
int execvp(const char *file, char *const argv[]) { return execvpIntercept(true, file, argv); }
int execvpe(const char *file, char *const argv[], char *const env[]) {
    return execvpeIntercept(true, file, argv, env);
}
int fexecve(int fd, char *const argv[], char *const env[]) {
    return fexecveIntercept(true, fd, argv, env);
}

#define EXEC_LIST(name, variant)                                                                   \
    int name(const char *file, const char *arg, ...) {                                             \
        va_list ap;                                                                                \
        va_start(ap, arg);                                                                         \
        return execlIntercept(true, variant, file, arg, ap);                                       \
    }
EXEC_LIST(execl, ExecL)
EXEC_LIST(execlp, ExecLP)
EXEC_LIST(execle, ExecLE)

static int spawn_managed(pid_t *pid, const char *file, const posix_spawn_file_actions_t *actions,
                         const posix_spawnattr_t *attrs, char *const argv[], char *const env[],
                         bool search_path) {
    struct spawn_context context = {pid, actions, attrs};
    struct spawn_context *previous = spawning;
    spawning = &context;
    int result = search_path ? execvpeIntercept(true, file, argv, env) : execve(file, argv, env);
    int error = result ? errno : 0;
    spawning = previous;
    return error;
}
int posix_spawn(pid_t *pid, const char *file, const posix_spawn_file_actions_t *actions,
                const posix_spawnattr_t *attrs, char *const argv[], char *const env[]) {
    return spawn_managed(pid, file, actions, attrs, argv, env, false);
}
int posix_spawnp(pid_t *pid, const char *file, const posix_spawn_file_actions_t *actions,
                 const posix_spawnattr_t *attrs, char *const argv[], char *const env[]) {
    return spawn_managed(pid, file, actions, attrs, argv, env, true);
}
