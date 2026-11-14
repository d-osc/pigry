/** Superseded requests may finish, but must never publish stale state. */
export function createRequestGate() {
  let generation = 0;
  return {
    begin() { const id = ++generation; return () => id === generation; },
    invalidate() { generation++; },
  };
}
