// Effyra – Claude-Proxy (Supabase Edge Function)
// Hält den echten Anthropic-Schlüssel serverseitig und setzt das 500/Monat-
// Kontingent fälschungssicher durch (RPC consume_ai). Der Client ruft diese
// Funktion mit dem eingeloggten Supabase-JWT auf – niemals mit dem echten Key.
//
// Benötigte Secrets (supabase secrets set ...):
//   ANTHROPIC_API_KEY   (gibst du später an – der eigentliche Claude-Schlüssel)
// Automatisch vorhanden: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const ALLOWED_MODELS = ['claude-sonnet-5', 'claude-haiku-4-5-20251001'];

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'content-type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'auth_required' }, 401);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
  const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
  if (!ANTHROPIC_API_KEY) return json({ error: 'server_not_configured' }, 500);

  // 1) Nutzer aus dem JWT bestimmen
  const userClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
  const { data: ures, error: uerr } = await userClient.auth.getUser();
  if (uerr || !ures?.user) return json({ error: 'auth_invalid' }, 401);
  const uid = ures.user.id;

  // 2) Anfrage validieren & begrenzen
  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const model = ALLOWED_MODELS.includes(body?.model) ? body.model : 'claude-sonnet-5';
  const max_tokens = Math.min(Math.max(1, Number(body?.max_tokens) || 1024), 2000);
  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if (!messages) return json({ error: 'bad_request' }, 400);

  // 3) Kontingent serverseitig verbrauchen (atomar, prüft Premium + Restmenge)
  const admin = createClient(SUPABASE_URL, SERVICE);
  const { data: consumed, error: cerr } = await admin.rpc('consume_ai', { p_user: uid, p_n: 1 });
  if (cerr) return json({ error: 'quota_error' }, 500);
  if (!consumed?.ok) {
    // reason: not_premium | quota_exceeded | no_profile
    return json({ error: consumed?.reason || 'quota', ai_used: consumed?.ai_used, ai_limit: consumed?.ai_limit }, 402);
  }

  // 4) Claude aufrufen (echter Schlüssel, nur hier)
  const ar = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens, messages, ...(body.system ? { system: body.system } : {}) }),
  });
  const data = await ar.json();
  if (!ar.ok) return json({ error: 'ai_failed', detail: data?.error?.message || '' }, ar.status);

  return json({ content: data.content, ai_used: consumed.ai_used, ai_limit: consumed.ai_limit }, 200);
});
