# Arxd Android app

Status: implemented.

Arxd is the Android host for rxd. It provides persistent Agent conversations,
process-restart recovery, workspace files and skills, connection-scoped models,
optional on-device GGUF models and local rxd analysis without embedding a second
analysis implementation. App code and Android adapters live in ``;
analysis stays in the Rust backends.

## Architecture

- **Runtime**: Expo/React Native Android app using Pi's published ESM packages and
  Pi-durable's portable core, with SQLite persistence and a local native module.
- **Analysis**: the unchanged rxd CLI is cross-compiled for
  `aarch64-linux-android` with the Android-buildable static-analysis backends and
  packaged as `librxd.so`; the module launches it directly with argv, without a shell.
- **Conversations**: durable messages, tool intents/results and task state survive
  App-process death; completed results are reused on reopen, interrupted pending
  calls are reported rather than rerun.
- **Workspace**: an independent file catalog and roots for workspace files and the
  built-in runtime Home. Analysis captures are immutable and content-addressed;
  editable working files are separate and are recaptured before analysis.
- **Skills**: imported or shell-installed Agent Skills are versioned, admitted before
  a task and pinned for that task. Selection persists across process restart.
- **Models**: connection-first configuration with per-connection credentials and
  models; chat selects an enabled model and thinking level. Cloud and on-device
  models share the Pi provider interface.
- **Network policy**: only explicit user-configured providers are contacted. No
  on-device model failure falls back to a cloud provider.

## Conversation execution

The screen streams thinking, text and tool activity with explicit status, timing,
cancellation and recovery. Context compaction is enabled by default with
model-sized budgets; manual compaction and status are available. A failed or
cancelled task leaves durable state that can be inspected and recovered.

Tools run through the durable execution boundary. The optional `shell` tool starts a
fresh managed Bash process per call with explicit working directory, environment,
timeout and output limits; shell variables and working-directory changes do not
survive a call. Shell declares `replay: unsafe`: intent is committed before
execution, completed results are retained, and an interrupted call is reported on
reopen instead of rerun. Cancellation covers waiting and active jobs and kills the
per-command process group. Arbitrary daemonized children are not promised to be
cleaned up.

The narrow `rxd_file_outline` tool writes an App-private temporary JS file and runs
rxd with 4 KiB input, 128 entities/records, 32 KiB output and AST depth 128. The
managed shell exposes the same executable as `$ARXD_RXD`; other bundled commands
can analyze immutable attachment paths without executing input. Worker/process
isolation is not an OS security sandbox.

## Files

The file manager owns `arxd_files` metadata and separate typed roots. It supports
bounded list/read/write/create/rename/copy/move/delete, directory paging, previews,
sharing and artifact save/attach flows. Paths are validated by the native host,
including symlink traversal and root/size guards; credentials and conversation
storage are not exposed as editable roots. Advanced runtime package files may be
browsed read-only.

Conversation deletion never deletes workspace files. Saved reports, imports and
attachments remain discoverable after their last conversation link is removed.
Deletion uses restart-resumable tombstones and retains historical tool results.

## Skills

`src/workspace/skills.ts` owns the skill catalog, versions and enablement state. A
stable UUID identifies each skill independently of its editable directory name.
`SKILL.md` uses Agent Skills YAML frontmatter with validated name/description;
optional license, compatibility, metadata and allowed-tools are retained. YAML
tags are never executable, and tool declarations do not grant host permissions.

Shared working files live at `skills/<folder>` and are editable through the file
manager or the `skills` mount. The host prepares `~/skills` as a controlled
symlink and advertises the real directory as `$ARXD_SKILLS`; the alias is not
indexed as a second skill. Shell installers publish a physical package under
`$ARXD_SKILLS/<folder>`; arbitrary default locations, linked packages and linked
resources are unsupported.

Imports copy bytes from one definition, an Android SAF tree or an unmanaged
workspace directory. Packages are bounded to 256 entries, depth 16, 8 MiB total,
2 MiB per resource and 64 KiB for the definition. Local symlinks, path traversal
and recursive imports of the workspace/managed skill root fail. Version identity
includes empty directories and every file's path/hash/length; the pinned copy is
rescanned before admission.

Before an input is submitted, enabled skills are validated and snapshotted into
private `skill-versions/<id>/<hash>/<name>`. The system section initially contains
metadata only, capped at 16 KiB with explicit incompleteness and search over the
full catalog (at most 256 skills). `skill_load` returns the full definition and
pinned base directory; `skill_read` pages resource metadata or UTF-8 byte ranges.
Every tool request validates the admitted identity/version. Up to eight explicit
conversation selections persist. For windows below 65,536 tokens, discovery and
tool response budgets scale down with the selected model; an instruction that
cannot fit its response budget is rejected with the skill name and guidance to use
a larger model, never silently truncated.

