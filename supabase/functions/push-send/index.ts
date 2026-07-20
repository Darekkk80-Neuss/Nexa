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
import { pushEndpointOk } from '../_shared/util.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, 'content-type': 'application/json' } });
}

// Titel kommen ausschliesslich von hier. Frei formulierte Titel aus dem Client
// erlaubten es jedem Familienmitglied, eine Push zu bauen, die auf dem
// Sperrbildschirm des anderen wie eine Meldung von Effyra selbst aussieht
// ("Effyra: Konto bestaetigen") -- Phishing innerhalb der Familie.
// Der beschreibende Text bleibt frei, "Aufgabe zugewiesen" braucht ihn.
// Sprache ist die des EMPFAENGERS: bisher kam der Titel in der Sprache des
// Absenders an, was in einer Familie ueber Landesgrenzen hinweg unlesbar war.
const KINDS = ['task', 'shopping', 'done', 'test'];
const TITLES: Record<string, Record<string, string>> = {
  task:     { de: '\u{1F46A} Neue Aufgabe für dich', en: '\u{1F46A} A new task for you', fr: '\u{1F46A} Une nouvelle tâche pour toi', es: '\u{1F46A} Una nueva tarea para ti', it: '\u{1F46A} Un nuovo compito per te', pl: '\u{1F46A} Nowe zadanie dla Ciebie' },
  shopping: { de: '\u{1F6D2} Einkaufsliste für dich', en: '\u{1F6D2} Shopping list for you', fr: '\u{1F6D2} Liste de courses pour toi', es: '\u{1F6D2} Lista de la compra para ti', it: '\u{1F6D2} Lista della spesa per te', pl: '\u{1F6D2} Lista zakupów dla Ciebie' },
  done:     { de: '\u{1F389} Gute Nachricht', en: '\u{1F389} Good news', fr: '\u{1F389} Bonne nouvelle', es: '\u{1F389} Buenas noticias', it: '\u{1F389} Buone notizie', pl: '\u{1F389} Dobra wiadomość' },
  test:     { de: '\u{1F514} Effyra-Test', en: '\u{1F514} Effyra test', fr: '\u{1F514} Test Effyra', es: '\u{1F514} Prueba de Effyra', it: '\u{1F514} Test Effyra', pl: '\u{1F514} Test Effyra' },
};

/** Freitext aus dem Client, der ungefiltert auf dem Sperrbildschirm eines
 *  anderen Menschen landet. Entfernt Steuer- und Richtungszeichen (ein
 *  RTL-Override tarnt angehaengten Text) sowie alles, was nach Adresse
 *  aussieht: der Service Worker oeffnet solche Links zwar nicht, der Empfaenger
 *  tippt sie aber ab. Preis dafuer: eine Aufgabe "Rechnung an anbieter.de"
 *  verliert die Domain -- bewusst in Kauf genommen. */
