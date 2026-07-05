# NEXA – Berechtigungskonzept & Kostenmodell

## 1. Rollen & Rechte

| Rolle | Zugang | Funktionen |
|---|---|---|
| **Gast** (nicht angemeldet) | Nur Login-/Registrierungsseite | Keine |
| **Free** (Testphase, 3 Tage) | Voller Zugang | **Alles**: Dokument-Analysen, Aufgaben, Kalender, KI-Chat, Einstellungen |
| **Free** (Testphase abgelaufen) | Paywall-Seite | Nur Premium-Freischaltung und Abmelden; alle Daten bleiben gespeichert |
| **Premium** | Voller Zugang, unbegrenzt | Alles, dauerhaft |

## 2. Regeln

- **Registrierung** (Name, E-Mail, Passwort) startet die Testphase. Das Passwort wird gesalzen und SHA-256-gehasht gespeichert – niemals im Klartext.
- **Testphase**: 3 Kalendertage ab Erst-Registrierung, gerätegebunden. Der Startzeitpunkt wird separat gespeichert und überlebt ein Konto-Zurücksetzen – die Testphase lässt sich nicht durch Neuregistrierung verlängern.
- **Premium-Freischaltung** über Codes im Format `NEXA-XXXX-XXXX`. Im Quelltext stehen nur die SHA-256-Hashes der gültigen Codes; die Codes selbst verwaltet der Betreiber und gibt sie z. B. nach Zahlungseingang heraus.
- **Abmelden/Anmelden** jederzeit möglich; Daten (Aufgaben, Termine, Dokumente, Chat) bleiben lokal erhalten.
- **„Alle Daten löschen"** entfernt auch das Konto (nicht aber den Testphasen-Zeitstempel).

## 3. Ehrliche Einordnung (wichtig)

NEXA ist eine reine Client-App ohne Server. Das Berechtigungssystem läuft vollständig im Browser und ist damit eine **Komfort- und Produkt-Sperre, kein echter Schutz**: Wer die Entwicklerkonsole öffnet, kann sie umgehen. Für die aktuelle Phase (Prototyp, Freunde & Familie, Validierung der Idee) ist das völlig ausreichend und branchenüblich. Sobald echtes Geld fließt, braucht es die Architektur aus Abschnitt 5.

## 4. KI-Kostenmodell – Empfehlung

**Das Kernproblem:** Echte KI (Foto-Analyse, freier Chat) kostet pro Anfrage Geld bei Anthropic. Irgendjemand muss das bezahlen. Drei Modelle, als Ausbaustufen gedacht:

### Stufe 1 – Heute: BYOK („Bring Your Own Key") + Demo-Modus
Genau das, was NEXA jetzt macht: Ohne Schlüssel Demo-Modus, mit eigenem Anthropic-API-Key echte KI. **Kosten für den Betreiber: 0 €.** Jeder Nutzer zahlt seine eigene KI-Nutzung direkt bei Anthropic. Nachteil: Normale Nutzer haben keinen API-Key – das skaliert nicht für „Millionen von Menschen", ist aber perfekt zum Validieren.

### Stufe 2 – Bei ersten zahlenden Nutzern: Du zahlst die KI, Nutzer zahlen dich
Das klassische Freemium-Modell aus deiner Idee (8–15 €/Monat). Die Rechnung geht auf, weil KI-Anfragen sehr günstig sind (Preise Stand Juli 2026, Claude Sonnet 5: 3 $ Input / 15 $ Output je Mio. Token; Haiku 4.5: 1 $/5 $):

| Aktion | Kosten ca. (Sonnet 5) | Kosten ca. (Haiku 4.5) |
|---|---|---|
| 1 Dokument-Analyse (Foto ≈ 1.600 Token + Antwort) | ~1,2 Cent | ~0,4 Cent |
| 1 Chat-Nachricht | ~0,6 Cent | ~0,2 Cent |
| **Typischer Nutzer/Monat** (30 Analysen + 200 Chats) | **~1,50–2 €** | **~0,50–0,70 €** |

Bei 10 €/Monat Abo bleiben also grob **80–90 % Marge** auf die KI-Kosten. Selbst Vielnutzer (100 Analysen + 1000 Chats) kosten nur ~7 € – deshalb braucht Premium ein Fair-Use-Limit (z. B. 150 Analysen/Monat).

**Zwingend nötig dafür:** Der API-Key darf dann **niemals** in der App stecken (jeder könnte ihn auslesen und auf deine Kosten nutzen). Stattdessen:

```
App (Browser) ──► Dein Backend (prüft Login + Abo + Limit) ──► Anthropic API
```

Konkreter, günstiger Stack ohne eigenen Server:
- **Supabase** (kostenloser Start): echte Benutzerkonten (E-Mail-Verifikation!) + Datenbank für Abos und Nutzungszähler
- **Supabase Edge Function / Cloudflare Worker** (kostenloser Start): nimmt Anfragen der App an, prüft das Login-Token und das Monatslimit, ruft mit **deinem** API-Key Anthropic auf, gibt die Antwort zurück
- **Stripe** für das Abo (8–15 €/Monat); Stripe-Webhook setzt `plan = premium` in der Datenbank
- Missbrauchsschutz: Limits pro Nutzer/Tag, E-Mail-Verifikation, Trial nur einmal pro E-Mail

Die heutige `index.html` bleibt fast unverändert – nur die `fetch`-URL zeigt dann auf dein Backend statt auf `api.anthropic.com`.

### Stufe 3 – Optimierung: Kostensteuerung
- Demo-/Trial-Nutzer bekommen **Haiku 4.5** (Faktor 3 günstiger), Premium **Sonnet 5**
- Trial-Kontingent begrenzen (z. B. 10 Analysen + 50 Chat-Nachrichten in den 3 Tagen) – begrenzt dein Risiko pro Trial-Nutzer auf wenige Cent
- BYOK als Zusatzoption behalten: Power-User mit eigenem Key kosten dich weiterhin 0 €

**Empfehlung in einem Satz:** Bleib jetzt bei BYOK + Demo (kostet dich nichts, validiert die Idee), und wenn die ersten Leute zahlen wollen, bau die Stufe-2-Brücke mit Supabase + Stripe – die Zahlen zeigen, dass 8–15 €/Monat die KI-Kosten um ein Vielfaches decken.
