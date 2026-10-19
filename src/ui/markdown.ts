/**
 * Markdown for Agent answers: `marked` (GFM) parses, this module maps its
 * tokens to a small block/inline model, and `RichText` renders that model with
 * React Native primitives. Parsing is delegated so emphasis, escapes, nested
 * lists, task lists, links and tables follow CommonMark/GFM instead of a
 * hand-maintained subset; rendering stays ours for selectable text, theming and
 * streaming. Raw HTML and links never become executable or tappable.
 */
import { marked, type Token, type Tokens } from 'marked';

export type TableAlignment = 'left' | 'center' | 'right';

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'del'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] }
  | { kind: 'image'; alt: string }
  | { kind: 'br' };

export type ListItem = {
  content: Inline[];
  /** Nested lists, code and paragraphs that belong to this item. */
  children: MarkdownBlock[];
  task?: boolean;
  checked?: boolean;
};

export type MarkdownBlock =
  | { kind: 'heading'; level: number; content: Inline[] }
  | { kind: 'paragraph'; content: Inline[] }
  | { kind: 'quote'; blocks: MarkdownBlock[] }
  | { kind: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { kind: 'code'; text: string; lang?: string }
  | { kind: 'rule' }
  | { kind: 'table'; align: TableAlignment[]; header: Inline[][]; rows: Inline[][][] };

const literal = (text: string): Inline[] => (text ? [{ kind: 'text', text }] : []);
/** Answer text is untrusted: bound nesting so hostile input cannot exhaust the render stack. */
const MAX_DEPTH = 8;

function inline(tokens: Token[] | undefined, depth = 0): Inline[] {
  return (tokens ?? []).flatMap((token): Inline[] => {
    switch (token.type) {
      case 'text': {
        const text = token as Tokens.Text;
        return text.tokens?.length && text.tokens[0] !== token && depth < MAX_DEPTH ? inline(text.tokens, depth + 1) : literal(text.text);
      }
      case 'escape': return literal((token as Tokens.Escape).text);
      case 'codespan': return [{ kind: 'code', text: (token as Tokens.Codespan).text }];
      case 'br': return [{ kind: 'br' }];
      case 'strong': return depth < MAX_DEPTH ? [{ kind: 'strong', children: inline((token as Tokens.Strong).tokens, depth + 1) }] : literal(token.raw);
      case 'em': return depth < MAX_DEPTH ? [{ kind: 'em', children: inline((token as Tokens.Em).tokens, depth + 1) }] : literal(token.raw);
      case 'del': return depth < MAX_DEPTH ? [{ kind: 'del', children: inline((token as Tokens.Del).tokens, depth + 1) }] : literal(token.raw);
      case 'link': {
        // Links keep their text and are styled, but never become tappable:
        // answer content is untrusted model output.
        const link = token as Tokens.Link;
        if (depth >= MAX_DEPTH) return literal(link.raw);
        const children = inline(link.tokens, depth + 1);
        return [{ kind: 'link', href: link.href, children: children.length ? children : literal(link.href) }];
      }
      case 'image': return [{ kind: 'image', alt: (token as Tokens.Image).text ?? '' }];
      // Raw HTML is shown literally; it is never interpreted.
      case 'html': return literal(token.raw);
      case 'checkbox': return [];
      default: {
        const raw = (token as { raw?: string }).raw ?? '';
        return literal(raw);
      }
    }
  });
}

function listItem(item: Tokens.ListItem, depth: number): ListItem {
  const itemBlocks = blocks(item.tokens, depth);
  const [first, ...rest] = itemBlocks;
  return {
    content: first?.kind === 'paragraph' ? first.content : [],
    children: first?.kind === 'paragraph' ? rest : itemBlocks,
    ...(item.task ? { task: true, checked: !!item.checked } : {}),
  };
}

function blocks(tokens: Token[], depth = 0): MarkdownBlock[] {
  return tokens.flatMap((token): MarkdownBlock[] => {
    switch (token.type) {
      case 'space':
      case 'def':
      case 'checkbox':
        return [];
      case 'heading': {
        const heading = token as Tokens.Heading;
        return [{ kind: 'heading', level: heading.depth, content: inline(heading.tokens) }];
      }
      case 'paragraph': return [{ kind: 'paragraph', content: inline((token as Tokens.Paragraph).tokens) }];
      // A top-level `text` token only appears inside list items; keep it visible.
      case 'text': {
        const text = token as Tokens.Text;
        return [{ kind: 'paragraph', content: inline(text.tokens ?? [text]) }];
      }
      case 'blockquote': {
        const raw = token.raw.trimEnd();
        return depth < MAX_DEPTH ? [{ kind: 'quote', blocks: blocks((token as Tokens.Blockquote).tokens, depth + 1) }] : (raw.trim() ? [{ kind: 'paragraph', content: literal(raw) }] : []);
      }
      case 'list': {
        const list = token as Tokens.List;
        const raw = token.raw.trimEnd();
        if (depth >= MAX_DEPTH) return raw.trim() ? [{ kind: 'paragraph', content: literal(raw) }] : [];
        return [{
          kind: 'list',
          ordered: list.ordered,
          start: typeof list.start === 'number' ? list.start : 1,
          items: list.items.map((item) => listItem(item, depth + 1)),
        }];
      }
      case 'code': {
        const code = token as Tokens.Code;
        const text = code.text.replace(/\n$/, '');
        return text.trim() ? [{ kind: 'code', text, ...(code.lang ? { lang: code.lang } : {}) }] : [];
      }
      case 'hr': return [{ kind: 'rule' }];
      case 'table': {
        const table = token as Tokens.Table;
        return [{
          kind: 'table',
          align: table.align.map((value): TableAlignment => value ?? 'left'),
          header: table.header.map((cell) => inline(cell.tokens)),
          rows: table.rows.map((row) => row.map((cell) => inline(cell.tokens))),
        }];
      }
      case 'html': {
        const text = (token as Tokens.Tag).raw.trimEnd();
        return text.trim() ? [{ kind: 'paragraph', content: literal(text) }] : [];
      }
      default: {
        // Never drop content for a token this renderer does not know yet.
        const raw = (token as { raw?: string }).raw?.trimEnd() ?? '';
        return raw.trim() ? [{ kind: 'paragraph', content: literal(raw) }] : [];
      }
    }
  });
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  return blocks(marked.lexer(source.replace(/\r\n?/g, '\n'), { gfm: true, breaks: false }));
}

/** Flattened text for table sizing and content-preservation checks. */
export function plainText(nodes: Inline[]): string {
  return nodes.map((node) => {
    switch (node.kind) {
      case 'text': return node.text;
      case 'code': return node.text;
      case 'br': return '\n';
      case 'image': return node.alt;
      default: return plainText(node.children);
    }
  }).join('');
}

/** East Asian wide characters occupy two terminal columns; tables size by this. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    width += (code >= 0x1100 && code <= 0x115f)
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe4f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
      || (code >= 0x1f300 && code <= 0x1faff)
      || (code >= 0x20000 && code <= 0x3fffd) ? 2 : 1;
  }
  return width;
}
