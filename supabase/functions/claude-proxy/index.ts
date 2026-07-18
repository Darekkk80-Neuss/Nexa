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

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
// Im OpenAI-Projekt „Allowed models" freigegeben (exakte IDs). KEIN gpt-5-nano, KEIN whisper-1/tts-1.
const ALLOWED_MODELS = ['gpt-5-mini', 'gpt-4o-mini-2024-07-18', 'gpt-4.1-mini-2025-04-14'];
const DEFAULT_MODEL = 'gpt-5-mini';
const TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe-2025-12-15';   // Sprache → Text (freigegeben)
const TTS_MODEL = 'gpt-4o-mini-tts-2025-12-15';                 // Text → Sprache (freigegeben)
// Modell je Operation – SERVERSEITIG bestimmt (Client kann kein anderes Modell erzwingen).
const OP_MODEL: Record<string, string> = {
  question: 'gpt-5-mini',   // KI-Antworten
  voice: 'gpt-5-mini',      // Sprachassistent-Antwort
  text: 'gpt-5-mini',       // Text/Brief erstellen
  weekplan: 'gpt-5-mini',   // Wochenplanung
  scan: 'gpt-5-mini',       // Dokument analysieren (multimodal)
  invoice: 'gpt-5-mini',    // Rechnung/Bild analysieren (multimodal)
};
// Credit-Kosten je Operation (serverseitig = fälschungssicher, Client kann sie nicht drücken)
const OP_COST: Record<string, number> = { question: 1, text: 2, voice: 2, scan: 5, invoice: 10, weekplan: 5, transcribe: 2, tts: 1 };
// Live: serverseitige KI-Abrechnung aktiv → Free/Trial 100 Credits/14 Tage, Premium 500/Monat (consume_ai).
// Voraussetzung erfüllt: supabase-trial-and-play.sql + supabase-tiers.sql sind deployt (consume_ai vorhanden).
// Nach Änderung claude-proxy neu deployen: `supabase functions deploy claude-proxy`.
const ENFORCE_TIERS = true;

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'content-type': 'application/json' } });
}
// Erkennt „Modell im Projekt nicht freigeschaltet"-Fehler → dann auf klassische Audio-Modelle zurückfallen
function isAccessErr(d: any): boolean {
  const m = String(d?.error?.message || d?.error || d || '');
  return /does not have access|model_not_found|does not exist|no access|unsupported_model|must be verified/i.test(m);
}

