// Effyra – KI-Proxy (Supabase Edge Function) — OpenAI-Backend
// Hält den echten OpenAI-Schlüssel serverseitig und setzt das Credit-Kontingent
// fälschungssicher durch (RPC consume_ai). Der Client ruft diese Funktion mit
// dem eingeloggten Supabase-JWT auf – niemals mit dem echten Key.
// (Funktionsname bleibt aus Kompatibilität "claude-proxy"; Backend ist OpenAI.)
//
// Benötigtes Secret (supabase secrets set ...):
//   OPENAI_API_KEY   (dein OpenAI-Schlüssel, sk-…)
// Automatisch vorhanden: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { fetchT } from '../_shared/util.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
// Modell-Kette in Reihenfolge der Bevorzugung. Wird ein Modell abgeschaltet oder
// ist es im Projekt nicht freigegeben, rückt automatisch das nächste nach.
// Per Secret OPENAI_MODEL_CHAIN überschreibbar (kommagetrennt) – so lässt sich ein
// Nachfolgemodell ohne Deployment einhängen:
//   supabase secrets set OPENAI_MODEL_CHAIN="gpt-5.4-mini,gpt-5-mini,gpt-4.1-mini-2025-04-14"
// WICHTIG: jedes Modell muss im OpenAI-Projekt unter „Allowed models" freigegeben sein.
const MODEL_CHAIN = (Deno.env.get('OPENAI_MODEL_CHAIN') || 'gpt-5-mini,gpt-4.1-mini-2025-04-14,gpt-4o-mini-2024-07-18')
  .split(',').map((s) => s.trim()).filter(Boolean);
const ALLOWED_MODELS = MODEL_CHAIN;
const DEFAULT_MODEL = MODEL_CHAIN[0] || 'gpt-5-mini';
const TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe-2025-12-15';   // Sprache → Text (freigegeben)
const TTS_MODEL = 'gpt-4o-mini-tts-2025-12-15';                 // Text → Sprache (freigegeben)
// Modell je Operation – SERVERSEITIG bestimmt (Client kann kein anderes Modell erzwingen).
// Alle Operationen nutzen das erste Modell der Kette. Bewusst über DEFAULT_MODEL
// statt hart verdrahtet: sonst zeigen diese Einträge weiter auf ein abgeschaltetes
// Modell, während die Kette daneben schon umgestellt ist.
const OP_MODEL: Record<string, string> = {
  question: DEFAULT_MODEL,   // KI-Antworten
  voice: DEFAULT_MODEL,      // Sprachassistent-Antwort
  text: DEFAULT_MODEL,       // Text/Brief erstellen
  weekplan: DEFAULT_MODEL,   // Wochenplanung
  scan: DEFAULT_MODEL,       // Dokument analysieren (multimodal)
  invoice: DEFAULT_MODEL,    // Rechnung/Bild analysieren (multimodal)
};
// Credit-Kosten je Operation (serverseitig = fälschungssicher, Client kann sie nicht drücken)
const OP_COST: Record<string, number> = { question: 1, text: 2, voice: 2, scan: 5, invoice: 10, weekplan: 5, transcribe: 2, tts: 1 };
// Live: serverseitige KI-Abrechnung aktiv → Free/Trial 100 Credits/7 Tage, Premium 500/Monat (consume_ai).
// Voraussetzung erfüllt: supabase-trial-and-play.sql + supabase-tiers.sql sind deployt (consume_ai vorhanden).
// Nach Änderung claude-proxy neu deployen: `supabase functions deploy claude-proxy`.
const ENFORCE_TIERS = true;
// Die Start-Begrüßung (tts_greeting) geht bewusst auf Betreiber-Kosten und zieht
// keine Credits. Damit sie nicht beliebig oft auslösbar ist, greift stattdessen
// ein Tageskontingent je Konto – ein Kaltstart braucht genau eine Begrüßung.
const GREETING_PER_DAY = 12;
// Cache-Version für die Begrüßungs-Sprachausgabe. BEI JEDER Änderung an Stimme,
// Engine-Reihenfolge oder den Sprech-Instruktionen hochzählen – sonst liefert der
// Cache weiter das alte Audio, und man sucht die Änderung vergeblich.
const TTS_CACHE_VER = '1';

