/** Diagrams and designs shown on a board. The board file only stores a reference
 * ("owner/name"); this module loads the referenced file and renders it so the
 * Board editor and the board tools (preview/export) draw the live content. */
import { renderDiagramSvg } from './diagram';
import { findNode, renderDesignSvg } from './design';
import { loadDiagram, resolveDiagram } from './diagramStore';
import { loadDesign, resolveDesign } from './designStore';
import { embedKey, prepareEmbedSvg, type Board, type BoardItem, type EmbedContent, type EmbedRef } from './board';
import { refKey } from './ownedFiles';

const cache = new Map<string, EmbedContent>();

const prefixFor = (key: string): string => {
  let hash = 7;
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `e${hash.toString(36)}-`;
};

export interface EmbedResult {
  content: EmbedContent | null;
  /** The canonical "owner/name" the reference resolved to. */
  ref?: string;
  /** Design: the frame's id. */
  node?: string;
  /** Title of the source file. */
  title?: string;
  error?: string;
}

/** Resolves and renders one embedded diagram/design. */
export async function loadEmbed(embed: EmbedRef, caller?: string): Promise<EmbedResult> {
  try {
    if (embed.kind === 'diagram') {
      const resolved = await resolveDiagram(embed.ref, caller);
      if ('error' in resolved) return { content: null, error: `diagram ${resolved.error}` };
      const { diagram } = await loadDiagram(resolved.ref);
      const key = embedKey({ kind: 'diagram', ref: refKey(resolved.ref) });
      const content = prepareEmbedSvg(renderDiagramSvg(diagram), prefixFor(key));
      return { content, ref: refKey(resolved.ref), title: diagram.title, ...(content ? {} : { error: 'diagram is empty' }) };
    }
    const resolved = await resolveDesign(embed.ref, caller);
    if ('error' in resolved) return { content: null, error: `design ${resolved.error}` };
    const { design } = await loadDesign(resolved.ref);
    const node = embed.node ? findNode(design, embed.node) : undefined;
    if (embed.node && !node) return { content: null, ref: refKey(resolved.ref), title: design.title, error: `frame "${embed.node}" not found in ${refKey(resolved.ref)}` };
    const key = embedKey({ kind: 'design', ref: refKey(resolved.ref), node: node?.id });
    const content = prepareEmbedSvg(renderDesignSvg(design, { nodeId: node?.id, background: '#ffffff', padding: node ? 0 : 20 }), prefixFor(key));
    return { content, ref: refKey(resolved.ref), node: node?.id, title: node?.name ?? design.title, ...(content ? {} : { error: 'design is empty' }) };
  } catch (error) {
    return { content: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Loads the content for every embed on the board (cached per canonical reference). */
export async function collectEmbeds(board: Board, caller?: string, opts?: { refresh?: boolean }): Promise<Record<string, EmbedContent>> {
  const out: Record<string, EmbedContent> = {};
  await Promise.all(board.items.filter((i) => i.type === 'embed' && i.embed).map(async (item) => {
    const embed = item.embed!;
    const key = embedKey(embed);
    if (!opts?.refresh && cache.has(key)) { out[key] = cache.get(key)!; return; }
    const result = await loadEmbed(embed, caller);
    if (result.content) { cache.set(key, result.content); out[key] = result.content; }
  }));
  return out;
}

/** Forget cached renderings of a diagram/design that just changed. */
export function invalidateEmbeds(kind: 'diagram' | 'design', ref: string): void {
  for (const key of [...cache.keys()]) if (key.startsWith(`${kind}:${ref}:`)) cache.delete(key);
}

/** Size that shows the whole content at a readable scale (header 34px + padding). */
export function fitEmbedSize(content: EmbedContent, width = 420): { w: number; h: number } {
  const [, , vw, vh] = content.viewBox;
  const bodyW = width - 16;
  const bodyH = Math.min(560, Math.max(120, Math.round((bodyW * vh) / Math.max(vw, 1))));
  return { w: width, h: bodyH + 42 };
}

/** Canonicalises embed references (alias → "owner/name", frame name → id), reports missing sources and
 * sizes brand-new embeds to their content. Mutates `board`. */
export async function canonicalizeEmbeds(board: Board, caller: string, fit: (item: BoardItem) => boolean): Promise<string[]> {
  const problems: string[] = [];
  for (const item of board.items) {
    if (item.type !== 'embed' || !item.embed) continue;
    const result = await loadEmbed(item.embed, caller);
    if (result.ref) item.embed = { kind: item.embed.kind, ref: result.ref, ...(result.node ? { node: result.node } : {}) };
    if (result.error || !result.content) { problems.push(`${item.id}: ${result.error ?? 'could not be drawn'}`); continue; }
    if (fit(item)) { const size = fitEmbedSize(result.content); item.w = size.w; item.h = size.h; }
  }
  return problems;
}
