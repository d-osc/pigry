export function isProjectStartRequest(text: string): boolean {
  return /^(?:(?:ช่วย\s*)?(?:start(?:\s*(?:app|project|แอป|โปรเจกต์))?|(?:เปิด|รัน)\s*(?:แอป|โปรเจกต์))(?:\s*(?:ให้หน่อย|หน่อย))?|(?:please\s+)?(?:start|run)\s+the\s+(?:app|project))[.!]?$/iu.test(text.trim());
}

export function projectStartupCommand(packageJson: string): string {
  const manifest = JSON.parse(packageJson) as { scripts?: Record<string, unknown> } | null;
  const scripts = manifest?.scripts;
  const hasScript = (name: string) => typeof scripts?.[name] === 'string' && scripts[name].trim().length > 0;
  if (scripts?.tauri === 'tauri' && hasScript('dev')) return 'npm run tauri dev';
  if (hasScript('start')) return 'npm start';
  if (hasScript('dev')) return 'npm run dev';
  throw new Error('No start or dev script was found in package.json.');
}

export function isStartupFailure(code: number | null): boolean {
  return code !== null && ![0, 130, 143, 0xc000013a].includes(code);
}

export function redactStartupLog(output: string): string {
  return output
    .replace(/(\bauthorization\b["']?\s*[:=]\s*["']?(?:bearer|basic)\s+)\S+/gi, '$1[redacted]')
    .replace(/(\b(?:[\w-]*token|[\w-]*api[_-]?key|[\w-]*secret|password)\b["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1[redacted]')
    .replace(/(\b[\w+.-]+:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[redacted]@');
}
