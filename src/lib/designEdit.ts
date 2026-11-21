/** Geometry helpers for the Design editor's pointer interactions: hit testing,
 * resizing, snapping and z-order. Pure functions so they are unit-testable. */
import {
  absoluteBox, absolutePosition, allNodes, findNode, isAutoLayoutFrame, parentOf, siblingsOf, walk,
  type Design, type DesignNode,
} from './design.ts';

export interface Box { x: number; y: number; w: number; h: number }
export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export const handlePoint = (box: Box, handle: Handle): { x: number; y: number } => ({
  x: handle.includes('w') ? box.x : handle.includes('e') ? box.x + box.w : box.x + box.w / 2,
  y: handle.includes('n') ? box.y : handle.includes('s') ? box.y + box.h : box.y + box.h / 2,
});

/** New box after dragging `handle` by (dx, dy). Shift keeps the aspect ratio on corners. */
export function computeResize(box: Box, handle: Handle, dx: number, dy: number, keepAspect = false, min = 4): Box {
  let { x, y, w, h } = box;
  if (handle.includes('e')) w = box.w + dx;
  if (handle.includes('w')) { w = box.w - dx; x = box.x + dx; }
  if (handle.includes('s')) h = box.h + dy;
  if (handle.includes('n')) { h = box.h - dy; y = box.y + dy; }
  if (keepAspect && handle.length === 2 && box.w > 0 && box.h > 0) {
    const ratio = box.w / box.h;
    if (Math.abs(w - box.w) / box.w > Math.abs(h - box.h) / box.h) h = w / ratio; else w = h * ratio;
    if (handle.includes('w')) x = box.x + box.w - w;
    if (handle.includes('n')) y = box.y + box.h - h;
  }
  if (w < min) { if (handle.includes('w')) x -= min - w; w = min; }
  if (h < min) { if (handle.includes('n')) y -= min - h; h = min; }
  return { x, y, w, h };
}

/** The deepest visible frame whose box contains the canvas point (top-most wins). */
export function deepestFrameAt(d: Design, px: number, py: number, exclude: Set<string> = new Set()): DesignNode | null {
  let found: DesignNode | null = null;
  const visit = (nodes: DesignNode[], ox: number, oy: number) => {
    for (const node of nodes) {
      if (node.visible === false || exclude.has(node.id) || node.type !== 'frame') continue;
      const x = ox + node.x, y = oy + node.y;
      if (px >= x && px <= x + node.w && py >= y && py <= y + node.h) {
        found = node;
        if (node.children) visit(node.children, x, y);
      }
    }
  };
  visit(d.nodes, 0, 0);
  return found;
}

export interface Guide { axis: 'x' | 'y'; pos: number; from: number; to: number }

/** Snaps a moving box to the edges/centres of its parent and siblings. */
export function snapMove(d: Design, movingIds: string[], box: Box, threshold: number): { dx: number; dy: number; guides: Guide[] } {
  const first = movingIds[0];
  if (!first) return { dx: 0, dy: 0, guides: [] };
  const parent = parentOf(d, first) ?? null;
  const targets: Box[] = [];
  const pushBox = (id: string) => { const b = absoluteBox(d, id); if (b) targets.push(b); };
  if (parent) pushBox(parent.id);
  for (const sibling of siblingsOf(d, first)) if (!movingIds.includes(sibling.id) && sibling.visible !== false) pushBox(sibling.id);
  const xs = [box.x, box.x + box.w / 2, box.x + box.w];
  const ys = [box.y, box.y + box.h / 2, box.y + box.h];
  let bestX: { delta: number; pos: number; target: Box } | null = null;
  let bestY: { delta: number; pos: number; target: Box } | null = null;
  for (const t of targets) {
    for (const tx of [t.x, t.x + t.w / 2, t.x + t.w]) {
      for (const x of xs) {
        const delta = tx - x;
        if (Math.abs(delta) <= threshold && (!bestX || Math.abs(delta) < Math.abs(bestX.delta))) bestX = { delta, pos: tx, target: t };
      }
    }
    for (const ty of [t.y, t.y + t.h / 2, t.y + t.h]) {
      for (const y of ys) {
        const delta = ty - y;
        if (Math.abs(delta) <= threshold && (!bestY || Math.abs(delta) < Math.abs(bestY.delta))) bestY = { delta, pos: ty, target: t };
      }
    }
  }
  const dx = bestX?.delta ?? 0, dy = bestY?.delta ?? 0;
  const moved: Box = { x: box.x + dx, y: box.y + dy, w: box.w, h: box.h };
  const guides: Guide[] = [];
  if (bestX) guides.push({ axis: 'x', pos: bestX.pos, from: Math.min(moved.y, bestX.target.y), to: Math.max(moved.y + moved.h, bestX.target.y + bestX.target.h) });
  if (bestY) guides.push({ axis: 'y', pos: bestY.pos, from: Math.min(moved.x, bestY.target.x), to: Math.max(moved.x + moved.w, bestY.target.x + bestY.target.w) });
  return { dx, dy, guides };
}

/** Where a dragged child lands in an auto layout frame: the number of siblings whose centre is before it. */
export function reorderIndex(parent: DesignNode, draggedId: string, draggedCenter: number): number {
  const row = parent.layout?.dir === 'row';
  const others = (parent.children ?? []).filter((kid) => kid.id !== draggedId && kid.visible !== false);
  let index = 0;
  for (const kid of others) {
    const center = row ? kid.x + kid.w / 2 : kid.y + kid.h / 2;
    if (center < draggedCenter) index += 1;
  }
  return index;
}

/** Moves a node one step in its parent's z-order (+1 = forward/on top). Returns false at the end. */
export function stepZOrder(d: Design, id: string, delta: 1 | -1): boolean {
  const list = siblingsOf(d, id);
  const index = list.findIndex((node) => node.id === id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= list.length) return false;
  [list[index], list[target]] = [list[target], list[index]];
  return true;
}

/** Selection with nested picks collapsed: nodes whose ancestor is also selected are dropped. */
export function topLevelSelection(d: Design, ids: string[]): string[] {
  const set = new Set(ids);
  return ids.filter((id) => {
    let p = parentOf(d, id);
    while (p) { if (set.has(p.id)) return false; p = parentOf(d, p.id); }
    return true;
  });
}

/** Top-level nodes intersecting a marquee rectangle. */
export function nodesInRect(d: Design, rect: Box): string[] {
  return d.nodes
    .filter((n) => n.visible !== false && !n.locked && n.x < rect.x + rect.w && n.x + n.w > rect.x && n.y < rect.y + rect.h && n.y + n.h > rect.y)
    .map((n) => n.id);
}

export function selectionBounds(d: Design, ids: string[]): Box | null {
  const boxes = ids.map((id) => absoluteBox(d, id)).filter((b): b is Box => b !== null);
  if (boxes.length === 0) return null;
  const x = Math.min(...boxes.map((b) => b.x)), y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
}

export const isFreeMove = (d: Design, id: string): boolean => !isAutoLayoutFrame(parentOf(d, id) ?? null);

/** Re-exports used by the screen so it needs a single import site for geometry. */
export { absoluteBox, absolutePosition, allNodes, findNode, parentOf, siblingsOf, walk };
