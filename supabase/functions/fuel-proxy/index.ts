// Effyra – Spritpreis-Proxy (Supabase Edge Function) — Tankerkönig
// ----------------------------------------------------------------------------
// Hält den Tankerkönig-API-Key serverseitig (nie im Client) und liefert die
// günstigste Tankstelle je Kraftstoff (E5/E10/Diesel) im Umkreis.
//
// EINRICHTUNG (einmalig):
//   1) Kostenlosen Key holen: https://creativecommons.tankerkoenig.de  (Abschnitt „API-Key")
//   2) In Supabase setzen:  supabase secrets set TANKERKOENIG_KEY='<dein-key>'
//   3) Deployen:            supabase functions deploy fuel-proxy
//   Danach zeigt das Dashboard-Widget „Spritpreise" automatisch echte Preise.
//
// Datenquelle: Tankerkönig, Lizenz CC BY 4.0 (Namensnennung im Widget vorhanden).
// ----------------------------------------------------------------------------
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'content-type': 'application/json' } });

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { fetchT } from '../_shared/util.ts';

const KEY = Deno.env.get('TANKERKOENIG_KEY') || '';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405);

  // Nur angemeldete Nutzer. Die Plattform-Prüfung (verify_jwt) reicht hier NICHT:
  // sie akzeptiert auch den Anon-Key, und der steht öffentlich im Client. Ohne
  // diesen Block war der Endpunkt faktisch offen und verbrannte das
  // Tankerkönig-Kontingent. Gleiches Muster wie in nutrition-/photo-proxy.
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ ok: false, error: 'auth_required' }, 401);
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: `Bearer ${jwt}` } } },
  );
  const { data: ures, error: uerr } = await userClient.auth.getUser();
  if (uerr || !ures?.user) return json({ ok: false, error: 'auth_invalid' }, 401);

  if (!KEY) return json({ ok: false, error: 'not_configured' }, 200);   // Widget zeigt dann „einrichten"

  try {
    const { lat, lng, rad } = await req.json();
    if (typeof lat !== 'number' || typeof lng !== 'number') return json({ ok: false, error: 'bad_params' }, 400);
    const r = Math.min(Math.max(Number(rad) || 5, 1), 25);
    const url = 'https://creativecommons.tankerkoenig.de/json/list.php?lat=' + lat + '&lng=' + lng +
      '&rad=' + r + '&sort=dist&type=all&apikey=' + KEY;
    const res = await fetchT(url, {}, 10000);
    const j = await res.json().catch(() => ({}));
    if (!j || !j.ok || !Array.isArray(j.stations)) return json({ ok: false, error: 'upstream' }, 200);

    // Günstigste offene Station je Kraftstoff bestimmen (inkl. Adresse zur Zuordnung)
    const cheapest = (fuel: string) => {
      let best: any = null;
      for (const s of j.stations) {
        const p = s[fuel];
        if (typeof p === 'number' && p > 0 && (s.isOpen !== false)) {
          if (!best || p < best.price) best = {
            name: s.name, brand: s.brand, price: p, dist: s.dist,
            street: s.street, houseNumber: s.houseNumber, place: s.place, postCode: s.postCode,
          };
        }
      }
      return best;
    };
    return json({ ok: true, e5: cheapest('e5'), e10: cheapest('e10'), diesel: cheapest('diesel') });
  } catch (e) {
    return json({ ok: false, error: 'proxy_error' }, 200);
  }
});
