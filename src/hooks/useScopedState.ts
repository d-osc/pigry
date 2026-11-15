import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';

/** Reset a value when its context changes, without expanding the caller's render graph. */
export function useScopedState<T>(scope: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [entry, setEntry] = useState({ scope, value: initial });
  if (entry.scope !== scope) setEntry({ scope, value: initial });
  const value = entry.scope === scope ? entry.value : initial;
  const setValue: Dispatch<SetStateAction<T>> = useCallback((next: SetStateAction<T>) => {
    setEntry((previous) => {
      const current = previous.scope === scope ? previous.value : initial;
      return { scope, value: typeof next === 'function' ? (next as (value: T) => T)(current) : next };
    });
  }, [scope, initial]);
  return [value, setValue];
}
