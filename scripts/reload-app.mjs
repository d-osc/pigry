#!/usr/bin/env node
/** Force-reloads the Pigry app's main webview over CDP (dev only) so it
 * picks up the latest frontend code from vite — use this after editing
 * frontend files when HMR hasn't propagated to the running window.
 * Requires the app to be running via `npm run tauri dev` (which enables
 * the remote debugging port in debug builds).
 * Usage: node scripts/reload-app.mjs
 */
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const main = list.find((t) => t.type === 'page' && t.url.startsWith('http://localhost:1420'));
if (!main) {
  console.error('main webview target not found — is the app running in dev mode?');
  process.exit(1);
}
const ws = new WebSocket(main.webSocketDebuggerUrl);
const timer = setTimeout(() => {
  console.error('reload timed out');
  process.exit(1);
}, 5000);
ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ id: 1, method: 'Page.reload', params: { ignoreCache: true } }));
  setTimeout(() => {
    clearTimeout(timer);
    console.log('app reloaded with the latest build (cache ignored)');
    process.exit(0);
  }, 800);
});
ws.addEventListener('error', () => {
  clearTimeout(timer);
  console.error('failed to attach to the page over CDP');
  process.exit(1);
});
