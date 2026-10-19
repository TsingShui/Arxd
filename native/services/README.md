# Native MCP transport and Android acceptance

The native broker owns protocol input/output independently of React screens and
Pi promises. The process supervisor creates instances, continuously forwards
MCP-owned stdout to the broker, logs stderr separately, and rejects generic
stdin writes for protocol-owned processes. The broker never spawns, restarts,
closes stdin or sends an application shutdown command.

The supported MCP baseline is **2025-11-25**, stdio and Streamable HTTP. Native
OkHttp **4.9.2** matches the pinned React Native HTTP stack. TLS uses platform
trust; redirects and connection retries are disabled, and every POST body is
one-shot. SSE responses and bounded cursor recovery use GET only. An expired
HTTP session requires explicit reconnection; no original request is replayed.
Initialize negotiates empty client capabilities: only server `ping` requests are
handled; sampling/elicitation/resources/prompts are not advertised. Unsupported
server requests receive JSON-RPC `-32601`.

`NativeMcp.get(context)` provides `connect`, `request`, `cancel`, `setEnabled`,
`disconnect`, `state`, `states`, `accept(instanceId, bytes)` and
`processEnded(instanceId)`. Configurations contain an ID, transport, optional
managed instance and HTTP URL/headers. Credentials/session headers remain in
native memory; public states omit them. RPC error text is bounded and configured
credential values are redacted. Server results remain untrusted data; a malicious
server already holding a credential cannot be guaranteed not to leak it.

`tools/list` retains server pagination cursors. The workspace registry aggregates
bounded pages, validates argument schemas and pins tool identities/revisions.
`tools/call` retains `isError` results, distinguishes JSON-RPC errors, and uses an
explicit invocation ID. Reusing an admitted invocation is refused, including
when its outcome was uncertain. A native cancellation returns without waiting
for the cancellation notification, cancels the local wait/socket, and best-effort
notifies the server. It cannot undo an already completed external side effect.

Disabling removes admission and cancels pending calls but leaves the protocol
reader and associated process alive. Reconnect to the same initialized stdio
binding verifies it with a ping, rather than sending initialize twice. Failed
or uncertain stdio initialization cannot be silently replayed on those pipes.
Native protocol stdout is not an ordinary log stream. Chunked writes (16 KiB)
are serialized under a per-client lock; an uncertain partial write invalidates
the connection rather than sending subsequent frames into a broken boundary.

Numeric native defaults: 16 connections, 16 pending requests total/8 per server,
1 MiB protocol message, 256 KiB request parameters, JSON nesting 64, 128 tools per
page, 1024 content blocks, 256 inbound messages per second/server, 120 seconds per
request, 15-second process-readiness/initialization waits, 4096 invocation records
per host lifetime. Exhausted ledgers reject admission rather than forgetting
unsafe identities. HTTP headers are limited to 32/16 KiB; metadata to 8 KiB per
negotiation object. SSE request streams are limited to 4 MiB, individual events
to 1 MiB; up to three GET cursor resumptions stay within the original deadline,
with server retry intervals bounded at 10 seconds. Native pools and queues are
bounded; optional GET listeners have their own pool, so idle listeners cannot
monopolize request workers. Disabled HTTP and ended stdio bindings may be retired
at the connection limit. No hard CPU/memory or arbitrary daemon ownership claim
is made.

The original Python stdlib fixture `mcp-fixture.py` is version 1, trusted test
code, and never executes tool arguments. Its protocol framing does not share
client implementation. It supports stdio, loopback HTTP JSON/SSE, pagination,
Unicode, tool/RPC errors, cancellation, bounded slow calls, schema-change
notifications, unsupported server requests, credential checks, redirects,
unknown versions, expired sessions, cursor resumption, uncertain mutation
responses, oversized messages and deeply nested JSON. Counters are flushed and
fsynced; all mutable state is under a verifier-owned temporary directory.

The Android-only route `arxd://verify-mcp` runs through the public native bridge
and real managed Python. `?background=1` publishes
`arxd-mcp-native-ready-background` immediately before a 10-second native RPC,
allowing the device coordinator to background and lock Arxd during the wait.
It emits `arxd-mcp-native` with checks/outcome and explicitly stops only its own
fixtures in cleanup. This route does not prove Pi dynamic tool admission (the
workspace/Pi acceptance covers it), sustained Android background behavior,
root execution, TLS fixture coverage or UI management. A successful static
compile, app lint or typecheck is not Android functional evidence.

