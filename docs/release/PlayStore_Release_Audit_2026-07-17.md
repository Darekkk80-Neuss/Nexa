# Google Play – Release-Audit · Effyra

**Datum:** 2026-07-17 · **Prüfer:** Android Release Engineer / Play-Policy-Reviewer (beweisbasiert)
**Basis:** lokaler Stand `C:\Users\Darekkk80\Desktop\Effyra` (Commit-Stand nach `3971c30`)

---

## 0. Update 2026-07-17 — im Code behobene Punkte

Nach dem Erst-Audit direkt umgesetzt (Commit-Stand danach):

| ID | Status | Änderung | Beweis |
|---|---|---|---|
| D-01 | ✅ BEHOBEN | App ist kostenpflichtig: `STORE_SAFE=false` → Kauf-Buttons sichtbar (Lifetime 12,99 € · Premium 4,99 €/Mon. · Familie 14,99 €/Mon.). Verifiziert im Browser. | `index.dev.html:3977` |
| D-02 | ✅ BEHOBEN | TWA nutzt **ausschließlich** Google Play Billing, Stripe ist unerreichbar: `startCheckout` routet bei `hasPlayBilling()` zu `startPlayPurchase`; neuer `IS_TWA`-Guard verhindert jeden Stripe-Fallback in der Play-App. Verifiziert (Kauf-Klick → Play Billing, kein `stripe-checkout`-Aufruf). | `index.dev.html:3973` (IS_TWA), `:3878ff` (Guard) |
| C-02 | ✅ BEHOBEN | Push in der TWA aktiviert. | `twa-manifest.json` `enableNotifications:true` |
| C-01 | 🟡 VORBEREITET | `assetlinks.json` (package `app.effyra.twa`) + Deploy-Anleitung angelegt. **Offen (deinerseits):** SHA-256-Fingerprint des Play-App-Signing-Zertifikats einsetzen und an die **Domain-Wurzel** deployen. | `.well-known/assetlinks.json`, `.well-known/README.md` |
| F-03 | ✅ BEHOBEN | In-App-Meldefunktion für KI-Antworten (generative-KI-Policy): „⚑ Antwort melden" je Chat-Antwort → Gründe-Dialog → Meldung an info@gonsoft-labs.de + lokale Markierung. Verifiziert. | `index.dev.html:11031 showAiReport()` |
| F-04 | ✅ BEHOBEN | Prominenter Notruf-Disclaimer im Notfallbereich („Im echten Notfall immer 112 wählen. Effyra ersetzt keinen Notruf.") mehrsprachig. | `index.dev.html:1113` (.em-disclaimer) |
| E-02 (Code) | ✅ BEHOBEN | Öffentliche Konto-Lösch-Seite `konto-loeschen.html` (DE/EN); im Rechtscenter verlinkt. **URL für Console:** `https://darekkk80-neuss.github.io/Effyra/konto-loeschen.html` | `konto-loeschen.html`, `index.dev.html:12418` |
| Billing-Modell | ✅ FESTGELEGT | Option B: nur KI kostenpflichtig, Module gratis. Server `ENFORCE_TIERS=true` (Trial 50/7 Tage, Premium 500/Monat). Lifetime-Produkt entfernt (nur Premium 4,99 €/Mon. + Familie 14,99 €/Mon.). | `claude-proxy:37` + `PLAY_PRODUCTS:7709` |
| P0-02 | ✅ ENTSCHIEDEN | TWA-Domain bleibt `darekkk80-neuss.github.io/Effyra/` (bereits lauffähig, URL in der TWA unsichtbar). Keine Code-Änderung. assetlinks → Root-Repo `darekkk80-neuss.github.io/.well-known/`. | `twa-manifest.json`, `index.dev.html:3962` |

### Re-Audit-Verdikt 2026-07-17 (nach allen Fixes)
**Code-Teil des Audits vollständig.** Verbleibende Blocker sind ausschließlich **außerhalb des Codes**: `P0-01` (AAB bauen – läuft via PWABuilder) und der **Deploy-Teil von C-01** (SHA-256-Fingerprint + Domain-Wurzel). Alle Hoch-Risiken mit Code-Bezug (C-02, D-01, D-02, F-01…F-04) sind behoben oder als Console-Deklaration abgegrenzt. Sicherheit: keine Server-Secrets im Client (Scan leer), durchgängig HTTPS, CLOUD host-gesperrt.

**Verbleibende echte Blocker (nur auf deinem Rechner / in der Console lösbar):**
`P0-01` (AAB bauen via Bubblewrap) und der **Deploy-Teil von C-01** (Fingerprint + Domain-Wurzel).
Alles Code-Seitige der kritischen Punkte ist erledigt.

---

## 1. Go/No-Go

**Entscheidung: NO-GO (noch nicht einreichbar) — aber alle _code-seitigen_ Blocker/Hoch-Risiken der Billing- und TWA-Konfiguration sind behoben.**

- Es existiert **kein baubares Android-Artefakt** (kein `android/`-Projekt, kein AAB) – nur eine TWA-Referenzkonfig. Ohne AAB keine Einreichung.
- Der TWA-Vertrauensanker **`assetlinks.json` fehlt** – ohne ihn zeigt die App eine Browser-Adressleiste und gilt Play als „nur Webview" (faktische Ablehnung).
- **Blocker: 2** · **Hoch: 10** · **Mittel: 6** · **Offen: 4**
- Realistische Zeitschätzung bis Einreichungsfähigkeit: **ca. 1–2 Wochen** aktive Arbeit (Build + assetlinks + Console-Deklarationen + Assets), **plus** die von Play für **neue Entwicklerkonten** verlangte Testphase (Dauer/Testerzahl **zu verifizieren**, kann Wochen ergänzen).

**Positiv-Befund vorab (wichtig):** Der häufigste Blocker – ein im Client ausgelieferter Server-Schlüssel – liegt **nicht** vor. Der OpenAI-Schlüssel bleibt serverseitig (Edge Function `claude-proxy`); im Client steht nur der **publishable** Supabase-Key (`index.dev.html:3958`, RLS-geschützt). Alles läuft über HTTPS. Das ist eine solide Ausgangslage.

---

## 2. Packaging-Feststellung (Phase 0)

**Fall C — Wrapper-Konfig vorhanden, aber kein gebautes/vollständiges Android-Projekt.**

| Vorhanden | Beweis |
|---|---|
| TWA-Referenzkonfig | `twa-manifest.json` (packageId `app.effyra.twa`, host `darekkk80-neuss.github.io`) |
| Packaging-Anleitung | `ANDROID.md` (Bubblewrap-Pfad, dokumentiert die assetlinks-Falle) |
| Web-App-Manifest | `manifest.webmanifest` (name/short_name/id/start_url/scope/display/icons inkl. maskable) |
| Service Worker | `sw.js` (v5, network-first + `index.html`-Fallback) |
| **Fehlt: Android-Projekt/AAB** | kein `android/`, kein `build.gradle`, kein `*.aab` (Phase-0-Scan) |
| **Fehlt: assetlinks.json** | `find assetlinks.json` → leer |
| **Fehlt: CI/CD** | kein `.github/workflows` |

**Empfohlener Pfad: TWA via Bubblewrap** (bereits vorbereitet und angemessen). Begründung: Effyra ist eine ausgereifte PWA mit eigenständigem Funktionsumfang; die für Play verpflichtende Abrechnung digitaler Güter ist über die **Digital Goods API + Play Billing** im Client bereits angelegt (`index.dev.html:7677 getDigitalGoodsService`, `:7685 PaymentRequest`) mit serverseitiger Prüfung (`play-verify`). Native Shell/Capacitor wären Overkill. **Folgekosten:** einmalig Play-Konto (25 $), Signaturschlüssel-Verwaltung, assetlinks-Hosting an der Domain-Wurzel (GitHub-Pages-Falle, s. C-01), Pflege des Wrappers bei Play-API-Level-Fristen.

---

## 3. Handlungsliste

Sortierung: BLOCKER → HOCH → MITTEL → OFFEN.

| ID | Stufe | Kategorie | Befund | Beweis | Auswirkung | Maßnahme | Aufwand |
|---|---|---|---|---|---|---|---|
| P0-01 | BLOCKER | Build | Kein gebautes Android-Artefakt (AAB) | kein `android/`/`build.gradle`/`*.aab`; nur `twa-manifest.json` | Einreichung technisch unmöglich | `bubblewrap init` + `bubblewrap build` auf dem Dev-Rechner ausführen → `app-release-signed.aab` erzeugen | M |
| C-01 | BLOCKER | TWA | `assetlinks.json` fehlt / nicht an Domain-Wurzel deployt | `find assetlinks.json`=leer; `ANDROID.md` §4 beschreibt die GitHub-Pages-Root-Falle | Ohne Digital Asset Links zeigt die TWA die Browser-Adressleiste → Play wertet als reinen Webview → Ablehnung | Repo `darekkk80-neuss.github.io` anlegen ODER eigene Domain; `/.well-known/assetlinks.json` mit SHA-256-Fingerprint des Play-App-Signing-Zertifikats ablegen; erreichbarkeit prüfen | M |
| C-02 | HOCH | TWA | Push in TWA deaktiviert, App nutzt aber Web-Push | `twa-manifest.json` `enableNotifications:false` vs. `sw.js` push + `ensurePushPermission` (index.dev.html) | Benachrichtigungen kämen in der App nicht an → Feature-/Qualitätsbefund + Data-Safety-Widerspruch | `enableNotifications:true`; `POST_NOTIFICATIONS`-Runtime-Flow im TWA verifizieren | S |
| D-01 | HOCH | Billing | Play Billing implementiert, aber `STORE_SAFE=true` blendet **alle** Kaufwege aus | `index.dev.html:3968 STORE_SAFE=true`; `:12534` `store-safe` blendet Buttons; Digital-Goods-Code `:7677` | Wird ein Abo beworben, aber kein Kaufweg gezeigt → gebrochenes Feature / irreführend; oder Launch ohne IAP nötig | Launch-Entscheidung treffen: (a) ohne IAP starten (nur Freischalt-Code/Free) **oder** (b) Play-Billing-Kaufweg sichtbar schalten und real testen | M |
| D-02 | HOCH | Billing | Stripe-Zahlungspfad im Code vorhanden | `index.dev.html:3890 FN_URL('stripe…')`; Functions `stripe-checkout`/`stripe-webhook` | Stripe für digitale Güter im Play-Build = Sperrgrund | Sicherstellen, dass Stripe im Play-Build **nie** erreichbar ist (STORE_SAFE deckt Buttons; kein alternativer Aufruf); im TWA gegenprüfen | S |
| E-01 | HOCH | Console | Data-Safety-Angaben müssen exakt zu den realen Datenflüssen passen | Code: `getUserMedia index.dev.html:11220`, Standort `:5438/:7503`, Bewegung `:7499`, KI→OpenAI (USA) via `claude-proxy`; Vorlage `legal/google_play_compliance.md` | Diskrepanz Formular↔Code = Sperrgrund | Data-Safety-Formular exakt ausfüllen: Standort, Kamera, Mikro, Gesundheit, „Datenweitergabe" an KI-Dienst (OpenAI/USA), Push-Dienst | M |
| E-02 | HOCH | Console | Öffentlich erreichbare **Konto-Lösch-URL** | In-App-Löschung vorhanden (`index.dev.html:12390`,`:12415` → `delete-account`); Beschreibung `datenschutz.html:97` | Bei Kontoanlage verlangt Play In-App-Weg **und** öffentliche Lösch-URL | Öffentliche Lösch-Seite/-Anleitung bereitstellen (kann `datenschutz.html`-Abschnitt/eigene Seite sein) und in der Console als Lösch-URL eintragen | S |
| F-01 | HOCH | Policy | Gesundheits-/Fitnessdaten (Bewegung, Notfall) | Bewegungssensor `index.dev.html:7499` (→ Android `ACTIVITY_RECOGNITION`); Notfall-/Medizindaten-Modul | Health-Apps-Policy + Prominent Disclosure + korrekte Deklaration nötig | Health-Deklaration; ACTIVITY_RECOGNITION begründen; keine medizinischen Heilaussagen; Sensor-Consent existiert bereits (Art. 9) | M |
| F-02 | HOCH | Policy | Kinderbereich verarbeitet Kinderdaten (Art. 8) | `showKidsConsent`, `kids` in SYNC_KEYS (Cloud-Sync) | Families-Policy einschlägig, wenn Zielgruppe falsch; Zusatzpflichten | Target Audience **18+** setzen, **Families-Programm nicht** wählen; Kinderdaten in Data Safety deklarieren (vgl. `legal/children_privacy.md`) | S |
| F-03 | HOCH | Policy | Generative-KI-Chat (Play-KI-Richtlinie) | Chat/AI-Funktionen; `legal/ai_disclaimer.md` | Play verlangt bei KI-Chat Kennzeichnung + Melde-/Missbrauchsweg | In-App-Meldefunktion für anstößige KI-Ausgaben sicherstellen; KI-Kennzeichnung (vorhanden) prüfen | M |
| F-04 | HOCH | Policy | Notfall-/SOS-suggerierende Funktion | Notfallbereich mit 112/110 (`index.dev.html` emCall); `legal/LIMITATIONS.md` §4 | Play hat besondere Anforderungen an Notfall-Funktionen | Prominenter Disclaimer „kein Ersatz für den Notruf" (in LIMITATIONS/Notfall vorhanden) sichtbar in der App; Einschlägigkeit der SOS-Policy verifizieren | S |
| G-02 | HOCH | Store | Store-Beschreibung muss dem Funktionsumfang entsprechen (Deceptive Behavior) | Umfangreiche Feature-Liste im Marketing vs. tatsächlich gelieferter Code | Feature-Versprechen ohne Code-Deckung = Ablehnung | Kurz-/Langbeschreibung nur mit real ausgelieferten Funktionen; KI-Grenzen (LIMITATIONS) beachten | S |
| P0-02 | MITTEL | Packaging | Host-/Domain-Inkonsistenz | `manifest.webmanifest` id `/Effyra/`; `ALLOWED_HOSTS` nur `github.io` (`index.dev.html:3962`); Custom-Domain `gonsoft-labs.de` **nicht** backend-fähig; TWA lädt `github.io` | Falsche Domain → CLOUD/Backend aus, assetlinks passt nicht, Verwirrung | EINE kanonische Auslieferungsdomain für die TWA festlegen; `startUrl`, `webManifestUrl`, `ALLOWED_HOSTS`, assetlinks konsistent halten | M |
| A-01 | MITTEL | Build | Signaturschlüssel-Verwaltung | `twa-manifest.json` `signingKey ./android.keystore`; `ANDROID.md` §3 warnt | Verlust = keine Updates mehr möglich | Play App Signing aktivieren, Upload-Key sicher sichern (Passwort!), **nicht** ins Repo | S |
| G-01 | MITTEL | Store | Screenshots fehlen | Feature-Graphic vorhanden (`store-feature-graphic.png`); keine Screenshot-Assets im Repo | Store-Listing unvollständig | Phone-Screenshots (+ ggf. 7"/10"-Tablet) erstellen; Lokalisierung konsistent zur App-Sprache | S |
| B-01 | MITTEL | Permissions | Web-Permission-Prompts (Kamera/Mikro/Standort) im TWA | `getUserMedia:11220`, `geolocation`, `DeviceMotion:7499` | Im TWA werden Web-Prompts an Android gereicht – muss real funktionieren | Kamera-/Mikro-/Standort-Flows im gebauten TWA testen (Custom-Tabs-Fallback beachten) | M |
| H-01 | MITTEL | Qualität | Offline-Fallback verifizieren | `sw.js` network-first mit `index.html`-Fallback | Fehlerbildschirm offline = Qualitätsbefund | Offline-Verhalten im TWA testen (installiert, ohne Netz) | S |
| I-01 | MITTEL | Sicherheit | Sensible Daten unverschlüsselt in localStorage | Notfall-/Gesundheits-/Budgetdaten lokal (`store`→localStorage) | Kein Play-Blocker, aber Datenschutz-Hinweis nötig | Als „gerätelokal, app-privat" dokumentiert (datenschutz.html); ok; ggf. Klartext-Hinweis prüfen | S |
| A-02 | OFFEN | Build | `targetSdk`/`minSdk` nicht prüfbar | nirgends definiert (Bubblewrap setzt sie erst beim Build) | Play verlangt eine Mindest-Target-API-Ebene | Nach dem Build die von Bubblewrap gesetzte `targetSdkVersion` gegen die **aktuell geforderte** Play-Target-API prüfen (**zu verifizieren**) | S |
| J-01 | OFFEN | Prozess | Test-/Wartepflicht für neue Konten | Kein Konto-Kontext einsehbar | Beeinflusst Zeitplan erheblich | Aktuelle Play-Anforderung (Mindest-Testerzahl/-dauer geschlossener Test) **verifizieren** | – |
| E-03 | OFFEN | Console | Console-Deklarationen insgesamt | Console nicht einsehbar | – | Data Safety, Content Rating (IARC), Zielgruppe, Werbe-Deklaration, Health-Deklaration vollständig ausfüllen | M |
| J-02 | OFFEN | Prozess | Developer-Verifizierung / öffentliche Kontaktdaten | Nicht einsehbar | Verzögerung möglich | Identitätsprüfung + welche Kontaktdaten öffentlich erscheinen **verifizieren** | – |

Aufwand: S = <½ Tag, M = ½–2 Tage.

---

## 4. Umsetzungsreihenfolge (nach Abhängigkeit)

1. **P0-02 Domain klären** – erst wenn die kanonische TWA-Domain feststeht, sind assetlinks, Manifest-URLs und ALLOWED_HOSTS stimmig.
2. **P0-01 AAB bauen** (Bubblewrap) → liefert den Signatur-Fingerprint, den C-01 braucht.
3. **C-01 assetlinks.json** mit diesem Fingerprint an der Domain-Wurzel deployen → erst danach ist die TWA „vertraut" testbar.
4. **C-02 / D-01 / D-02** Funktions-/Billing-Konfig festlegen (Push an, Kaufweg-Entscheidung, Stripe aus) und im gebauten TWA verifizieren (B-01, H-01).
5. **E-01/E-02/E-03 + F-01…F-04 + G-01/G-02** Console-Deklarationen, Assets, Policy-Nachweise – parallel möglich, aber vor Einreichung vollständig.
6. **A-02 / J-01 / J-02** verifizieren (Ziel-API, Testpflicht, Verifizierung) – bestimmen den Zeitplan.

---

## 5. Detailbefunde je Block

- **A Build & Packaging:** Kein AAB (P0-01). Signaturschlüssel via Bubblewrap, sicher zu verwahren (A-01). `targetSdk`/`minSdk` erst nach Build prüfbar (A-02, OFFEN). `versionCode`/`versionName` in `twa-manifest.json` = 1/1.0.0 – Strategie für Updates festlegen (niedrig). Kein CI – Build derzeit nur lokal reproduzierbar (niedrig).
- **B Manifest & Berechtigungen:** Kein AndroidManifest vorhanden (wird generiert). Genutzte Web-APIs → abzuleitende Android-Permissions: `POST_NOTIFICATIONS` (Push), Kamera + Mikro (`getUserMedia:11220`), Standort (`geolocation:5438/:7503/:8952`), Bewegung → `ACTIVITY_RECOGNITION` (`DeviceMotion:7499`). Jede im Console-Formular begründen (B-01/E-01). Kein `QUERY_ALL_PACKAGES`, kein `SCHEDULE_EXACT_ALARM` – gut (TWA nutzt keine nativen Alarme).
- **C PWA/TWA:** Manifest vollständig inkl. maskable Icon. **assetlinks fehlt (C-01, BLOCKER).** Push in TWA aus (C-02). Mindestfunktionalität deutlich über „reiner Webview" (eigenständige App-Logik) – aber Play prüft TWAs streng.
- **D Abrechnung:** Digital Goods API + `play-verify` (serverseitige Prüfung) vorhanden – architektonisch korrekt. Aktuell alle Kaufwege via `STORE_SAFE=true` aus (D-01). Stripe-Pfad muss im Play-Build unerreichbar bleiben (D-02). Merchant of Record = Google → Store-Texte entsprechend.
- **E Console-Deklarationen:** Vorlagen vorhanden (`legal/google_play_compliance.md`, `legal/apple_app_privacy.md`). Data Safety exakt ausfüllen (E-01). Öffentliche Lösch-URL (E-02). Alles Weitere OFFEN bis Console (E-03).
- **F Policy:** Health/Fitness (F-01), Kinderdaten/Families (F-02), generative KI + Meldeweg (F-03), Notfall-Funktion (F-04). Rechtsdoku (DSGVO-Consent, LIMITATIONS, Datenschutz DE/EN) ist überdurchschnittlich vorbereitet – als Nachweis nutzbar.
- **G Store-Listing:** Icons + Feature-Graphic vorhanden; **Screenshots fehlen (G-01).** Beschreibung deckungsgleich mit Code halten (G-02). Zeichenlimits/Formate **zu verifizieren**.
- **H Qualität:** Offline-Fallback via SW (H-01, testen). i18n jetzt durchgängig (6 Sprachen) – gut für Lokalisierungsanforderungen. Barrierefreiheit/Vitals nicht im Detail geprüft (OFFEN, niedrig).
- **I Sicherheit:** **Keine Server-Secrets im Client** (Secret-Scan leer; nur publishable Anon-Key `:3958`). Durchgängig HTTPS (kein Cleartext gefunden). CLOUD host-gesperrt (`ALLOWED_HOSTS:3962`). localStorage-Klartext gerätelokal (I-01). Insgesamt starker Sicherheitsstand.
- **J Prozess & Konto:** Testspuren/Testpflicht/Verifizierung OFFEN (J-01/J-02) – zeitbestimmend.

---

## 6. Einreichungs-Checkliste

- [ ] Kanonische TWA-Domain festgelegt (P0-02)
- [ ] `bubblewrap build` → `app-release-signed.aab` (P0-01)
- [ ] Upload-Key gesichert, Play App Signing aktiviert (A-01)
- [ ] `/.well-known/assetlinks.json` an Domain-Wurzel, Fingerprint korrekt, erreichbar (C-01)
- [ ] `enableNotifications:true`, Push im TWA getestet (C-02)
- [ ] Billing-Entscheidung umgesetzt; Stripe im Build unerreichbar (D-01/D-02)
- [ ] Kamera/Mikro/Standort/Push im TWA real getestet (B-01), Offline getestet (H-01)
- [ ] Data-Safety-Formular exakt (E-01); Konto-Lösch-URL eingetragen (E-02)
- [ ] Content Rating (IARC), Zielgruppe 18+ / kein Families (F-02), Health-Deklaration (F-01), Werbe-Deklaration
- [ ] KI-Meldeweg vorhanden (F-03); Notfall-Disclaimer sichtbar (F-04)
- [ ] Screenshots erstellt (G-01); Beschreibung code-deckungsgleich (G-02)
- [ ] Datenschutz-URL dauerhaft erreichbar
- [ ] `targetSdkVersion` gegen aktuelle Play-Pflicht geprüft (A-02)
- [ ] Geschlossener Test gem. aktueller Neukonto-Pflicht durchlaufen (J-01)

---

## 7. Offene Fragen an den Entwickler

1. **Launch mit oder ohne In-App-Kauf?** (D-01) – bestimmt, ob der Play-Billing-Kaufweg jetzt sichtbar geschaltet und getestet werden muss.
2. **Welche Domain** liefert die TWA final aus – `darekkk80-neuss.github.io/Effyra/` oder eine eigene Domain? (P0-02, C-01) – davon hängen assetlinks + ALLOWED_HOSTS + Manifest-URLs ab.
3. Ist bereits ein **Google-Play-Entwicklerkonto** angelegt und verifiziert? (J-01/J-02)
4. Gibt es bereits eine **öffentliche Konto-Lösch-Seite** oder soll `datenschutz.html` als solche dienen? (E-02)

---

## 8. Verifikationsliste (gegen aktuelle Play-Doku prüfen)

- **A-02** Aktuell geforderte **Target-API-Ebene** für neue Apps/Updates.
- **J-01** **Neukonto-Testpflicht**: Mindest-Testerzahl und Mindest-Testdauer im geschlossenen Test.
- **J-02** **Developer-Verifizierung**: Identitätsprüfung + welche Kontaktdaten öffentlich im Store erscheinen.
- **G** **Store-Listing-Limits**: Zeichenlimits Titel/Kurz-/Langbeschreibung, Screenshot-/Feature-Graphic-Formate.
- **F-01/F-03/F-04** Genauer Wortlaut der aktuellen **Health-Apps-Policy**, **Generative-KI-Policy** und **Notfall-/SOS-Anforderungen**.
- **E-02** Aktuelle Ausgestaltung der **Account-Deletion-Anforderung** (In-App + Web-URL).
- **D-01/D-02** Aktuelle **Play-Billing-Pflicht** und Ausnahmen für digitale Güter.

> Hinweis gemäß Audit-Guardrails: Alle mit **„zu verifizieren"/OFFEN** markierten Punkte wurden **nicht** aus dem Gedächtnis behauptet; Play-Vorgaben ändern sich laufend und sind vor Einreichung gegen die offizielle Dokumentation zu prüfen.
