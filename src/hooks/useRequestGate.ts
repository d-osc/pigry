import { useEffect, useRef } from 'react';
import { createRequestGate } from '../lib/latestRequest';
export function useRequestGate() {
  const ref = useRef<ReturnType<typeof createRequestGate> | null>(null);
  if (!ref.current) ref.current = createRequestGate();
  const gate = ref.current;
  useEffect(() => () => gate.invalidate(), [gate]);
  return gate;
}
