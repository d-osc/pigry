/** Agents tagged together in one message work at the same time. While such a fan-out runs, the first agent to write a
 * file owns it for the rest of the run: a different agent writing the same path is refused, so one never silently
 * overwrites the other's work. Outside a fan-out nothing is guarded. */
let fanOutDepth = 0;
const writers = new Map<string, string>();

export function beginFanOut(): void {
  if (fanOutDepth === 0) writers.clear();
  fanOutDepth += 1;
}

export function endFanOut(): void {
  fanOutDepth = Math.max(0, fanOutDepth - 1);
  if (fanOutDepth === 0) writers.clear();
}

const normalize = (path: string): string => path.trim().split(String.fromCharCode(92)).join('/').replace(/^[.]\//, '').toLowerCase();

/** Returns an error message when `agent` may not write `path`, otherwise records the claim and returns null. */
export function claimWrite(path: string, agent: string | undefined): string | null {
  if (fanOutDepth === 0 || !agent) return null;
  const key = normalize(path);
  const owner = writers.get(key);
  if (owner && owner !== agent) {
    return `error: ${path} was already written by @${owner} in this parallel run — do not overwrite it. Pick another file or say what you would change instead.`;
  }
  writers.set(key, agent);
  return null;
}