## Supervisor and request admission safety

The owned process-group leader is a trusted Bash supervisor. It launches the
payload with unchanged stdin/stdout/stderr, retains its verified PID/start time,
and atomically receives the payload exit status. Natural payload exit triggers
TERM/KILL of the verified group before reporting completion, including ordinary
redirected background children. `exitCode` remains the payload status;
`supervisorExitCode` and `payloadPid` distinguish the host leader from its command.
A missing or changed leader permits only a harmless group-existence probe and
never authorizes signaling a possibly reused group. Detached sessions are outside
the declared foreground-group ownership scope. Root control uses the bundled
Python interpreter to distinguish ESRCH from permission/control errors explicitly.

A persistence failure before spawn is contained on the service thread. Subsequent
registry write failures remain visible as `persistenceError` while native ownership
and stream draining continue. Live/possibly-surviving instances retain foreground
notification ownership and an admission slot even when their displayed state is
`lost`; a failed/interrupted Stop cannot free capacity for unbounded survivors.

MCP saved headers are scoped to the exact canonical HTTP endpoint. Changing the
destination removes old secure headers before publishing the replacement
configuration. Production discovery and calls pass captured connection ID and
catalog revision through `mcpRequestBound`; native admission checks them under
its connection lock before recording or dispatching an invocation. The legacy
unbound request bridge remains solely for existing native protocol verification.
An explicitly removed exited process is a structured not-found outcome, allowing
a subsequent explicit MCP start; permission, storage and other inspection errors
never imply absence or authorize a replacement launch.

`arxd://verify-service-safety` is a dedicated Android acceptance route. It uses
real workspace state, a trusted loopback server, native process controls and
fixed storage/interruption scenarios to check destination scoping, stale binding
rejection, redirected-child cleanup and preserved exit status, pre-spawn EISDIR
containment, interrupted Stop ownership, and restart after explicit record
removal. Its evidence event is `arxd-service-safety`. The EISDIR fixture exercises
the shared persistence-failure containment path; it is not a claim that physical
storage exhaustion or every fsync failure has been induced. Device execution is
reported separately from compilation and host type checks.


## Pi/process verification

`arxd://verify-services?run=<unique-id>&case=functional` opens a dedicated real
Expo-SQLite workspace and the same Pi/service/MCP libraries as the App. Only its
provider responses are deterministic. It executes the shipped trusted
`process-fixture.py` (version 1), real rxd analysis and the independent MCP
fixture; analyzed imports are never executed. It verifies process start followed
by other actual tools/rxd work, stdin and genuine persistent Bash state, Unicode
and binary cursors, bounded flooding/gaps, chat Stop/conversation removal lifetime,
stop escalation, stdio/HTTP MCP dynamic schema admission, workspace sharing,
credential removal and observed root identity or explicit unavailability.

The `intent`, `spawn`, `result`, `input` and `mcp` cases stop at observable durable
boundaries; `stage=resume` requires a new Android process and checks retained
side-effect counters plus unsafe-operation interruption. MCP mutation recovery
uses an independent host HTTP fixture that survives the APK force-stop. No
checkpoint is a mocked process effect. Root success is claimed only when UID 0
and stop are observed on an actually capable device; an unavailable root result
is separate evidence.

`case=background` starts an actual loopback HTTP process, then closes the Pi
workspace owner before publishing readiness. The host driver backgrounds/locks
Android and sends real requests throughout the recorded interval. `stage=finish`
reattaches to the existing native instance without restarting it and stops it
explicitly. `case=storage` temporarily denies writes to the isolated package's
owned process registry/log file, restores modes, and checks failed-admission
rollback, single explicit retry and visible reader failure. It does not pretend
an invalid input is a storage fault or claim a full-filesystem ENOSPC test.

Run against an already installed **isolated** non-debuggable APK:

```sh
python3 apps/arxd/scripts/verify-services.py --serial <device> \
  --package <isolated-package> --apk <combined.apk> \
  --checkpoints --storage-faults --background-seconds 60
```

