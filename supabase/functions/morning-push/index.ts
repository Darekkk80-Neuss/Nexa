// Effyra – Morgen-Briefing-Push (per Cron, serverseitig)
// Wird täglich von pg_cron aufgerufen und schickt allen Geräten mit dem Opt-in
// (push_subscriptions.morning = true) einen generischen „Guten Morgen"-Push.
// Der eigentliche, personalisierte Tagesüberblick wird beim Öffnen der App
// clientseitig aus den lokalen Daten berechnet (local-first / Datenschutz).
//
// Sicherheit: fail-closed – nur mit korrektem CRON_SECRET-Header ausführbar.
// Deploy:  supabase functions deploy morning-push --no-verify-jwt
//
// Benötigte Secrets (supabase secrets set ...):
//   CRON_SECRET     (geteimes Geheimnis, identisch im pg_cron-Aufruf)
//   VAPID_PUBLIC, VAPID_PRIVATE, VAPID_SUBJECT (wie bei push-send)
// Automatisch vorhanden: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';
import { chunk, pageAll, pMap, withFallback } from '../_shared/util.ts';

function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  // Fail-closed: ohne gesetztes & passendes Secret keine Ausführung.
  const secret = Deno.env.get('CRON_SECRET');
  if (!secret || req.headers.get('x-cron-secret') !== secret) return json({ error: 'forbidden' }, 403);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC');
  const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE');
  const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:info@gonsoft-labs.de';
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return json({ error: 'push_not_configured' }, 500);

  const admin = createClient(SUPABASE_URL, SERVICE);
  let subs: any[];
  try {
    subs = await pageAll(() => admin
      .from('push_subscriptions')
      .select('user_id,endpoint,sub')
      .eq('morning', true));
  } catch (e: any) { return json({ error: 'db_error', detail: String(e?.message || e) }, 500); }
  if (!subs.length) return json({ ok: true, sent: 0 }, 200);

  (webpush as any).setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

  // Sprache je Empfänger aus user_state. Nur das Sprachfeld selbst holen – der
  // volle data-Blob wäre hier ein Vielfaches an Übertragung für zwei Buchstaben.
  const uids = [...new Set(subs.map((s) => s.user_id))];
  const langBy = new Map<string, string>();
  try {
    await pMap(chunk(uids, 300), 4, async (part) => {
      const states = await withFallback(
        () => pageAll<any>(() => admin.from('user_state').select('user_id,lang:data->profile->>lang').in('user_id', part)),
        async () => (await pageAll<any>(() => admin.from('user_state').select('user_id,data').in('user_id', part)))
          .map((r) => ({ user_id: r.user_id, lang: r.data?.profile?.lang })),
      );
      for (const st of states) {
        if (typeof st.lang === 'string' && /^(de|en|fr|es|it|pl)$/.test(st.lang)) langBy.set(st.user_id, st.lang);
      }
    });
  } catch (_e) { /* Fallback de */ }
  const MSG: Record<string, { title: string; body: string }> = {
    de: { title: '☀️ Guten Morgen!', body: 'Dein Tagesüberblick wartet in Effyra – Termine, Aufgaben, Medikamente und Fristen auf einen Blick.' },
    en: { title: '☀️ Good morning!', body: 'Your daily overview is waiting in Effyra – appointments, tasks, medication and deadlines at a glance.' },
    fr: { title: '☀️ Bonjour !', body: 'Ton aperçu du jour t’attend dans Effyra – rendez-vous, tâches, médicaments et échéances en un coup d’œil.' },
    es: { title: '☀️ ¡Buenos días!', body: 'Tu resumen del día te espera en Effyra: citas, tareas, medicamentos y plazos de un vistazo.' },
    it: { title: '☀️ Buongiorno!', body: 'La tua panoramica del giorno ti aspetta in Effyra: appuntamenti, attività, farmaci e scadenze a colpo d’occhio.' },
    pl: { title: '☀️ Dzień dobry!', body: 'Twój przegląd dnia czeka w Effyrze – terminy, zadania, leki i terminy płatności w jednym miejscu.' },
  };
  const payloadFor = (uid: string) => {
    const m = MSG[langBy.get(uid) || 'de'] || MSG.de;
    return JSON.stringify({ title: m.title, body: m.body, tag: 'effyra-morning', url: './' });
  };

  // Zustellung nebenläufig (20 gleichzeitig). Sequenziell war das der harte
  // Deckel des Laufs: bei ~200 ms je Push reicht das Function-Limit sonst nur
  // für einige hundert Geräte, der Rest bekommt still nichts.
  const outcome = await pMap(subs, 20, async (s) => {
    try { await (webpush as any).sendNotification(s.sub, payloadFor(s.user_id)); return 'sent'; }
    catch (e: any) {
      const code = e?.statusCode;
      return (code === 404 || code === 410) ? s.endpoint : 'fail';   // Abo tot → Endpoint zum Aufräumen
    }
  });
  const sent = outcome.filter((o) => o === 'sent').length;
  const deadEps = outcome.filter((o) => o !== 'sent' && o !== 'fail') as string[];

  // Tote Abos gebündelt entfernen statt einzeln.
  for (const part of chunk(deadEps, 200)) {
    try { await admin.from('push_subscriptions').delete().in('endpoint', part); } catch (_e) { /* nächster Lauf */ }
  }
  return json({ ok: true, sent, dead: deadEps.length }, 200);
});
