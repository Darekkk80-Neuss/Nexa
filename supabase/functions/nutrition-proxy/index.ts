// Effyra – Nährwerte-Proxy (Spoonacular). Versteckt den API-Key serverseitig.
// Der Client ruft die Funktion mit seinem JWT auf; die Funktion schätzt die Nährwerte
// eines Gerichts anhand des (englischen) Gerichtnamens über Spoonacular „guessNutrition"
// (~1 Punkt, gratis 150/Tag) und gibt kcal/Eiweiß/KH/Fett je Portion zurück.
//
// Benötigtes Secret:  SPOONACULAR_KEY   (supabase secrets set SPOONACULAR_KEY=...)
// Automatisch vorhanden: SUPABASE_URL, SUPABASE_ANON_KEY
// Deploy:  supabase functions deploy nutrition-proxy --project-ref ocnlrxmosbbtsczjyvxb --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, 'content-type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'auth_required' }, 401);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
  const KEY = Deno.env.get('SPOONACULAR_KEY');
  if (!KEY) return json({ error: 'not_configured' }, 500);   // Secret noch nicht gesetzt

  // Nur angemeldete Nutzer (verhindert anonymen Missbrauch des Kontingents).
  const userClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
  const { data: ures, error: uerr } = await userClient.auth.getUser();
  if (uerr || !ures?.user) return json({ error: 'auth_invalid' }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const title = String(body?.title || '').trim().slice(0, 120);
  if (!title) return json({ error: 'bad_request' }, 400);

  try {
    const url = 'https://api.spoonacular.com/recipes/guessNutrition?apiKey=' + encodeURIComponent(KEY) + '&title=' + encodeURIComponent(title);
    const r = await fetchT(url, {}, 10000);
    if (!r.ok) return json({ error: 'spoonacular_error', status: r.status }, 502);
    const d = await r.json();
    const num = (x: any) => (x && typeof x.value === 'number') ? Math.round(x.value) : null;
    return json({ ok: true, kcal: num(d.calories), protein: num(d.protein), carbs: num(d.carbs), fat: num(d.fat) }, 200);
  } catch (_e) {
    return json({ error: 'fetch_failed' }, 502);
  }
});
