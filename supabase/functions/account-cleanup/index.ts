// Effyra – Aufräumung inaktiver Konten (Art. 5 Abs. 1 lit. e DSGVO)
// ----------------------------------------------------------------------------
// Führt die festgelegte Löschfrist aus:
//   nach 23 Monaten Inaktivität -> Vorwarnung per E-Mail, 30 Tage Frist
//   nach 24 Monaten und zugestellter Warnung -> Löschung
//
// Die Löschung selbst macht diese Function NICHT selbst, sondern ruft
// delete-account auf. Dort steckt die geprüfte Abbaureihenfolge (Familien,
// Mitgliedschaften, Profil, Auth-Nutzer); eine zweite Kopie davon wäre die
// sichere Quelle für Abweichungen.
//
// Sicherheitsnetz: Gelöscht wird nur, wer nachweislich gewarnt wurde. Fehlt
// BREVO_API_KEY oder schlägt der Versand fehl, unterbleibt die Warnung – und
// damit auch jede Löschung. Der Fehlerfall heißt "nichts passiert".
//
// Aufruf: ausschließlich per Cron mit x-cron-secret.
// Deploy: supabase functions deploy account-cleanup
// Nötiges Secret: BREVO_API_KEY (Brevo → SMTP & API → API-Schlüssel)
// ----------------------------------------------------------------------------
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeErr } from '../_shared/util.ts';

const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });

const ABSENDER = { name: 'Effyra', email: 'info@gonsoft-labs.de' };

function warnMail(anrede: string) {
  const hallo = anrede ? `Hallo ${anrede},` : 'Hallo,';
  return {
    subject: 'Dein Effyra-Konto wird in 30 Tagen gelöscht',
    html: `<p>${hallo}</p>
<p>dein Effyra-Konto wurde seit <b>23 Monaten</b> nicht mehr genutzt. Wir speichern
Daten nur so lange, wie sie gebraucht werden – deshalb löschen wir Konten nach
<b>24 Monaten ohne Aktivität</b>.</p>
<p><b>In 30 Tagen wird dein Konto mit allen darin gespeicherten Daten endgültig
gelöscht.</b> Das lässt sich danach nicht rückgängig machen.</p>
<p>Du möchtest das Konto behalten? Dann melde dich einfach einmal in der App an –
das genügt, die Frist beginnt von vorn.</p>
<p>Du möchtest sofort löschen? In der App unter „Einstellungen → Konto endgültig
löschen".</p>
<p>Viele Grüße<br>Effyra · Gonsoft labs</p>
<p style="color:#888;font-size:12px">Diese Nachricht geht dir aufgrund unserer
Löschfrist zu (Art. 5 Abs. 1 lit. e DSGVO). Fragen: info@gonsoft-labs.de</p>`,
  };
}

Deno.serve(async (req) => {
  const erwartet = Deno.env.get('CRON_SECRET') || '';
  if (!erwartet || req.headers.get('x-cron-secret') !== erwartet) {
    return json({ error: 'forbidden' }, 403);
  }

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(SUPABASE_URL, SERVICE);
  const brevo = Deno.env.get('BREVO_API_KEY') || '';

  const bericht = { gewarnt: 0, warnungFehlgeschlagen: 0, geloescht: 0, loeschungFehlgeschlagen: 0, hinweis: '' };

  try {
    // ---------------- Vorwarnungen ----------------
    if (!brevo) {
      // Ohne Versandweg keine Warnung. Und ohne Warnung – siehe unten – auch
      // keine Löschung. Das ist beabsichtigt: lieber zu lange aufbewahren als
      // ohne Vorankündigung löschen.
      bericht.hinweis = 'BREVO_API_KEY fehlt – keine Warnungen versandt, daher auch keine Loeschungen.';
    } else {
      const { data: zuWarnen, error } = await admin.rpc('accounts_to_warn');
      if (error) throw error;
      for (const k of (zuWarnen || [])) {
        try {
          const { data: prof } = await admin.from('profiles').select('name').eq('id', k.user_id).maybeSingle();
          const mail = warnMail(String(prof?.name || '').trim());
          const r = await fetch('https://api.brevo.com/v3/smtp/email', {
            method: 'POST',
            headers: { 'api-key': brevo, 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ sender: ABSENDER, to: [{ email: k.email }], subject: mail.subject, htmlContent: mail.html }),
          });
          if (!r.ok) { bericht.warnungFehlgeschlagen++; continue; }
          // Erst nach BESTÄTIGTEM Versand vermerken – sonst liefe die 30-Tage-Frist
          // für eine Mail, die nie ankam, und am Ende stünde eine Löschung ohne
          // Vorwarnung.
          const { error: mErr } = await admin.rpc('mark_warned', { p_user: k.user_id });
          if (mErr) { bericht.warnungFehlgeschlagen++; continue; }
          bericht.gewarnt++;
        } catch (_e) { bericht.warnungFehlgeschlagen++; }
      }
    }

    // ---------------- Löschungen ----------------
    // accounts_to_delete() liefert nur Konten mit gesetztem deletion_warned_at,
    // das mindestens 30 Tage zurückliegt.
    const { data: zuLoeschen, error: dErr } = await admin.rpc('accounts_to_delete');
    if (dErr) throw dErr;
    for (const k of (zuLoeschen || [])) {
      try {
        const r = await fetch(`${SUPABASE_URL}/functions/v1/delete-account`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-cron-secret': erwartet },
          body: JSON.stringify({ user_id: k.user_id }),
        });
        if (r.ok) bericht.geloescht++; else bericht.loeschungFehlgeschlagen++;
      } catch (_e) { bericht.loeschungFehlgeschlagen++; }
    }

    return json({ ok: true, ...bericht });
  } catch (e) {
    return json({ error: safeErr(e) }, 500);
  }
});
