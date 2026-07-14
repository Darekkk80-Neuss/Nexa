// Effyra – Foto-Proxy (Pexels) für EffyraFit-Hero-Bilder.
// Versteckt den PEXELS_KEY serverseitig und liefert einen kleinen Vorrat an Fitness-Fotos.
// ZENTRALES CACHING (skaliert bei vielen Nutzern): der Vorrat wird in der Tabelle photo_cache
// gespeichert und nur ~1×/Woche bei Pexels neu geholt – alle Nutzer bekommen den Cache. Die
// Tabelle ist OPTIONAL: fehlt sie, holt die Funktion einfach direkt von Pexels (Client cached dann).
//
// Benötigtes Secret:  PEXELS_KEY
// Optional (für Server-Cache):  supabase-photo.sql ausführen (Tabelle public.photo_cache)
// Deploy:  supabase functions deploy photo-proxy --project-ref ocnlrxmosbbtsczjyvxb --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, 'content-type': 'application/json' } });
}
const QUERIES = ['running outdoor', 'cycling', 'yoga', 'hiking mountains', 'fitness workout', 'trail running sunrise', 'swimming', 'strength training gym'];
const MAX_AGE = 7 * 86400000;   // 7 Tage Server-Cache

async function fetchPexels(KEY: string) {
  const photos: any[] = [], seen = new Set<string>();
  const qs = QUERIES.slice().sort(() => Math.random() - 0.5).slice(0, 3);
  for (const q of qs) {
    try {
      const r = await fetch('https://api.pexels.com/v1/search?orientation=landscape&per_page=12&query=' + encodeURIComponent(q), { headers: { Authorization: KEY } });
      if (!r.ok) continue;
      const d = await r.json();
      (d.photos || []).forEach((p: any) => {
        const u = p.src && (p.src.landscape || p.src.large);
        if (u && !seen.has(u)) { seen.add(u); photos.push({ url: u, alt: p.alt || 'Fitness & Bewegung', credit: p.photographer || '', creditUrl: p.url || '' }); }
      });
    } catch (_e) { /* Query übersprungen */ }
  }
  return photos.slice(0, 24);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const KEY = Deno.env.get('PEXELS_KEY');

  // Nur angemeldete Nutzer.
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'auth_required' }, 401);
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
  const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  if (!KEY) return json({ error: 'not_configured' }, 500);
  const userClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
  const { data: ures, error: uerr } = await userClient.auth.getUser();
  if (uerr || !ures?.user) return json({ error: 'auth_invalid' }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE);

  // 1) Server-Cache lesen (falls Tabelle existiert & frisch)
  let cached: any[] | null = null;
  try {
    const { data } = await admin.from('photo_cache').select('data,updated_at').eq('key', 'fit_heroes').maybeSingle();
    if (data && data.data && Array.isArray(data.data.photos) && (Date.now() - new Date(data.updated_at).getTime() < MAX_AGE)) cached = data.data.photos;
  } catch (_e) { /* Tabelle fehlt → ohne Server-Cache weiter */ }
  if (cached && cached.length) return json({ ok: true, photos: cached, cached: true });

  // 2) Frisch von Pexels holen + (falls möglich) cachen
  const pool = await fetchPexels(KEY);
  if (!pool.length) return json({ error: 'pexels_error' }, 502);
  try { await admin.from('photo_cache').upsert({ key: 'fit_heroes', data: { photos: pool }, updated_at: new Date().toISOString() }); } catch (_e) { /* kein Cache-Table → egal */ }
  return json({ ok: true, photos: pool, cached: false }, 200);
});
