// Reads the public Supabase settings injected by scripts/serve.mjs (from .env) as window.CHECKLINE_CONFIG.
// Only the project URL and the public (anon / publishable) key belong here. Secret keys are rejected.

export const DEFAULT_SUPABASE_JS_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

export interface OnlineConfig {
  supabaseUrl: string;
  supabaseKey: string;
  supabaseJsUrl: string;
}

export type ConfigProblem = 'missing' | 'placeholder' | 'bad_url' | 'secret_key';

export type ConfigResult = { ok: true; config: OnlineConfig } | { ok: false; problem: ConfigProblem };

interface RawConfig {
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  supabaseJsUrl?: string;
}

/** True for service-role / secret keys, which must never reach a browser. */
export function looksSecret(key: string): boolean {
  if (key.startsWith('sb_secret_')) return true;
  const parts = key.split('.');
  if (parts.length === 3) {
    try {
      const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
      return JSON.parse(json).role === 'service_role';
    } catch {
      return false;
    }
  }
  return false;
}

export function parseOnlineConfig(raw: RawConfig | undefined | null): ConfigResult {
  const url = (raw?.supabaseUrl ?? '').trim();
  const key = (raw?.supabaseAnonKey ?? '').trim();
  if (!url || !key) return { ok: false, problem: 'missing' };
  if (/your-project|YOUR_|<|example/i.test(url + key)) return { ok: false, problem: 'placeholder' };
  if (!/^https?:\/\/[^\s/]+/i.test(url)) return { ok: false, problem: 'bad_url' };
  if (looksSecret(key)) return { ok: false, problem: 'secret_key' };
  // Only the project origin is used. People often paste the REST endpoint
  // (https://<ref>.supabase.co/rest/v1/) from the dashboard; supabase-js adds those paths itself.
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return { ok: false, problem: 'bad_url' };
  }
  return {
    ok: true,
    config: { supabaseUrl: origin, supabaseKey: key, supabaseJsUrl: (raw?.supabaseJsUrl ?? '').trim() || DEFAULT_SUPABASE_JS_URL },
  };
}

export function readOnlineConfig(): ConfigResult {
  const raw = (globalThis as { CHECKLINE_CONFIG?: RawConfig }).CHECKLINE_CONFIG;
  return parseOnlineConfig(raw);
}
