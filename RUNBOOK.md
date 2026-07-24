# Ordela – Betriebshandbuch

Die einzige verbindliche Quelle für **Reihenfolge** und **Deploy-Flags**.
Beides war bisher nur in Kommentarköpfen von 20 Dateien verstreut dokumentiert,
und genau daran ist am 20.07.2026 zweimal Arbeit verloren gegangen.

---

## 0. Vor JEDEM Deploy und JEDEM SQL-Lauf

```bash
git fetch && git status
```

Steht dort „behind", **zuerst** `git pull`. `supabase functions deploy` schickt,
was auf der Platte liegt — ohne jeden Bezug zum Git-Stand und ohne Warnung. Ein
veralteter Arbeitsordner rollt stillschweigend alte Versionen über neue Fixes.

An diesem Repository arbeiten mehrere Claude-Sitzungen parallel und pushen nach
`master`. Das ist der Grund für diese Regel.

---

## 1. SQL-Reihenfolge

Im Supabase-Dashboard → SQL Editor → New query → Inhalt einfügen → Run.
Alle Dateien sind idempotent und mehrfach ausführbar.

**Die Reihenfolge ist zwingend.** Mehrere Dateien definieren dieselben
Funktionen; die zuletzt ausgeführte gewinnt.

| # | Datei | Zweck |
|---|---|---|
| 1 | `supabase-setup.sql` | profiles, Registrierungs-Trigger |
| 2 | `supabase-sync.sql` | user_state (Geräte-Sync) |
| 3 | `supabase-push.sql` | push_subscriptions |
| 3a | `supabase-consents.sql` | `consents` – **`export_my_data()` liest sie**, ohne sie stirbt der ganze Export |
| 3b | `supabase-photo.sql` | `photo_cache` (Hintergrundbilder) |
| 4 | `supabase-codes.sql` | `gen_family_code`, Beitritts-Rate-Limit |
| 5 | `supabase-family.sql` | Familien, Beitritt/Austritt, Tabellen + Spalte `role` |
| 6 | `supabase-kids.sql` | Kinderprofile, **kanonische `save_family`** (nach family.sql) |
| 7 | `supabase-tiers.sql` | Stufen, `apply_purchase` |
| 8 | `supabase-family-entitlements.sql` | `get_entitlements`, `effective_tier` |
| 9 | `supabase-play-purchases.sql` | Play-Abo-Lebenszyklus, Sitzplätze, `void_play_purchase` (Erstattung) |
| 10 | `supabase-trial-and-play.sql` | **`consume_ai` – muss NACH 7–9 laufen**; `grant_play_purchase` vermerkt Topf + vorherigen Rang |
| 11 | `supabase-trial-schutz.sql` | Missbrauchsschutz Testphase |
| 12 | `supabase-optimierung.sql` | Indizes, `refund_ai`, Statistik, Caches |
| 13 | `supabase-due-reminder.sql` | reminder_log + Cron (alle 15 Min) |
| 14 | `supabase-due-check.sql` | `due_reminders()` – nach 13 |
| 15 | `supabase-morning.sql` | Cron Morgen-Push |
| 16 | `supabase-overdue.sql` | Cron überfällige Aufgaben |
| 17 | `supabase-weather.sql` | Warn-Spalten + Cron Unwetter |
| 18 | `supabase-monitoring.sql` | `cron_health()`, `cron_http_health()` |
| 19 | `supabase-family-merge.sql` | `apply_family_ops` – Familiendaten als Delta statt Voll-Blob (nach 5+6) |
| 20 | `supabase-export.sql` | Datenexport Art. 20 DSGVO – als LETZTE, liest u. a. `families.plan` |
| 21 | — | entfällt: `supabase/migrations/20260719_*.sql` enthält nur noch einen Hinweis, die Rollenprüfung steht jetzt in Schritt 6 (`supabase-kids.sql`) |

### Rezept-Übersetzung („Gericht des Tages")

Die **Zubereitung** ist Fließtext und lässt sich nicht über die eingebaute Wortliste
übersetzen (anders als Titel und Zutaten). Vorher lief sie über die **KI des
Nutzers** (`aiCall op:'text'` = 2 Credits) und hing damit an KI-Einwilligung **und**
Guthaben — wer beides nicht hatte, sah die Zubereitung dauerhaft auf Englisch.

