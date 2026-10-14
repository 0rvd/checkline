// Builds the browser-safe Supabase config from environment variables.
// Shared by serve.mjs (served as /config.js) and write-config.mjs (static hosting).

function isSecretKey(key) {
  if (key.startsWith('sb_secret_')) return true;
  const parts = key.split('.');
  if (parts.length !== 3) return false;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role === 'service_role';
  } catch {
    return false;
  }
}

/** @returns {{ config: { supabaseUrl: string, supabaseAnonKey: string, supabaseJsUrl: string }, warning: string | null }} */
export function publicConfig(env) {
  let supabaseUrl = (env.SUPABASE_URL ?? '').trim();
  // Keep only the project origin: a pasted REST endpoint (https://<ref>.supabase.co/rest/v1/) also works.
  try {
    if (supabaseUrl) supabaseUrl = new URL(supabaseUrl).origin;
  } catch {
    /* left as typed; the game reports it as an invalid URL */
  }
  let supabaseAnonKey = (env.SUPABASE_ANON_KEY ?? env.SUPABASE_PUBLISHABLE_KEY ?? '').trim();
  const supabaseJsUrl = (env.SUPABASE_JS_URL ?? '').trim();
  let warning = null;
  if (supabaseAnonKey && isSecretKey(supabaseAnonKey)) {
    warning = 'SUPABASE_ANON_KEY looks like a secret / service-role key. It was NOT sent to the browser. Use the anon or publishable key.';
    supabaseAnonKey = '';
  } else if (!supabaseUrl || !supabaseAnonKey) {
    warning = 'Online play is off: set SUPABASE_URL and SUPABASE_ANON_KEY in .env (see SUPABASE_SETUP.md).';
  }
  return { config: { supabaseUrl, supabaseAnonKey, supabaseJsUrl }, warning };
}
