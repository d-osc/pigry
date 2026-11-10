/**
 * Memoized fibonacci.
 *
 * Trade-off: a Map keyed by n keeps results across calls (the cache lives at
 * module scope), so repeat calls are O(1). Memory grows with distinct inputs,
 * which is fine here since fib results overflow Number precision around n=79
 * anyway.
 */

const cache = new Map<number, number>();

export function fib(n: number): number {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError("fib expects a non-negative integer");
  }
  if (n < 2) return n;

  const cached = cache.get(n);
  if (cached !== undefined) return cached;

  const result = fib(n - 1) + fib(n - 2);
  cache.set(n, result);
  return result;
}

// Runnable example: `npx tsx dev-demo/fib.ts`
if (process.argv[1]?.endsWith("fib.ts")) {
  console.log("fib(10) =", fib(10)); // 55
  console.log("fib(40) =", fib(40)); // 102334155
}