Jetzt übernimmt das die Edge Function **`meal-translate`**: sie holt das Rezept
**selbst** bei TheMealDB (vom Client kommt nur die `id` — sonst könnte ein
angemeldeter Nutzer den gemeinsamen Cache mit beliebigem Inhalt füllen), übersetzt
serverseitig und legt das Ergebnis in **`public.meal_tr_cache`** ab (Schlüssel
`meal_id` + `lang`). Danach ist jede Sprache für **alle** Nutzer sofort und
**kostenlos** da — keine Credits, keine KI-Einwilligung nötig (es gehen keine
Nutzerdaten an OpenAI, nur das öffentliche Rezept).

Braucht `OPENAI_API_KEY` und die Tabelle aus `supabase-optimierung.sql`.

### Erstattungen (voidedPurchaseNotification)

`play-verify` ruft **`void_play_purchase(p_token)`** — eine einzige Transaktion, die
die Zeile sperrt, `expiry_ms = 0` und `revoked_at` setzt und dann entzieht. Schlägt
der Entzug fehl, rollt das `raise` alles mit zurück; Pub/Sub bekommt kein 200 und
stellt erneut zu. Es gibt keinen Zwischenzustand, in dem ein Kauf entwertet ist,
ohne dass etwas entzogen wurde.

**`revoked_at` ist ein Sperrvermerk, kein bloßes Protokollfeld.** Google widerruft
den Zugang bei einer Erstattung nicht von selbst — `subscriptions.get` liefert
weiter ein Datum in der Zukunft. Ohne die Sperre stellte der nächste RTDN-Lauf oder
App-Start das erstattete Abo wieder her. Beide Pfade prüfen die Spalte.

**Rang-Nachbewertung beim Entzug:** `revoke_play_purchase` bestimmt Rang und
`premium_until` nach dem Entzug einer premium-gebenden Leistung (premium/family/
lifetime) **zentral am Ende** aus dem, was noch gilt — nicht mehr pro Zweig
(drei divergente Kopien hatten hier wiederholt Fehler erzeugt): läuft noch ein
Premium-/Family-Abo, gilt dessen echtes Google-Ablaufdatum (gestapelte Zusatztage
eines erstatteten Abos fallen weg); sonst wird `premium_until` gekappt und der Rang
auf den beim Kauf vermerkten `prev_tier` zurückgesetzt. Ein **natürlicher** Ablauf
läuft hier nicht durch (kein Void) und behält die bewusste „abgelaufen → medium"-
Landung in `effective_tier`. Damit behält ein `free`-Nutzer nach Erstattung nichts,
während ein separat per **Stripe** oder Dauerlizenz erworbenes `medium` erhalten
bleibt.

**`credited_fid` / `credited_scope` / `prev_tier`** schreibt `grant_play_purchase`
beim Kauf **in derselben Transaktion** wie die Gewährung (der Token wird als
`p_token` durchgereicht) — in welchen Credit-Topf gebucht wurde (`credited_scope`
= `'family'` \| `'personal'`), welche Familie (`credited_fid`) und welchen Rang der
Nutzer vorher hatte (`prev_tier`, für premium/family/lifetime). `prev_tier` ist der
**dauerhafte Boden**: bei einem gestapelten Kauf wird er vom ältesten noch aktiven
Play-Entitlement geerbt, nicht aus dem schon angehobenen `tier` neu gelesen — sonst
konservierte ein Folgekauf den Rang der zuerst erstatteten Leistung (P+L bei
Erstattung in Kauf-Reihenfolge blieb sonst `medium` statt `free`).

**`profiles.stripe_until`** trennt die über **Stripe** (Web) bezahlte
Premium-Frist von der Play-abgeleiteten `premium_until`. `apply_purchase('premium')`
(Stripe-Webhook) schreibt `stripe_until` und hebt `premium_until` auf das spätere
von beiden; die zentrale Rang-Nachbewertung im Play-Entzug berücksichtigt beide
Quellen. Ohne diese Trennung kappte eine Play-Erstattung auch die noch bezahlten
Stripe-Tage eines Nutzers, der Web **und** App mischt (Stripe ist der Web-Bezahlweg,
in der Play-App per Policy nie genutzt). Der Entzug nimmt genau das zurück, statt aus dem
heutigen Zustand zu raten. **`credited_scope` löst die Zweideutigkeit von
`credited_fid = null`** (persönlich gebucht ≠ kein Vermerk): ein persönlich
gebuchter Boost würde sonst beim Entzug einem aktiven Familientopf zugerechnet und
zöge dort bezahlte Credits ab. Käufe von **vor** dieser Änderung tragen die Spalten
nicht (`credited_scope = null`); für sie fällt der Entzug auf die alte Heuristik
zurück und kann den falschen Topf treffen.