Deno.serve(async (req) => {
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

  // 3) Kontingent serverseitig verbrauchen (atomar) – nur wenn ENFORCE_TIERS aktiv ist. Gilt für Chat UND Audio.
  //    Im Vorstart (ENFORCE_TIERS=false) ist die KI für jede angemeldete Person freigeschaltet.
  let usage: { ai_used: number; ai_limit: number } = { ai_used: 0, ai_limit: 1000000 };
  if (ENFORCE_TIERS && op !== 'tts_greeting') {   // Start-Begrüßung geht auf Betreiber-Kosten – NIE Nutzer-Credits
    const cost = OP_COST[op] || 1;   // Credits je nach Operation
    const admin = createClient(SUPABASE_URL, SERVICE);
    const { data: consumed, error: cerr } = await admin.rpc('consume_ai', { p_user: uid, p_n: cost });
    if (cerr) return json({ error: 'quota_error' }, 500);
    if (!consumed?.ok) {
      // reason: not_premium | quota_exceeded | no_profile
      return json({ error: consumed?.reason || 'quota', ai_used: consumed?.ai_used, ai_limit: consumed?.ai_limit }, 402);
    }
    usage = { ai_used: consumed.ai_used, ai_limit: consumed.ai_limit };
  }

  // 4z) Realtime-Live-Modus: kurzlebiges Session-Token (ephemeral) für gpt-realtime.
  //     Der echte Key bleibt hier; der Client verbindet sich per WebRTC mit diesem Token direkt zu OpenAI.
  if (op === 'realtime_token') {
    let r = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ session: { type: 'realtime', model: 'gpt-realtime' } }),
    });
    let d: any = await r.json().catch(() => ({}));
    if (!r.ok) {   // Fallback: ältere Sessions-Endpoint-Form
      r = await fetch('https://api.openai.com/v1/realtime/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' },
        body: JSON.stringify({ model: 'gpt-realtime' }),
      });
      d = await r.json().catch(() => ({}));
    }
    if (!r.ok) return json({ error: 'ai_failed', detail: d?.error?.message || JSON.stringify(d).slice(0, 200) }, r.status);
    const token = d?.value || d?.client_secret?.value || null;
    return json({ token, expires_at: d?.expires_at || d?.client_secret?.expires_at || null }, 200);
  }

  // 4a) Sprache → Text (Transkription, gpt-4o-mini-transcribe). Client schickt { op:'transcribe', audio:<base64>, mime }
  if (op === 'transcribe') {
    const b64 = String(body?.audio || '');
    if (!b64) return json({ error: 'bad_request' }, 400);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const mime = String(body?.mime || 'audio/webm');
    const ext = mime.includes('mp4') || mime.includes('m4a') ? 'mp4' : mime.includes('mpeg') || mime.includes('mp3') ? 'mp3' : mime.includes('wav') ? 'wav' : mime.includes('ogg') ? 'ogg' : 'webm';
    const doStt = (m: string) => {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: mime }), `audio.${ext}`);
      form.append('model', m);
      form.append('language', 'de');
      form.append('response_format', 'json');
      return fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, body: form });
    };
    const tr = await doStt(TRANSCRIBE_MODEL);
    const td: any = await tr.json().catch(() => ({}));
    if (!tr.ok) return json({ error: 'ai_failed', detail: td?.error?.message || '' }, tr.status);
    return json({ text: td?.text || '', ai_used: usage.ai_used, ai_limit: usage.ai_limit }, 200);
  }

  // 4b) Text → Sprache (TTS, gpt-4o-mini-tts). Client: { op:'tts', text, voice? }
  //     Start-Begrüßung: { op:'tts_greeting', text, voice, lang } → kostenfrei (Betreiber), lebendige Ansage.
  if (op === 'tts' || op === 'tts_greeting') {
    const isGreeting = op === 'tts_greeting';
    const input = String(body?.text || '').slice(0, isGreeting ? 180 : 1500);   // Begrüßung: kurz (Missbrauch/Kosten begrenzen)
    if (!input) return json({ error: 'bad_request' }, 400);
    const voice = /^(alloy|echo|fable|onyx|nova|shimmer|coral|sage|ash|ballad|verse)$/.test(String(body?.voice || '')) ? String(body.voice) : 'nova';
    const LANGN: Record<string, string> = { de: 'German', en: 'English', fr: 'French', es: 'Spanish', it: 'Italian', pl: 'Polish' };
    const langName = LANGN[String(body?.lang || 'de')] || 'German';
    const instr = isGreeting
      ? `Speak in ${langName} as a warm, upbeat friend who is genuinely happy to see this person. Bright, energetic and encouraging, with natural, flowing, connected phrasing and lively, expressive intonation and a gentle smile in the voice. Keep it effortless and human — never flat, monotone, robotic, choppy, or like an advertising announcer.`
      : 'Sprich auf Deutsch, warm, freundlich und natürlich – wie eine hilfsbereite Freundin, nicht wie eine Werbestimme.';
    const doTts = (m: string) => {
      const b: any = { model: m, input, voice, response_format: 'mp3', instructions: instr };
      return fetch('https://api.openai.com/v1/audio/speech', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` }, body: JSON.stringify(b) });
    };
    const sr = await doTts(TTS_MODEL);
    if (!sr.ok) { const se: any = await sr.json().catch(() => ({})); return json({ error: 'ai_failed', detail: se?.error?.message || '' }, sr.status); }
    const buf = new Uint8Array(await sr.arrayBuffer());
    let bin = ''; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    return json({ audio: btoa(bin), mime: 'audio/mpeg', ai_used: usage.ai_used, ai_limit: usage.ai_limit }, 200);
  }

  // 4c) Chat (Standard). GPT-5-/o-Modelle: max_completion_tokens + minimales Reasoning.
  const model = OP_MODEL[op] || (ALLOWED_MODELS.includes(body?.model) ? body.model : DEFAULT_MODEL);
  const max_tokens = Math.min(Math.max(1, Number(body?.max_tokens) || 1024), 4000);
  const inMsgs = Array.isArray(body?.messages) ? body.messages : null;
  if (!inMsgs) return json({ error: 'bad_request' }, 400);
  const messages = body.system ? [{ role: 'system', content: body.system }, ...inMsgs] : inMsgs;
  const doChat = (m: string) => {
    const isReasoning = /^(gpt-5|o[0-9])/.test(m);
    const tokenParam = isReasoning ? { max_completion_tokens: Math.max(max_tokens, 800), reasoning_effort: 'minimal' } : { max_tokens };
    return fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: m, messages, ...tokenParam }),
    });
  };
  let ar = await doChat(model);
  let data: any = await ar.json().catch(() => ({}));
  if (!ar.ok && isAccessErr(data) && model !== DEFAULT_MODEL) { ar = await doChat(DEFAULT_MODEL); data = await ar.json().catch(() => ({})); }   // Fallback auf freigegebenes Modell
  if (!ar.ok) return json({ error: 'ai_failed', detail: data?.error?.message || '' }, ar.status);
  const text = data?.choices?.[0]?.message?.content || '';
  return json({ content: [{ type: 'text', text }], ai_used: usage.ai_used, ai_limit: usage.ai_limit }, 200);
});