The driver never installs an APK, grants only the test package's foreground
notification permission, and force-stops only that explicit package for restart
checks. It uses the shared chunked evidence format. `--native-mcp` reuses the
existing native protocol matrix when a rerun is warranted; it does not duplicate
that suite in new helpers. Screenshots, device/OS/APK/runtime identities, numeric
limits, control observations, root scope and cleanup outcomes belong to ignored
`target/arxd/services-evidence/`. Static checks and route availability alone are
not Android acceptance. UI page/notification interaction coverage remains a
separately recorded check.

### Foreground-service generation transitions

Each foreground-service instance owns a bounded set of execution IDs and a fresh
in-memory generation token. Destruction stops only those IDs, with generation
matching rechecked under the native process-owner lock; it does not run workspace
Stop All. The notification's explicit Stop All action remains workspace-wide.
Idle shutdown uses Android's latest start ID and relinquishes notification/wake
ownership only when `stopSelfResult` accepts the stop. A previous service removes
its changed callback only while that callback still belongs to it. Notification
counts include pending/uncertain instances rather than claiming every entry is
application-ready or running.

Explicit Stop can recover a missing in-record startup identity only from that
instance's bounded private PID, initial-stat, UID and payload-PID sidecars. It
checks captured PID/PGID/start ticks and requested UID, then still verifies the
live identity before any real signal. Missing/invalid evidence remains unknown;
there is no force-forget or arbitrary PID adoption. Original startup/I/O failure
information remains available alongside failed-stop diagnostics. The payload exit
staging marker is created by the App before root launch so a restrictive root
umask cannot make the final atomic marker unreadable.

The Android safety route now exercises twelve rapid short-exit/next-start/stop
transitions through the production APIs. Its base runtime is prepared first, and
per-transition waits respect the documented startup deadline. The production
services functional matrix remains the primary reproducer for the observed
queued-MCP teardown regression. Neither static checks nor this added scenario
constitutes a claim that the device regression has passed.

### One-shot bootstrap environment and operation budgets

The native launch entry removes `ARXD_JOB_FILE` with a Bash builtin before any
external command or payload fork, then replaces that shell through the managed
exec adapter without changing its PID/group. Removing a C `environ` entry alone
is insufficient when Bash imports the original startup `envp`. Descendants must
not recreate a process group or overwrite the supervisor's one-shot PID file.
The Android functional fixture independently records its actual PID, PGID and
absence of the bootstrap variable. This launch path is also used by bounded
shells and offline setup; their Android child-process acceptance must be repeated
when this adapter changes. No C shim/bootstrap identity is changed by this fix.

MCP discovery has a 32-page and 60-second caller budget, including initialization
wait; its page dispatches honor the remaining budget and cancellation. A shared
initialization already in flight may settle after cancellation, but the canceled
operation dispatches no later pages or tools and does not tear down another
Agent's connection. `mcp_search` publishes these limits. Endless unique empty
pages are exercised by the real loopback fixture. The native notification worker
has at most one running and one queued stop operation; repeated Stop All actions
coalesce while a batch is pending. Explicit checkpoint cleanup failures fail the
Android driver instead of merely being attached to an overall-success report.

### Production page and notification acceptance

After installing the same non-debuggable isolated APK, run from the repository:

```sh
python3 apps/arxd/scripts/verify-services-ui.py --serial SERIAL --package art.tsingshui.arxd.specs --apk target/arxd/gradle/_app/outputs/apk/release/app-release.apk
```

Run this only after other device acceptance jobs finish. The driver verifies the
installed APK hash, rejects production package IDs, and requires no pre-existing
active or uncertain services in the isolated package before testing Stop All.
Every ordinary UI node must belong to the exact target package. Notification
interaction is limited to SystemUI's uniquely identified managed-service row,
after proving the only matching notification record belongs to that package;
ambiguous or foreign notifications cause failure rather than coordinate taps.

Actual production process controls create a trusted fixture, read logs, send
stdin and explicitly stop it. Actual MCP controls save/start/discover a stdio
configuration, inspect a real schema, disable/re-enable the same instance, follow
its process link, and connect to authenticated HTTP with secure header entry.
A small isolated observer route supplies fixture paths and reads native state;
it never substitutes programmatic process starts or MCP configuration for UI
interaction. Only setup/ownership metadata and explicit owned cleanup mutate
fixture files. Secrets are fixed fixture values, with no paid/model traffic.

