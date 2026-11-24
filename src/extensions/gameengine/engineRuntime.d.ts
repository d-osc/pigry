/** Declarations for engineRuntime.js (plain JavaScript, so it can also be inlined into the sandboxed game page). */
export const API_VERSION: number;
export function ease(t: number, trans?: string, mode?: 'in' | 'out' | 'inout'): number;
export interface EngineOptions {
  mode?: 'play' | 'edit';
  debugShapes?: boolean;
  random?: () => number;
  onLog?: (level: string, text: string) => void;
  onQuit?: () => void;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createEngine(three: any, options?: EngineOptions): any;