Import, enable and select are data operations, never requests to execute scripts.
A later Agent task may run bundled scripts through the existing shell. Pinned
versions prevent ordinary working-file edits from changing an admitted task; they
are not an access-control boundary against arbitrary shell commands. A newly
installed skill becomes available at the next input boundary. Deletion retains
messages/tool results and unrelated library files.

## Connections and models

A connection has a stable ID, display name, protocol/provider preset, endpoint,
credential reference and enabled models. Model identity includes the connection,
so the same upstream model ID can exist under multiple accounts. Credentials stay
in SecureStore; serializable connection documents never contain secret values.

Presets include DeepSeek, OpenAI, Anthropic and Google; custom endpoints use OpenAI
Completions, OpenAI Responses, Anthropic Messages or Google Generative AI. Model
discovery uses each endpoint's chat-capable model list: OpenAI-compatible/Responses
`GET /models`, Anthropic `/v1/models`, Gemini `/v1beta/models`. Non-chat artifacts
and Gemini models without `generateContent` are skipped. Known IDs use Pi catalog
capabilities; unknown IDs become editable manual models with safe defaults.
Discovery is idempotent and does not overwrite existing generation settings.

Generation controls are capability-aware and separate from ordinary model
selection. Default output budgets are concrete token counts. Disabled or deleted
models fail submission explicitly; there is no silent switch to another provider.
A saved key or `checkAuth()` result is not a successful network test.

## Optional on-device models

Arxd offers an explicit on-device model choice, never a replacement default or
cloud fallback. It supports one pinned Qwen download and user-imported GGUF files
through the same Pi provider. Inference is Pi provider → `llama.rn` 0.12.9 →
in-process llama.cpp; there is no localhost server, API key or vision projector.
This is App-level inference, not a new rxd analysis backend; model latency is
measured separately from rxd.

The CPU configuration targets recent flagship Android ARM64 devices: at most 8,192
context tokens, at most 1,024 generated tokens, four CPU threads, mmap, one request
at a time and no implicit context shifting. Jinja uses the GGUF chat template.
Structured native tool calls become Pi events only after every name and JSON
argument validates. The pinned engine does not install an optional Qwen/tool GBNF
in this flow; the adapter uses the exact token-counted Jinja prompt and serialized
native chat parser, then validates the generated call. Malformed, unknown or
incomplete calls fail and are never repaired or executed. The known empty
`<think>` prefill is stripped only from the exact verified input suffix, never from
generated reasoning or tool arguments. Sampling is temperature 0.2, top-p 0.95,
top-k 20, no presence penalty. Images, oversized transcripts, context overflow and
incomplete tool generations fail explicitly.

Thinking is opt-in per model. The import probe formats the same conversation with
the template switch off and on; a different prompt plus a structured parser records
`thinking=true`. The template exposes a boolean, not effort levels, so the UI
offers only `off` and `medium`. With `medium`, Pi sets `enable_thinking=true` and
`reasoning_format=auto`; native `reasoning_content` streams as a Pi thinking block
before text or tool calls and is never spliced into the answer. With `off`, the
fast `reasoning_format=none` path is used. Thinking shares the output budget and
per-request deadline (90 seconds by default, capped at 180); exhausting the budget
fails closed instead of executing a partial tool call.

Only `rxd_file_outline` and `shell` are offered to an on-device model. Such
conversations select only runtime, workspace and context-accounting extensions with
compact safety-preserving instructions; unrelated CodeMode, skill and MCP prompt
sections are not loaded. Explicitly selected skills must be deselected before an
on-device send; they are never silently ignored. Four tool rounds per user message
and eight calls per response bound a turn. Cancellation stops native decoding,
discards failed recurrent state and never retries via cloud. Native model
initialization is not preemptible; an abort during load is observed immediately
after initialization, then the context is released. Backgrounding aborts decoding;
an idle model unloads after 60 seconds. Concurrent foreground or compaction
requests fail visibly rather than queueing unbounded native work.

### Pinned model and engine

`modules/rxd/android/src/main/assets/qwen-model.json` is the shared
Android/TypeScript manifest for the one-click model:

- Official post-trained `Qwen/Qwen3.5-2B` (Apache-2.0), third-party Unsloth GGUF
  `Qwen3.5-2B-Q4_K_M.gguf`; this is not a new upstream Qwen release.
- Repository revision `f6d5376be1edb4d416d56da11e5397a961aca8ae`.
- Bytes `1280835840` (1.28 GB decimal; not a runtime memory estimate).
- SHA-256 `aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223`.
- Engine npm `llama.rn@0.12.9`, MIT, package integrity pinned in
  `package-lock.json`; checksum-verified Android JNI release archive
  SHA-256 `cda945a7c0ed075a0b028c1c3c6f5b668532eb18b069ecc4793ed7ca6cdb65ac`.
  OpenCL/Hexagon are not enabled for the initial CPU path.

