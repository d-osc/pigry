/**
 * ZCode desktop integration — detects the installed ZCode app and decrypts its
 * z.ai coding-plan API key (scheme verified from ZCode's own bundle:
 * aes-256-gcm, key = sha256(machine-derived secret), format enc:v1:nonce.tag.ct).
 */
import { zcodeCredentials } from './tauriClient';

export interface ZcodeGlmProvider {
  name: string;
  type: 'zcode';
  model: string;
  baseUrl: string;
  apiKey: string;
  account: string;
}

export const ZCODE_CHAT_ENDPOINT = 'https://api.z.ai/api/coding/paas/v4/chat/completions';
export const ZCODE_DEFAULT_MODEL = 'GLM-5.3-Flash';

function b64url(v: string): Uint8Array<ArrayBuffer> {
  const bin = atob(v.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Decrypts the z.ai coding-plan api-key from ZCode's credential store.
 * Returns a ready-to-use provider entry, or null when ZCode isn't detected.
 */
export async function detectZcodeGlm(): Promise<ZcodeGlmProvider | null> {
  const creds = await zcodeCredentials();
  if (!creds || creds.entries.length === 0) return null;

  const enc = new TextEncoder();
  const keyMat = await crypto.subtle.digest('SHA-256', enc.encode(creds.secret));
  const key = await crypto.subtle.importKey('raw', keyMat, 'AES-GCM', false, ['decrypt']);

  for (const entry of creds.entries) {
    try {
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: b64url(entry.iv) },
        key,
        new Uint8Array([...b64url(entry.ct), ...b64url(entry.tag)]),
      );
      const apiKey = new TextDecoder().decode(plain);
      if (!apiKey) continue;
      const account = entry.key.split(':account:')[1]?.split(':')[0] ?? '';
      return {
        name: 'ZCode Cloud (GLM)' + (account ? ' · ' + account : ''),
        type: 'zcode',
        model: ZCODE_DEFAULT_MODEL,
        baseUrl: ZCODE_CHAT_ENDPOINT,
        apiKey,
        account,
      };
    } catch {
      // try next entry
    }
  }
  return null;
}
