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
    await admin.from('family_members').delete().eq('user_id', uid);
    // Vom Nutzer erstellte Familien: Mitglieder + Familie loesen (verwaiste Familie vermeiden)
    const { data: fams } = await admin.from('families').select('id').eq('created_by', uid);
    for (const f of fams || []) {
      await admin.from('family_child_codes').delete().eq('family_id', f.id);
      await admin.from('family_members').delete().eq('family_id', f.id);
      await admin.from('families').delete().eq('id', f.id);
    }
    await admin.from('photo_cache').delete().eq('user_id', uid);
    await admin.from('profiles').delete().eq('id', uid);

    // 2) Auth-Nutzer endgueltig loeschen
    const { error: delErr } = await admin.auth.admin.deleteUser(uid);
    if (delErr) return json({ ok: false, error: 'auth_delete_failed', detail: delErr.message }, 500);

    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: 'delete_error', detail: String(e) }, 500);
  }
});
