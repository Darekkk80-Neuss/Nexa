# Effyra – gewinnt dir Zeit zurück

**Nicht nur Informationen liefern – Arbeit abnehmen.**

Effyra ist ein Alltagshelfer als Web-App: Briefe fotografieren und in einfachen Worten verstehen, Fristen automatisch erkennen, Aufgaben und Termine organisieren – und ein KI-Chat, der den Alltag plant.

**➡️ Live ausprobieren: https://darekkk80-neuss.github.io/Effyra/**

## Funktionen

- 📄 **Dokumente verstehen** – Brief, Rechnung oder Vertrag fotografieren: Effyra erklärt das Dokument in einfachen Worten, erkennt Fristen, schlägt Aufgaben vor und formuliert auf Wunsch eine Antwort.
- ✅ **Aufgaben** – To-dos mit Fälligkeit und Priorität; entstehen automatisch aus Dokumenten und Chat.
- 📅 **Kalender** – Termine und Fristen im Monatsüberblick, automatisch befüllt.
- ✨ **KI-Chat** – „Ich möchte nächste Woche in den Urlaub" → Effyra prüft den Kalender, erstellt Packliste und Erinnerungen per Ein-Klick-Buttons.
- 📊 **Dashboard** – Begrüßung, nächste Termine, wichtigste Aufgaben, zuletzt analysierte Dokumente.

## Konto & Testphase

Beim ersten Start erstellst du ein Konto. Danach sind **7 Tage lang alle Funktionen kostenlos** nutzbar; ein Premium-Code (`Effyra-XXXX-XXXX`) schaltet alles dauerhaft frei. Details und Kostenmodell: [KONZEPT.md](KONZEPT.md).

Standardmäßig werden Konten nur lokal auf dem Gerät gespeichert. Optional lässt sich ein **kostenloses Supabase-Backend** anbinden (zentrale Nutzerverwaltung, serverseitige Testphase, einmalige Codes, Admin-Dashboard) – Anleitung: [BACKEND.md](BACKEND.md).

## Demo-Modus & echte KI

Effyra läuft sofort im **Demo-Modus** (simulierte Analysen und ein Chat mit vorbereiteten Szenarien – die Urlaubs­planung funktioniert dabei wirklich).

Für **echte KI** einen eigenen [Anthropic-API-Schlüssel](https://console.anthropic.com) in den Einstellungen hinterlegen: Dann analysiert Claude die fotografierten Dokumente tatsächlich und der Chat antwortet frei. Der Schlüssel wird nur lokal im Browser gespeichert und direkt an die Anthropic-API gesendet.

## Datenschutz

Kein Konto, keine Cloud, keine Werbung, kein Tracking. Alle Daten (Aufgaben, Termine, Dokumente, Chat) liegen ausschließlich im `localStorage` des Browsers.

## Technik

Eine einzige `index.html` – Vanilla-JavaScript, ohne Build-System und ohne Abhängigkeiten. Einfach die Datei im Browser öffnen oder statisch hosten (z. B. GitHub Pages).

Das Cloud-Backend (Supabase) ist per **Domain-Sperre** an die offizielle Adresse gebunden: Kopien der App auf fremden Domains laufen automatisch nur im lokalen Modus und haben keinen Zugriff auf das Backend.

## Lizenz

**Proprietär – Alle Rechte vorbehalten.** Dieses Repository ist öffentlich, damit die offizielle App über GitHub Pages läuft. Das ist **keine** Open-Source-Lizenz: Kopieren, Verändern, Verbreiten oder kommerzielle Nutzung sind ohne ausdrückliche Genehmigung nicht gestattet. Details siehe [LICENSE](LICENSE).
