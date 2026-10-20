# Arxd official Termux package provenance

`repository/InRelease` and `repository/Packages.gz` are unchanged upstream
Termux-main aarch64 repository metadata, fetched on 2026-10-18. They are retained
to make the package lock cryptographically auditable after the live index moves.
These files are metadata only, not a Linux runtime, SDK, cache or build output.

The signed snapshot has repository date 2026-10-17 18:39:15 UTC. GnuPG verifies
its signature against the keys in Arxd's SHA-pinned official bootstrap; the
accepted signer is `CC72CF8BA7DBFA0182877D045A897D96E57CF20C` (Termux Releases).
The signed SHA-256/size for `main/binary-aarch64/Packages.gz` binds the exact
package records used by the runtime lock. The metadata and package URLs use
`https://packages-cf.termux.dev/apt/termux-main/`.

The adopted lock lives with the Arxd runtime sources. Normal builds authenticate
this snapshot, compare the complete resolved closure to that lock, download
only exact pinned .deb files with TLS enabled, verify each size and SHA-256,
and stage the unchanged .deb archives under ignored `target/arxd/preload/`.
The generated manifest records every package, homepage, dependency, architecture,
size, digest, installed size and the exact installed license file identities.
Each original package retains its own copyright/license material. Arxd's bundle
does not relicense upstream packages. The original bootstrap identity stays
separate from the added package-bundle identity.

Host prerequisites: Python 3.9+, curl, GnuPG `gpgv`, Android NDK 28.2.
Build with `python3 apps/arxd/scripts/build-preload.py`. Deliberate pin changes
require updating/reviewing the unmodified signed repository snapshot, then
running the package staging script's explicit `--refresh-lock` option and
repeating Android acceptance. Normal builds never resolve the moving index.
