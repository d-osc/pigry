/**
 * Minimal Markdown → React renderer for wiki pages. No dependencies —
 * covers the constructs GitHub wiki pages actually use: headings, paragraphs,
 * lists, fenced code, blockquotes, pipe tables, hr, inline code / bold /
 * italic / links / images. Everything is escaped (text never becomes HTML).
 */
import type { ReactNode } from 'react';
import { pushWithMentions } from './mentions';

export interface Heading {
  text: string;
  slug: string;
  level: number;
}

/** GitHub-style slug: lowercase, strip punctuation, spaces → dashes. */
function slugOf(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

/** h2/h3 headings — feeds the "On this page" rail. */
export function extractHeadings(source: string): Heading[] {
  const headings: Heading[] = [];
  let inFence = false;
  for (const raw of source.split('\n')) {
    if (raw.trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = raw.match(/^(#{2,3})\s+(.+?)\s*#*\s*$/);
    if (match) {
      const text = match[2].replace(/[*`]/g, '');
      headings.push({ text, slug: slugOf(text), level: match[1].length });
    }
  }
  return headings;
}

/* ---------- inline ---------- */


const INLINE_PATTERN = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\s][^*]*\*)|(!?\[[^\]]*\]\([^)\s]+\))/;

/* ---------- workspace file references ---------- */

const FILE_EXT = 'tsx?|jsx?|mjs|cjs|json|mdx?|rs|toml|ya?ml|css|scss|html?|txt|ps1|sh|py|go|java|kt|swift|lock|cmd|bat|xml|svg|sql|env|conf|csv|c|h|cpp|hpp|cs|rb|php|vue';
const LINE_SUFFIX = '(?::(\\d+)(?::\\d+)?|#L(\\d+))?';
/** A relative path with at least one folder, found inside running text. */
const PLAIN_FILE_PATTERN = new RegExp(
  `(?<![\\w/\\\\.:@-])((?:\\.{1,2}/)?(?:[\\w.@()-]+[\\\\/])+[\\w.@()-]+\\.(?:${FILE_EXT}))${LINE_SUFFIX}(?!\\w)`,
  'i',
);
/** A whole `code span` / link target that is a relative path or bare file name. */
const WHOLE_FILE_PATTERN = new RegExp(
  `^((?:\\.{1,2}/)?[\\w.@()-]+(?:[\\\\/][\\w.@()-]+)*\\.(?:${FILE_EXT}))${LINE_SUFFIX}$`,
  'i',
);

/** `name`, `Class.method`, `name()` or `name(args)` — group 2 is the symbol. */
const SYMBOL_PATTERN = /^(?:[A-Za-z_$][\w$]*\.)*([A-Za-z_$][\w$]*)(?:\([^`]*\))?$/;
const COMMON_WORDS = new Set(['true', 'false', 'null', 'undefined', 'this', 'self', 'string', 'number', 'boolean', 'void', 'any', 'Promise', 'Array', 'Object', 'Map', 'Set', 'JSON', 'console', 'window', 'document', 'React']);

/** Only link names that read like code: a call `fn()`, camelCase, PascalCase or snake_case. */
function looksLikeSymbol(name: string, code: string): boolean {
  if (name.length < 3 || COMMON_WORDS.has(name)) return false;
  return /\(.*\)$/.test(code.trim()) || /[a-z][A-Z]/.test(name) || /^[A-Z][a-z]+[A-Z]/.test(name) || name.includes('_');
}

/** When set, workspace file references render as clickable buttons (the chat
 * panel handles the click). Set only for the duration of a renderMarkdown call. */
let fileLinksEnabled = false;

function fileLink(match: RegExpMatchArray, display: string, key: string, code = false): ReactNode {
  const path = match[1].replace(/\\/g, '/').replace(/^\.\//, '');
  const line = match[2] ?? match[3];
  return (
    <button
      key={key}
      type="button"
      className={`md-file-link${code ? ' md-file-link--code' : ''}`}
      data-file-path={path}
      data-file-line={line}
      title={`Open ${path}${line ? ` at line ${line}` : ''} in the editor`}
    >
      {display}
    </button>
  );
}

function renderInline(raw: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let rest = raw;
  let index = 0;
  const pushPlain = (text: string, at: number) => {
    if (!text) return;
    if (!fileLinksEnabled) {
      pushWithMentions(nodes, text, `${keyBase}-p${at}`);
      return;
    }
    let remaining = text;
    let part = 0;
    while (remaining) {
      const found = remaining.match(PLAIN_FILE_PATTERN);
      if (!found || found.index === undefined) {
        pushWithMentions(nodes, remaining, `${keyBase}-p${at}-${part}`);
        break;
      }
      if (found.index > 0) pushWithMentions(nodes, remaining.slice(0, found.index), `${keyBase}-p${at}-${part}`);
      nodes.push(fileLink(found, found[0], `${keyBase}-f${at}-${part}`));
      remaining = remaining.slice(found.index + found[0].length);
      part += 1;
    }
  };
  while (rest) {
    const match = rest.match(INLINE_PATTERN);
    if (!match || match.index === undefined) {
      pushPlain(rest, index);
      break;
    }
    if (match.index > 0) pushPlain(rest.slice(0, match.index), index);
    const token = match[0];
    const key = `${keyBase}-${index}`;
    index += 1;
    if (token.startsWith('`')) {
      const code = token.slice(1, -1);
      const file = fileLinksEnabled ? code.trim().match(WHOLE_FILE_PATTERN) : null;
      const symbol = fileLinksEnabled && !file ? code.trim().match(SYMBOL_PATTERN) : null;
      if (file) {
        nodes.push(fileLink(file, code, key, true));
      } else if (symbol && looksLikeSymbol(symbol[1], code)) {
        nodes.push(
          <button
            key={key}
            type="button"
            className="md-file-link md-file-link--code"
            data-symbol={symbol[1]}
            title={`Go to definition of ${symbol[1]}`}
          >
            {code}
          </button>,
        );
      } else {
        nodes.push(<code key={key}>{code}</code>);
      }
    } else if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(<strong key={key}>{renderInline(token.slice(2, -2), key)}</strong>);
    } else if (token.startsWith('*')) {
      nodes.push(<em key={key}>{renderInline(token.slice(1, -1), key)}</em>);
    } else if (token.startsWith('!')) {
      // Images: wiki-relative paths can't resolve here — render as a link.
      const image = token.match(/!\[([^\]]*)\]\(([^)\s]+)\)/);
      if (image) {
        nodes.push(
          <a key={key} href={image[2]} target="_blank" rel="noreferrer">
            🖼 {image[1] || 'image'}
          </a>,
        );
      }
    } else {
      const link = token.match(/\[([^\]]*)\]\(([^)\s]+)\)/);
      if (link) {
        const href = link[2];
        const internal = !/^https?:/.test(href);
        const file = fileLinksEnabled && internal ? href.match(WHOLE_FILE_PATTERN) : null;
        if (file) {
          nodes.push(fileLink(file, link[1] || href, key));
          rest = rest.slice((match.index ?? 0) + token.length);
          continue;
        }
        nodes.push(
          <a
            key={key}
            href={internal ? undefined : href}
            target={internal ? undefined : '_blank'}
            rel="noreferrer"
            title={internal ? `wiki page: ${href}` : undefined}
          >
            {link[1] || href}
          </a>,
        );
      }
    }
    rest = rest.slice((match.index ?? 0) + token.length);
  }
  return nodes;
}

/* ---------- block ---------- */

function renderTable(lines: string[], key: string): ReactNode {
  const rows = lines
    .filter((line) => line.trim().startsWith('|'))
    .map((line) =>
      line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim()),
    );
  if (rows.length < 2) {
    return <p key={key}>{lines.join(' ')}</p>;
  }
  const [head, , ...body] = rows; // second row is the |---|---| separator
  return (
    <table key={key}>
      <thead>
        <tr>
          {head.map((cell, index) => (
            <th key={index}>{renderInline(cell, `${key}-h${index}`)}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {body.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {row.map((cell, cellIndex) => (
              <td key={cellIndex}>{renderInline(cell, `${key}-c${rowIndex}${cellIndex}`)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function renderFence(lines: string[], key: string): ReactNode {
  return (
    <div key={key} className="wiki-md__code">
      <pre>
        <code>{lines.join('\n')}</code>
      </pre>
    </div>
  );
}

/** Renders a markdown source string into React elements. */
export function renderMarkdown(source: string, options?: { fileLinks?: boolean }): ReactNode[] {
  fileLinksEnabled = options?.fileLinks === true;
  try {
    return renderMarkdownBlocks(source);
  } finally {
    fileLinksEnabled = false;
  }
}

function renderMarkdownBlocks(source: string): ReactNode[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;

  const flushParagraph = (buffer: string[], keyBase: string) => {
    if (buffer.length > 0) {
      blocks.push(
        <p key={keyBase}>
          {buffer.map((line, i) => (
            <span key={i}>
              {renderInline(line, `${keyBase}-${i}`)}
              {i < buffer.length - 1 ? ' ' : null}
            </span>
          ))}
        </p>,
      );
      buffer.length = 0;
    }
  };

  const headingPattern = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      const fence: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        fence.push(lines[index]);
        index += 1;
      }
      index += 1; // closing fence
      blocks.push(renderFence(fence, `f${blocks.length}`));
      continue;
    }

    const heading = trimmed.match(headingPattern);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2];
      const slug = slugOf(text.replace(/[*`]/g, ''));
      const content = renderInline(text, `h${blocks.length}`);
      if (level === 1) blocks.push(<h1 key={`b${blocks.length}`}>{content}</h1>);
      else if (level === 2) blocks.push(<h2 key={`b${blocks.length}`} id={slug}>{content}</h2>);
      else if (level === 3) blocks.push(<h3 key={`b${blocks.length}`} id={slug}>{content}</h3>);
      else blocks.push(<h4 key={`b${blocks.length}`}>{content}</h4>);
      index += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push(<hr key={`b${blocks.length}`} />);
      index += 1;
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quote: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith('>')) {
        quote.push(lines[index].trim().replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push(
        <blockquote key={`b${blocks.length}`}>
          {quote.map((q, i) => (
            <p key={i}>{renderInline(q, `q${blocks.length}-${i}`)}</p>
          ))}
        </blockquote>,
      );
      continue;
    }

    const isTable = trimmed.startsWith('|') && index + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[index + 1]) && lines[index + 1].includes('-');
    if (isTable) {
      const rows: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        rows.push(lines[index]);
        index += 1;
      }
      blocks.push(renderTable(rows, `t${blocks.length}`));
      continue;
    }

    const listItem = trimmed.match(/^([-*+]|\d+[.)])\s+(.*)$/);
    if (listItem) {
      const ordered = /\d/.test(listItem[1][0]);
      const items: string[] = [];
      while (index < lines.length) {
        const next = lines[index].trim().match(/^([-*+]|\d+[.)])\s+(.*)$/);
        if (!next || (/\d/.test(next[1][0]) !== ordered)) break;
        items.push(next[2]);
        index += 1;
      }
      const rendered = items.map((item, i) => (
        <li key={i}>{renderInline(item, `l${blocks.length}-${i}`)}</li>
      ));
      if (ordered) blocks.push(<ol key={`b${blocks.length}`}>{rendered}</ol>);
      else blocks.push(<ul key={`b${blocks.length}`}>{rendered}</ul>);
      continue;
    }

    if (!trimmed) {
      index += 1;
      continue;
    }

    // Paragraph: gather until a blank line or a block-starting line.
    const paragraph = [trimmed];
    index += 1;
    while (index < lines.length) {
      const current = lines[index];
      const t = current.trim();
      if (
        !t ||
        t.startsWith('```') ||
        headingPattern.test(t) ||
        t.startsWith('>') ||
        /^([-*+]|\d+[.)])\s+/.test(t) ||
        /^(-{3,}|\*{3,}|_{3,})$/.test(t)
      ) {
        break;
      }
      paragraph.push(t);
      index += 1;
    }
    flushParagraph(paragraph, `p${blocks.length}`);
  }

  return blocks;
}
