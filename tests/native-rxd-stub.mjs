/**
 * Host-test substitute for the native `modules/rxd` module.
 *
 * The Node suite exercises durable state, the workspace and pure UI logic; it
 * never has the Android native module, so nothing here performs work. Keeping
 * the surface explicit means an unexpected native dependency fails loudly
 * instead of silently appearing functional in tests.
 */
const listeners = () => ({ remove() {} });

export default {
  addListener: listeners,
  verificationEnabled: () => false,
  report: () => {},
  startCodeMode: async () => ({}),
  writeCodeMode: async () => {},
  stopCodeMode: async () => {},
};
