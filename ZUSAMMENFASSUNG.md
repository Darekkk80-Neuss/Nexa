# Effyra – Zusammenfassung

**Stand:** Juli 2026 · **Live:** https://darekkk80-neuss.github.io/Effyra/ · **Repo:** [Darekkk80-Neuss/Effyra](https://github.com/Darekkk80-Neuss/Effyra)

---

## Was ist Effyra?

Der persönliche **KI-Alltagsmanager** – eine Web-App, die Arbeit abnimmt statt nur Informationen zu liefern. Komplett auf Deutsch, dunkles/visionäres Design, läuft auf Handy und Desktop.

Technisch: **eine einzige `index.html`** (Vanilla-JavaScript, kein Build-System, keine Abhängigkeiten). Alle Daten bleiben lokal im Browser – kein Server, keine Cloud, keine Werbung, kein Tracking.

---

## Funktionen

| Bereich | Was es kann |
|---|---|
| 📄 **Dokumente** | Brief/Rechnung/Vertrag fotografieren → Effyra erklärt ihn in einfachen Worten, erkennt Fristen, schlägt Aufgaben vor, formuliert einen Antwortentwurf |
| ✅ **Aufgaben** | To-dos mit Fälligkeit und Priorität; entstehen automatisch aus Dokumenten und Chat; überfällige rot markiert |
| 📅 **Kalender** | Monatsübersicht, Termine und Fristen automatisch eingetragen |
| ✨ **KI-Chat** | „Ich möchte nächste Woche in den Urlaub" → prüft Kalender, erstellt Packliste + Erinnerungen per Ein-Klick-Buttons |
| 📊 **Dashboard** | Begrüßung, nächste Termine, wichtigste Aufgaben, zuletzt analysierte Dokumente |

**KI zweistufig:** Demo-Modus funktioniert sofort (simulierte Analysen, funktionierende Chat-Szenarien). Mit eigenem Anthropic-API-Schlüssel in den Einstellungen wird echte KI aktiv (Claude analysiert Fotos wirklich, Chat antwortet frei). Der Schlüssel bleibt nur lokal im Browser.

---

## Authentifizierung & Berechtigungen

Beim ersten Start erscheint eine **Login-/Registrierungsseite** als erste Seite.

| Rolle | Zugang |
|---|---|
| **Gast** (nicht angemeldet) | Nur Login-Seite |
| **Free – Testphase (3 Tage)** | Voller Zugang zu allen Funktionen |
| **Free – abgelaufen** | Paywall-Seite; Daten bleiben erhalten |
| **Premium** | Alles, unbegrenzt und dauerhaft |

**Sicherheit:** Passwort wird gesalzen und SHA-256-gehasht gespeichert (nie im Klartext). Die Testphase startet bei Registrierung und lässt sich nicht durch Neuanmeldung verlängern (Startzeitpunkt separat gespeichert). Premium wird über Codes im Format `NEXA-XXXX-XXXX` freigeschaltet – im Quelltext stehen nur die Hashes der Codes, nicht die Codes selbst.

> ⚠️ **Ehrlicher Hinweis:** Da Effyra ohne Server läuft, ist die Sperre eine **Komfort-Sperre, kein echter Schutz** – technisch versierte Nutzer könnten sie umgehen. Für die aktuelle Prototyp-Phase ist das ausreichend und üblich.

---

## KI-Kostenmodell (Kurzfassung)

Die zentrale Frage „Wer bezahlt die KI?" in drei Ausbaustufen:

1. **Heute – BYOK + Demo:** Jeder Nutzer bringt seinen eigenen API-Schlüssel mit → **kostet dich 0 €**, ideal zum Validieren der Idee.
2. **Bei zahlenden Nutzern – Freemium (8–15 €/Monat):** Du zahlst die KI, Nutzer zahlen dich. Eine Dokument-Analyse kostet ~1 Cent, ein typischer Nutzer ~1,50–2 €/Monat → **80–90 % Marge**. Braucht dann ein Backend (Supabase + Cloudflare/Stripe), damit der API-Key nicht in der App steckt.
3. **Optimierung:** Trial-Nutzer bekommen das günstigere Modell (Haiku), Premium das bessere (Sonnet); Fair-Use-Limits.

**Empfehlung:** Jetzt bei BYOK + Demo bleiben (kostenlos), erst bei zahlungsbereiten Nutzern die Backend-Brücke bauen. → Details in [KONZEPT.md](KONZEPT.md).

---

## Projekt-Dateien

| Datei | Inhalt |
|---|---|
| `index.html` | Die gesamte App |
| `manifest.webmanifest` + `icon.svg` | „Zum Startbildschirm hinzufügen" auf dem Handy |
| `README.md` | Kurzbeschreibung mit Live-Link |
| `KONZEPT.md` | Ausführliches Berechtigungs- und KI-Kostenkonzept |
| `ZUSAMMENFASSUNG.md` | Dieses Dokument |

## Deployment

Ein `git push` auf `master` genügt → GitHub Pages aktualisiert die Live-Seite automatisch. Falls der Build nicht anspringt:
`gh api -X POST repos/Darekkk80-Neuss/Effyra/pages/builds`