The internal provider/choice IDs keep their original spelling
(`arxd-local-qwen`, `qwen-3.5-2b-local`) so existing conversations resolve; the
product/UI name is the on-device model.

### Imported GGUF files

Connections → on-device models exposes **Import GGUF**. The system document picker
returns the selected file without copying it to the App cache; the native module
reads `content:` or `file:` URIs through `ContentResolver`. Import is explicit and
fail-closed:

- Input ceiling 8 GiB, with free-space, 30-minute overall, cancellation and
  60-second stalled-provider bounds. Files are copied to a private `.part`,
  fsynced and hashed while reading; nothing is executed. The source stays where the
  user selected it, so importing needs space for a second copy.
- Registry identity is the full SHA-256, exposed as `gguf-<first 16 hex>`.
  Re-importing identical bytes returns the existing record; at most 16 models are
  tracked. A damaged registry is quarantined and never authorizes files.
- Structural gate: GGUF magic, version 2/3 and bounded tensor/metadata counts.
- Runtime gate on the real engine: llama.cpp accepts the architecture/quant,
  `<arch>.context_length` is at least 2,048, `tokenizer.chat_template` is
  non-empty, Jinja is supported, and `getFormattedChat` with a probe tool returns
  a Jinja prompt plus a native `chat_parser`. This is a capability gate, not a
  model-name allowlist.
- A file failing the runtime gate is deleted; a pre-existing deduplicated record is
  left untouched. Errors name the incompatibility and never repair, substitute or
  call the cloud.
- Accepted limits are persisted: `contextWindow = min(8192, n_ctx_train)` (8192
  when metadata is unavailable), `maxTokens = min(1024, contextWindow / 4)` and
  the thinking-switch capability. They feed the Pi model definition and prompt
  budget check.
- Chat-only GGUFs are rejected: an on-device Agent model must expose structured
  tool calls. Loading a template is not treated as tool support.

The registry lives in `noBackupFilesDir/local-models/index.json`, written
atomically; model files stay outside Android backups. The pre-registry
single-model install is adopted only when its size and legacy receipt match the
pinned manifest. Deleting a model removes only its weights; conversations and
analysis files remain. A selected model whose file is missing fails instead of
silently choosing another provider. Every cold load re-hashes the complete file
with a 120-second bound, so registry data never replaces content verification.

The deterministic `faux` model remains exclusively a test fixture. Guarded
`ui-local-*` actions exercise real weights through the public workspace/rxd path;
inference evidence is never inferred from TypeScript checks or an ordinary chat
response. Test transports do not prove production HTTPS downloading or the system
picker's `content:` grant.

## Managed services and MCP

Managed native services and MCP entries are explicit, isolated, cancellable and
bounded. Service definitions retain versioned content identities; process
registries migrate without execution; automatic restarts are unsupported. MCP is
default-off; enabling it is an explicit user action. Disabling MCP sends no
loopback requests, leaves stdio usable and preserves configuration/credentials/
process retention. Verification-only network probes require an isolated build and
are unavailable in normal production builds.

Service and skill mutation requires task quiescence. Shell changes reconcile while a
task runs but never alter its admitted set or pinned versions. Credentials,
conversation storage and native registries are not editable workspace files.

## Build and verification

Host checks use TypeScript, Expo lint, Node tests with the Pi-native compatibility
loader, real Bash/Python/Node/rxd processes and SQLite. Android verification uses
the isolated package `art.tsingshui.arxd.qwen`, a non-debuggable ARM64 release APK,
the real native SQLite/Hermes/executable identity and fresh App processes. The
physical-device harness covers UI actions, runtime status, file/skill flows,
connection/model probes, offline model import/download/probe/cancel and managed
shell execution. Test fixtures never substitute for real HTTPS or system-picker
evidence.

The build cross-compiles the unchanged CLI with the selected NDK/API 26 linker and
16 KiB ELF LOAD alignment. Kuna specs and the ILSpy Android C ABI bundle (with its
private OpenSSL) are embedded. The manifest binds executable bytes to the source
revision, target and feature set; native code verifies the manifest and task engine
hash. The module launches `nativeLibraryDir` directly with argv, without a shell.
Generated evidence belongs under root `target/arxd/`.

## Boundaries

Android is the supported host. iOS, OAuth mobile login, a terminal UI, Node
embedding, arbitrary-package compatibility and full coding-agent extension
compatibility are separate decisions. The App is a host for rxd, not a replacement
for the Rust analysis backends. Input analysis remains offline and never executes
analyzed code; App-level model inference and rxd execution are reported separately.
