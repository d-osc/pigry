/** The script sandbox: a dedicated worker per script run. Before any script runs, the network and code-loading
 * globals are removed and the Function constructors are cut off, so a script can neither reach the network nor
 * compile code that could. It gets the pm API only (see apiScript.ts). */
import { runScript, type ScriptInput } from './apiScript';

const scope = self as unknown as Record<string, unknown>;
for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'WebTransport', 'EventSource', 'importScripts', 'indexedDB', 'caches', 'BroadcastChannel', 'Worker', 'SharedWorker', 'eval', 'WebAssembly', 'navigator', 'Request', 'Response']) {
  try { Object.defineProperty(scope, name, { value: undefined, configurable: false, writable: false }); } catch { /* not configurable here */ }
}
// (function(){}).constructor('…') and friends would compile code outside the parameter shadowing.
for (const fn of [function () { /* plain */ }, async function () { /* async */ }, function* () { /* generator */ }, async function* () { /* async generator */ }]) {
  try { Object.defineProperty(Object.getPrototypeOf(fn), 'constructor', { value: undefined, configurable: false, writable: false }); } catch { /* frozen already */ }
}

const post = (self as unknown as { postMessage: (m: unknown) => void }).postMessage.bind(self);
self.onmessage = (event: MessageEvent<ScriptInput>) => {
  void runScript(event.data).then((out) => post(out), (e: unknown) => post({ tests: [], logs: [], error: String(e), request: event.data.request, scopes: event.data.scopes }));
};
