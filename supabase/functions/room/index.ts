import { createClient } from 'npm:@supabase/supabase-js@2';
import { handleRoom } from '../_shared/handlers.js';
import { supabaseDb } from '../_shared/store.js';

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-allow-methods': 'POST, OPTIONS',
};

const db = supabaseDb(
  createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  }),
);

// The address the platform saw. Cloudflare sets cf-connecting-ip itself; x-forwarded-for can carry
// client-supplied entries in front, so only its last entry is trusted.
function clientIp(req: Request): string {
  const cf = req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip');
  if (cf) return cf.trim();
  const xff = (req.headers.get('x-forwarded-for') || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : 'unknown';
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  let body;
  try {
    const text = await req.text();
    if (text.length > 4096) return Response.json({ error: 'request too large' }, { status: 413, headers: cors });
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400, headers: cors });
  }
  try {
    const { status, body: out } = await handleRoom(db, body, { ip: clientIp(req) });
    const headers = status === 429 ? { ...cors, 'retry-after': '30' } : cors;
    return Response.json(out, { status, headers });
  } catch (e) {
    console.error(e);
    return Response.json({ error: 'internal error' }, { status: 500, headers: cors });
  }
});
