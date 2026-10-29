# Arxd LD_PRELOAD experiment

This is an Android ARM64 execution experiment, not a supported generic Linux
container. It keeps Arxd's own `art.tsingshui.arxd` package, UID and target SDK.
It neither starts another App nor uses PRoot, root or a custom package server.

`bootstrap.json` pins the unchanged Termux upstream bootstrap by release, byte
count and the SHA-256 published in the GitHub release asset metadata. The build
script verifies it and packages the original ZIP in the APK. Original packages,
copyright notices, trusted repository keys and repository configuration remain
in the archive. Subsequent package installation uses normal apt signature
verification and the HTTPS official source shipped in that archive.

`compat.c` is Arxd-authored Apache-2.0 host/relocation code. The execution pipeline
is adapted from the pinned snapshot in `third_party/termux-exec/`; see its
REFERENCE.md for original identities, licenses and local changes. Upstream
shebang/argv construction, fd execution and PATH fallback compile into the shim.
Its process-local interposition
maps the two default Termux App-data path spellings into Arxd-owned storage,
maps conventional interpreter paths, and launches data-directory dynamic ELF
programs with Android's system linker. It supplies the actual executable path
to readlink callers and carries command arguments/environment across child
execution. Linker-mediated argv[0] behavior is not a general POSIX guarantee.
The host reserves `ARXD_TERMUX_ROOT`, `ARXD_TERMUX_APP_ROOT`, `LD_PRELOAD`,
`LD_LIBRARY_PATH` and `PREFIX`: the shim caches them on process startup and restores
them for child execution, including callers that supply an empty environment
or explicitly blank a loader variable. Other caller environment entries are
preserved. Thus `env={}` clears ordinary variables, not this managed loader
context. This is needed by libuv and Python's upstream packaging helpers.
Execution of `/system/bin/sh` uses managed Bash so shell commands also retain
the context; reading that system file is not redirected.
The job leader owns a process group so a timeout or completed command can clean
up its remaining children. No analyzed input is executed by this experiment;
the scripts in `probes.json` are explicit, trusted verification code, shared by
the native verification service and the screen entry point.

The reference for linker execution is upstream's documented technique:
<https://github.com/termux/termux-exec-package/blob/master/site/pages/en/projects/docs/technical/index.md>.
The APK includes the execution-source notices. The official bootstrap and
installed packages retain their own licenses and source identities; they are
not relicensed as Arxd code.

This is deliberately not a complete filesystem virtualization layer. Static
executables, raw syscalls, hidden/internal libc calls, linker namespace rules,
arbitrary native addons and Android-facing Termux plugins need independent
evidence. Every newly exercised important failure must be fixed at the real
device/process seam or documented as an unsupported workload. A successful
Python/Node probe must not be reported as compatibility of the complete repo.

Build artifacts, original downloads and device evidence live in root
`target/arxd/`. `scripts/build-preload.py` builds the shim with NDK 28.2 and
stages assets. Use Expo prebuild/config plugins for native project settings;
never patch generated Gradle files or the bootstrap's executable bytes.
The staged manifest binds all shim/adapted execution source files and reads
Unix executable modes from the original ZIP central directory. Native setup
restores those modes, including APT methods outside bin/libexec.

## Network research tools

The normal build also stages unchanged Android ARM64 eCapture 2.9.0 using
`scripts/fetch-ecapture.py` and `ecapture.json`. The pinned official HTTPS archive
must match the pinned upstream checksum file and executable hash. Upstream
currently publishes no signatures/attestations; do not describe these checks as
signed provenance. Its static ELF is installed as `libecapture.so` in Android's
executable nativeLibraryDir, excluded from stripping. It is NOT run via linker64
from writable App data. Both Full and Lite retain this tool.

The offline package bundle binds the host-owned `ecapture` launcher and version
pin by path, size and SHA-256. Preparation installs them into a staged prefix,
rejects conflicting user files, and verifies their identity before publication/reuse.
Retired, unchanged host files are removed from the staged generation; modified
ones require explicit reconciliation and leave the existing runtime untouched.
Use the original `ecapture` and `tshark` commands directly; see
[network tools](../../docs/network-capture.md). No root request, live capture,
TLS trust change or config listener occurs during preparation.