**Tombstone:** Wird ein Token erstattet, **bevor** ihn je eine Verifikation angelegt
hat (Absturz/offline direkt nach dem Kauf), legt `void_play_purchase` eine
`revoked_at`-Zeile mit `user_id = null` und `sku = 'unknown'` an. Ein später doch
eintreffender Erstkauf trifft per `onConflict` diese Zeile, läuft nicht in `isFirst`
und kann den erstatteten Kauf nicht nachträglich gewähren. Dafür ist
`play_purchases.user_id` **nullable**.

**Signatur-Reihenfolge (wichtig beim erneuten Einspielen):** `revoke_play_purchase`
und `grant_play_purchase` haben zusätzliche Default-Parameter bekommen. Die Dateien
`drop`en alle früheren Signaturen (2-/4-stellig bzw. 2-stellig), **bevor** die neue
Fassung greift — sonst wäre der Aufruf mehrdeutig (`ambiguous function call`). Die
Dateien bleiben mehrfach ausführbar.

### Doppelt definierte Funktionen — bewusst bereinigt

| Funktion | Gültige Definition | Aus welcher Datei entfernt |
|---|---|---|
| `consume_ai` | `supabase-trial-and-play.sql` | tiers, family-entitlements |
| `save_family` | `supabase-kids.sql` | family.sql (auch aus der grant-Liste) |
| `get_entitlements` | `supabase-family-entitlements.sql` | tiers.sql (auch die revoke/grant-Zeilen) |
| `create_child_code`, `revoke_child_code` | `supabase-kids.sql` | `supabase/migrations/20260719_*.sql` (Rollenprüfung dorthin übernommen) |

### Doppelt definierte Funktionen — bleiben doppelt

Beide lassen sich nicht auflösen, ohne `supabase-setup.sql` auf einer frischen
Datenbank unbrauchbar zu machen. **`supabase-setup.sql` deshalb nie einzeln
nachlaufen lassen** — danach immer 7 (`tiers`) und 11 (`trial-schutz`) erneut.

| Funktion | Gültig ist | Steht auch in |
|---|---|---|
| `handle_new_user` | `supabase-trial-schutz.sql` (Schritt 11) | `supabase-setup.sql` — dort ohne Trial-Missbrauchsschutz |
| `redeem_code` | `supabase-tiers.sql` (Schritt 7) | `supabase-setup.sql` — dort ohne `tier`/`premium_until` |

---

## 2. Edge Functions deployen

Das Flag `--no-verify-jwt` ist eine **Einstellung pro Function**, die bei jedem
Deploy neu gesetzt wird. Ein Sammel-Deploy ohne Flag schaltet die JWT-Prüfung
bei den Cron-Functions wieder ein — pg_cron schickt keinen JWT, alle Pushes
fallen dann mit 401 aus, still.

```bash
# Eigene Auth im Code (JWT aus dem Client) → OHNE Flag
supabase functions deploy claude-proxy
supabase functions deploy nutrition-proxy
supabase functions deploy meal-translate     # Rezept-Übersetzung, serverseitig gecacht
supabase functions deploy photo-proxy
supabase functions deploy fuel-proxy
supabase functions deploy ics-proxy          # Muellkalender: laedt iCal/ICS-Link der Gemeinde serverseitig (CORS-Umgehung); Auth im Code (getUser), SSRF-Schutz, kein Secret noetig
supabase functions deploy push-send
supabase functions deploy delete-account
supabase functions deploy stripe-checkout

# Cron/Webhook, Auth über CRON_SECRET bzw. Signatur → MIT Flag
supabase functions deploy due-reminder     --no-verify-jwt
supabase functions deploy morning-push     --no-verify-jwt
supabase functions deploy overdue-reminder --no-verify-jwt
supabase functions deploy weather-push     --no-verify-jwt
supabase functions deploy play-verify      --no-verify-jwt   # RTDN: OIDC-Token wird IM CODE geprueft, das Gateway darf den authorization-Header nicht anfassen
supabase functions deploy stripe-webhook   --no-verify-jwt   # Signaturprüfung im Code
```

