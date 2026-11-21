/** Agents tagged together in one message work at the same time. While such a fan-out runs:
 *  - changes to the same file (write / delete / rename) go through a queue: one agent at a time, and the next one in
 *    line goes as soon as the previous change is done (no waiting for that agent's turn to end);
 *  - an agent whose picture of a file is out of date — the content on disk differs from what it last read or wrote, or
 *    another agent changed it since — is told to read_file again and redo its edit on top of the current content;
 *  - repo-wide operations (shell commands, staging, commits) run one at a time through a shared queue.
 * Outside a fan-out nothing is guarded. */
export type Snapshot = (path: string) => Promise<string | null>;
interface GuardOptions { signal?: AbortSignal; onWait?: (writer: string) => void; }

/** A FIFO mutex: `run` waits for every earlier call, then runs `fn`; an aborted waiter drops out without blocking others. */
class Gate {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private running = '';

  async run<T>(agent: string, fn: () => Promise<T>, options: GuardOptions = {}): Promise<T> {
    if (this.pending > 0) options.onWait?.(this.running);
    this.pending += 1;
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    try {
      await Promise.race([
        previous,
        new Promise<never>((_, reject) => {
          if (options.signal?.aborted) reject(options.signal.reason);
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
        }),
      ]);
      this.running = agent;
      return await fn();
    } finally {
      this.pending -= 1;
      // Pass the baton once everything ahead is done (immediately when this call ran).
      void previous.then(release, release);
    }
  }
}

interface FileState {
  gate: Gate;
  version: number; // bumped by every guarded change
  seen: Map<string, string | null>; // agent -> fingerprint of the content it last read or wrote
  seenVersion: Map<string, number>; // agent -> version at that moment
}

let fanOutDepth = 0;
const files = new Map<string, FileState>();
const gates = new Map<string, Gate>();

export function beginFanOut(): void {
  if (fanOutDepth === 0) reset();
  fanOutDepth += 1;
}

/** True while several agents are working at the same time. */
export function isFanOut(): boolean {
  return fanOutDepth > 0;
}

export function endFanOut(): void {
  fanOutDepth = Math.max(0, fanOutDepth - 1);
  if (fanOutDepth === 0) reset();
}

function reset(): void {
  files.clear();
  gates.clear();
}

const normalize = (path: string): string => path.trim().split(String.fromCharCode(92)).join('/').replace(/^[.]\//, '').toLowerCase();

function fingerprint(content: string | null): string | null {
  if (content === null) return null;
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) hash = Math.imul(hash ^ content.charCodeAt(i), 0x01000193);
  return `${content.length}:${hash >>> 0}`;
}

function fileState(key: string): FileState {
  let state = files.get(key);
  if (!state) {
    state = { gate: new Gate(), version: 0, seen: new Map(), seenVersion: new Map() };
    files.set(key, state);
  }
  return state;
}

/** Call after `agent` reads `path`: it has now seen what is on disk. */
export async function noteRead(path: string, agent: string | undefined, snapshot: Snapshot): Promise<void> {
  if (fanOutDepth === 0 || !agent) return;
  const state = fileState(normalize(path));
  state.seen.set(agent, fingerprint(await snapshot(path).catch(() => null)));
  state.seenVersion.set(agent, state.version);
}

const staleMessage = (path: string): string =>
  `error: ${path} was changed by another agent (or a command) since you last read it. It is free now — read_file ${path} again, then redo your edit on top of the current content.`;

/** Runs `change` (a write, delete or rename touching `paths`) for `agent` once it is its turn in each file's queue.
 * Resolves to the change's output, or to an error message (nothing changed) when the agent must re-read a file first. */
export async function guardedChange(
  paths: string[],
  agent: string | undefined,
  change: () => Promise<string>,
  snapshot: Snapshot,
  options: GuardOptions = {},
): Promise<string> {
  if (fanOutDepth === 0 || !agent) return change();
  // Always take file queues in the same (sorted) order so two multi-file changes cannot wait on each other.
  const keyed = [...new Map(paths.map((path) => [normalize(path), path])).entries()].sort(([a], [b]) => a.localeCompare(b));
  const hold = async (index: number): Promise<string> => {
    if (index >= keyed.length) {
      for (const [key, path] of keyed) {
        const state = fileState(key);
        const current = fingerprint(await snapshot(path).catch(() => null));
        const mine = state.seen.get(agent);
        const stale = mine === undefined ? state.version > (state.seenVersion.get(agent) ?? 0) : mine !== current;
        if (stale) return staleMessage(path);
      }
      const output = await change();
      if (!/^error\b/i.test(output)) {
        for (const [key, path] of keyed) {
          const state = fileState(key);
          state.version += 1;
          state.seen.set(agent, fingerprint(await snapshot(path).catch(() => null)));
          state.seenVersion.set(agent, state.version);
        }
      }
      return output;
    }
    const [key] = keyed[index];
    return fileState(key).gate.run(agent, () => hold(index + 1), options);
  };
  return hold(0);
}

/** Runs `operation` for `agent` while holding a named queue (e.g. 'repo' for shell commands, staging and commits). */
export async function exclusive<T>(name: string, agent: string | undefined, operation: () => Promise<T>, options: GuardOptions = {}): Promise<T> {
  if (fanOutDepth === 0 || !agent) return operation();
  let gate = gates.get(name);
  if (!gate) {
    gate = new Gate();
    gates.set(name, gate);
  }
  return gate.run(agent, operation, options);
}
