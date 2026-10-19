/**
 * Syntax highlighting for code the App displays: chat fenced blocks, the file
 * manager previews and attachment/tool source views. `lowlight` (highlight.js
 * AST) tokenizes; this module flattens its tree into colour tones so a plain
 * React Native `<Text>` can render it without HTML or a DOM.
 */
import { createLowlight } from 'lowlight';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import type { RootContent } from 'hast';

export type CodeTone = 'plain' | 'keyword' | 'string' | 'number' | 'comment' | 'title' | 'builtin' | 'meta' | 'attr' | 'literal' | 'variable';
export type CodeToken = { text: string; tone: CodeTone };

const lowlight = createLowlight({ bash, c, cpp, csharp, css, ini, java, javascript, json, kotlin, markdown, python, rust, sql, typescript, xml, yaml });

/** highlight.js emits nested span classes; children override their parent's tone. */
const TONES: Record<string, CodeTone> = {
  keyword: 'keyword', 'selector-tag': 'keyword', doctag: 'keyword', tag: 'keyword', name: 'keyword',
  string: 'string', 'string-template': 'string', regexp: 'string', char: 'string', 'template-tag': 'keyword',
  number: 'number', literal: 'literal', symbol: 'literal', boolean: 'literal', bullet: 'literal', addition: 'literal',
  comment: 'comment', quote: 'comment', deletion: 'variable', emphasis: 'plain', strong: 'plain',
  title: 'title', 'title.class': 'title', 'title.function': 'title', function: 'title', section: 'title',
  built_in: 'builtin', type: 'builtin', class: 'title',
  meta: 'meta', link: 'meta',
  attr: 'attr', attribute: 'attr', property: 'attr', variable: 'variable', params: 'variable',
  subst: 'plain', code: 'string',
};

const toneOf = (node: Extract<RootContent, { type: 'element' }>, inherited: CodeTone): CodeTone => {
  const classes = Array.isArray(node.properties.className) ? node.properties.className : [];
  for (const value of classes) {
    if (typeof value !== 'string') continue;
    const key = value.replace(/^hljs-/, '').replace(/_+$/, '');
    const tone = TONES[key];
    if (tone) return tone;
  }
  return inherited;
};

const push = (tokens: CodeToken[], text: string, tone: CodeTone) => {
  if (!text) return;
  const last = tokens.at(-1);
  if (last && last.tone === tone) last.text += text;
  else tokens.push({ text, tone });
};

const walk = (nodes: RootContent[], tone: CodeTone, tokens: CodeToken[]) => {
  for (const node of nodes) {
    if (node.type === 'text') push(tokens, node.value, tone);
    else if (node.type === 'element') walk(node.children, toneOf(node, tone), tokens);
  }
};

/** Plain fences such as report tool output stay uncoloured. */
const NO_HIGHLIGHT = new Set(['', 'text', 'txt', 'plain', 'plaintext', 'output', 'console', 'log']);

/** Highlight at most this many characters per block; larger code renders plainly. */
const MAX_HIGHLIGHT_CHARS = 20_000;

export function highlightCode(code: string, language?: string): CodeToken[] {
  if (!code) return [];
  const name = (language ?? '').trim().toLowerCase();
  if (NO_HIGHLIGHT.has(name) || code.length > MAX_HIGHLIGHT_CHARS) return [{ text: code, tone: 'plain' }];
  try {
    const tokens: CodeToken[] = [];
    walk(lowlight.highlight(name, code).children, 'plain', tokens);
    return tokens.length ? tokens : [{ text: code, tone: 'plain' }];
  } catch {
    return [{ text: code, tone: 'plain' }];
  }
}

const BY_EXTENSION: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  json: 'json', jsonl: 'json', ndjson: 'json', geojson: 'json',
  java: 'java', kt: 'kotlin', kts: 'kotlin', smali: 'java',
  cs: 'csharp', py: 'python', pyw: 'python',
  rs: 'rust', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  xml: 'xml', html: 'xml', htm: 'xml', xhtml: 'xml', svg: 'xml', plist: 'xml',
  sh: 'bash', bash: 'bash', zsh: 'bash', ksh: 'bash',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
  sql: 'sql', css: 'css', md: 'markdown', markdown: 'markdown',
};

/** Infer a highlight language from a file name or path; unknown files stay plain. */
export function languageForFile(name: string): string | undefined {
  const base = (name.split('/').pop() ?? name).toLowerCase();
  if (!base || base.startsWith('.')) return undefined;
  const dot = base.lastIndexOf('.');
  return dot === -1 ? undefined : BY_EXTENSION[base.slice(dot + 1)];
}