---

## 3. Client

```bash
node build.mjs        # index.dev.html -> index.html  (NIE index.html direkt bearbeiten)
git add -A && git commit && git push
```

GitHub Pages zieht nach dem Push automatisch nach.

**Der Build wird jetzt erzwungen.** `build.mjs` stempelt einen Fingerabdruck der
Quelldatei in `index.html`; `check-build.mjs` rechnet ihn nach. Die Hooks in
`.githooks/` lösen das bei `commit`, `merge` und `push` aus.

Einmalig je Arbeitskopie aktivieren:

```bash
git config core.hooksPath .githooks     # oder: npm run hooks
```

Bewusst ein Fingerabdruck statt „neu bauen und vergleichen": die Bau-Kennung ist
zeitbasiert, zwei Läufe erzeugen nie dieselbe Datei — eine Vergleichsprüfung
würde **jeden** Commit ablehnen, auch den frisch gebauten, und wäre binnen eines
Tages per `--no-verify` tot.

`--no-verify` ist damit die Ausnahme, nicht der Alltag. Wer es braucht, schreibt
den Grund in die Commit-Nachricht.

`build.mjs` stempelt die Bau-Kennung `YYYYMMDD-HHMM` in `index.html`, `sw.js` und
`version.json`. Der `CACHE`-Name in `sw.js` muss **nicht mehr** von Hand hochgezählt
werden — er folgt der Kennung. `sw.js` und `version.json` gehören damit in jeden
Commit (`git add -A` deckt das ab).

**Eine Fassung aus dem Feld holen:** in `version.json` das Feld `min` auf die
älteste noch zulässige Kennung setzen, committen, pushen. Clients mit älterer
Kennung zeigen dann einen Hinweis, der sich nicht wegklicken lässt. `build.mjs`
übernimmt ein vorhandenes `min` unverändert; zum Aufheben das Feld leeren (`""`).

---

## 4. Nach dem Deploy prüfen

```sql
select * from public.cron_health();        -- laufen alle vier Jobs?
select * from public.cron_http_health();   -- nehmen die Functions sie an?
```

Alles ausser `ok (200)` heisst: der Job läuft, die Function weist ihn ab.
`403` = CRON_SECRET stimmt nicht · `401` = ohne `--no-verify-jwt` deployt ·
`500` = fehlende RPC (SQL nicht eingespielt).

Zusätzlich in den Function-Logs nach diesen Zeichenketten suchen:

| Logeintrag | Bedeutung |
|---|---|
| `consume_ai_outdated` | `supabase-trial-and-play.sql` nicht eingespielt — Erstattungen treffen den falschen Topf |
| `refund_failed` | `refund_ai` fehlt — Nutzer verlieren Credits bei jedem KI-Fehler |
| `due_reminders_failed` | `supabase-due-check.sql` nicht eingespielt |
| `unhandled` | unerwarteter Fehler im claude-proxy |

---

## 5. Secrets

`supabase secrets set NAME=wert`

