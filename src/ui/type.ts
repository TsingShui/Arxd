import { Platform, type TextStyle } from 'react-native';

/**
 * One role-based type scale for the whole app. Sizes are dp; line heights are
 * tuned for CJK text (1.55–1.7×) instead of React Native's tight default.
 *
 * Rules:
 * - 11 dp is the floor; never use 9 dp metadata.
 * - Hierarchy comes from color (heading/text/quiet/faint) and weight first,
 *   from size second.
 * - Large text gets negative tracking, uppercase mono labels positive tracking.
 * - Code, hashes and evidence names always use a mono token so digits line up.
 */
const mono = Platform.select({ android: 'monospace', default: 'Courier' });

export const type = {
  /** Welcome hero line. */
  display: { fontSize: 32, lineHeight: 44, fontWeight: '500', letterSpacing: -0.8 },
  /** Full-screen panel title, e.g. an entity name. */
  title: { fontSize: 22, lineHeight: 32, fontWeight: '500', letterSpacing: -0.3 },
  /** Turn status, sheet headers. */
  heading: { fontSize: 17, lineHeight: 26, fontWeight: '600', letterSpacing: -0.2 },
  /** In-transcript section titles. */
  section: { fontSize: 14, lineHeight: 22, fontWeight: '600' },
  /** Answers, prompts and the composer. */
  body: { fontSize: 15, lineHeight: 25 },
  /** Primary list rows: conversations, artifacts, menu options. */
  list: { fontSize: 14, lineHeight: 22 },
  /** Inline labels, buttons, greeting. */
  label: { fontSize: 13, lineHeight: 20, fontWeight: '500' },
  /** Secondary description lines. */
  caption: { fontSize: 12, lineHeight: 19 },
  /** The smallest allowed text: metadata, notes, pills. */
  micro: { fontSize: 11, lineHeight: 17 },
  /** Drawer navigation and conversation rows. */
  rowLarge: { fontSize: 17, lineHeight: 26 },
  /** Drawer section labels ("全部"). */
  sectionLabel: { fontSize: 13.5, lineHeight: 20 },
  /** Header model label. */
  nav: { fontSize: 16, lineHeight: 22, fontWeight: '500', letterSpacing: -0.3 },
  /** Uppercase mono eyebrow labels. */
  eyebrow: { fontSize: 11, lineHeight: 17, fontWeight: '500', fontFamily: mono, letterSpacing: 1.1 },
  /** Inline mono text: file names, evidence names. */
  mono: { fontSize: 12, lineHeight: 18, fontFamily: mono },
  /** Code blocks and raw tool output. */
  code: { fontSize: 12, lineHeight: 21, fontFamily: mono },
} satisfies Record<string, TextStyle>;

export type TypeRole = keyof typeof type;
