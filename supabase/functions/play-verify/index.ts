// Effyra – Google Play Purchase Verify (Supabase Edge Function)
// ----------------------------------------------------------------------------
// Zweck: Einen Play-Kauf fälschungssicher bei Google prüfen und das passende
//        Entitlement setzen (RPC grant_play_purchase, service_role).
//
// Zwei Aufruf-Wege:
//   A) Vom Client (nach dem Kauf):  POST mit Supabase-JWT + { sku, token, type }
//   B) Als RTDN-Push (Pub/Sub):     POST ?rtdn=1  (Google Real-time Dev Notifications)
//
// Secrets (supabase secrets set ...):
//   PLAY_PACKAGE_NAME          z. B. app.effyra.twa
//   PLAY_SERVICE_ACCOUNT_JSON  Inhalt der Service-Account-JSON (Play Developer API)
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY  (automatisch vorhanden)
//
// ⚠️ Scaffold: Die Google-API-Aufrufe sind Standard, müssen aber mit deinem echten
//    Service-Account einmal getestet werden (siehe GOOGLE_PLAY_SETUP.md, Schritt 2/5).
// ----------------------------------------------------------------------------
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'content-type': 'application/json' } });

const PACKAGE = Deno.env.get('PLAY_PACKAGE_NAME') || '';
const SA_JSON = Deno.env.get('PLAY_SERVICE_ACCOUNT_JSON') || '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ADDON_SKUS = ['effyra_adult', 'effyra_child'];
const isAddon = (s: string) => ADDON_SKUS.indexOf(s) >= 0;

// ---- Google OAuth-Token aus dem Service-Account (signierter JWT, RS256) ----
function b64url(buf: ArrayBuffer | Uint8Array) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function pemToDer(pem: string) {
  const body = pem.replace(/-----BEGIN [^-]+-----/, '').replace(/-----END [^-]+-----/, '').replace(/\s+/g, '');
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}
async function googleAccessToken(): Promise<string> {
  const sa = JSON.parse(SA_JSON);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  };
  const unsigned = b64url(new TextEncoder().encode(JSON.stringify(header))) + '.' +
                   b64url(new TextEncoder().encode(JSON.stringify(claim)));
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToDer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const jwt = unsigned + '.' + b64url(sig);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + jwt,
  });
  const t = await res.json();
  if (!t.access_token) throw new Error('google_token_failed');
  return t.access_token as string;
}

