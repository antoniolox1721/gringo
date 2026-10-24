const CFG = window.GRINGO_CONFIG || {};
const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';

export const isMock =
  String(CFG.SUPABASE_URL || '').includes('localhost') ||
  new URLSearchParams(location.search).get('mock') === '1';

const BASE = isMock && !String(CFG.SUPABASE_URL || '').includes('localhost')
  ? location.origin
  : String(CFG.SUPABASE_URL || '').replace(/\/+$/, '');

export const pollMs = isMock ? 1000 : 5000;

export async function call(fn, body) {
  const headers = { 'content-type': 'application/json' };
  if (!isMock && CFG.SUPABASE_ANON_KEY) {
    headers.apikey = CFG.SUPABASE_ANON_KEY;
    headers.authorization = `Bearer ${CFG.SUPABASE_ANON_KEY}`;
  }
  let res;
  try {
    res = await fetch(`${BASE}/functions/v1/${fn}`, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch {
    const e = new Error('Cannot reach the server');
    e.status = 0;
    throw e;
  }
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    const e = new Error(data.error || `Request failed (${res.status})`);
    e.status = res.status;
    throw e;
  }
  return data;
}

function loadSupabase() {
  if (window.supabase) return Promise.resolve(window.supabase);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SUPABASE_JS;
    s.onload = () => resolve(window.supabase);
    s.onerror = () => reject(new Error('realtime library failed to load'));
    document.head.appendChild(s);
  });
}

// Calls onChange on every broadcast and on (re)subscribe. Returns an unsubscribe function.
// Polling stays the fallback, so a failed realtime setup is silent by design.
export function subscribe(code, onChange) {
  if (isMock) return () => {};
  let channel = null;
  let client = null;
  let dead = false;
  loadSupabase().then((sb) => {
    if (dead || !sb) return;
    client = sb.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
    channel = client.channel(`game:${code}`);
    channel
      .on('broadcast', { event: 'changed' }, () => onChange())
      .subscribe((status) => { if (status === 'SUBSCRIBED') onChange(); });
  }).catch(() => {});
  return () => {
    dead = true;
    try { if (client && channel) client.removeChannel(channel); } catch { /* ignore */ }
  };
}
