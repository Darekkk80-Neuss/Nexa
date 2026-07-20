// Effyra – Sanfte Erinnerung an überfällige, zugewiesene Familienaufgaben (per Cron)
// ---------------------------------------------------------------------------------
// Läuft STÜNDLICH (pg_cron), agiert aber nur, wenn es in Europa/Berlin gerade 9 Uhr ist
// (DST-sicher, kein Sommer-/Winter-Drift). Für jede überfällige, einer Person mit Konto
// zugewiesene, noch offene Familienaufgabe wird – gestaffelt nach Überfälligkeit
// (1 / 3 / 7 Tage) – ein FREUNDLICHER Push an die zuständige Person geschickt.
// Bewusst kein Nörgeln: nur an diesen drei Meilensteinen, und mehrere fällige Aufgaben
// einer Person werden zu EINER Nachricht zusammengefasst. Der Ton lädt zum bewussten
// Neu-Bewerten ein (verschieben/löschen), statt zu ermahnen.
//
// Datenschutz: Es werden nur bereits zum Sync freigegebene Familiendaten (families.data)
// und die Push-Abos gelesen; die eigentliche Verarbeitung bleibt serverseitig, es werden
// keine Inhalte protokolliert.
//
// Sicherheit: fail-closed – nur mit korrektem CRON_SECRET-Header ausführbar.
// Deploy:  supabase functions deploy overdue-reminder --no-verify-jwt
//
// Benötigte Secrets (supabase secrets set ...):
//   CRON_SECRET   (identisch zum pg_cron-Header)
//   VAPID_PUBLIC, VAPID_PRIVATE, VAPID_SUBJECT (wie bei push-send)
// Automatisch vorhanden: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';
import { chunk, pageAll, pMap, withFallback } from '../_shared/util.ts';

function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
}

// Datum als UTC-Mitternacht → taggenaue Differenzen, zeitzonenneutral.
function dayNum(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
}

const MILESTONES = [1, 3, 7];

