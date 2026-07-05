# NEXA – Dein persönlicher KI-Alltagsmanager

**Nicht nur Informationen liefern – Arbeit abnehmen.**

NEXA ist ein Alltagshelfer als Web-App: Briefe fotografieren und in einfachen Worten verstehen, Fristen automatisch erkennen, Aufgaben und Termine organisieren – und ein KI-Chat, der den Alltag plant.

**➡️ Live ausprobieren: https://darekkk80-neuss.github.io/Nexa/**

## Funktionen

- 📄 **Dokumente verstehen** – Brief, Rechnung oder Vertrag fotografieren: NEXA erklärt das Dokument in einfachen Worten, erkennt Fristen, schlägt Aufgaben vor und formuliert auf Wunsch eine Antwort.
- ✅ **Aufgaben** – To-dos mit Fälligkeit und Priorität; entstehen automatisch aus Dokumenten und Chat.
- 📅 **Kalender** – Termine und Fristen im Monatsüberblick, automatisch befüllt.
- ✨ **KI-Chat** – „Ich möchte nächste Woche in den Urlaub" → NEXA prüft den Kalender, erstellt Packliste und Erinnerungen per Ein-Klick-Buttons.
- 📊 **Dashboard** – Begrüßung, nächste Termine, wichtigste Aufgaben, zuletzt analysierte Dokumente.

## Konto & Testphase

Beim ersten Start erstellst du ein Konto (nur lokal auf dem Gerät gespeichert). Danach sind **3 Tage lang alle Funktionen kostenlos** nutzbar. Nach der Testphase schaltet ein Premium-Code (`NEXA-XXXX-XXXX`) alles dauerhaft frei – im Quelltext stehen nur die Hashes der Codes. Details und das Kostenmodell: [KONZEPT.md](KONZEPT.md).

## Demo-Modus & echte KI

NEXA läuft sofort im **Demo-Modus** (simulierte Analysen und ein Chat mit vorbereiteten Szenarien – die Urlaubs­planung funktioniert dabei wirklich).

Für **echte KI** einen eigenen [Anthropic-API-Schlüssel](https://console.anthropic.com) in den Einstellungen hinterlegen: Dann analysiert Claude die fotografierten Dokumente tatsächlich und der Chat antwortet frei. Der Schlüssel wird nur lokal im Browser gespeichert und direkt an die Anthropic-API gesendet.

## Datenschutz

Kein Konto, keine Cloud, keine Werbung, kein Tracking. Alle Daten (Aufgaben, Termine, Dokumente, Chat) liegen ausschließlich im `localStorage` des Browsers.

## Technik

Eine einzige `index.html` – Vanilla-JavaScript, ohne Build-System und ohne Abhängigkeiten. Einfach die Datei im Browser öffnen oder statisch hosten (z. B. GitHub Pages).
