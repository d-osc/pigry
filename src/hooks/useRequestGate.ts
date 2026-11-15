import { useEffect, useState } from 'react';
import { createRequestGate } from '../lib/latestRequest';
export function useRequestGate() {
  const [gate] = useState(createRequestGate);
  useEffect(() => () => gate.invalidate(), [gate]);
  return gate;
}