// Eine/mehrere überfällige Aufgaben – freundliche Texte in der Sprache des Empfängers (profile.lang).
type Tpl = { title: string; body: (x: any) => string };
const SINGLE_L: Record<string, Record<number, Tpl>> = {
  de: {
    1: { title: '🌟 Sanfte Erinnerung', body: (t) => '„' + t + '“ von gestern ist noch offen. Vielleicht findest du heute einen passenden Moment dafür.' },
    3: { title: '💙 Ganz ohne Druck', body: (t) => '„' + t + '“ begleitet dich schon ein paar Tage. Falls es nicht mehr relevant ist, kannst du es auch löschen oder verschieben.' },
    7: { title: '🗂️ Kurzer Blick?', body: (t) => '„' + t + '“ ist schon länger offen. Vielleicht lohnt sich ein kurzer Blick, ob es noch aktuell ist.' },
  },
  en: {
    1: { title: '🌟 Gentle reminder', body: (t) => '“' + t + '” from yesterday is still open. Maybe you’ll find a good moment for it today.' },
    3: { title: '💙 No pressure', body: (t) => '“' + t + '” has been with you for a few days. If it’s no longer relevant, feel free to delete or reschedule it.' },
    7: { title: '🗂️ Quick look?', body: (t) => '“' + t + '” has been open for a while. Maybe it’s worth a quick look to see if it’s still current.' },
  },
  fr: {
    1: { title: '🌟 Petit rappel', body: (t) => '« ' + t + ' » d’hier est encore ouvert. Tu trouveras peut-être un bon moment aujourd’hui.' },
    3: { title: '💙 Sans pression', body: (t) => '« ' + t + ' » t’accompagne depuis quelques jours. Si ce n’est plus utile, supprime-le ou reporte-le.' },
    7: { title: '🗂️ Un coup d’œil ?', body: (t) => '« ' + t + ' » est ouvert depuis un moment. Un rapide coup d’œil vaut peut-être la peine.' },
  },
  es: {
    1: { title: '🌟 Recordatorio suave', body: (t) => '«' + t + '» de ayer sigue pendiente. Quizás hoy encuentres un buen momento.' },
    3: { title: '💙 Sin presión', body: (t) => '«' + t + '» te acompaña desde hace unos días. Si ya no es relevante, puedes borrarla o aplazarla.' },
    7: { title: '🗂️ ¿Un vistazo?', body: (t) => '«' + t + '» lleva un tiempo pendiente. Quizás valga la pena comprobar si sigue siendo actual.' },
  },
  it: {
    1: { title: '🌟 Promemoria gentile', body: (t) => '“' + t + '” di ieri è ancora aperta. Forse oggi trovi un momento adatto.' },
    3: { title: '💙 Senza fretta', body: (t) => '“' + t + '” ti accompagna da qualche giorno. Se non serve più, puoi eliminarla o rimandarla.' },
    7: { title: '🗂️ Un’occhiata?', body: (t) => '“' + t + '” è aperta da un po’. Forse vale un rapido controllo se è ancora attuale.' },
  },
  pl: {
    1: { title: '🌟 Delikatne przypomnienie', body: (t) => '„' + t + '” z wczoraj wciąż czeka. Może dziś znajdziesz na to chwilę.' },
    3: { title: '💙 Bez presji', body: (t) => '„' + t + '” towarzyszy Ci już kilka dni. Jeśli straciło aktualność, możesz je usunąć lub przełożyć.' },
    7: { title: '🗂️ Krótki rzut oka?', body: (t) => '„' + t + '” jest otwarte od dłuższego czasu. Może warto sprawdzić, czy wciąż jest aktualne.' },
  },
};
const MULTI_L: Record<string, Record<number, Tpl>> = {
  de: {
    1: { title: '🌟 Sanfte Erinnerung', body: (n) => n + ' Aufgaben von den letzten Tagen sind noch offen. Vielleicht findest du heute für eine davon einen Moment.' },
    3: { title: '💙 Ganz ohne Druck', body: (n) => n + ' Aufgaben begleiten dich schon eine Weile. Was nicht mehr passt, darfst du löschen oder verschieben.' },
    7: { title: '🗂️ Kurzer Blick?', body: (n) => n + ' Aufgaben sind schon länger offen. Ein kurzer Blick lohnt sich vielleicht, was davon noch aktuell ist.' },
  },
  en: {
    1: { title: '🌟 Gentle reminder', body: (n) => n + ' tasks from the last days are still open. Maybe you’ll find a moment for one of them today.' },
    3: { title: '💙 No pressure', body: (n) => n + ' tasks have been with you for a while. Whatever no longer fits, feel free to delete or reschedule.' },
    7: { title: '🗂️ Quick look?', body: (n) => n + ' tasks have been open for a while. A quick check which are still current might be worth it.' },
  },
  fr: {
    1: { title: '🌟 Petit rappel', body: (n) => n + ' tâches des derniers jours sont encore ouvertes. Peut-être un moment aujourd’hui pour l’une d’elles.' },
    3: { title: '💙 Sans pression', body: (n) => n + ' tâches t’accompagnent depuis un moment. Supprime ou reporte ce qui ne convient plus.' },
    7: { title: '🗂️ Un coup d’œil ?', body: (n) => n + ' tâches sont ouvertes depuis un moment. Un rapide tri vaut peut-être la peine.' },
  },
  es: {
    1: { title: '🌟 Recordatorio suave', body: (n) => n + ' tareas de los últimos días siguen pendientes. Quizás hoy haya un momento para una de ellas.' },
    3: { title: '💙 Sin presión', body: (n) => n + ' tareas te acompañan desde hace un tiempo. Lo que ya no encaje, bórralo o aplázalo.' },
    7: { title: '🗂️ ¿Un vistazo?', body: (n) => n + ' tareas llevan un tiempo pendientes. Quizás valga la pena revisar cuáles siguen siendo actuales.' },
  },
  it: {
    1: { title: '🌟 Promemoria gentile', body: (n) => n + ' attività degli ultimi giorni sono ancora aperte. Forse oggi trovi un momento per una di esse.' },
    3: { title: '💙 Senza fretta', body: (n) => n + ' attività ti accompagnano da un po’. Ciò che non serve più, puoi eliminarlo o rimandarlo.' },
    7: { title: '🗂️ Un’occhiata?', body: (n) => n + ' attività sono aperte da tempo. Forse vale un rapido controllo di cosa è ancora attuale.' },
  },
  pl: {
    1: { title: '🌟 Delikatne przypomnienie', body: (n) => n + ' zadań z ostatnich dni wciąż czeka. Może dziś znajdziesz chwilę na jedno z nich.' },
    3: { title: '💙 Bez presji', body: (n) => n + ' zadań towarzyszy Ci już jakiś czas. Co straciło aktualność, możesz usunąć lub przełożyć.' },
    7: { title: '🗂️ Krótki rzut oka?', body: (n) => n + ' zadań jest otwartych od dłuższego czasu. Może warto sprawdzić, które są wciąż aktualne.' },
  },
};

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  // Fail-closed: ohne gesetztes & passendes Secret keine Ausführung.
  const secret = Deno.env.get('CRON_SECRET');
  if (!secret || req.headers.get('x-cron-secret') !== secret) return json({ error: 'forbidden' }, 403);

  // Nur um 9 Uhr deutscher Zeit handeln. Cron feuert stündlich; ?force=1 nur zum Testen.
  const force = new URL(req.url).searchParams.get('force') === '1';
  let berlinHour = -1;
  try {
    berlinHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', hour12: false }).format(new Date()));
  } catch (_) { /* ICU sollte vorhanden sein */ }
  if (!force && berlinHour !== 9) return json({ ok: true, skipped: 'not_9am_berlin', berlinHour }, 200);

  // Heutiges Datum in Berlin (YYYY-MM-DD) für die Überfälligkeits-Berechnung.
  const todayIso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const today = dayNum(todayIso);
  if (today == null) return json({ error: 'date_error' }, 500);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC');
  const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE');
  const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:info@gonsoft-labs.de';
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return json({ error: 'push_not_configured' }, 500);

  const admin = createClient(SUPABASE_URL, SERVICE);

  // Familien + Push-Abos laden (Service-Role, umgeht RLS). Seitenweise, weil ein
  // nacktes select serverseitig bei max_rows abgeschnitten würde – ohne Fehler.
  // Aus dem Familien-Blob nur members/tasks holen; shopping/events/occasions
  // werden hier nie gelesen und machen den Löwenanteil der Größe aus.
  let fams: any[], allSubs: any[];
  try {
    fams = await withFallback(
      () => pageAll<any>(() => admin.from('families').select('members:data->members,tasks:data->tasks')),
      async () => (await pageAll<any>(() => admin.from('families').select('data')))
        .map((f) => ({ members: f.data?.members, tasks: f.data?.tasks })),
    );
    allSubs = await pageAll(() => admin.from('push_subscriptions').select('user_id,endpoint,sub'));
  } catch (e: any) { return json({ error: 'db_error', detail: String(e?.message || e) }, 500); }

  // Push-Abos nach user_id gruppieren.
  const subsByUser = new Map<string, any[]>();
  for (const s of allSubs) {
    if (!subsByUser.has(s.user_id)) subsByUser.set(s.user_id, []);
    subsByUser.get(s.user_id)!.push(s);
  }

  // Qualifizierende Aufgaben je zuständiger authId sammeln.
  //   perUser: authId -> { level (höchster erreichter Meilenstein), titles[] }
  const perUser = new Map<string, { level: number; titles: string[] }>();
  for (const f of fams) {
    const members = Array.isArray(f.members) ? f.members : [];
    const tasks = Array.isArray(f.tasks) ? f.tasks : [];
    const authById = new Map<string, string>();
    for (const m of members) { if (m && m.id && m.authId) authById.set(String(m.id), String(m.authId)); }
    for (const t of tasks) {
      if (!t || t.done || !t.assignee || !t.due) continue;         // nur offene, terminierte, zugewiesene Aufgaben
      const due = dayNum(String(t.due));
      if (due == null) continue;
      const overdue = Math.round((today - due) / 86400000);
      if (MILESTONES.indexOf(overdue) < 0) continue;               // ausschließlich an Tag 1 / 3 / 7
      // Zielperson: die/der Zuständige, sofern push-fähig; sonst die/der Erstellende (Manager, z. B. Elternteil).
      // t.by ist bereits eine authId (famSelfId), t.assignee eine Member-ID.
      const assigneeAuth = authById.get(String(t.assignee));
      let target = (assigneeAuth && subsByUser.has(assigneeAuth)) ? assigneeAuth : '';
      if (!target && t.by && subsByUser.has(String(t.by))) target = String(t.by);
      if (!target) continue;                                       // niemand mit Gerät → kein Push möglich
      const cur = perUser.get(target) || { level: 0, titles: [] };
      cur.titles.push(String(t.title || 'Aufgabe'));
      if (overdue > cur.level) cur.level = overdue;
      perUser.set(target, cur);
    }
  }

  (webpush as any).setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

  // Sprache je Empfänger aus user_state (profile.lang); Fallback Deutsch.
  const langBy = new Map<string, string>();
  try {
    const rids = [...perUser.keys()];
    // Nur das Sprachfeld, nicht den kompletten Zustands-Blob je Empfänger.
    await pMap(chunk(rids, 300), 4, async (part) => {
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

  // Erst alle Zustellungen bestimmen, dann nebenläufig senden (20 gleichzeitig).
  type Job = { sub: any; endpoint: string; payload: string };
  const jobs: Job[] = [];
  let users = 0;
  for (const [authId, info] of perUser) {
    const subs = subsByUser.get(authId);
    if (!subs || !subs.length) continue;
    const n = info.titles.length;
    const lvl = info.level;                                        // 1, 3 oder 7
    const lang = langBy.get(authId) || 'de';
    const spec = n === 1 ? (SINGLE_L[lang] || SINGLE_L.de)[lvl] : (MULTI_L[lang] || MULTI_L.de)[lvl];
    if (!spec) continue;
    const body = n === 1 ? (spec as any).body(info.titles[0]) : (spec as any).body(n);
    const payload = JSON.stringify({ title: spec.title, body, tag: 'effyra-overdue', url: './?fam=1' });
    users++;
    for (const s of subs) jobs.push({ sub: s.sub, endpoint: s.endpoint, payload });
  }

  const outcome = await pMap(jobs, 20, async (j) => {
    try { await (webpush as any).sendNotification(j.sub, j.payload); return 'sent'; }
    catch (e: any) {
      const code = e?.statusCode;
      return (code === 404 || code === 410) ? j.endpoint : 'fail';   // Abo tot → aufräumen
    }
  });
  const sent = outcome.filter((o) => o === 'sent').length;
  const deadEps = [...new Set(outcome.filter((o) => o !== 'sent' && o !== 'fail') as string[])];
  for (const part of chunk(deadEps, 200)) {
    try { await admin.from('push_subscriptions').delete().in('endpoint', part); } catch (_e) { /* nächster Lauf */ }
  }
  return json({ ok: true, users, sent, dead: deadEps.length, berlinHour }, 200);
});
