import { createClient } from 'npm:@supabase/supabase-js@2';
import { handleAct } from '../_shared/handlers.js';
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
    const { status, body: out } = await handleAct(db, body);
    return Response.json(out, { status, headers: cors });
  } catch (e) {
    console.error(e);
    return Response.json({ error: 'internal error' }, { status: 500, headers: cors });
  }
});