## Offline base toolchain (#160)

Normal preparation now adds an independently identified official-package bundle:
uv/uvx 0.13.6, Python 3.14.8, Node 26.12.1, npm/npx 11.21.1, Git 2.56.0,
curl 8.23.0, android-tools 37.0.0p1-3, Frida/frida-python 17.2.14-4,
tshark 4.6.9, iproute2 7.3.0 and their complete
required package closure. `runtime-packages.json` and the signed repository
snapshot under `prebuilt/arxd/` pin the exact inputs. The package bundle is
assembled reproducibly from unchanged .deb bytes; licenses and APT/dpkg metadata
remain installed. Build-time GnuPG verification uses the bootstrap's original
trusted keys for both the official main and root repository snapshots. Android
verifies the bundle, every package and both repository signatures before offline
dpkg. The root repository name grants no root privileges and is not automatically
added to the user's APT sources. Neither TLS nor APT signature checking is disabled.
First preparation makes no network request.

Frida includes CLI tools (`frida`, `frida-ps`, `frida-trace`), the Python binding
and `frida-server`. The original packages are unchanged. Its upstream postinst
uses pip, so `python-wheels.json` pins the complete pure-Python dependency closure
from official PyPI artifacts with exact versions, sizes, URLs and SHA-256.
Preparation verifies those bytes and forces `PIP_NO_INDEX`/local wheel lookup,
ignoring user pip configuration. It never compiles/downloads a Python extension.
Full Frida licence texts/source references ship in `arxd-runtime-notices.txt`.
The upstream `frida-server/down` marker is required; no server, root request,
process attachment or target-App launch is performed by preparation.

Preparation copies an existing prefix into a staging generation, retaining
unrelated packages and configuration; the persistent Home/workspace stay in
place. A managed dependency differing from both the official bootstrap baseline
and both the previously managed and new pins fails with a package/version
reconciliation diagnostic. A recorded previous managed generation can be upgraded;
dpkg refuses downgrades, and every final Debian package version must match the new pin. Same-version packages are
left unchanged by dpkg. Local wheel/uvx and npm/npx execution must pass in the
staging environment before its prefix is published. A previous prefix is retained
across the publication rename; a subsequent preparation recovers interrupted
publication and removes abandoned stages. Failed input, extraction, dpkg or
functional checks never create the ready marker and never erase Home/workspace.
Explicit developer `reset` remains destructive only to the selected test runtime.

The environment page reads actual versions, including uv/uvx/npm/npx/git/adb/frida/frida-server/tshark/ecapture. The runtime
identity reports the package-bundle SHA-256, byte count, installed package size,
package count and the full on-device manifest location, separately from the
unchanged official bootstrap and shim identities. User modifications therefore
remain distinguishable from shipped provenance.

Android acceptance uses the DUMP-protected native verifier, in an isolated test
App package (the integration runner chooses the package/APK):

```
python3 apps/arxd/scripts/verify-preload.py --serial DEVICE --package TEST_APP \
  --apk /path/to/test-release.apk --no-install --offline-toolchain --bundle-failures
```

Disable package repositories/network for the test App before first preparation.
The trusted fixture parses a generated local DNS PCAP with actual tshark,
checks eCapture version without loading BPF, generates a temporary ADB key without connecting to a device,
loads Frida's real Python binding/device manager without attaching to any process,
and checks CLI/server versions while leaving the server disabled. This does not
prove wireless pairing, cross-App injection, Gadget compatibility or root access.
It also creates a local pure-Python wheel and npm tarball, creates a
venv, installs/runs it with uv, executes its entry point using uvx, and runs npm/npx
with offline flags. It also checks shell, empty-environment and Node-to-Python
children under the ordinary App UID. Failure probes use separate App-private
storage and preserve sentinel skills/workspace files while rejecting missing,
corrupt and mismatched input, then retrying an abandoned stage and checking
executable modes. Version commands alone are not functional acceptance. A real
process interruption/reopen and App upgrade/UI checks remain integration device
gates; a host build or this document is never evidence they passed.

Only the base toolchain and trusted local fixture are offline-ready. Public
package downloads, native wheels/addons, arbitrary MCP packages and automatic
Python provisioning need separate evidence. No fnm or Node/Python multi-version
manager is introduced.
