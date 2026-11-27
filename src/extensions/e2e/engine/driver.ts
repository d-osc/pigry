/** The E2E runner's browser: the external test window picked in E2E Testing.
 * src-tauri/src/devtools.rs drives Edge, Chrome and the other Chromium browsers
 * over the Chrome DevTools Protocol, and Firefox over WebDriver BiDi (bidi.rs) —
 * the same actions either way, except video recording (Chromium only). */
import { agentShellRun, browserDevtools, readWorktreeFile, writeWorktreeFile } from '../../../lib/tauriClient';
import type { Driver } from './runner';

export function tauriDriver(): Driver {
  return {
    open: async (url, waitMs) => { await browserDevtools('open', { url, waitMs: waitMs ?? 0 }); },
    eval: (js) => browserDevtools('eval', { js }),
    initScript: async (js) => { await browserDevtools('init_script', { js }); },
    screenshot: async (saveAs, opts) => {
      const shot = opts?.clip ? { clip: opts.clip } : opts?.fullPage ? { fullPage: true } : undefined;
      await browserDevtools('screenshot', { url: saveAs, js: shot ? JSON.stringify(shot) : undefined });
    },
    input: async (events) => { await browserDevtools('input', { js: JSON.stringify(events) }); },
    cookies: async () => JSON.parse(await browserDevtools('cookies')) as Array<{ name: string; value: string; domain: string; path: string; httpOnly: boolean; secure: boolean; expires?: number }>,
    setCookie: async (cookie) => { await browserDevtools('set_cookie', { js: JSON.stringify(cookie) }); },
    clearCookies: async (name) => { await browserDevtools('clear_cookies', { js: name }); },
    setHeaders: async (headers) => { await browserDevtools('headers', { js: JSON.stringify(headers) }); },
    setWebSecurity: async (enabled) => { await browserDevtools('websecurity', { js: enabled ? 'on' : 'off' }); },
    setBrowser: async (id) => { await browserDevtools('browser', { js: id }); },
    viewport: async (width, height, mobile) => { await browserDevtools('viewport', { js: `${width},${height},${mobile === true}` }); },
    recordStart: async (saveAs) => { await browserDevtools('record_start', { url: saveAs }); },
    recordStop: async () => { await browserDevtools('record_stop'); },
    networkExport: async (saveAs) => { await browserDevtools('network_export', { url: saveAs, js: 'api' }); },
    console: () => browserDevtools('console', { waitMs: 60 }),
    readFile: async (path) => {
      try { const f = await readWorktreeFile(path); return f.binary || f.tooLarge ? null : f.content; } catch { return null; }
    },
    writeFile: (path, content) => writeWorktreeFile(path, content),
    exec: async (command, timeoutSecs) => { const r = await agentShellRun(command, timeoutSecs); return { code: r.code ?? 0, output: r.output }; },
    close: async () => { await browserDevtools('close'); },
  };
}

/* ---- calling the page-side library (selector playground, recorder) ---- */
import CY_PAGE from './cyPage.js?raw';

const unwrapText = (raw: string): string => { try { const v = JSON.parse(raw) as unknown; return typeof v === 'string' ? v : raw; } catch { return raw; } };

/** Calls window.__cy.<name>(...args) in the test browser, injecting the library first when the page has none. */
export async function pageCall<T = unknown>(driver: Driver, name: string, args: unknown[] = []): Promise<T> {
  const js = `(function(){ if(!window.__cy){ ${CY_PAGE} } return window.__cy.call(${JSON.stringify(name)}, ${JSON.stringify(args)}); })()`;
  const parsed = JSON.parse(unwrapText(await driver.eval(js))) as { r?: T; x?: string };
  if (parsed.x) throw new Error(parsed.x);
  return parsed.r as T;
}
