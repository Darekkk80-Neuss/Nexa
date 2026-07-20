# Effyra als Android‑App (TWA) im Google Play Store

Effyra ist eine Web‑App. Für **Google Play (inkl. Play Billing)** wird sie in eine
**TWA** (Trusted Web Activity) verpackt – ein dünner Android‑Wrapper, der die
Live‑Web‑App (`https://darekkk80-neuss.github.io/Effyra/`) im Vollbild lädt.

> **Wichtig:** Diese Schritte laufen auf **deinem** Rechner mit Android‑Toolchain
> und **deinem** Google‑Play‑Konto. Effyra selbst muss dafür nichts weiter tun –
> die App ist bereits eine installierbare PWA (Manifest + Service Worker sind drin).

---

## 0. Voraussetzungen (einmalig)
- **Node.js** (für Bubblewrap).
- **JDK 17** + **Android SDK** – Bubblewrap kann beides beim ersten Lauf selbst
  herunterladen/verwalten (es fragt danach).
- **Google‑Play‑Entwicklerkonto** (einmalig 25 $): https://play.google.com/console
- Bubblewrap installieren:
  ```bash
  npm install -g @bubblewrap/cli
  ```

## 1. App‑Icon als PNG bereitstellen
Play/Bubblewrap brauchen ein **512×512‑PNG** (SVG reicht nicht als Launcher‑Icon).
- `icon.svg` in ein **`icon-512.png`** (512×512) und **`icon-192.png`** exportieren
  (z. B. mit einem Grafiktool oder online).
- Beide ins Repo neben `index.html` legen und in `manifest.webmanifest` als Icons
  ergänzen (zusätzlich zum SVG). Danach pushen.

## 2. TWA‑Projekt erzeugen
```bash
bubblewrap init --manifest https://darekkk80-neuss.github.io/Effyra/manifest.webmanifest
```
Fragen: **packageId** z. B. `app.effyra.twa`, App‑Name `Effyra`, Start‑URL `/Effyra/`.
(Die mitgelieferte `twa-manifest.json` ist eine Referenz – Bubblewrap legt seine
eigene an.)

## 3. Bauen & signieren
```bash
bubblewrap build
```
- Beim ersten Mal wird ein **Signaturschlüssel** (`android.keystore`) erstellt –
  **sicher aufbewahren + Passwort merken!** Ohne ihn kannst du keine Updates
  veröffentlichen.
- Ergebnis: `app-release-signed.aab` (für Play) und eine `.apk` (zum Testen).

## 4. Digital Asset Links (der kniffligste Punkt)
Damit Android die TWA ohne Browser‑Adressleiste vertraut, muss unter der
**Domain‑Wurzel** eine Datei liegen:

```
https://darekkk80-neuss.github.io/.well-known/assetlinks.json
```

⚠️ **GitHub‑Pages‑Falle:** Das Effyra‑Repo bedient nur `…/Effyra/…`, **nicht** die
Domain‑Wurzel `darekkk80-neuss.github.io/`. Die Wurzel gehört einem Repo namens
**`darekkk80-neuss.github.io`** (User/Org‑Pages‑Site). Lösungen:
- **(empfohlen)** Ein Repo `darekkk80-neuss.github.io` anlegen und dort
  `/.well-known/assetlinks.json` ablegen, **oder**
- eine **eigene Domain** für Effyra verwenden und dort die Datei hosten.

Fingerprint holen und Datei erzeugen:
```bash
bubblewrap fingerprint         # zeigt den SHA-256 der Signatur
```
`assetlinks.json`:
```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "app.effyra.twa",
    "sha256_cert_fingerprints": ["DEIN:SHA256:FINGERPRINT:AUS:BUBBLEWRAP"]
  }
}]
```
Nach Play‑Upload nutzt Google außerdem einen **eigenen** Signatur‑Fingerprint
(App‑Signing) – den findest du in der Play Console unter *App‑Integrität* und
musst ihn **zusätzlich** in `sha256_cert_fingerprints` eintragen.

## 5. In Google Play hochladen
- Play Console → neue App → Store‑Eintrag ausfüllen (Name, Beschreibung,
  Screenshots, Datenschutzerklärung‑Link).
- **Datensicherheit‑Formular:** ehrlich angeben, dass Konto/Sync‑Daten in der
  Cloud (Supabase) liegen.
- `.aab` unter *Produktion* (oder erst *Interner Test*) hochladen → Review.

## 6. Bezahlung: Google Play Billing (Pflicht für digitale Abos)
Digitale Abos/Käufe **müssen** in Play‑Apps über **Play Billing** laufen
(Stripe ist dafür nicht erlaubt). In einer TWA geht das über die
**Digital Goods API + PaymentRequest**:
1. In der Play Console die Produkte anlegen, passend zu Effyra:
   - Abo `effyra_premium` – 4,99 €/Monat
   - Abo `effyra_family` – 14,99 €/Monat
   - Abo `effyra_adult` – 3,99 €/Monat · `effyra_child` – 0,99 €/Monat
   - Einmalkauf `effyra_lifetime` – **12,99 €** (ohne KI) · Verbrauchskauf `effyra_ai_boost` – 4,99 €

   > 📋 Vollständige Schritt-für-Schritt-Anleitung für den Anmeldetag inkl. exakter
   > Produkt-IDs, Server-Verifikation (Play Developer API), RTDN und Trial-Durchsetzung:
   > **`GOOGLE_PLAY_SETUP.md`**. Der Code ist bereits vorbereitet: `PLAY_PRODUCTS` +
   > `startPlayPurchase()` im Client, `supabase/functions/play-verify`, `supabase-trial-and-play.sql`.
2. Im TWA‑Build `"features": { "playBilling": { "enabled": true } }` aktivieren
   (Bubblewrap fragt danach bzw. in der twa-manifest.json ergänzen).
3. Im Web‑Client `startCheckout()` durch Play‑Billing‑Aufrufe ersetzen
   (Digital Goods API `getDetails`/`PaymentRequest`), Kauf serverseitig über
   die **Play Developer API** verifizieren und Entitlement (Tier/Credits) in
   Supabase setzen. → Das baue ich, sobald die Play‑Produkte existieren.

---

## Was bereits erledigt ist (Effyra‑Seite)
- ✅ Installierbare **PWA**: `manifest.webmanifest` + **Service Worker** (`sw.js`,
  Netzwerk‑zuerst, offline‑fähig) + Icons verlinkt.
- ✅ Live‑App unter `https://darekkk80-neuss.github.io/Effyra/`.

## Was noch dein Part ist
1. `icon-512.png` / `icon-192.png` erzeugen (Schritt 1).
2. Play‑Entwicklerkonto + Bubblewrap‑Build (Schritte 0–3).
3. `assetlinks.json` an der Domain‑Wurzel hosten (Schritt 4).
4. Play‑Produkte anlegen (Schritt 6) → dann verdrahte **ich** Play Billing im Client + Backend.
