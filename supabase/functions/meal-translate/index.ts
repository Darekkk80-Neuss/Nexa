// Effyra – Rezept-Uebersetzung (serverseitig, gecacht, fuer den Nutzer kostenlos).
//
// Warum es diese Funktion gibt: Die Zubereitung ist Fliesstext und laesst sich
// nicht ueber die eingebaute Wortliste uebersetzen (anders als Titel und Zutaten).
// Frueher lief die Uebersetzung ueber die KI DES NUTZERS (claude-proxy, op 'text'
// = 2 Credits) und haing damit an KI-Einwilligung UND Guthaben – wer beides nicht
// hatte, sah die Zubereitung dauerhaft auf Englisch. Fuer ein oeffentliches Rezept
// ist das falsch am Platz.
//
// Hier passiert es serverseitig: einmal pro Rezept+Sprache uebersetzt, in
// meal_tr_cache abgelegt und danach fuer ALLE Nutzer sofort und gratis geliefert.
// Es gehen KEINE Nutzerdaten an OpenAI – das Rezept ist oeffentlich (TheMealDB).
//
// WICHTIG (Cache-Vergiftung): Der Rezepttext wird hier SELBST bei TheMealDB geholt;
// vom Client kommt nur die id. Wuerde der Client den Text mitschicken, koennte ein
// angemeldeter Nutzer beliebigen Inhalt in den GEMEINSAMEN Cache schreiben und ihn
// damit fuer alle anderen verfaelschen.
//
// Benoetigtes Secret:  OPENAI_API_KEY   (optional OPENAI_MODEL_CHAIN)
// Voraussetzung:       Tabelle public.meal_tr_cache (supabase-optimierung.sql)
// Deploy:              supabase functions deploy meal-translate

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { fetchT } from '../_shared/util.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, 'content-type': 'application/json' } });
}

// 'en' fehlt bewusst: das Original ist bereits Englisch, da gibt es nichts zu tun.
const LANGS: Record<string, string> = { de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pl: 'Polish' };

const MODEL_CHAIN = (Deno.env.get('OPENAI_MODEL_CHAIN') || 'gpt-5-mini,gpt-4.1-mini-2025-04-14,gpt-4o-mini-2024-07-18')
  .split(',').map((s) => s.trim()).filter(Boolean);

