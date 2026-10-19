# Mobile JS compatibility

`provider-auth-context.ts` replaces pi-ai's optional Node-file auth lookup with
the documented browser behavior. Arxd supplies DeepSeek credentials explicitly
from SecureStore; it does not provide Node filesystem APIs to Hermes.

`babel-transformer.cjs` delegates to the installed Expo transformer, with one
Android-only change to Chord 1.3.0's `dist/json.js`: pass `String(index)` to
`Object.getOwnPropertyDescriptor`. The original source SHA-256 is checked before
rewriting, and the transform participates in Metro's cache key. A dependency
update must review this adapter instead of silently bypassing it.

On the tested Hermes/RN 0.88 runtime, a numeric property lookup forwards a
**number** into a Proxy's `getOwnPropertyDescriptor` trap. Node forwards a string.
Chord's draft-array trap accepts only string indices; Pi's `convertPartial`
copies such a draft when cancelling or recovering an in-flight generation.
Without normalization, strict JSON copying rejects the draft and the Session
fails; reopening encounters the same partial. Chord's sibling `isJsonValue`
already normalizes its index with `String(index)`.

This changes no strict-JSON checks, dependency files, serialized state or SQL
schema. Existing interrupted state recovers without deleting the database.
`verify-live-android.py` records the proxy key types and exercises both stream
cancellation and process-kill recovery with actual DeepSeek responses.
