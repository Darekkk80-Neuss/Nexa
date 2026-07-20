// Effyra – Google Play Purchase Verify (Supabase Edge Function)
// ----------------------------------------------------------------------------
// Zweck: Einen Play-Kauf fälschungssicher bei Google prüfen und das passende
//        Entitlement setzen (RPC grant_play_purchase, service_role).
//
// Zwei Aufruf-Wege:
//   A) Vom Client (nach dem Kauf):  POST mit Supabase-JWT + { sku, token, type }
//   B) Als RTDN-Push (Pub/Sub):     POST ?rtdn=1  (Google Real-time Dev Notifications)
//      Authentifiziert ueber das OIDC-Token, das Pub/Sub im authorization-Header
//      mitschickt. Der Marker ?rtdn=1 ist KEIN Geheimnis, nur die Wegweisung.
//
// Secrets (supabase secrets set ...):
//   PLAY_PACKAGE_NAME          z. B. app.effyra.twa
//   PLAY_SERVICE_ACCOUNT_JSON  Inhalt der Service-Account-JSON (Play Developer API)
//   RTDN_SA_EMAIL              Dienstkonto des Pub/Sub-Push-Abos, z. B.
//                              effyra-rtdn-push@<projekt>.iam.gserviceaccount.com
//   RTDN_AUDIENCE              im Push-Abo eingetragene Zielgruppe, z. B. effyra-rtdn
//                              (leer = aud wird nicht geprueft)
//   RTDN_SECRET                NUR NOCH UEBERGANGSWEISE fuer den alten ?key=-Weg,
//                              siehe Kommentar am if (isRtdn)-Zweig
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY  (automatisch vorhanden)
//
// ⚠️ Scaffold: Die Google-API-Aufrufe sind Standard, müssen aber mit deinem echten
//    Service-Account einmal getestet werden (siehe GOOGLE_PLAY_SETUP.md, Schritt 2/5).
// ----------------------------------------------------------------------------
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { fetchT } from '../_shared/util.ts';

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
// Zugriffstoken je Instanz zwischenspeichern. Es gilt eine Stunde; vorher wurde
// bei JEDER Kaufpruefung neu RS256-signiert und ein Token-Call an Google gemacht –
// also zwei Google-Roundtrips statt einem.
let tokenCache: { value: string; expMs: number } | null = null;

async function googleAccessToken(): Promise<string> {
  if (tokenCache && tokenCache.expMs > Date.now() + 60000) return tokenCache.value;
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
  const res = await fetchT('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + jwt,
  }, 10000);
  const t = await res.json();
  if (!t.access_token) throw new Error('google_token_failed');
  const ttl = Math.max(60, Number(t.expires_in) || 3600) * 1000;
  tokenCache = { value: t.access_token as string, expMs: Date.now() + ttl };
  return t.access_token as string;
}