Notification entry must open the production process page. Its real Stop All
must leave every tracked instance exited without uncertain ownership; native
records and captured OS identities are checked independently of notification
visibility. A fresh App process must retain the same exited IDs and one launch
counter per service. Screenshots/XML and structured state go under ignored
`target/arxd/services-ui-evidence/`. Cleanup removes only UUIDs whose stored
names match the unpredictable run prefix. This source defines acceptance;
syntax/type/lint success is not evidence the controls passed on Android.

### Locked stdio completion with an unavailable JavaScript thread

Run the existing native protocol matrix with the optional Android driver flag:

```sh
python3 apps/arxd/scripts/verify-services.py --serial SERIAL \
  --package art.tsingshui.arxd.specs --apk /absolute/path/to/combined.apk \
  --native-mcp-background --background-seconds 0
```

This requires the matching fixture assets in the installed APK. The driver waits
for a real ten-second stdio request to start, records its native RPC correlation
ID, backgrounds Arxd and observes screen-off/keyguard state for sixteen seconds.
The trusted verification route deliberately holds its JavaScript thread for a
bounded fourteen seconds; this is an explicit test condition, not a claim that
Android automatically pauses JavaScript. Native pipes and HTTP remain available.

The independent Python fixture retains at most eight timing-only records in an
8 KiB atomic file. Completion is marked only after the correlated stdio response
has actually been written and flushed. A fixed loopback verification endpoint
exposes these timestamps and process/launch identities, never arguments,
credentials or arbitrary files. Host HTTP probes prove response completion while
the device is still locked and the client later verifies it occurred during the
JavaScript hold. Both process payload PIDs and launch counters remain unchanged.

The driver brings the same existing Activity forward without a second deep link
or process restart, checks its Activity token and App PID, then requires the
normal native result and all existing protocol/cleanup checks. Both fixture
servers remain available for a bounded thirty-second observation window. The
existing finally path wakes the device and removes only its own adb mappings.
This source defines acceptance; no device success is inferred from static gates.

Add `--lifecycle` for four separate actual Android lifecycle cases, each using a
fresh trusted HTTP fixture started through the production process form:

- Clear the Activity task and start a new task; require a different resumed
  ActivityRecord while the exact host PID/start time, managed supervisor/payload
  PID and one-launch counter remain unchanged, with a real HTTP response.
- Background Arxd and SIGKILL only its captured host PID, without force-stop.
  Existing device root is required. Before signaling, revalidate the isolated
  package, native/PackageManager/proc UID, exact process command and kernel start
  time in the same privileged shell. Never signal a group or adopt a daemon.
- Execute `cmd activity stop-app PACKAGE`, the official Android 13+ Task Manager
  user-stop test, independently of notification Stop All and force-stop. The
  device's activity shell help must advertise that command.
- Force-stop a separate active fixture, recording the package's stopped flag as
  distinct from SIGKILL and Task Manager user-stop.

