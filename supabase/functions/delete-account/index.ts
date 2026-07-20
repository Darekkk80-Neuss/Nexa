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
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
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

  // Aufrufer aus dem JWT bestimmen
  const jwt = (req.headers.get('authorization') || '').replace('Bearer ', '');
  if (!jwt) return json({ error: 'no_auth' }, 401);
  const { data: u } = await admin.auth.getUser(jwt);
  const uid = u?.user?.id;
  if (!uid) return json({ error: 'invalid_user' }, 401);

  try {
    // 1) Personenbezogene Zeilen des Nutzers entfernen (service_role umgeht RLS)
    await admin.from('push_subscriptions').delete().eq('user_id', uid);
    await admin.from('user_state').delete().eq('user_id', uid);

    // Familien, in denen der Nutzer nur MITGLIED ist: seinen Personenbezug aus
    // dem gemeinsamen Blob entfernen, bevor die Mitgliedschaft gelöscht wird.
    // Vorher blieben Name, Geburtsdatum und die von ihm angelegten Einträge
    // unbefristet in families.data stehen – Art. 17 DSGVO war damit nicht
    // erfüllt, und nach dem Löschen der Mitgliedschaft war die Zeile nicht
    // einmal mehr auffindbar.
    try {
      const { data: mine } = await admin
        .from('family_members').select('family_id').eq('user_id', uid);
      for (const m of mine || []) {
        // Nur die Existenz pruefen – der data-Blob wird hier nicht gebraucht.
        const { data: fam } = await admin
          .from('families').select('id').eq('id', m.family_id).maybeSingle();
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
        if (scrubErr) console.error('scrub_failed', JSON.stringify({ fid: m.family_id, msg: safeErr(scrubErr) }));
      }
    } catch (e) { console.error('scrub_threw', JSON.stringify({ msg: safeErr(e) })); }

    await admin.from('family_members').delete().eq('user_id', uid);

    // Vom Nutzer erstellte Familien: nur löschen, wenn NIEMAND sonst mehr drin
    // ist. Vorher wurde die Familie samt aller Daten von Partner und Kindern
    // mitgelöscht, nur weil der Ersteller sein Konto aufgab.
    const { data: fams } = await admin.from('families').select('id').eq('created_by', uid);
    for (const f of fams || []) {
      const { count, error: cntErr } = await admin
        .from('family_members').select('user_id', { count: 'exact', head: true }).eq('family_id', f.id);
      // Bei einem Fehler ist count null. Das als "leer" zu werten wuerde die
      // Familie samt aller Partner- und Kinderdaten loeschen – im Zweifel behalten.
      if (cntErr || count == null || count > 0) {
        // Andere nutzen sie weiter → nur die Urheberschaft lösen (FK ist ON DELETE SET NULL).
        await admin.from('families').update({ created_by: null }).eq('id', f.id);
        continue;
      }
      await admin.from('family_child_codes').delete().eq('family_id', f.id);
      await admin.from('families').delete().eq('id', f.id);
    }

    // photo_cache hat KEINE user_id (nur key/data/updated_at) – der frühere
    // Aufruf lief ins Leere. Die Tabelle enthält reine Pexels-Fotos ohne
    // Personenbezug, es gibt hier also nichts zu löschen.
    await admin.from('profiles').delete().eq('id', uid);

    // 2) Auth-Nutzer endgueltig loeschen
    const { error: delErr } = await admin.auth.admin.deleteUser(uid);
    if (delErr) return json({ ok: false, error: 'auth_delete_failed', detail: delErr.message }, 500);

    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: 'delete_error', detail: String(e) }, 500);
  }
});
