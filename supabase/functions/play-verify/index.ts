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

// ---- Kauf bei Google prüfen (Abo vs. Einmalprodukt) ----
async function verifyPurchase(sku: string, token: string, type: string): Promise<boolean> {
  const at = await googleAccessToken();
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}`;
  const url = type === 'subs'
    ? `${base}/purchases/subscriptions/${sku}/tokens/${token}`
    : `${base}/purchases/products/${sku}/tokens/${token}`;
  const res = await fetch(url, { headers: { authorization: 'Bearer ' + at } });
  if (!res.ok) return false;
  const d = await res.json();
  // Abo: purchaseState/expiry; Einmalkauf: purchaseState 0 = gekauft
  if (type === 'subs') return !d.expiryTimeMillis || Number(d.expiryTimeMillis) > Date.now();
  return d.purchaseState === 0 || d.purchaseState === undefined;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  if (!PACKAGE || !SA_JSON) return json({ error: 'server_not_configured' }, 500);
  const admin = createClient(SUPABASE_URL, SERVICE);
  const isRtdn = new URL(req.url).searchParams.get('rtdn') === '1';

  try {
    // ---- B) RTDN (Pub/Sub push) --------------------------------------------
    if (isRtdn) {
      const body = await req.json();
      const msg = body?.message?.data ? JSON.parse(atob(body.message.data)) : null;
      // TODO(Test): msg.subscriptionNotification / oneTimeProductNotification auswerten,
      // Kauf via verifyPurchase prüfen und Nutzer über obfuscatedExternalAccountId zuordnen
      // (beim Kauf im Client als accountId mitgeben), dann grant_play_purchase aufrufen.
      return json({ ok: true, note: 'rtdn_received', got: !!msg });
    }

    // ---- A) Client-Verifikation nach Kauf ----------------------------------
    const jwt = (req.headers.get('authorization') || '').replace('Bearer ', '');
    if (!jwt) return json({ error: 'no_auth' }, 401);
    const { data: u } = await admin.auth.getUser(jwt);
    const uid = u?.user?.id;
    if (!uid) return json({ error: 'invalid_user' }, 401);

    const { sku, token, type } = await req.json();
    if (!sku || !token) return json({ error: 'missing_params' }, 400);

    const ok = await verifyPurchase(sku, token, type || 'subs');
    if (!ok) return json({ error: 'purchase_invalid' }, 402);

    const { data: granted, error } = await admin.rpc('grant_play_purchase', { p_user: uid, p_sku: sku });
    if (error) return json({ error: 'grant_failed', detail: error.message }, 500);
    return json({ ok: true, granted });
  } catch (e) {
    return json({ error: 'verify_error', detail: String(e) }, 500);
  }
});
