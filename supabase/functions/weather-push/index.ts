// Effyra – Unwetter-Push (Supabase Edge Function, per Cron)
// ----------------------------------------------------------------------------
// Prüft für jedes Gerät mit aktiviertem Warn-Push (push_subscriptions.warn = true)
// die amtlichen DWD-Warnungen (Bright Sky) für den gespeicherten Standort und
// sendet NUR bei einer NEUEN Warnung einen Push – auch bei geschlossener App.
//
// EINRICHTUNG:
//   1) Spalten ergänzen (einmalig, SQL-Editor):
//        alter table public.push_subscriptions add column if not exists warn boolean default false;
//        alter table public.push_subscriptions add column if not exists warn_lat double precision;
//        alter table public.push_subscriptions add column if not exists warn_lon double precision;
//        alter table public.push_subscriptions add column if not exists warn_last text;
//   2) Secrets: VAPID_PUBLIC, VAPID_PRIVATE, VAPID_SUBJECT (wie push-send) sind bereits gesetzt.
//   3) Deploy:  supabase functions deploy weather-push --no-verify-jwt
//   4) Cron (z. B. alle 30 Min) in Supabase → Database → Cron/pg_cron ODER ein
//      externer Scheduler, der diese Function-URL aufruft.
// ----------------------------------------------------------------------------
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';
import { fetchT, pageAll, pMap } from '../_shared/util.ts';

const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });

// Standorte auf ~100 m runden → Geräte am selben Ort teilen sich EINEN Bright-Sky-Abruf.
// Amtliche Warnungen gelten kreisweit; feinere Auflösung brächte keine anderen Treffer.
const locKey = (lat: number, lon: number) => lat.toFixed(2) + ',' + lon.toFixed(2);

Deno.serve(async (req) => {
  // Fail-closed wie bei den anderen Cron-Functions. Vorher nahm diese Function
  // gar keinen Request entgegen und prüfte nichts – mit --no-verify-jwt deployt
  // war sie damit ein offener Endpunkt: jeder Aufruf las die gesamte Abo-Tabelle,
  // feuerte Bright-Sky-Abrufe und verschickte Pushes, auf Betreiberkosten.
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const secret = Deno.env.get('CRON_SECRET');
  if (!secret || req.headers.get('x-cron-secret') !== secret) return json({ error: 'forbidden' }, 403);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC');
  const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE');
  const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:info@gonsoft-labs.de';
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return json({ error: 'push_not_configured' }, 500);
  (webpush as any).setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

  const admin = createClient(SUPABASE_URL, SERVICE);
  let subs: any[];
  try {
    subs = await pageAll(() => admin
      .from('push_subscriptions')
      .select('endpoint,sub,warn_lat,warn_lon,warn_last')
      .eq('warn', true));
  } catch (e: any) { return json({ error: 'db', detail: String(e?.message || e) }, 500); }

  const SEV = new Set(['moderate', 'severe', 'extreme']);   // reine 'minor'-Hinweise nicht pushen
  const ICON: Record<string, string> = { moderate: '⚠️', severe: '⛈️', extreme: '🚨' };

  // 1) Abos nach Standort bündeln – aus N Abos werden M Standorte (M ≪ N).
  const byLoc = new Map<string, any[]>();
  for (const s of subs) {
    if (s.warn_lat == null || s.warn_lon == null) continue;
    const k = locKey(s.warn_lat, s.warn_lon);
    const list = byLoc.get(k);
    if (list) list.push(s); else byLoc.set(k, [s]);
  }
  const checked = [...byLoc.values()].reduce((n, l) => n + l.length, 0);

  // 2) Je Standort EIN Bright-Sky-Abruf, bis zu 8 gleichzeitig, mit Timeout.
  const locs = [...byLoc.keys()];
  const alertByLoc = await pMap(locs, 8, async (k) => {
    const [lat, lon] = k.split(',');
    try {
      const r = await fetchT('https://api.brightsky.dev/alerts?lat=' + lat + '&lon=' + lon, {}, 10000);
      if (!r.ok) return null;
      const d: any = await r.json();
      const alerts = ((d && d.alerts) || []).filter((a: any) => SEV.has(String(a.severity || '').toLowerCase()));
      return alerts.length ? alerts[0] : null;
    } catch (_e) { return null; }   // Zeitüberschreitung/Ausfall → dieser Standort entfällt still
  });

  // 3) Zustellungen sammeln (nur wirklich neue Warnungen) und nebenläufig senden.
  type Job = { sub: any; endpoint: string; key: string; payload: string };
  const jobs: Job[] = [];
  locs.forEach((k, i) => {
    const a = alertByLoc[i];
    if (!a) return;
    const key = (a.id || a.event_de || 'w') + '|' + (a.expires || '');
    const payload = JSON.stringify({
      title: (ICON[String(a.severity).toLowerCase()] || '⚠️') + ' ' + (a.event_de || a.event_en || 'Unwetterwarnung'),
      body: String(a.headline_de || a.description_de || 'Amtliche Warnung des Deutschen Wetterdienstes.').slice(0, 180),
      url: '/',
    });
    for (const s of byLoc.get(k)!) {
      if (s.warn_last === key) continue;   // bereits gepusht → nichts tun
      jobs.push({ sub: s.sub, endpoint: s.endpoint, key, payload });
    }
  });

  const okByKey = new Map<string, string[]>();   // Warn-Schlüssel → erfolgreich belieferte Endpoints
  const results = await pMap(jobs, 20, async (j) => {
    try { await (webpush as any).sendNotification(j.sub, j.payload); return j; }
    catch (_e) { return null; }   // ungültiges Abo o. Ä. → überspringen
  });
  for (const j of results) {
    if (!j) continue;
    const list = okByKey.get(j.key);
    if (list) list.push(j.endpoint); else okByKey.set(j.key, [j.endpoint]);
  }

  // 4) warn_last gebündelt fortschreiben: ein UPDATE je Warnung statt je Gerät.
  await pMap([...okByKey.entries()], 5, async ([key, endpoints]) => {
    try { await admin.from('push_subscriptions').update({ warn_last: key }).in('endpoint', endpoints); } catch (_e) { /* nächster Lauf holt es nach */ }
  });

  const sent = results.filter(Boolean).length;
  return json({ ok: true, checked, locations: locs.length, sent });
});
