// SPDX-License-Identifier: Apache-2.0
#ifndef ARXD_EXEC_H
#define ARXD_EXEC_H
#include <errno.h>
#include <limits.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

extern char **environ;
#define ENV_PREFIX__LD_LIBRARY_PATH "LD_LIBRARY_PATH="
#define ENV_PREFIX__LD_PRELOAD "LD_PRELOAD="
#define ENV_PREFIX__TERMUX_EXEC__PROC_SELF_EXE "TERMUX_EXEC__PROC_SELF_EXE="
#define TERMUX__ROOTFS_DIR___MAX_LEN 85
#define SYSTEM_LINKER_PATH "/system/bin/linker64"
#define LOG_LEVEL__NORMAL 1
#define LOG_LEVEL__VERBOSE 2
static inline int getCurrentLogLevel(void) { return getenv("ARXD_EXEC_DEBUG") ? 2 : 0; }
static inline void arxd_log(const char *tag, const char *format, ...) {
    if (!getenv("ARXD_EXEC_DEBUG"))
        return;
    int saved = errno;
    fprintf(stderr, "arxd-exec[%s]: ", tag);
    va_list ap;
    va_start(ap, format);
    vfprintf(stderr, format, ap);
    va_end(ap);
    fprintf(stderr, " (errno=%d)\n", errno);
    errno = saved;
}
#define logErrorDebug arxd_log
#define logErrorVerbose arxd_log
#define logErrorVVerbose arxd_log
#define logStrerrorDebug arxd_log
static inline int termuxExec_execveCall_intercept_get(void) { return 1; }
static inline bool libtermux_exec__nos__c__getIsRunningTests(void) { return false; }
static inline int android_buildVersionSdk_get(void) { return 29; }
static inline bool stringStartsWith(const char *s, const char *prefix) {
    while (*prefix)
        if (*s++ != *prefix++)
            return false;
    return true;
}
static inline bool areVarsInEnv(char *const env[], const char *keys[], int count) {
    for (size_t i = 0; env && env[i]; i++)
        for (int j = 0; j < count; j++)
            if (stringStartsWith(env[i], keys[j]))
                return true;
    return false;
}
static inline bool areEmptyVarsInEnv(char *const env[], const char *keys[], int count) {
    for (size_t i = 0; env && env[i]; i++)
        for (int j = 0; j < count; j++) {
            const char *s = env[i], *key = keys[j];
            while (*key && *s == *key) {
                s++;
                key++;
            }
            if (!*key && !*s)
                return true;
        }
    return false;
}
bool isFdPath(const char *path);
const char *getRegularFileFdRealPath(const char *tag, const char *path, char *out, size_t size);
char *normalizePath(char *path, bool allow_relative, bool unused);
char *absolutizePath(const char *path, char *out, size_t size);
const char *termuxPrefixPath(const char *tag, const char *prefix, const char *path, char *out,
                             size_t size);
int shouldEnableSystemLinkerExecForFile(const char *path);
int arxd_exec_final(const char *path, char *const argv[], char *const env[]);
#endif
