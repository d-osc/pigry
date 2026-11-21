// Dev helper: print a line range from a file.
// Usage: node .pigry/tools/lines.mjs <file> <start> <end>
import { readFileSync } from 'node:fs';

const [file, startArg, endArg] = process.argv.slice(2);
const start = Number(startArg ?? 1);
const end = Number(endArg ?? Infinity);
const lines = readFileSync(file, 'utf8').split(/\r?\n/);
for (let i = start; i <= Math.min(end, lines.length); i += 1) {
  process.stdout.write(`${String(i).padStart(5)}  ${lines[i - 1]}\n`);
}
