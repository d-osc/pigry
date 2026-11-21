/** Images queued for a model's NEXT turn. The read_image tool and the design/board preview tools queue data URLs
 * here; the agent loop flushes them into the conversation as visible image blocks right after the tool result.
 * Queues are per agent so agents working in parallel never pick up each other's images. */
const queues = new Map<string, string[]>();
const keyOf = (agent?: string): string => agent ?? '';

export function queueImage(dataUrl: string, agent?: string): void {
  const key = keyOf(agent);
  queues.set(key, [...(queues.get(key) ?? []), dataUrl]);
}

export function hasImages(agent?: string): boolean {
  return (queues.get(keyOf(agent))?.length ?? 0) > 0;
}

/** Removes and returns this agent's queued images. */
export function takeImages(agent?: string): string[] {
  const key = keyOf(agent);
  const taken = queues.get(key) ?? [];
  queues.delete(key);
  return taken;
}

export function clearImages(agent?: string): void {
  queues.delete(keyOf(agent));
}
