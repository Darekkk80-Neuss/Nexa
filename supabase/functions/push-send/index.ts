// Effyra – Web-Push senden (Supabase Edge Function)
// Der Sender ruft diese Funktion mit seinem JWT auf; sie schickt eine
// System-Benachrichtigung an das/​die Gerät(e) des Empfängers – auch wenn dessen
// App geschlossen ist. Sicherheit: Sender & Empfänger müssen dieselbe Familie teilen.
//
// Benötigte Secrets (supabase secrets set ...):
//   VAPID_PUBLIC    (öffentlicher VAPID-Schlüssel, base64url)
//   VAPID_PRIVATE   (privater VAPID-Schlüssel, base64url)
//   VAPID_SUBJECT   (optional, z. B. mailto:du@example.com)
// Automatisch vorhanden: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, 'content-type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'auth_required' }, 401);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
  const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC');
  const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE');
  const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:info@gonsoft-labs.de';
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return json({ error: 'push_not_configured' }, 500);

  // Sender aus dem JWT
  const userClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
  const { data: ures, error: uerr } = await userClient.auth.getUser();
  if (uerr || !ures?.user) return json({ error: 'auth_invalid' }, 401);
  const sender = ures.user.id;

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }

  // Morgen-Briefing-Opt-in des Senders setzen (Service-Role → zuverlässig, umgeht Spaltenrechte/RLS).
  if (body && typeof body.setMorning !== 'undefined') {
    const admin2 = createClient(SUPABASE_URL, SERVICE);
    const { error: e2 } = await admin2.from('push_subscriptions').update({ morning: !!body.setMorning }).eq('user_id', sender);
    if (e2) return json({ error: 'update_failed', detail: e2.message }, 500);
    return json({ ok: true, morning: !!body.setMorning }, 200);
  }

  const toUserId = String(body?.toUserId || '');
  if (!/^[0-9a-f-]{36}$/i.test(toUserId)) return json({ error: 'bad_request' }, 400);
  const isTest = body?.test === true;
  if (toUserId === sender && !isTest) return json({ ok: true, skipped: 'self' }, 200);   // Selbst-Push nur beim Test
  const title = String(body?.title || '👪 Neue Aufgabe für dich').slice(0, 80);
  const msg = String(body?.body || '').slice(0, 160);
  const tag = String(body?.tag || 'effyra-fam').slice(0, 60);

  const admin = createClient(SUPABASE_URL, SERVICE);

  // Sicherheit: nur innerhalb derselben Familie pushen
  const { data: mems } = await admin.from('family_members').select('user_id,family_id').in('user_id', [sender, toUserId]);
  const famOf = (uid: string) => (mems || []).filter((m: any) => m.user_id === uid).map((m: any) => m.family_id);
  const shared = famOf(sender).some((f: string) => famOf(toUserId).includes(f));
  if (toUserId !== sender && !shared) return json({ error: 'not_in_same_family' }, 403);   // Selbst-Test braucht keine Familie

  const { data: subs } = await admin.from('push_subscriptions').select('endpoint,sub').eq('user_id', toUserId);
  if (!subs || !subs.length) return json({ ok: true, sent: 0 }, 200);

  (webpush as any).setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  const payload = JSON.stringify({ title, body: msg, tag, url: './?fam=1' });

  let sent = 0;
  for (const s of subs as any[]) {
    try { await (webpush as any).sendNotification(s.sub, payload); sent++; }
    catch (e: any) {
      const code = e?.statusCode;
      if (code === 404 || code === 410) {   // Abo tot → aufräumen
        await admin.from('push_subscriptions').delete().eq('user_id', toUserId).eq('endpoint', s.endpoint);
      }
    }
  }
  return json({ ok: true, sent }, 200);
});