| Secret | Gebraucht von | Fehlt → |
|---|---|---|
| `CRON_SECRET` | due-reminder, morning-push, overdue-reminder, weather-push, play-verify (RTDN) | 403, still |
| `VAPID_PUBLIC` / `VAPID_PRIVATE` / `VAPID_SUBJECT` | alle Push-Functions | 500 |
| `OPENAI_API_KEY` | claude-proxy | 500 |
| `OPENAI_MODEL_CHAIN` | claude-proxy (optional) | Default-Kette |
| `GOOGLE_TTS_KEY`, `ELEVENLABS_API_KEY` | claude-proxy (optional) | still auf OpenAI-TTS |
| `PLAY_PACKAGE_NAME`, `PLAY_SERVICE_ACCOUNT_JSON` | play-verify | 500 |
| `RTDN_SA_EMAIL` | play-verify (RTDN, Dienstkonto des Push-Abos) | OIDC-Weg aus, es zieht nur noch der alte `?key=`-Weg |
| `RTDN_AUDIENCE` | play-verify (RTDN, optional) | `aud` wird nicht geprüft |
| `RTDN_SECRET` | play-verify (RTDN, **Altweg `?key=`, wird abgeschafft**) | fällt auf CRON_SECRET zurück |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_*`, `APP_URL` | stripe-* | **Käufe werden nicht gutgeschrieben, nur im Stripe-Dashboard sichtbar** |
| `PEXELS_KEY`, `SPOONACULAR_KEY`, `TANKERKOENIG_KEY` | jeweiliger Proxy | Widget zeigt „nicht eingerichtet" |

**CRON_SECRET rotieren — Achtung, die Automatik hilft hier NICHT.**
Die vier Cron-Dateien lesen das Secret aus einem *bestehenden* Job ab. Nach
einer Rotation lesen sie also das **alte** — erneutes Ausführen ändert nichts,
und alle Pushes fallen still mit 403 aus. Richtige Reihenfolge:

```sql
-- 1. Alle vier Jobs entfernen (sonst wird das alte Secret weiter abgelesen)
select cron.unschedule('effyra-due');
select cron.unschedule('effyra-morning');
select cron.unschedule('effyra-overdue');
select cron.unschedule('effyra-weather');
```

2. `supabase secrets set CRON_SECRET=<neu>`
3. **Einen** Job von Hand anlegen — in `supabase-due-reminder.sql` das
   `format(...)` vorübergehend durch das neue Secret im Klartext ersetzen und
   ausführen. Danach die Datei wieder zurücksetzen (nicht mit echtem Wert committen).
4. Die übrigen drei Dateien normal ausführen — sie lesen jetzt das neue Secret.
5. `select * from public.cron_http_health();` — muss `ok (200)` zeigen.

**RTDN-Umstellung (läuft):** play-verify akzeptiert übergangsweise beide
Auth-Wege — das OIDC-Token im `authorization`-Header (neu) und `?key=` im
Query-String (alt). Der alte Weg schrieb das Secret in Function-Logs, in die
Pub/Sub-Konfiguration und in jedes Proxy-Log; weil `RTDN_SECRET` auf
`CRON_SECRET` zurückfällt, lag dort im Regelfall das Cron-Secret. Solange
`rtdn_auth_legacy_key` in den Function-Logs auftaucht, steht es noch in der
Push-URL. Abschalten (in dieser Reihenfolge): `&key=` aus dem Pub/Sub-Push-Abo
entfernen → mehrere Tage Logs beobachten → Legacy-Zweig in
`play-verify/index.ts` löschen → `RTDN_SECRET` entfernen → **CRON_SECRET
rotieren**, denn es stand in Logs und Console-Historie.

---

## 6. Backup und Wiederherstellung

**Offen — vor dem öffentlichen Launch zu klären.**

Die SQL-Dateien werden von Hand im Dashboard ausgeführt, ohne
Transaktionsklammer und ohne Rückfrage. Ein Fehlgriff ist ohne
Point-in-Time-Recovery endgültig, und `user_state` ist das einzige
serverseitige Abbild der Nutzerdaten.

Zu tun:
1. Supabase-Plan prüfen (PITR gibt es erst ab Pro als Add-on)
2. PITR aktivieren
3. Wiederherstellung **einmal testen** — ein ungetestetes Backup ist kein Backup

---

## 7. Bekannte Grenzen

| Grenze | Ab wann | Was dann |
|---|---|---|
| `due_reminders()` liest jeden Blob mit Push-Abo | ~50.000 Nutzer | Spalte `user_state.next_due_at` mit Index |
| `families.data`: zwei Geräte ändern DENSELBEN Eintrag | jetzt | letzter Schreiber gewinnt – aber nur für diesen einen Eintrag (`apply_family_ops`). Verschiedene Einträge kollidieren nicht mehr |
| Ungesendete Änderungen überleben keinen App-Neustart | jetzt | `famBase` wird bewusst nicht persistiert (sonst Auferstehung fremd gelöschter Einträge). Persistieren nur mit Grössenschranke, der Blob darf 2 MB gross sein |
| `morning-push` Laufzeit | ~100.000 Geräte | nach Shards aufteilen (mehrere Cron-Einträge) |
| `families.data` wächst unbegrenzt | harte Grenze bei 2 MB | automatisches Aufräumen nach 1 Jahr (Einstellungen → Aufräumen), Frühwarnung ab 80 % |
| Kein Alerting | jetzt | `cron_health()` regelmässig ansehen |