/* Modelle antworten gern mit ```json-Zaun drumherum – den vor dem Parsen abraeumen. */
function extractJSON(s: string): any {
  const t = String(s || '').replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(t); } catch { /* weiter unten der Ausschnitt-Versuch */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; } }
  return null;
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
  if (!OPENAI_API_KEY) return json({ error: 'not_configured' }, 500);

  // Nur angemeldete Nutzer – verhindert, dass der OpenAI-Schluessel anonym
  // leergefahren wird. Es werden KEINE Credits abgezogen und es ist KEINE
  // KI-Einwilligung noetig: hier gehen ausschliesslich oeffentliche Rezeptdaten raus.
  const userClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
  const { data: ures, error: uerr } = await userClient.auth.getUser();
  if (uerr || !ures?.user) return json({ error: 'auth_invalid' }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const id = String(body?.id || '').trim().slice(0, 32);
  const lang = String(body?.lang || '').trim().toLowerCase();
  if (!/^[0-9]+$/.test(id)) return json({ error: 'bad_request' }, 400);   // TheMealDB-Ids sind rein numerisch
  if (!LANGS[lang]) return json({ error: 'bad_lang' }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE);

  // ---- 1) Cache ----------------------------------------------------------
  const { data: hit } = await admin.from('meal_tr_cache')
    .select('title,names,instr').eq('meal_id', id).eq('lang', lang).maybeSingle();
  if (hit && hit.title) {
    return json({ ok: true, cached: true, title: hit.title, names: hit.names || [], instr: hit.instr || '' });
  }

  // ---- 2) Rezept SELBST holen (nicht vom Client uebernehmen) --------------
  let title_en = '', instr_en = '', names_en: string[] = [];
  try {
    const r = await fetchT('https://www.themealdb.com/api/json/v1/1/lookup.php?i=' + encodeURIComponent(id), {}, 10000);
    if (!r.ok) return json({ error: 'lookup_failed', status: r.status }, 502);
    const d = await r.json().catch(() => null);
    const m = d && Array.isArray(d.meals) && d.meals[0];
    if (!m) return json({ error: 'unknown_meal' }, 404);
    title_en = String(m.strMeal || '').trim().slice(0, 200);
    instr_en = String(m.strInstructions || '').trim().slice(0, 6000);
    for (let i = 1; i <= 20; i++) {
      const n = m['strIngredient' + i];
      if (n && String(n).trim()) names_en.push(String(n).trim().slice(0, 80));
    }
  } catch (_e) {
    return json({ error: 'lookup_failed' }, 502);
  }
  if (!title_en || !instr_en) return json({ error: 'empty_meal' }, 502);

  // ---- 3) Uebersetzen ----------------------------------------------------
  const LNAME = LANGS[lang];
  const prompt = 'Translate this recipe into ' + LNAME
    + '. Reply with STRICT JSON only, no extra text: {"title":"...","ingredients":["...","..."],"instructions":"..."}.'
    + ' Keep EXACTLY the same number and order of ingredients; translate only the ingredient NAME (no quantities).'
    + ' Keep the instructions readable.\n\nTitle: ' + title_en
    + '\n\nIngredients:\n' + names_en.map((n, i) => (i + 1) + '. ' + n).join('\n')
    + '\n\nInstructions:\n' + instr_en;

  const doChat = (model: string) => {
    const isReasoning = /^(gpt-5|o[0-9])/.test(model);
    const tokenParam = isReasoning
      ? { max_completion_tokens: 1600, reasoning_effort: 'minimal' }
      : { max_tokens: 1600 };
    return fetchT('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], ...tokenParam }),
    }, 60000);
  };

  let parsed: any = null;
  for (const model of MODEL_CHAIN) {
    try {
      const r = await doChat(model);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        // Nur bei „Modell gibt es nicht" weiterruecken; ein echtes Limit/400
        // traefe beim naechsten Modell dasselbe Konto und waere sinnlos.
        const code = String(d?.error?.code || d?.error?.type || '');
        if (/model_not_found|does_not_exist|invalid_model/i.test(code)) continue;
        break;
      }
      parsed = extractJSON(d?.choices?.[0]?.message?.content || '');
      if (parsed && parsed.title) break;
    } catch (_e) { /* naechstes Modell versuchen */ }
  }
  if (!parsed || !parsed.title) return json({ error: 'translate_failed' }, 502);

  // Reihenfolge/Anzahl der Zutaten MUSS zum Original passen – der Client ordnet
  // sie ueber den Index seiner eigenen Liste zu. Fehlt eine, bleibt das Original.
  const outNames = Array.isArray(parsed.ingredients) ? parsed.ingredients : [];
  const names = names_en.map((n, i) => (outNames[i] ? String(outNames[i]).slice(0, 120) : n));
  const out = {
    title: String(parsed.title).slice(0, 200),
    names,
    instr: String(parsed.instructions || instr_en).slice(0, 8000),
  };

  // ---- 4) Cachen (best effort) -------------------------------------------
  // Ein Fehler hier darf die Antwort nicht kosten – der Nutzer hat seine
  // Uebersetzung, sie wird beim naechsten Mal eben erneut erzeugt.
  const { error: cErr } = await admin.from('meal_tr_cache')
    .upsert({ meal_id: id, lang, title: out.title, names: out.names, instr: out.instr, updated_at: new Date().toISOString() },
      { onConflict: 'meal_id,lang' });
  if (cErr) console.error('meal_tr_cache_write_failed', JSON.stringify({ id, lang, msg: cErr.message }));

  return json({ ok: true, cached: false, ...out });
});
