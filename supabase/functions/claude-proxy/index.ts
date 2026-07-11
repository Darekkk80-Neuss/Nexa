// Effyra – KI-Proxy (Supabase Edge Function) — OpenAI-Backend
// Hält den echten OpenAI-Schlüssel serverseitig und setzt das Credit-Kontingent
// fälschungssicher durch (RPC consume_ai). Der Client ruft diese Funktion mit
// dem eingeloggten Supabase-JWT auf – niemals mit dem echten Key.
// (Funktionsname bleibt aus Kompatibilität "claude-proxy"; Backend ist OpenAI.)
//
// Benötigtes Secret (supabase secrets set ...):
//   OPENAI_API_KEY   (dein OpenAI-Schlüssel, sk-…)
// Automatisch vorhanden: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const ALLOWED_MODELS = ['gpt-5-mini'];   // nur das im OpenAI-Projekt freigegebene Modell → alles andere wird darauf abgebildet
const DEFAULT_MODEL = 'gpt-5-mini';
// Credit-Kosten je Operation (serverseitig = fälschungssicher, Client kann sie nicht drücken)
const OP_COST: Record<string, number> = { question: 1, text: 2, voice: 2, scan: 5, invoice: 10, weekplan: 5 };

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
  const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY');
  if (!OPENAI_API_KEY) return json({ error: 'server_not_configured' }, 500);

  // 1) Nutzer aus dem JWT bestimmen
  const userClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
  const { data: ures, error: uerr } = await userClient.auth.getUser();
  if (uerr || !ures?.user) return json({ error: 'auth_invalid' }, 401);
  const uid = ures.user.id;

  // 2) Anfrage validieren & begrenzen
  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const model = ALLOWED_MODELS.includes(body?.model) ? body.model : DEFAULT_MODEL;
  const max_tokens = Math.min(Math.max(1, Number(body?.max_tokens) || 1024), 4000);
  const inMsgs = Array.isArray(body?.messages) ? body.messages : null;
  if (!inMsgs) return json({ error: 'bad_request' }, 400);
  // System-Prompt wird bei OpenAI als erste Nachricht im messages-Array gesendet
  const messages = body.system ? [{ role: 'system', content: body.system }, ...inMsgs] : inMsgs;

  // 3) Kontingent serverseitig verbrauchen (atomar, prüft Premium + Restmenge)
  const cost = OP_COST[String(body?.op || '')] || 1;   // Credits je nach Operation
  const admin = createClient(SUPABASE_URL, SERVICE);
  const { data: consumed, error: cerr } = await admin.rpc('consume_ai', { p_user: uid, p_n: cost });
  if (cerr) return json({ error: 'quota_error' }, 500);
  if (!consumed?.ok) {
    // reason: not_premium | quota_exceeded | no_profile
    return json({ error: consumed?.reason || 'quota', ai_used: consumed?.ai_used, ai_limit: consumed?.ai_limit }, 402);
  }

  // 4) OpenAI aufrufen (echter Schlüssel, nur hier)
  // GPT-5-/o-Modelle: max_completion_tokens + minimales Reasoning (sonst frisst das interne Denken das Budget)
  const isReasoning = /^(gpt-5|o[0-9])/.test(model);
  const tokenParam = isReasoning ? { max_completion_tokens: Math.max(max_tokens, 800), reasoning_effort: 'minimal' } : { max_tokens };
  const ar = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model, messages, ...tokenParam }),
  });
  const data = await ar.json();
  if (!ar.ok) return json({ error: 'ai_failed', detail: data?.error?.message || '' }, ar.status);

  const text = data?.choices?.[0]?.message?.content || '';
  // Antwort im gewohnten content-Format zurückgeben – der Client bleibt unverändert
  return json({ content: [{ type: 'text', text }], ai_used: consumed.ai_used, ai_limit: consumed.ai_limit }, 200);
});