// ---- Kauf bei Google prüfen (Abo vs. Einmalprodukt). Gibt Gültigkeit + Ablaufdatum zurück. ----
async function verifyPurchase(sku: string, token: string, type: string): Promise<{ ok: boolean; expiryMs: number }> {
  const at = await googleAccessToken();
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}`;
  // encodeURIComponent: sku und token kommen ungefiltert aus dem Client-Body.
  // Ohne Kodierung normalisiert fetch Segmente wie '../' weg und erlaubt GETs auf
  // ANDERE androidpublisher-Endpunkte – mit dem Service-Account deines
  // Play-Developer-Kontos.
  const sk = encodeURIComponent(sku);
  const tk = encodeURIComponent(token);
  const url = type === 'subs'
    ? `${base}/purchases/subscriptions/${sk}/tokens/${tk}`
    : `${base}/purchases/products/${sk}/tokens/${tk}`;
  const res = await fetchT(url, { headers: { authorization: 'Bearer ' + at } }, 10000);
  if (!res.ok) return { ok: false, expiryMs: 0 };
  const d = await res.json();
  if (type === 'subs') {
    const exp = Number(d.expiryTimeMillis || 0);         // Abo: gültig, solange Ablauf in der Zukunft
    return { ok: !exp || exp > Date.now(), expiryMs: exp };
  }
  return { ok: d.purchaseState === 0 || d.purchaseState === undefined, expiryMs: 0 };   // Einmalkauf
}

// ---- RTDN-Authentifizierung: OIDC-Token im Header statt Secret in der URL ----
// Vorher trug die Push-URL das Geheimnis (?rtdn=1&key=...). Query-Strings stehen
// im Klartext in den Supabase-Function-Logs, in der Pub/Sub-Abo-Konfiguration und
// in jedem Proxy dazwischen – und weil RTDN_SECRET auf CRON_SECRET zurueckfiel,
// war das dort liegende Secret dasselbe, mit dem die fuenf Cron-Jobs laufen.
// Ein eigener Header wie x-cron-secret bei den Cron-Functions geht hier NICHT:
// eine Pub/Sub-Push-Subscription kann keine frei gewaehlten Header senden, das
// PushConfig kennt nur pushEndpoint, attributes, oidcToken und noWrapper. Der
// einzige kopfbasierte Weg ist das OIDC-Token, das Pub/Sub als
// "authorization: Bearer <JWT>" mitschickt – von Google signiert und kurzlebig.
const RTDN_SA_EMAIL = Deno.env.get('RTDN_SA_EMAIL') || '';
const RTDN_AUDIENCE = Deno.env.get('RTDN_AUDIENCE') || '';

// Googles Signaturschluessel je Instanz halten. Sie rotieren im Tagesbereich;
// ohne Cache holt JEDE Kaufbenachrichtigung erst das JWKS – ein zusaetzlicher
// Google-Roundtrip vor jeder Abo-Verlaengerung, aus demselben Grund wie beim
// tokenCache oben.
let jwksCache: { keys: Record<string, CryptoKey>; expMs: number } | null = null;

async function googleJwk(kid: string): Promise<CryptoKey | null> {
  if (!jwksCache || jwksCache.expMs < Date.now() || !jwksCache.keys[kid]) {
    const res = await fetchT('https://www.googleapis.com/oauth2/v3/certs', {}, 10000);
    if (!res.ok) return null;
    const jwks = await res.json();
    const keys: Record<string, CryptoKey> = {};
    for (const k of (jwks.keys || [])) {
      if (k.kty !== 'RSA' || k.alg !== 'RS256') continue;
      keys[k.kid] = await crypto.subtle.importKey(
        'jwk', k, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    }
    jwksCache = { keys, expMs: Date.now() + 3600000 };
  }
  return jwksCache.keys[kid] || null;
}

// b64url gibt es oben nur in der Signier-Richtung (Bytes -> Text).
function b64urlToBytes(s: string): Uint8Array {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b + '='.repeat((4 - (b.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

// Gibt einen Grund zurueck statt nur false: ein blankes 403 ohne Log ist genau
// der Zustand, der bei den Cron-Functions schon einmal tagelang unbemerkt blieb
// (RUNBOOK Abschnitt 4, "403, still").
async function verifyRtdnOidc(jwt: string): Promise<{ ok: boolean; why: string }> {
  const p = jwt.split('.');
  if (p.length !== 3) return { ok: false, why: 'not_a_jwt' };
  let head: any, claim: any;
  try {
    head = JSON.parse(new TextDecoder().decode(b64urlToBytes(p[0])));
    claim = JSON.parse(new TextDecoder().decode(b64urlToBytes(p[1])));
  } catch (_e) { return { ok: false, why: 'malformed' }; }
  if (head.alg !== 'RS256' || !head.kid) return { ok: false, why: 'alg' };
  const key = await googleJwk(String(head.kid));
  if (!key) return { ok: false, why: 'unknown_kid' };
  const sigOk = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key,
    b64urlToBytes(p[2]), new TextEncoder().encode(p[0] + '.' + p[1]));
  if (!sigOk) return { ok: false, why: 'bad_signature' };
  // Die Signatur belegt nur "von Google" – ein OIDC-Token bekommt JEDES
  // Google-Konto. Erst der Vergleich mit unserer Dienstkonto-Adresse macht
  // daraus "von UNSEREM Push-Abo". Ohne diese Zeile waere die Pruefung wertlos.
  const now = Math.floor(Date.now() / 1000);
  if (Number(claim.exp || 0) <= now) return { ok: false, why: 'expired' };
  if (claim.iss !== 'https://accounts.google.com' && claim.iss !== 'accounts.google.com') return { ok: false, why: 'iss' };
  if (!RTDN_SA_EMAIL) return { ok: false, why: 'no_sa_configured' };
  if (claim.email !== RTDN_SA_EMAIL || claim.email_verified !== true) return { ok: false, why: 'email' };
  // aud nur pruefen, wenn gesetzt: laesst man die Zielgruppe im Push-Abo leer,
  // traegt Google die Push-URL ein – die aendert sich beim Entfernen von &key=
  // und wuerde die Umstellung genau im falschen Moment abwuergen.
  if (RTDN_AUDIENCE && claim.aud !== RTDN_AUDIENCE) return { ok: false, why: 'aud' };
  return { ok: true, why: 'oidc' };
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
      // Fail-closed, aber waehrend der Umstellung mit ZWEI gueltigen Wegen:
      // OIDC-Token im Header (neu) und ?key= im Query-String (alt). Auf der
      // Google-Seite sind das zwei getrennte Schritte – erst die OIDC-Auth am
      // Push-Abo einschalten, dann &key= aus der Push-URL nehmen. Wer nur einen
      // Weg akzeptiert, hat dazwischen ein Loch, und Pub/Sub liefert einen 403
      // nur bis zum Ende der Message Retention nach (Standard 7 Tage) – danach
      // sind Verlaengerungen und Stornos endgueltig weg.
      const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      const oidc = bearer ? await verifyRtdnOidc(bearer) : { ok: false, why: 'no_header' };
      let via = oidc.ok ? 'oidc' : '';
      if (!via) {
        const secret = Deno.env.get('RTDN_SECRET') || Deno.env.get('CRON_SECRET');
        if (secret && new URL(req.url).searchParams.get('key') === secret) via = 'legacy_key';
      }
      if (!via) { console.log('rtdn_forbidden', oidc.why); return json({ error: 'forbidden' }, 403); }
      // Solange das hier auftaucht, steht das Secret noch in der Push-URL. Erst
      // wenn es ueber mehrere Tage still bleibt, darf der Legacy-Zweig raus –
      // zusammen mit RTDN_SECRET und der Zeile in RUNBOOK Abschnitt 5.
      if (via === 'legacy_key') console.log('rtdn_auth_legacy_key');
      const body = await req.json();
      const msg = body?.message?.data ? JSON.parse(atob(body.message.data)) : null;
      const sn = msg?.subscriptionNotification;
      if (sn && sn.purchaseToken) {
        const token = String(sn.purchaseToken);
        const { data: pp } = await admin.from('play_purchases').select('user_id,sku').eq('purchase_token', token).maybeSingle();
        if (!pp) return json({ ok: true, note: 'rtdn_unknown_token' });
        const useSku = String(sn.subscriptionId || pp.sku);
        const v = await verifyPurchase(useSku, token, 'subs');                 // Googles aktueller Stand
        // NICHTS schreiben, wenn Google gerade nicht antwortet. Vorher lief ein
        // 5xx bei Google in expiryMs=0 und damit ueber to_timestamp(0) auf 1970 –
        // ALLE Abonnenten haetten in dem Moment ihren Zugang verloren. Pub/Sub
        // stellt bei 500 erneut zu, also ist Abbrechen hier das Richtige.
        if (!v.ok && !v.expiryMs) return json({ error: 'upstream_unavailable' }, 500);
        await admin.from('play_purchases').update({ expiry_ms: v.expiryMs || null, updated_at: new Date().toISOString() }).eq('purchase_token', token);
        if (isAddon(useSku)) await admin.rpc('recompute_family_seats', { p_user: pp.user_id });   // Add-on: Sitzplätze neu
        else await admin.rpc('sync_play_expiry', { p_user: pp.user_id, p_sku: useSku, p_expiry_ms: v.expiryMs || 0 });
        return json({ ok: true, note: 'rtdn_synced', until: v.expiryMs });
      }
      // Erstattung/Ruecklastschrift. Ohne diesen Zweig blieben gekaufte Credits
      // nach einer Rueckerstattung bestehen: kaufen, erstatten lassen, 1000
      // Credits behalten – beliebig oft wiederholbar.
      const vd = msg?.voidedPurchaseNotification;
      if (vd && vd.purchaseToken) {
        const vtok = String(vd.purchaseToken);
        const { data: vpp } = await admin.from('play_purchases').select('user_id,sku').eq('purchase_token', vtok).maybeSingle();
        if (!vpp) return json({ ok: true, note: 'void_unknown_token' });
        const { error: rerr } = await admin.rpc('revoke_play_purchase', { p_user: vpp.user_id, p_sku: vpp.sku });
        if (rerr) { console.error('void_failed', JSON.stringify({ sku: vpp.sku, msg: rerr.message })); return json({ error: 'revoke_failed' }, 500); }
        await admin.from('play_purchases').update({ expiry_ms: 0, updated_at: new Date().toISOString() }).eq('purchase_token', vtok);
        return json({ ok: true, note: 'void_revoked', sku: vpp.sku });
      }
      return json({ ok: true, note: 'rtdn_ignored' });                          // Test-Notifications
    }

    // ---- A) Client-Verifikation (Erstkauf: mode≠'sync' → gewähren; Re-Verifikation: mode='sync' → Ablauf setzen)
    const jwt = (req.headers.get('authorization') || '').replace('Bearer ', '');
    if (!jwt) return json({ error: 'no_auth' }, 401);
    const { data: u } = await admin.auth.getUser(jwt);
    const uid = u?.user?.id;
    if (!uid) return json({ error: 'invalid_user' }, 401);

    const { sku, token, type, mode } = await req.json();
    if (!sku || !token) return json({ error: 'missing_params' }, 400);

    // ---- Wiedereinlösung verhindern -------------------------------------
    // Ohne diese Prüfung war `mode` frei aus dem Client wählbar, und der
    // Nicht-sync-Pfad rief grant_play_purchase auf – das rechnet KUMULATIV
    // (+32 Tage je Aufruf, bzw. +1000 Credits bei effyra_ai_boost). 100 POSTs
    // mit einem einzigen echten Token ergaben so Jahre Premium bzw. unbegrenzt
    // Credits. Zusätzlich überschrieb der Upsert unten stillschweigend die
    // user_id, sodass ein fremder Token auf das eigene Konto umgeschrieben
    // werden konnte – samt aller künftigen RTDN-Verlängerungen.
    const v = await verifyPurchase(sku, token, type || 'subs');
    if (!v.ok) return json({ error: 'purchase_invalid' }, 402);

    // Die Erstgewährung wird über einen ATOMAREN Insert entschieden, nicht über
    // ein vorheriges select. Ein „erst lesen, dann handeln" wäre zwar seriell
    // dicht, aber 100 gleichzeitige POSTs mit demselben Token läsen alle
    // „unbekannt" und liefen alle in grant_play_purchase – das rechnet kumulativ
    // (+32 Tage bzw. +1000 Credits je Aufruf). Nur der Aufruf, dessen Insert die
    // Zeile wirklich anlegt, darf gewähren; alle anderen landen im sync-Pfad.
    const { data: ins, error: insErr } = await admin
      .from('play_purchases')
      .upsert(
        { purchase_token: token, user_id: uid, sku, ptype: type || 'subs', expiry_ms: v.expiryMs || null, updated_at: new Date().toISOString() },
        { onConflict: 'purchase_token', ignoreDuplicates: true })
      .select('purchase_token');
    // Fail-CLOSED: bei einem Datenbankfehler lieber nichts gewähren, als über
    // den Fehlerpfad in die kumulative Gewährung zu rutschen.
    if (insErr) return json({ error: 'grant_failed', detail: insErr.message }, 500);
    const isFirst = !!(ins && ins.length);

    if (!isFirst) {
      // Token existiert bereits. Gehört er jemand anderem? Dann abweisen –
      // sonst wanderte die Zuordnung samt aller künftigen RTDN-Verlängerungen
      // zum letzten Aufrufer.
      const { data: known, error: knownErr } = await admin
        .from('play_purchases').select('user_id').eq('purchase_token', token).maybeSingle();
      if (knownErr) return json({ error: 'grant_failed', detail: knownErr.message }, 500);
      if (!known || known.user_id !== uid) return json({ error: 'token_owned' }, 409);
      // Eigener, bereits eingelöster Token → nur das Ablaufdatum fortschreiben.
      await admin.from('play_purchases')
        .update({ expiry_ms: v.expiryMs || null, updated_at: new Date().toISOString() })
        .eq('purchase_token', token);
    }

    // Bekannter Token → NIE erneut gewähren, nur den Ablauf synchronisieren.
    // sync_play_expiry SETZT das Datum (statt zu addieren) und ist damit idempotent.
    const effMode = isFirst ? mode : 'sync';

    // Add-ons (Zusatz-Erwachsener/Kind): Sitzplätze idempotent neu berechnen (kein grant/sync).
    if (isAddon(sku)) {
      const r = await admin.rpc('recompute_family_seats', { p_user: uid });
      const seats = r.data as { ok?: boolean; reason?: string } | null;
      // Kein still-erfolgreiches ok:true, wenn der Nutzer (noch) in keiner Familie ist -> Client kann es erkennen.
      if (seats && seats.ok === false) return json({ error: 'addon_no_family', detail: seats.reason }, 409);
      return json({ ok: true, seats });
    }

    if (effMode === 'sync') {
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
