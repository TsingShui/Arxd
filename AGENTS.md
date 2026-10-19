Arxd is the Android host for rxd. Keep UI,
Agent orchestration and Android host adapters here; parsing and analysis remain
in the shared Rust backends. The root repository instructions still apply to
the analysis engine. App screens may present the Agent's results to a user.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use `bunx` instead of `npx` if the project uses bun (`bun.lock` present).

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx expo start              # start the dev server
npx expo lint               # lint
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

## Navigation & Routing

- Use **Expo Router** for navigation. Routes live in `app/`; keep Agent logic and host adapters in `src/` and the Android native module in `modules/rxd/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Building with EAS

The app builds locally with the installed Android SDK/NDK. EAS is optional; do
not create cloud projects or submit releases as part of local verification.
Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md

## Validation

- Exercise durable state through the real Pi-durable harness and SQLite storage.
  A deterministic provider is allowed for offline verification; identify it in
  the UI and evidence. Never present it as a live model response.
- Restart verification must reopen persistent storage in a new process, rather
  than only rebuilding React components or restoring an in-memory object.
- Local rxd verification must analyze bytes with the real Android CLI, including
  its worker process; `--help` or mocked output is not sufficient.
- Keep generated Android projects, APKs, Rust executables and test evidence out
  of source control. Put build artifacts and device evidence under root `target/`.
- Record simulator and physical-device results separately. Do not claim device
  verification based only on TypeScript checks or a successful APK build.

## UI design standard

Before changing Arxd UI, follow the existing borderless/weightless contract:
prefer inline state changes and full-bleed layers, avoid default control chrome,
use local scrolling for long lists, keep control rows on one line, and do not let
transient errors occupy page layout. Keep theme tokens and appearance behavior
shared across product routes.