function cleanText(v: unknown, max: number): string {
  return String(v ?? '')
    // Steuer- und Bidi-Zeichen als Escape-Folgen, NICHT roh: rohe Zeichen
    // ueberleben kein Kopieren zwischen Werkzeugen und machen den Ausdruck
    // unlesbar. U+202A..U+202E und U+2066..U+2069 kehren die Leserichtung um
    // und koennen angehaengten Text tarnen; U+200B..U+200F sind unsichtbare
    // Trenner, mit denen sich Wortfilter umgehen lassen.
    .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g, ' ')
    .replace(/(?:https?:\/\/|www\.)\S*/gi, '')
    // Generisch statt Aufzaehlung: die alte Liste deckte weder .fr noch .es,
    // .it, .pl oder .info ab – also ausgerechnet die fuenf Zielsprachraeume nicht.
    // Preis bleibt derselbe wie zuvor: eine Aufgabe "Rechnung an anbieter.de"
    // verliert die Domain. Bewusst in Kauf genommen.
    .replace(/\b[a-z0-9-]{2,}\.[a-z]{2,6}\b\S*/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
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
  // body.title und body.tag werden BEWUSST nicht mehr gelesen. Der Client
  // schickt stattdessen `kind`. Alte Clients (TWA-Installationen im Feld)
  // kennen das Feld nicht -- die bekommen den Aufgaben-Titel, schlimmstenfalls
  // ueber einer Einkaufsliste. Ein falscher Titel ist hinnehmbar, ein
  // frei gewaehlter nicht.
  const kind = KINDS.includes(String(body?.kind)) ? String(body?.kind) : (isTest ? 'test' : 'task');

  const admin = createClient(SUPABASE_URL, SERVICE);

  // Sicherheit: nur innerhalb derselben Familie pushen
  const { data: mems } = await admin.from('family_members').select('user_id,family_id').in('user_id', [sender, toUserId]);
  const famOf = (uid: string) => (mems || []).filter((m: any) => m.user_id === uid).map((m: any) => m.family_id);
  const shared = famOf(sender).some((f: string) => famOf(toUserId).includes(f));
  if (toUserId !== sender && !shared) return json({ error: 'not_in_same_family' }, 403);   // Selbst-Test braucht keine Familie

  // Sprache des Empfaengers. Nur der schlanke JSON-Pfad, kein Rueckfall auf den
  // vollen Zustands-Blob wie in morning-push: hier geht es um EINE Zeile, und
  // ein Push auf Deutsch ist besser als ein Megabyte Blob fuer einen Titel.
  let lang = 'de';
  try {
    const { data: st, error: se } = await admin.from('user_state')
      .select('lang:data->profile->>lang').eq('user_id', toUserId).maybeSingle();
    if (se) throw new Error(se.message);
    const l = String((st as any)?.lang || '');
    if (/^(de|en|fr|es|it|pl)$/.test(l)) lang = l;
  } catch (_e) { /* Default de */ }

  // Absender serverseitig aufloesen. Der Client darf den Namen NICHT
  // mitschicken -- sonst waere die Kennzeichnung genau von dem faelschbar,
  // gegen den sie schuetzt.
  let senderName = '';
  const myFam = famOf(sender)[0] || null;
  if (myFam) {
    try {
      const { data: fam } = await admin.from('families').select('data').eq('id', myFam).maybeSingle();
      const me = (((fam as any)?.data?.members) || []).find((m: any) => m && m.authId === sender);
      senderName = cleanText(me?.name, 24);
    } catch (_e) { /* ohne Namen weiter -- lieber ein Push ohne Absender als keiner */ }
  }

  const title = (TITLES[kind] && (TITLES[kind][lang] || TITLES[kind].de)) || TITLES.task.de;
  const raw = cleanText(body?.body, 130);
  // Absender voranstellen, ausser beim Selbst-Test und ausser wenn der Text den
  // Namen ohnehin schon traegt ("Anna hat Einkaufen erledigt") -- sonst stuende
  // er doppelt da. Die Kennzeichnung ist der eigentliche Schutz: der Empfaenger
  // sieht, dass die Zeile von einem Menschen kommt und nicht von der App.
  // startsWith statt includes: mit includes unterdrueckte jeder, der seinen
  // eigenen Namen irgendwo im Text unterbrachte, die Kennzeichnung – und konnte
  // damit einen fremden Absender vortaeuschen.
  const msg = (kind === 'test' || !senderName || raw.toLowerCase().startsWith(senderName.toLowerCase()))
    ? raw
    : senderName + ': ' + raw;
  const tag = 'effyra-' + kind;   // fester tag: ein selbst gewaehlter konnte die Morgen-Push ueberschreiben

  const { data: subs } = await admin.from('push_subscriptions').select('endpoint,sub').eq('user_id', toUserId);
  if (!subs || !subs.length) return json({ ok: true, sent: 0 }, 200);

  (webpush as any).setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  const payload = JSON.stringify({ title, body: msg, tag, url: './?fam=1' });

  let sent = 0;
  for (const s of subs as any[]) {
    // Zweite Linie zur CHECK-Constraint push_endpoint_known: die ist NOT VALID
    // gesetzt, Zeilen aus der Zeit davor sind ungeprueft. Beide Adressen
    // pruefen -- gesendet wird an sub.endpoint, aufgeraeumt ueber die Spalte.
    if (!pushEndpointOk(s.sub) || !pushEndpointOk(s)) continue;
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
