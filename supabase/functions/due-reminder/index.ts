// Effyra – Fälligkeits-Erinnerungen (per Cron, serverseitig)
//   • Termine (events mit Datum+Uhrzeit): ~30 Minuten vorher
//   • Aufgaben (tasks mit Fälligkeitsdatum, offen): am Fälligkeitstag ab 8 Uhr lokal
//
// Die eigentliche Auswahl passiert in der DATENBANK (RPC due_reminders, siehe
// supabase-due-check.sql). Diese Function verschickt nur noch, was von dort
// zurückkommt – typischerweise ein paar Dutzend Zeilen.
//
// Vorher lud sie die Aufgaben und Termine ALLER Nutzer mit Push-Abo in den
// Speicher einer einzigen Invocation. Edge Functions haben 256 MB und 2 s
// CPU-Zeit, beides nicht erhöhbar; bei rund 10.000 Push-Abos wäre das still
// ausgefallen. Jetzt ist die Nutzerzahl für diesen Job praktisch egal.
//
// Idempotenz liegt ebenfalls in der DB: due_reminders() trägt in reminder_log
// ein und liefert NUR die dabei neu angelegten Zeilen zurück.
//
// Sicherheit: fail-closed – nur mit korrektem CRON_SECRET-Header ausführbar.
// Deploy:  supabase functions deploy due-reminder --no-verify-jwt
// Benötigte Secrets: CRON_SECRET, VAPID_PUBLIC, VAPID_PRIVATE, VAPID_SUBJECT
// Automatisch vorhanden: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';
import { chunk, pageAll, pMap, reqId, safeErr } from '../_shared/util.ts';

function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
}

// Push-Texte in der Sprache des Empfängers (kommt als lang aus der DB).
const L: Record<string, Record<string, string>> = {
  soon:  { de: '⏰ Gleich: ', en: '⏰ Coming up: ', fr: '⏰ Bientôt : ', es: '⏰ Pronto: ', it: '⏰ Tra poco: ', pl: '⏰ Wkrótce: ' },
  at:    { de: 'Um ', en: 'At ', fr: 'À ', es: 'A las ', it: 'Alle ', pl: 'O ' },
  clock: { de: ' Uhr', en: '', fr: '', es: '', it: '', pl: '' },
  inMin: { de: ' · in etwa {n} Min.', en: ' · in about {n} min', fr: ' · dans env. {n} min', es: ' · en unos {n} min', it: ' · tra circa {n} min', pl: ' · za ok. {n} min' },
  dueT:  { de: '📋 Heute fällig', en: '📋 Due today', fr: '📋 À faire aujourd’hui', es: '📋 Vence hoy', it: '📋 In scadenza oggi', pl: '📋 Termin dziś' },
  event: { de: 'Termin', en: 'Appointment', fr: 'Rendez-vous', es: 'Cita', it: 'Appuntamento', pl: 'Termin' },
  task:  { de: 'Aufgabe', en: 'Task', fr: 'Tâche', es: 'Tarea', it: 'Attività', pl: 'Zadanie' },
};
const tr = (key: string, lang: string) => (L[key] && (L[key][lang] || L[key].de)) || '';

type Row = {
  user_id: string; rk: string; kind: string; lang: string;
  title: string; tm: string | null; note: string | null; minutes: number | null;
};