async function sha256Hex(s: string): Promise<string> {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('');
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'content-type': 'application/json' } });
}
// Erkennt „Modell im Projekt nicht freigeschaltet"-Fehler → dann auf klassische Audio-Modelle zurückfallen
function isAccessErr(d: any): boolean {
  const m = String(d?.error?.message || d?.error || d || '');
  return /does not have access|model_not_found|does not exist|no access|unsupported_model|must be verified/i.test(m);
}

// Sicherheitsnetz um den gesamten Ablauf. Wirft irgendetwas NACH der Abbuchung
// eine unerwartete Ausnahme – kaputtes Base64 in atob(), abgebrochener
// Body-Download, ein künftiger Pfad, an den hier niemand gedacht hat –, dann
// beendet die Plattform den Aufruf mit 500 und die Credits wären verloren.
// handleRequest hinterlegt seine Erstattungsfunktion in `box`, sobald abgebucht
// wurde; hier wird sie im Ausnahmefall noch ausgeführt.
type RefundBox = { refund: null | (() => Promise<void>) };

Deno.serve(async (req) => {
  const box: RefundBox = { refund: null };
  try {
    return await handleRequest(req, box);
  } catch (e) {
    console.error('unhandled', String(e));
    try { if (box.refund) await box.refund(); } catch (_e) { /* mehr ist nicht zu retten */ }
    return json({ error: 'server_error' }, 500);
  }
});

