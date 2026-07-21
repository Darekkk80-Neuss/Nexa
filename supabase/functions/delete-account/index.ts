// Effyra – Konto- & Datenlöschung (Supabase Edge Function) — Art. 17 DSGVO
// ----------------------------------------------------------------------------
// Löscht das Konto des AUFRUFENDEN Nutzers (per JWT identifiziert) samt seiner
// personenbezogenen Daten und anschliessend den Auth-Nutzer selbst.
//
// Aufruf: POST mit Supabase-JWT im Authorization-Header (vom Client, Einstellungen
//         → "Konto endgültig löschen").
//
// Deploy: supabase functions deploy delete-account
// (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY sind automatisch vorhanden.)
// ----------------------------------------------------------------------------
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeErr } from '../_shared/util.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'content-type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(SUPABASE_URL, SERVICE);

  // Zwei Wege hierher:
  //  1. Der Nutzer selbst, per JWT (Einstellungen → "Konto endgültig löschen").
  //  2. Die Aufräumung inaktiver Konten (account-cleanup), die sich mit dem
  //     CRON_SECRET ausweist und die betroffene Kennung im Rumpf mitschickt.
  // Der zweite Weg existiert, damit die Löschfrist nach Art. 5 Abs. 1 lit. e
  // exakt dieselbe geprüfte Abbaureihenfolge nutzt wie die Löschung auf
  // Wunsch – zwei Kopien derselben Logik wären die sichere Quelle für
  // Abweichungen.
  let uid: string | undefined;
  const cronSecret = Deno.env.get('CRON_SECRET') || '';
  const mitgebracht = req.headers.get('x-cron-secret') || '';
  if (cronSecret && mitgebracht && mitgebracht === cronSecret) {
    const body = await req.json().catch(() => ({}));
    uid = typeof body?.user_id === 'string' ? body.user_id : undefined;
    if (!uid) return json({ error: 'no_user_id' }, 400);
  } else {
    const jwt = (req.headers.get('authorization') || '').replace('Bearer ', '');
    if (!jwt) return json({ error: 'no_auth' }, 401);
    const { data: u } = await admin.auth.getUser(jwt);
    uid = u?.user?.id;
    if (!uid) return json({ error: 'invalid_user' }, 401);
  }

  try {
    // 1) Personenbezogene Zeilen des Nutzers entfernen (service_role umgeht RLS)
    // Jeden Schritt auswerten. Vorher meldete die Function ok:true, ohne zu
    // pruefen, ob ueberhaupt etwas geloescht wurde – und der Client raeumte
    // daraufhin den lokalen Speicher. Bei einer Loeschung nach Art. 17 ist eine
    // unbelegte Erfolgsmeldung das Schlimmste, was passieren kann.
    const { error: psErr } = await admin.from('push_subscriptions').delete().eq('user_id', uid);
    if (psErr) return json({ ok: false, error: 'push_delete_failed', detail: psErr.message }, 500);
    const { error: usErr } = await admin.from('user_state').delete().eq('user_id', uid);
    if (usErr) return json({ ok: false, error: 'state_delete_failed', detail: usErr.message }, 500);

    // Familien, in denen der Nutzer nur MITGLIED ist: seinen Personenbezug aus
    // dem gemeinsamen Blob entfernen, bevor die Mitgliedschaft gelöscht wird.
    // Vorher blieben Name, Geburtsdatum und die von ihm angelegten Einträge
    // unbefristet in families.data stehen – Art. 17 DSGVO war damit nicht
    // erfüllt, und nach dem Löschen der Mitgliedschaft war die Zeile nicht
    // einmal mehr auffindbar.
    // Der Lesevorgang MUSS ausgewertet werden: faellt er aus, ist mine null, kein
    // einziger Scrub laeuft, und die Mitgliedschaft wird trotzdem geloescht –
    // Name und Geburtsdatum blieben unauffindbar im Blob stehen.
    const { data: mine, error: mineErr } = await admin
      .from('family_members').select('family_id').eq('user_id', uid);
    if (mineErr) return json({ ok: false, error: 'members_read_failed', detail: mineErr.message }, 500);
    try {
      for (const m of mine || []) {
        // Nur die Existenz pruefen – der data-Blob wird hier nicht gebraucht.
        const { data: fam, error: famErr } = await admin
          .from('families').select('id').eq('id', m.family_id).maybeSingle();
        // Nur eine bestaetigt NICHT vorhandene Familie darf uebersprungen werden.
        // Bei einem Lesefehler ist fam ebenfalls null – der Scrub fiele still aus
        // und Name und Geburtsdatum blieben im Blob stehen.
        if (famErr) return json({ ok: false, error: 'family_read_failed', detail: famErr.message }, 500);
        if (!fam) continue;
        const { error: scrubErr } = await admin.rpc('scrub_member_from_family', { p_fid: m.family_id, p_user: uid });
        // .rpc() wirft bei Postgres-Fehlern NICHT. Bisher wurde der Rückgabewert
        // verworfen, ein Fehlschlag blieb damit voellig unsichtbar – und die
        // naechste Zeile loescht danach die Mitgliedschaft, sodass Name und
        // Geburtsdatum unauffindbar in families.data zurueckbleiben. Genau der
        // Schaden, den der Kommentar weiter oben als behoben beschreibt.
        // Protokolliert wird die family_id, NICHT die uid: die uid ist das Datum,
        // das dieser Loeschauftrag gerade beseitigen soll, und ueberlebte im
        // Protokoll ausgerechnet die Loeschung. Die family_id bleibt ohnehin in
        // der Datenbank und ist die einzige Angabe, mit der sich der Rest von
        // Hand entfernen laesst.
        if (scrubErr) {
          console.error('scrub_failed', JSON.stringify({ fid: m.family_id, msg: safeErr(scrubErr) }));
          // ABBRECHEN, nicht nur protokollieren. Die Mitgliedschaft darf erst
          // fallen, wenn der Blob nachweislich sauber ist – sonst bestaetigt die
          // Function eine Loeschung, die gar nicht stattgefunden hat.
          return json({ ok: false, error: 'scrub_failed' }, 500);
        }
      }
    } catch (e) {
      console.error('scrub_threw', JSON.stringify({ msg: safeErr(e) }));
      return json({ ok: false, error: 'scrub_failed' }, 500);
    }

    /* Plan raeumen, BEVOR die Mitgliedschaft faellt: war der Loeschende der
       Zahler, blieben plan/plan_until/plan_by sonst stehen – die Familie waere
       bis zum Ablauf weiter Premium, und derselbe Kauf koennte ueber
       sync_play_expiry die naechste Familie freischalten. Gleiche Bereinigung
       wie bei leave_family und join_family. */
    // Mitgliedschaften MERKEN, dann loeschen, DANN raeumen – in dieser
    // Reihenfolge, wie in leave_family. release_family ruft
    // recompute_family_seats_fid, und das zaehlt ueber family_members: stuende
    // der Austretende dort noch, wuerden SEINE Add-on-Sitze der Familie
    // weiterhin zugerechnet.
    // Auch hier auswerten: mit leerer Liste liefe kein release_family, und der
    // Plan des Zahlers bliebe stehen – dieselbe Familie waere weiter Premium.
    const { data: mine2, error: mine2Err } = await admin
      .from('family_members').select('family_id').eq('user_id', uid);
    if (mine2Err) return json({ ok: false, error: 'members_read_failed', detail: mine2Err.message }, 500);
    const meineFamilien: any[] = mine2 || [];

    const { error: memErr } = await admin.from('family_members').delete().eq('user_id', uid);
    if (memErr) return json({ ok: false, error: 'members_delete_failed', detail: memErr.message }, 500);

    for (const m of meineFamilien) {
      const { error: relErr } = await admin.rpc('release_family', { p_fid: m.family_id, p_user: uid });
      if (relErr) console.error('release_failed', JSON.stringify({ msg: safeErr(relErr) }));
    }

    // Vom Nutzer erstellte Familien: nur löschen, wenn NIEMAND sonst mehr drin
    // ist. Vorher wurde die Familie samt aller Daten von Partner und Kindern
    // mitgelöscht, nur weil der Ersteller sein Konto aufgab.
    const { data: fams, error: famsErr } = await admin.from('families').select('id').eq('created_by', uid);
    if (famsErr) return json({ ok: false, error: 'families_read_failed', detail: famsErr.message }, 500);
    for (const f of fams || []) {
      const { count, error: cntErr } = await admin
        .from('family_members').select('user_id', { count: 'exact', head: true })
        .eq('family_id', f.id).neq('role', 'child');   // Kinder allein halten keine Familie am Leben
      // Bei einem Fehler ist count null. Das als "leer" zu werten wuerde die
      // Familie samt aller Partner- und Kinderdaten loeschen – im Zweifel behalten.
      if (cntErr || count == null || count > 0) {
        // Andere nutzen sie weiter → nur die Urheberschaft lösen (FK ist ON DELETE SET NULL).
        const { error: upErr } = await admin.from('families').update({ created_by: null }).eq('id', f.id);
        // Bleibt created_by stehen, zeigt die Familie weiter auf ein geloeschtes
        // Konto – der FK ist ON DELETE SET NULL, aber nur wenn das Update greift.
        if (upErr) return json({ ok: false, error: 'family_detach_failed', detail: upErr.message }, 500);
        continue;
      }
      const { error: ccErr } = await admin.from('family_child_codes').delete().eq('family_id', f.id);
      if (ccErr) return json({ ok: false, error: 'child_codes_delete_failed', detail: ccErr.message }, 500);
      // Auswerten: schlaegt das fehl, bliebe der gesamte families.data-Blob mit
      // Aufgaben, Terminen und Mitgliedsangaben stehen – und die Function
      // meldete trotzdem ok:true.
      const { error: fdErr } = await admin.from('families').delete().eq('id', f.id);
      if (fdErr) return json({ ok: false, error: 'family_delete_failed', detail: fdErr.message }, 500);
    }

    // photo_cache hat KEINE user_id (nur key/data/updated_at) – der frühere
    // Aufruf lief ins Leere. Die Tabelle enthält reine Pexels-Fotos ohne
    // Personenbezug, es gibt hier also nichts zu löschen.
    const { error: prErr } = await admin.from('profiles').delete().eq('id', uid);
    if (prErr) return json({ ok: false, error: 'profile_delete_failed', detail: prErr.message }, 500);

    // 2) Auth-Nutzer endgueltig loeschen
    const { error: delErr } = await admin.auth.admin.deleteUser(uid);
    if (delErr) return json({ ok: false, error: 'auth_delete_failed', detail: delErr.message }, 500);

    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: 'delete_error', detail: String(e) }, 500);
  }
});