// ---- Kauf bei Google prüfen (Abo vs. Einmalprodukt). Gibt Gültigkeit + Ablaufdatum zurück. ----
async function verifyPurchase(sku: string, token: string, type: string): Promise<{ ok: boolean; expiryMs: number }> {
  const at = await googleAccessToken();
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}`;
  const url = type === 'subs'
    ? `${base}/purchases/subscriptions/${sku}/tokens/${token}`
    : `${base}/purchases/products/${sku}/tokens/${token}`;
  const res = await fetch(url, { headers: { authorization: 'Bearer ' + at } });
  if (!res.ok) return { ok: false, expiryMs: 0 };
  const d = await res.json();
  if (type === 'subs') {
    const exp = Number(d.expiryTimeMillis || 0);         // Abo: gültig, solange Ablauf in der Zukunft
    return { ok: !exp || exp > Date.now(), expiryMs: exp };
  }
  return { ok: d.purchaseState === 0 || d.purchaseState === undefined, expiryMs: 0 };   // Einmalkauf
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  if (!PACKAGE || !SA_JSON) return json({ error: 'server_not_configured' }, 500);
  const admin = createClient(SUPABASE_URL, SERVICE);
  const isRtdn = new URL(req.url).searchParams.get('rtdn') === '1';

  try {
    // ---- B) RTDN (Pub/Sub push): Verlängerung / Storno / Ablauf ------------
    if (isRtdn) {
      // Schutz: die Pub/Sub-Push-URL trägt ?rtdn=1&key=<RTDN_SECRET> (fail-closed).
      const secret = Deno.env.get('RTDN_SECRET') || Deno.env.get('CRON_SECRET');
      if (!secret || new URL(req.url).searchParams.get('key') !== secret) return json({ error: 'forbidden' }, 403);
      const body = await req.json();
      const msg = body?.message?.data ? JSON.parse(atob(body.message.data)) : null;
      const sn = msg?.subscriptionNotification;
      if (sn && sn.purchaseToken) {
        const token = String(sn.purchaseToken);
        const { data: pp } = await admin.from('play_purchases').select('user_id,sku').eq('purchase_token', token).maybeSingle();
        if (!pp) return json({ ok: true, note: 'rtdn_unknown_token' });
        const useSku = String(sn.subscriptionId || pp.sku);
        const v = await verifyPurchase(useSku, token, 'subs');                 // Googles aktueller Stand
        await admin.from('play_purchases').update({ expiry_ms: v.expiryMs || null, updated_at: new Date().toISOString() }).eq('purchase_token', token);
        if (isAddon(useSku)) await admin.rpc('recompute_family_seats', { p_user: pp.user_id });   // Add-on: Sitzplätze neu
        else await admin.rpc('sync_play_expiry', { p_user: pp.user_id, p_sku: useSku, p_expiry_ms: v.expiryMs || 0 });
        return json({ ok: true, note: 'rtdn_synced', until: v.expiryMs });
      }
      return json({ ok: true, note: 'rtdn_ignored' });                          // Test-/Einmalprodukt-Notifications
    }

    // ---- A) Client-Verifikation (Erstkauf: mode≠'sync' → gewähren; Re-Verifikation: mode='sync' → Ablauf setzen)
    const jwt = (req.headers.get('authorization') || '').replace('Bearer ', '');
    if (!jwt) return json({ error: 'no_auth' }, 401);
    const { data: u } = await admin.auth.getUser(jwt);
    const uid = u?.user?.id;
    if (!uid) return json({ error: 'invalid_user' }, 401);

    const { sku, token, type, mode } = await req.json();
    if (!sku || !token) return json({ error: 'missing_params' }, 400);

    const v = await verifyPurchase(sku, token, type || 'subs');
    if (!v.ok) return json({ error: 'purchase_invalid' }, 402);

    // Kauf↔Nutzer merken (mit Ablaufdatum – für RTDN & Add-on-Sitzplätze)
    await admin.from('play_purchases').upsert(
      { purchase_token: token, user_id: uid, sku, ptype: type || 'subs', expiry_ms: v.expiryMs || null, updated_at: new Date().toISOString() },
      { onConflict: 'purchase_token' });

    // Add-ons (Zusatz-Erwachsener/Kind): Sitzplätze idempotent neu berechnen (kein grant/sync).
    if (isAddon(sku)) {
      const r = await admin.rpc('recompute_family_seats', { p_user: uid });
      const seats = r.data as { ok?: boolean; reason?: string } | null;
      // Kein still-erfolgreiches ok:true, wenn der Nutzer (noch) in keiner Familie ist -> Client kann es erkennen.
      if (seats && seats.ok === false) return json({ error: 'addon_no_family', detail: seats.reason }, 409);
      return json({ ok: true, seats });
    }

    if (mode === 'sync') {
      // Re-Verifikation beim App-Start: Ablaufdatum IDEMPOTENT setzen (keine 32-Tage-Verlängerung/Runaway)
      const r = await admin.rpc('sync_play_expiry', { p_user: uid, p_sku: sku, p_expiry_ms: v.expiryMs || 0 });
      return json({ ok: true, synced: r.data });
    }

    // Erstkauf (Premium/Family/Top-up): Entitlement anlegen/gewähren
    const { data: granted, error } = await admin.rpc('grant_play_purchase', { p_user: uid, p_sku: sku });
    if (error) return json({ error: 'grant_failed', detail: error.message }, 500);
    return json({ ok: true, granted });
  } catch (e) {
    return json({ error: 'verify_error', detail: String(e) }, 500);
  }
});
