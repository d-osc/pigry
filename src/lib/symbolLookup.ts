/** Resolves a function / class / type name mentioned in chat to the place it
 * is defined in the workspace, so the name can be a "go to definition" link. */
import { searchCode } from './tauriClient';
import { extractSymbols, type SymbolItem } from '../app/symbolSearch';

export interface DefinitionTarget {
  path: string;
  line: number;
  kind: SymbolItem['kind'];
}

/** Lower is better — declarations beat variables, methods and JSON keys. */
const KIND_RANK: Record<SymbolItem['kind'], number> = {
  function: 0, class: 0, interface: 0, type: 0, struct: 0, method: 1, variable: 2, key: 9,
};

const rankPath = (path: string): number => {
  if (/(^|\/)(node_modules|dist|target|\.pigry)\//.test(path)) return 3;
  if (/(^|\/)(tests?|__tests__)\//.test(path) || /\.(test|spec)\./.test(path)) return 2;
  return /(^|\/)(src|src-tauri)\//.test(path) ? 0 : 1;
};

export async function findDefinition(name: string): Promise<DefinitionTarget | null> {
  const hits = await searchCode(name);
  let best: (DefinitionTarget & { score: number }) | null = null;
  for (const hit of hits) {
    // Search rows are trimmed; re-add an indent so the method pattern can match.
    const symbol = extractSymbols(` ${hit.text}`).find((entry) => entry.name === name);
    if (!symbol || symbol.kind === 'key') continue;
    const score = KIND_RANK[symbol.kind] * 10 + rankPath(hit.path);
    if (!best || score < best.score) best = { path: hit.path, line: hit.line, kind: symbol.kind, score };
  }
  return best ? { path: best.path, line: best.line, kind: best.kind } : null;
}