The official user-stop semantics and command are documented at
[Android foreground-service user stopping](https://developer.android.com/develop/background-work/services/fgs/handle-user-stopping).
The proof records that source URL and each independent case. Cold reopening must
preserve the original instance handle and one-launch counter, without claiming
that a still-alive child is owned or dead. Root `/proc` observations distinguish
absence, changed identity, zombies and a surviving original process; surviving
processes must remain explicitly lost/uncertain in Arxd. An explicit normal
production Stop then verifies the same owned group has ended. No watchdog,
automatic relaunch, generic root process adoption or reboot guarantee is tested.
Only the coordinator runs these disruptive device cases; static source checks
are not lifecycle acceptance evidence.

### Native startup approval and explicit root denial

Managed payloads now wait behind a versioned native approval gate. The supervisor
first writes its captured UID/PID/stat markers and a fresh ready nonce, then waits
for the native host. Only after validating those markers and the requested
identity does the host atomically approve that nonce; the payload fork occurs
after approval. Root permission loss, malformed markers and stopped launchers
cannot skip this gate. Shell startup hooks (`BASH_ENV`, `ENV`, shell option/xtrace
variables) are reserved at the host boundary; trusted scripts can explicitly set
workflow variables inside their admitted body instead.

A concrete root proxy denial is a terminal `failed` record with
`rootStartupDenied=true`, `payloadAdmitted=false` and no surviving managed payload
only when the proxy exited nonzero, every startup marker is empty, no approval
was issued, both pipes drained, and the retained diagnostic says Permission
denied. This is a pre-admission denial proof, not an inference from a missing PID.
Partial markers, a hung negotiation or an already approved payload retain the
existing verified-cleanup/unknown rules. The gate is closed on an unapproved
exit, so a delayed helper cannot later execute the requested body.

Old records created without this gate are not retroactively declared safe or
force-forgotten. The Android functional root case checks actual denial metadata
and independently verifies that its trusted payload launch counter was never
written; positive root capability still requires observed UID 0 and verified
explicit stop on a device whose root manager authorizes the App UID.

### True conversation purge and retained controls

The functional Android driver now calls real `core.purge` twice while the same
trusted echo, stdio MCP and HTTP MCP payloads remain active. It retains manager
and method handles, pauses an actual Keystore write before its SQLite save, and
requires purge to join that accepted operation. It checks durable preference
active/list references, removed owner documents, retained source bytes, unchanged
PID/start/launch/initialize identities and usable enabled MCP through another
conversation. An actual shell-installed skill and skill/MCP subscriptions cross
both session replacements; explicit mutations deliver once, unsubscribe stays
synchronous, and closing the owner leaves zero native skill watchers.

The host then cold-reopens the same functional SQLite workspace and checks
reference removal, unchanged survivor context/capacity, retained files and zero
model replay. Raw credential values are excluded from reports. This defines the
acceptance path; actual Android execution is separate from TS/lint/export.

A focused existing host regression also materializes the same public preference
document after purge/reopen. Restoring the old plain-string kind SQL reproduces
its failure because pinned Pi stores `documents.kind` as a JSON-encoded string.

Verification URIs and native fault/fixture hooks are disabled by default, including isolated builds. A release acceptance build must set **both** `ARXD_ENABLE_VERIFICATION=1` and an isolated `ARXD_ANDROID_APPLICATION_ID=art.tsingshui.arxd.specsui` for Expo config/prebuild/export; keep that environment for the coordinated build. Enabling verification without an isolated ID fails configuration. The production package `art.tsingshui.arxd` can never enable it. Native manifest metadata is the runtime authority, so a URI or changed JS manifest cannot opt in. Normal product pages do not require this flag.

```sh
ARXD_ENABLE_VERIFICATION=1 ARXD_ANDROID_APPLICATION_ID=art.tsingshui.arxd.specsui npx expo prebuild --platform android --no-install
# Build the corresponding non-debuggable APK, then run the existing Android drivers.
# Separate negative APK: ARXD_ENABLE_VERIFICATION=0, isolated package specsclosed.
python3 scripts/verify-verification-gate.py --serial DEVICE --package art.tsingshui.arxd.specsclosed --apk NEGATIVE_APK
```

The negative driver opens only an intentionally isolated opt-out package, checks rejection before production workspace/SQLite creation, and observes zero loopback fixture requests. It never targets the user's package or reads credentials. Actual device results must be recorded separately from static/build success.

Service definitions are retained immutable v1 launch configurations, identified by `svc-v1-` plus SHA-256 of canonical launch content (`arxd-service-definition-v1\n` domain separator). Name, script/argv, identity, cwd, explicit environment and configured endpoints contribute; origin, admission, execution and MCP protocol-owner IDs do not. Registry schema 2 migrates schema 1 records by capturing their existing configuration without launching anything. Each new execution stores its own full immutable snapshot and definition ID. Definitions survive record removal and reopen, bounded at 256 definitions and 32 MiB for the combined registry. `process_definitions` lists bounded metadata, `process_definition` inspects a definition without returning environment values, and `process_definition_remove` explicitly removes an unused definition only after all retained instances are removed. `process_start({definitionId})` creates a new execution; overrides alongside a reference are rejected. The process page offers explicit repeat for a cleaned non-MCP execution. An MCP configuration may reference a saved definition independently of its MCP/configuration and live-connection IDs; disabled/stopped services never restart automatically.

MCP aliases identify an immutable offered catalog: configuration revision, native connection identity/revision and actual discovered schema content. Exact unchanged rediscovery preserves aliases; changed content withdraws them and creates new names, including silent schema changes without a notification. The stable logical identity remains configuration ID plus original remote tool name. The functional Android verifier holds a real Pi model request while the shared MCP UI library refreshes a changed independent server schema, requires zero old-call effects, then admits one explicit new call. Catalog publication and production RPC admission share the native admission lock, including a captured catalog token, so a schema refresh racing a JS promise cannot redirect old calls. Native connection/PID checks and no-POST-replay behavior remain in force.
