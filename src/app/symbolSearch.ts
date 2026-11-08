/**
 * Symbol extraction for Quick Open ("Go to Symbol") — lightweight regex scan
 * over source lines: functions, classes, interfaces, structs, variables.
 */

export interface SymbolItem {
  name: string;
  kind: 'function' | 'method' | 'class' | 'interface' | 'type' | 'struct' | 'variable' | 'key';
  line: number;
  path?: string;
}

const PATTERNS: Array<{ re: RegExp; kind: SymbolItem['kind'] }> = [
  { re: /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z0-9_$]+)/, kind: 'function' },
  { re: /\b(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/, kind: 'class' },
  { re: /\b(?:export\s+)?interface\s+([A-Za-z0-9_$]+)/, kind: 'interface' },
  { re: /\b(?:export\s+)?type\s+([A-Za-z0-9_$]+)\s*=/, kind: 'type' },
  { re: /\b(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z0-9_]+)/, kind: 'struct' },
  { re: /\bfn\s+([A-Za-z0-9_]+)/, kind: 'function' },
  // TS class/object methods: indented `name(args) [ret] {` — no arrow callbacks.
  { re: /^\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^<>]*>)?\([^)]*\)\s*(?::\s*[^{=]+)?\{/, kind: 'method' },
  { re: /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=/, kind: 'variable' },
  // JSON / object-literal keys:  "name": "orbit"
  { re: /^\s*"([^"]+)"\s*:/, kind: 'key' },
];

// Control flow reads like a method signature but is not a symbol.
const METHOD_STOP = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function']);

export function extractSymbols(content: string): SymbolItem[] {
  const out: SymbolItem[] = [];
  content.split('\n').forEach((line, i) => {
    for (const { re, kind } of PATTERNS) {
      const m = line.match(re);
      if (!m) continue;
      if (kind === 'method' && (METHOD_STOP.has(m[1]) || line.includes('=>'))) continue;
      // `const fn = () => …` is a function, not a variable.
      const resolved: SymbolItem['kind'] = kind === 'variable' && line.includes('=>') ? 'function' : kind;
      out.push({ name: m[1], kind: resolved, line: i + 1 });
      return;
    }
  });
  return out;
}

/** Search symbols across many files (bounded). */
export async function extractWorkspaceSymbols(
  files: string[],
  readFile: (path: string) => Promise<string>,
  query: string,
  onPartial: (hits: SymbolItem[]) => void,
): Promise<void> {
  const q = query.trim().toLowerCase();
  const out: SymbolItem[] = [];
  const maxFiles = 120;
  const maxHits = 60;
  for (const file of files.slice(0, maxFiles)) {
    if (out.length >= maxHits) break;
    try {
      const content = await readFile(file);
      if (!content) continue;
      for (const symbol of extractSymbols(content)) {
        if (q && !symbol.name.toLowerCase().includes(q)) continue;
        out.push({ ...symbol, path: file });
        if (out.length >= maxHits) break;
      }
      onPartial([...out]);
    } catch {
      // unreadable file — skip
    }
  }
}