function buildPush(r: Row): { title: string; body: string } {
  const lang = r.lang || 'de';
  if (r.kind === 'event') {
    return {
      title: tr('soon', lang) + (r.title || tr('event', lang)),
      body: tr('at', lang) + (r.tm || '') + tr('clock', lang)
          + (r.note ? ' · ' + String(r.note).slice(0, 80) : '')
          + tr('inMin', lang).replace('{n}', String(r.minutes ?? 0)),
    };
  }
  return {
    title: tr('dueT', lang),
    body: (r.title || tr('task', lang)).replace(/^[🛒📝🔔]\s*/, '')
        + (r.tm ? ' · ' + r.tm + tr('clock', lang) : ''),
  };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  // Fail-closed: ohne gesetztes & passendes Secret keine Ausführung.
  const secret = Deno.env.get('CRON_SECRET');
  if (!secret || req.headers.get('x-cron-secret') !== secret) return json({ error: 'forbidden' }, 403);

  // Kennung dieses Laufs. Der Cron feuert im Minutentakt; ohne sie lässt sich
  // eine Fehlerzeile keinem Lauf zuordnen – und genau das braucht man, um
  // "heute früh kam keine Erinnerung an" nachzuvollziehen, ohne dafür
  // Empfänger-IDs zu protokollieren.
  const rid = reqId();

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC');
  const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE');
  const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:info@gonsoft-labs.de';
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return json({ error: 'push_not_configured' }, 500);

  // Bewusst VOR der RPC: alles zwischen der Vormerkung in reminder_log und dem
  // Versand ist ein Fenster, in dem Erinnerungen verloren gehen können.
  (webpush as any).setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

  const admin = createClient(SUPABASE_URL, SERVICE);

  // 1) Fällige Erinnerungen aus der DB holen. Der Aufruf trägt sie zugleich in
  //    reminder_log ein und gibt nur die neuen zurück.
  const { data, error } = await admin.rpc('due_reminders');
  if (error) {
    // Häufigster Fall: supabase-due-check.sql wurde noch nicht eingespielt.
    // safeErr kappt und maskiert: Postgres zitiert bei einem Constraint-Fehler
    // den auslösenden Datensatz mit, und rk besteht laut supabase-due-check.sql
    // aus Titel oder Notiz, sobald ein Eintrag keine id hat – hier landeten sonst
    // fremde Termintitel im Protokoll.
    console.error('due_reminders_failed', JSON.stringify({ rid, msg: safeErr(error) }));
    return json({ error: 'rpc_failed', detail: error.message, hint: 'supabase-due-check.sql im SQL-Editor ausfuehren' }, 500);
  }
  const rows = (data || []) as Row[];
  if (!rows.length) return json({ ok: true, due: 0, sent: 0 }, 200);

  // due_reminders() hat die Erinnerungen bereits als gesendet vorgemerkt.
  // Bricht ab hier etwas ab, MUSS das zurückgenommen werden – sonst überspringt
  // der nächste Lauf sie wegen des Log-Eintrags, und sie kommen nie an.
  const undo = async (list: Row[]) => {
    if (!list.length) return;
    try {
      const { error: undoErr } = await admin.rpc('due_reminders_undo', {
        p_user: list.map((r) => r.user_id),
        p_rk: list.map((r) => r.rk),
      });
      // .rpc() wirft bei Postgres-Fehlern NICHT, es liefert error zurück (dieselbe
      // Falle wie in claude-proxy). Bisher wurde der Rückgabewert verworfen, das
      // catch griff praktisch nie – und ausgerechnet dieser Fehlschlag ist der
      // teuerste: die Vormerkung in reminder_log bleibt stehen, der nächste Lauf
      // überspringt die Erinnerungen für immer, und niemand erfuhr davon.
      // Protokolliert wird die ANZAHL, nicht die Liste: user_id ist personen-
      // beziehbar und rk enthält bei Einträgen ohne id den Titel. Für die Frage
      // "ist etwas verloren gegangen und wie viel" genügt die Zahl.
      if (undoErr) console.error('undo_failed', JSON.stringify({ rid, lost: list.length, msg: safeErr(undoErr) }));
    } catch (e) { console.error('undo_threw', JSON.stringify({ rid, lost: list.length, msg: safeErr(e) })); }
  };

  // 2) Push-Abos NUR für die betroffenen Nutzer laden (nicht mehr alle).
  const uids = [...new Set(rows.map((r) => r.user_id))];
  const subsByUser = new Map<string, any[]>();
  try {
    await pMap(chunk(uids, 300), 4, async (part) => {
      const subs = await pageAll<any>(() => admin
        .from('push_subscriptions').select('user_id,endpoint,sub').in('user_id', part).order('endpoint'));
      for (const s of subs) {
        const list = subsByUser.get(s.user_id);
        if (list) list.push(s); else subsByUser.set(s.user_id, [s]);
      }
    });
  } catch (e: any) {
    await undo(rows);   // nichts verschickt → Vormerkung wieder entfernen
    return json({ error: 'db_error', detail: String(e?.message || e) }, 500);
  }

  // 3) Ein Zustell-Auftrag je (Erinnerung × Gerät), nebenläufig verschickt.
  //    key identifiziert die Erinnerung: rk allein reicht nicht, zwei Nutzer
  //    können denselben Schlüssel haben (gleicher Titel, gleiches Datum).
  const keyOf = (r: { user_id: string; rk: string }) => r.user_id + '|' + r.rk;
  type Job = { key: string; sub: any; endpoint: string; payload: string };
  const jobs: Job[] = [];
  for (const r of rows) {
    const msg = buildPush(r);
    const payload = JSON.stringify({ title: msg.title, body: msg.body, tag: 'effyra-due', url: './' });
    for (const s of (subsByUser.get(r.user_id) || [])) jobs.push({ key: keyOf(r), sub: s.sub, endpoint: s.endpoint, payload });
  }

  const outcome = await pMap(jobs, 20, async (j) => {
    try { await (webpush as any).sendNotification(j.sub, j.payload); return 'sent'; }
    catch (e: any) {
      const code = e?.statusCode;
      return (code === 404 || code === 410) ? j.endpoint : 'fail';   // totes Abo → aufräumen
    }
  });
  const sent = outcome.filter((o) => o === 'sent').length;

  // Erinnerungen, die KEIN Gerät erreicht haben, wieder freigeben – sonst
  // gelten sie als gesendet und der nächste Lauf überspringt sie für immer.
  // Betrifft zwei Fälle: gar kein Abo mehr vorhanden (etwa weil ein paralleler
  // Lauf das letzte tote Abo geräumt hat) und Zustellung an allen Geräten
  // fehlgeschlagen. Nach Ablauf des Fälligkeitsfensters hört das von selbst auf.
  const delivered = new Set<string>();
  outcome.forEach((o, i) => { if (o === 'sent') delivered.add(jobs[i].key); });
  await undo(rows.filter((r) => !delivered.has(keyOf(r))));
  const deadEps = [...new Set(outcome.filter((o) => o !== 'sent' && o !== 'fail') as string[])];
  for (const part of chunk(deadEps, 200)) {
    try { await admin.from('push_subscriptions').delete().in('endpoint', part); } catch { /* nächster Lauf */ }
  }

  // 4) Aufräumen: Log-Einträge älter als 30 Tage entfernen.
  try { await admin.from('reminder_log').delete().lt('sent_at', new Date(Date.now() - 30 * 864e5).toISOString()); } catch { /* egal */ }

  return json({ ok: true, due: rows.length, sent, dead: deadEps.length }, 200);
});
