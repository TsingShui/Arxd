# Termux execution snapshot for Arxd

Source: https://github.com/termux/termux-exec-package
Revision: `2cd0ba6b907565484130851f9617523c98df8615` (Makefile version 2.5.0).
Original file paths and SHA-256 identities are recorded in `upstream.json`.
The repository's Apache-2.0 license is retained in `LICENSE-APACHE-2.0`;
`ExecVariantsIntercept.c` retains its separate BSD notice.

Only the execution pipeline and headers are vendored. Arxd supplies the narrow
host/platform adapters declared in `apps/arxd/native/preload/arxd_exec.h`, in
place of depending on the complete termux-core package. This is an adapted
source snapshot, not an unchanged upstream library or a compatibility claim.

Local changes:

- Replace termux-core/termux-exec include paths with the local adapter/header
  includes. Diagnostic logging is off by default (`ARXD_EXEC_DEBUG` enables
  upstream traces through the adapter); target API
  is at least 29, so the legacy Android < 6 overflow check is inactive.
- Route the final exec syscall through `arxd_exec_final`, which restores cached
  host context for managed programs and supports the native posix_spawn bridge.
  Upstream still owns file-header inspection, shebang/argv construction, system
  loader-variable cleanup, fd execution and PATH/ENOEXEC fallback.
- PATH defaults to managed Termux bin plus Android system bin when absent.
- Return success when the host spawn bridge returns zero (exec ordinarily does
  not return on success); remove an unreachable return after ENOEXEC fallback.

The Arxd spawn adapter marks already-prepared execution in thread-local state.
Bionic's spawn child can reenter the public execve symbol, including after
vfork; that reentry performs only the raw syscall, preserving prepared loader
identity and avoiding recursive spawn or allocation in the vfork child.

The host adapters relocate normalized execution paths, resolve regular-file fd
paths, and select linker execution only inside Arxd's generated runtime root.
No termux-exec environment toggle may disable these host requirements.
Package bytes and official repository metadata are not patched.

Keep upstream formatting for reviewable deltas. Runtime verification belongs at
the real Android process boundary; see `apps/arxd/native/preload/probes.json`.