async function handleRequest(req: Request, box: RefundBox): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'auth_required' }, 401);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
  const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY');
  if (!OPENAI_API_KEY) return json({ error: 'server_not_configured' }, 500);

  // 1) Nutzer aus dem JWT bestimmen
  const userClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
  const { data: ures, error: uerr } = await userClient.auth.getUser();
  if (uerr || !ures?.user) return json({ error: 'auth_invalid' }, 401);
  const uid = ures.user.id;

  // 2) Anfrage validieren & begrenzen
  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const op = String(body?.op || '');

  // Ein Service-Client für alle serverseitigen Buchungen (Kontingent, Erstattung,
  // Statistik, TTS-Cache) – nicht je Aufruf einen neuen erzeugen.
  let _admin: any = null;
  const adminC = () => (_admin ||= createClient(SUPABASE_URL, SERVICE));

  // Was abgebucht wurde – wird bei einem Fehlschlag wieder gutgeschrieben.
  // Die AUFTEILUNG ist entscheidend: Monatstopf und gekaufte Credits müssen
  // getrennt zurück, sonst wandelt jede Erstattung das eine ins andere um.
  let refundMonth = 0, refundExtra = 0;
  let consumedScope: string | null = null;
  let creditsCharged = 0;   // für die Statistik, wird von refund() nicht zurückgesetzt

  /** Bei JEDEM Fehlerpfad nach der Abbuchung aufrufen. Muss abgewartet werden:
   *  eine nicht abgeschlossene Erstattung ist ein verlorenes Credit. */
  const refund = async () => {
    if (!refundMonth && !refundExtra) return;
    const m = refundMonth, x = refundExtra;
    refundMonth = 0; refundExtra = 0;   // nur einmal erstatten
    try {
      const { error } = await adminC().rpc('refund_ai', { p_user: uid, p_month: m, p_extra: x, p_scope: consumedScope });
      // .rpc() wirft bei Postgres-Fehlern NICHT, es liefert error zurück. Ohne
      // diese Prüfung würde eine fehlende refund_ai-Funktion lautlos scheitern.
      if (error) console.error('refund_failed', JSON.stringify({ op, uid, m, x, scope: consumedScope, msg: error.message }));
    } catch (e) { console.error('refund_threw', JSON.stringify({ op, uid, m, x, msg: String(e) })); }
  };

  /** Verbrauchszahlen mitschreiben. Best effort und bewusst NICHT abgewartet:
   *  Telemetrie darf die Antwortzeit nicht verlängern.
   *  Credits werden NUR bei Erfolg gezählt – sonst stünden erstattete Credits im
   *  Nenner von ai_kosten und wiesen die Kosten je Credit zu niedrig aus. */
  const track = (model: string, u: any, ok: boolean) => {
   // Vollständig gekapselt: Telemetrie darf NIEMALS eine Buchung beeinflussen.
   // Ohne diesen Rahmen würde eine hier geworfene Ausnahme vom äusseren
   // Sicherheitsnetz aufgefangen – und löste auf einem ERFOLGSPFAD eine
   // Erstattung aus, obwohl die Antwort erzeugt und bezahlt wurde.
   try {
    const d = u?.completion_tokens_details || {};
    const p = adminC().rpc('ai_usage_track', {
      p_op: op || '?', p_model: model || '?', p_credits: ok ? creditsCharged : 0,
      p_in: Number(u?.prompt_tokens || u?.input_tokens || 0),
      p_out: Number(u?.completion_tokens || u?.output_tokens || 0),
      p_reason: Number(d?.reasoning_tokens || 0),
      p_ok: ok,
    });
    // Fehler SOFORT abfangen, bevor die Promise irgendwohin weitergereicht wird.
    // Eine unbehandelte Ablehnung könnte den Isolate beenden – und zwar am
    // äusseren Sicherheitsnetz vorbei, also wieder mit verlorenen Credits.
    const safe = Promise.resolve(p).catch(() => {});
    try {
      const rt: any = (globalThis as any).EdgeRuntime;
      if (rt?.waitUntil) rt.waitUntil(safe);   // hält den Isolate, bis die Zahlen geschrieben sind
    } catch (_e) { /* ohne waitUntil bleibt es beim Best-Effort-Versuch */ }
   } catch (_e) { /* Statistik verloren – die Buchung bleibt unberührt */ }
  };

  // 3) Kontingent serverseitig verbrauchen (atomar) – nur wenn ENFORCE_TIERS aktiv ist. Gilt für Chat UND Audio.
  //    Im Vorstart (ENFORCE_TIERS=false) ist die KI für jede angemeldete Person freigeschaltet.
  let usage: { ai_used: number; ai_limit: number } = { ai_used: 0, ai_limit: 1000000 };
  if (ENFORCE_TIERS && op !== 'tts_greeting') {   // Start-Begrüßung geht auf Betreiber-Kosten – NIE Nutzer-Credits
    const cost = OP_COST[op] || 1;   // Credits je nach Operation
    const admin = adminC();
    const { data: consumed, error: cerr } = await admin.rpc('consume_ai', { p_user: uid, p_n: cost });
    if (cerr) return json({ error: 'quota_error' }, 500);
    if (!consumed?.ok) {
      // reason: not_premium | quota_exceeded | no_profile
      return json({ error: consumed?.reason || 'quota', ai_used: consumed?.ai_used, ai_limit: consumed?.ai_limit }, 402);
    }
    usage = { ai_used: consumed.ai_used, ai_limit: consumed.ai_limit };
    creditsCharged = cost;
    consumedScope = consumed.scope || null;       // 'family' | 'personal' | null (ältere consume_ai)
    // Aufteilung von consume_ai übernehmen.
    if (Number.isFinite(consumed.from_month) && Number.isFinite(consumed.from_extra)) {
      refundMonth = Number(consumed.from_month);
      refundExtra = Number(consumed.from_extra);
    } else {
      // Fehlt sie, läuft noch die alte consume_ai. Dann ist KEINE Zuordnung
      // korrekt: alles auf den Monatstopf vernichtet gekaufte Credits, alles auf
      // ai_extra liesse sich über die Fehlerpfade als Guthaben farmen. Die
      // konservative Richtung ist die einzig vertretbare – aber sie darf kein
      // stiller Dauerzustand werden, deshalb laut ins Log.
      refundMonth = cost; refundExtra = 0;
      console.error('consume_ai_outdated', JSON.stringify({ op, cost, hint: 'supabase-trial-and-play.sql erneut einspielen' }));
    }
    box.refund = refund;                          // Sicherheitsnetz scharfstellen
  } else if (ENFORCE_TIERS && op === 'tts_greeting') {
    // Kein Credit-Abzug, aber ein Tageslimit. Fehlt rate_take (SQL noch nicht
    // eingespielt), bleibt es bewusst offen – die Begrüßung soll nie am
    // Deployment-Zeitpunkt scheitern.
    const admin = adminC();
    const { data: allowed, error: rerr } = await admin.rpc('rate_take', { p_user: uid, p_op: 'tts_greeting', p_max: GREETING_PER_DAY });
    if (!rerr && allowed === false) return json({ error: 'rate_limited' }, 429);
  }

  // 4z) Realtime-Live-Modus: kurzlebiges Session-Token (ephemeral) für gpt-realtime.
  //     Der echte Key bleibt hier; der Client verbindet sich per WebRTC mit diesem Token direkt zu OpenAI.
  if (op === 'realtime_token') {
   try {
    let r = await fetchT('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ session: { type: 'realtime', model: 'gpt-realtime' } }),
    }, 10000);
    let d: any = await r.json().catch(() => ({}));
    if (!r.ok) {   // Fallback: ältere Sessions-Endpoint-Form
      r = await fetchT('https://api.openai.com/v1/realtime/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' },
        body: JSON.stringify({ model: 'gpt-realtime' }),
      }, 10000);
      d = await r.json().catch(() => ({}));
    }
    if (!r.ok) { await refund(); return json({ error: 'ai_failed', detail: d?.error?.message || JSON.stringify(d).slice(0, 200) }, r.status); }
    const token = d?.value || d?.client_secret?.value || null;
    // 200 ohne Token (Formataenderung bei OpenAI) ist fuer die Nutzerin ein
    // Fehlschlag – nicht 1 Credit fuer eine unbrauchbare Antwort behalten.
    if (!token) { await refund(); return json({ error: 'ai_empty' }, 502); }
    return json({ token, expires_at: d?.expires_at || d?.client_secret?.expires_at || null }, 200);
   } catch (_e) { await refund(); return json({ error: 'ai_timeout' }, 504); }
  }

  // 4a) Sprache → Text (Transkription, gpt-4o-mini-transcribe). Client schickt { op:'transcribe', audio:<base64>, mime }
  if (op === 'transcribe') {
    const b64 = String(body?.audio || '');
    if (!b64) { await refund(); return json({ error: 'bad_request' }, 400); }
    // Schranke VOR atob(): ein 100-MB-Base64 erzeugt ~133 MB String plus gleich
    // grosses Array. Bei OOM wird der Isolate abgeraeumt, bevor irgendein catch
    // laeuft – das Sicherheitsnetz kann das strukturell nicht auffangen.
    if (b64.length > 15_000_000) { await refund(); return json({ error: 'too_large' }, 413); }
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const mime = String(body?.mime || 'audio/webm');
    const ext = mime.includes('mp4') || mime.includes('m4a') ? 'mp4' : mime.includes('mpeg') || mime.includes('mp3') ? 'mp3' : mime.includes('wav') ? 'wav' : mime.includes('ogg') ? 'ogg' : 'webm';
    const doStt = (m: string) => {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: mime }), `audio.${ext}`);
      form.append('model', m);
      // Sprache der Spracherkennung = App-Sprache des Nutzers (nicht hart Deutsch – Polnisch-Bug 18.07.2026)
      const sttLang = /^(de|en|fr|es|it|pl)$/.test(String(body?.lang || '')) ? String(body.lang) : 'de';
      form.append('language', sttLang);
      form.append('response_format', 'json');
      return fetchT('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, body: form }, 30000);
    };
    let tr: Response, td: any;
    try { tr = await doStt(TRANSCRIBE_MODEL); td = await tr.json().catch(() => ({})); }
    catch (_e) { await refund(); return json({ error: 'ai_timeout' }, 504); }
    if (!tr.ok) { await refund(); return json({ error: 'ai_failed', detail: td?.error?.message || '' }, tr.status); }
    const sttText = String(td?.text || '');
    track(TRANSCRIBE_MODEL, td?.usage, !!sttText);
    if (!sttText) { await refund(); return json({ error: 'ai_empty' }, 502); }
    return json({ text: sttText, ai_used: usage.ai_used, ai_limit: usage.ai_limit }, 200);
  }

  // 4b) Text → Sprache (TTS, gpt-4o-mini-tts). Client: { op:'tts', text, voice? }
  //     Start-Begrüßung: { op:'tts_greeting', text, voice, lang } → kostenfrei (Betreiber), lebendige Ansage.
  if (op === 'tts' || op === 'tts_greeting') {
    const isGreeting = op === 'tts_greeting';
    const input = String(body?.text || '').slice(0, isGreeting ? 180 : 1500);   // Begrüßung: kurz (Missbrauch/Kosten begrenzen)
    if (!input) { await refund(); return json({ error: 'bad_request' }, 400); }

    // --- Cache, nur für die Begrüßung -------------------------------------
    // Sie wiederholt sich je Nutzer täglich wortgleich; Nutzer mit gleichem
    // Vornamen und gleicher Sprache teilen sich sogar denselben Eintrag.
    // Für op='tts' bewusst NICHT: dort ist der Text jedes Mal anders, ein Cache
    // hätte praktisch keine Treffer und würde die Tabelle nur vollschreiben.
    const cacheClient = isGreeting ? adminC() : null;
    let cacheKey = '';
    if (cacheClient) {
      const reqVoice = String(body?.voice || '');
      const reqLang = String(body?.lang || 'de');
      cacheKey = await sha256Hex([TTS_CACHE_VER, reqLang, reqVoice, input].join('|'));
      try {
        const { data: hit } = await cacheClient
          .from('tts_cache').select('audio,mime,engine,last_used').eq('key', cacheKey).maybeSingle();
        if (hit?.audio) {
          // last_used höchstens einmal täglich fortschreiben – sonst wäre jeder
          // Kaltstart ein Schreibvorgang, nur um die Aufräum-Frist zu pflegen.
          if (!hit.last_used || Date.parse(hit.last_used) < Date.now() - 864e5) {
            try { await cacheClient.from('tts_cache').update({ last_used: new Date().toISOString() }).eq('key', cacheKey); } catch (_e) { /* unkritisch */ }
          }
          return json({ audio: hit.audio, mime: hit.mime || 'audio/mpeg', engine: 'cache', ai_used: usage.ai_used, ai_limit: usage.ai_limit }, 200);
        }
      } catch (_e) { /* Tabelle fehlt o. Ä. → ohne Cache weiter, nur teurer */ }
    }

    // Frisch erzeugtes Audio ablegen. Fehler bleiben folgenlos: schlimmstenfalls
    // wird beim nächsten Start erneut synthetisiert.
    const cacheStore = async (audio: string, mime: string, engine: string) => {
      if (!cacheClient || !cacheKey || !audio) return;
      try { await cacheClient.from('tts_cache').upsert({ key: cacheKey, audio, mime, engine }, { onConflict: 'key' }); } catch (_e) { /* unkritisch */ }
    };

    // Start-Begrüßung, 1. Wahl: Google Cloud TTS (kostenlos im Kontingent, sehr natürliche Neural2-Stimmen), wenn Key gesetzt.
    if (isGreeting) {
      const gKey = Deno.env.get('GOOGLE_TTS_KEY') || '';
      if (gKey) {
        try {
          const G: Record<string, [string, string]> = {
            de: ['en-US', 'en-US-Neural2-D'], en: ['en-US', 'en-US-Neural2-D'], fr: ['fr-FR', 'fr-FR-Neural2-B'],   // de/en: US-Stimme = leichter US-Akzent
            es: ['es-ES', 'es-ES-Neural2-B'], it: ['it-IT', 'it-IT-Neural2-C'], pl: ['pl-PL', 'pl-PL-Wavenet-B'],
          };
          const pair = G[String(body?.lang || 'de')] || G.de;
          const gVoice = Deno.env.get('GOOGLE_TTS_VOICE') || pair[1];
          // Sprachcode IMMER aus dem Stimmennamen ableiten (verhindert Voice/Lang-Mismatch), sofern nicht explizit gesetzt.
          const gLang = Deno.env.get('GOOGLE_TTS_LANG') || (/^[a-z]{2}-[A-Z]{2}/.test(gVoice) ? gVoice.slice(0, 5) : pair[0]);
          const gRate = Number(Deno.env.get('GOOGLE_TTS_RATE') || '1.08');    // etwas schneller & flüssiger
          const gPitch = Number(Deno.env.get('GOOGLE_TTS_PITCH') || '2.0');   // höher = mehr Lebensfreude
          const gr = await fetchT(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${gKey}`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              input: { text: input },
              voice: { languageCode: gLang, name: gVoice },
              audioConfig: { audioEncoding: 'MP3', speakingRate: gRate, pitch: gPitch },
            }),
          }, 10000);
          const gd: any = await gr.json().catch(() => ({}));
          if (gr.ok && gd.audioContent) {
            await cacheStore(gd.audioContent, 'audio/mpeg', 'google');
            return json({ audio: gd.audioContent, mime: 'audio/mpeg', engine: 'google', ai_used: usage.ai_used, ai_limit: usage.ai_limit }, 200);
          }
          // sonst: weiter zu ElevenLabs/OpenAI
        } catch (_e) { /* Fallback */ }
      }
    }

    // Start-Begrüßung, 2. Wahl: ElevenLabs (falls Key gesetzt) – cineastisch, aber kommerziell kostenpflichtig.
    if (isGreeting) {
      const elKey = Deno.env.get('ELEVENLABS_API_KEY') || '';
      if (elKey) {
        try {
          const voiceId = Deno.env.get('ELEVENLABS_VOICE_ID') || 'JBFqnCBsd6RMkjVDRZzb';   // „George" – britisch, warm-souverän
          const elModel = Deno.env.get('ELEVENLABS_MODEL') || 'eleven_multilingual_v2';
          const er = await fetchT(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
            method: 'POST',
            headers: { 'xi-api-key': elKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
            body: JSON.stringify({ text: input, model_id: elModel, voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true } }),
          }, 15000);
          if (er.ok) {
            const eb = new Uint8Array(await er.arrayBuffer());
            let ebin = ''; for (let i = 0; i < eb.length; i++) ebin += String.fromCharCode(eb[i]);
            const eb64 = btoa(ebin);
            await cacheStore(eb64, 'audio/mpeg', 'elevenlabs');
            return json({ audio: eb64, mime: 'audio/mpeg', engine: 'elevenlabs', ai_used: usage.ai_used, ai_limit: usage.ai_limit }, 200);
          }
          // nicht ok → unten auf OpenAI zurückfallen
        } catch (_e) { /* Fallback OpenAI */ }
      }
    }

    const voice = /^(alloy|echo|fable|onyx|nova|shimmer|coral|sage|ash|ballad|verse)$/.test(String(body?.voice || '')) ? String(body.voice) : 'nova';
    const LANGN: Record<string, string> = { de: 'German', en: 'English', fr: 'French', es: 'Spanish', it: 'Italian', pl: 'Polish' };
    const langName = LANGN[String(body?.lang || 'de')] || 'German';
    const instr = isGreeting
      ? `Speak in ${langName} like a sophisticated, high-tech AI assistant — the calm, refined artificial-intelligence butler from the Iron Man films (think J.A.R.V.I.S.). Poised, articulate and composed, with quiet confidence, effortless smooth and flowing phrasing, and subtle warmth. Intelligent and reassuring, gently welcoming, with a hint of dry charm — never flat, robotic, choppy, hyper, sing-song, or like an advertising announcer.`
      : `Speak in ${langName}, warm, friendly and natural – like a helpful friend, not like an advertising voice.`;
    const doTts = (m: string) => {
      const b: any = { model: m, input, voice, response_format: 'mp3', instructions: instr };
      return fetchT('https://api.openai.com/v1/audio/speech', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` }, body: JSON.stringify(b) }, 20000);
    };
    let sr: Response;
    try { sr = await doTts(TTS_MODEL); } catch (_e) { await refund(); return json({ error: 'ai_timeout' }, 504); }
    if (!sr.ok) { const se: any = await sr.json().catch(() => ({})); await refund(); return json({ error: 'ai_failed', detail: se?.error?.message || '' }, sr.status); }
    const buf = new Uint8Array(await sr.arrayBuffer());
    let bin = ''; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    const b64 = btoa(bin);
    if (!b64) { track(TTS_MODEL, null, false); await refund(); return json({ error: 'ai_empty' }, 502); }
    await cacheStore(b64, 'audio/mpeg', 'openai');
    track(TTS_MODEL, null, true);   // Audio wird nach Minuten abgerechnet – hier zählen nur Aufrufe und Credits
    return json({ audio: b64, mime: 'audio/mpeg', ai_used: usage.ai_used, ai_limit: usage.ai_limit }, 200);
  }

  // 4c) Chat (Standard). GPT-5-/o-Modelle: max_completion_tokens + minimales Reasoning.
  const model = OP_MODEL[op] || (ALLOWED_MODELS.includes(body?.model) ? body.model : DEFAULT_MODEL);
  const max_tokens = Math.min(Math.max(1, Number(body?.max_tokens) || 1024), 4000);
  const inMsgs = Array.isArray(body?.messages) ? body.messages : null;
  if (!inMsgs) { await refund(); return json({ error: 'bad_request' }, 400); }
  const messages = body.system ? [{ role: 'system', content: body.system }, ...inMsgs] : inMsgs;
  const doChat = (m: string) => {
    const isReasoning = /^(gpt-5|o[0-9])/.test(m);
    const tokenParam = isReasoning ? { max_completion_tokens: Math.max(max_tokens, 800), reasoning_effort: 'minimal' } : { max_tokens };
    return fetchT('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: m, messages, ...tokenParam }),
    }, 60000);
  };
  // Gewünschtes Modell zuerst, danach die restliche Kette. Weitergerückt wird NUR
  // bei „Modell nicht verfügbar" – bei einem echten Fehler (400, oder 429 wegen
  // erreichtem Ausgabenlimit) wäre jeder weitere Versuch sinnlos, weil er dasselbe
  // Konto trifft. Vorher zeigte der Fallback auf DEFAULT_MODEL, also bei den
  // Standard-Operationen auf genau dasselbe Modell – er konnte nie greifen.
  const order = [...new Set([model, ...MODEL_CHAIN])];
  let ar: Response | null = null, data: any = {}, used = model;
  for (const m of order) {
    try {
      const r = await doChat(m);
      const d = await r.json().catch(() => ({}));
      ar = r; data = d; used = m;
      if (r.ok) break;
      if (!isAccessErr(d)) break;                 // echter Fehler → nicht weiterprobieren
    } catch (_e) {
      // Zeitüberschreitung: NICHT weiterrücken. Der Abbruch wirkt nur hier –
      // OpenAI erzeugt und berechnet die Antwort trotzdem. Ein Durchlauf durch
      // die Kette hiesse also mehrere bezahlte Antworten für ein Credit, und die
      // Gesamtdauer (3 × 60 s) könnte das Function-Limit reissen, bevor die
      // Erstattung läuft.
      ar = null; used = m;
      break;
    }
  }

  if (!ar) {                                      // alle Modelle liefen in einen Timeout
    track(used, null, false);
    await refund();
    return json({ error: 'ai_timeout' }, 504);
  }
  if (!ar.ok) {
    track(used, data?.usage, false);
    await refund();
    return json({ error: 'ai_failed', detail: data?.error?.message || '' }, ar.status);
  }

  // Leere Antwort trotz HTTP 200: bei den Reasoning-Modellen realistisch, wenn
  // das Token-Budget schon durchs Reasoning aufgebraucht ist (finish_reason
  // 'length'). Für die Nutzerin ist das ein Fehlschlag – also erstatten, statt
  // 10 Credits für eine leere Rechnungsanalyse zu behalten.
  const text = data?.choices?.[0]?.message?.content || '';
  const finish = data?.choices?.[0]?.finish_reason || '';
  track(used, data?.usage, !!text);
  if (!text) {
    await refund();
    return json({ error: 'ai_empty', detail: finish }, 502);
  }
  return json({ content: [{ type: 'text', text }], model: used, ai_used: usage.ai_used, ai_limit: usage.ai_limit }, 200);
}
