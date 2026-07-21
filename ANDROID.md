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

## 2a. Pflichtfristen von Google Play

> **Stand 21.07.2026 – beide Fristen enden am 31.08.2026.** Play meldet sie in
> der Console. Verlängerung auf den 01.11.2026 ist auf Antrag möglich.

| Anforderung | Ab 31.08.2026 nötig | Wo geregelt |
|---|---|---|
| **Ziel-API-Level** | **API 36** (Android 16) für neue Updates. Bestandsapps brauchen mindestens API 35, sonst erreichen sie keine neuen Nutzer auf neueren Geräten | `targetSdkVersion` im TWA-Projekt |
| **Play Billing Library** | **Version 8 oder höher**, sonst werden Updates abgelehnt | kommt über `android-browser-helper`, das Bubblewrap mitbringt |

Beides steckt in der Android-Hülle, **nicht** in der Web-App – ein Push ins
Web-Repo ändert daran nichts. Der Weg ist für beide derselbe:

```bash
npm install -g @bubblewrap/cli@latest   # bringt neueres android-browser-helper
cd <dein TWA-Ordner>                     # der von "bubblewrap init", nicht dieses Repo
bubblewrap update                        # zieht Wrapper und Abhängigkeiten nach
bubblewrap build
```

Danach in der erzeugten `twa-manifest.json` prüfen, dass `targetSdkVersion` auf
**36** steht, und `appVersionCode` **erhöhen** – Play weist ein AAB mit gleicher
oder niedrigerer Nummer ab.

> ⚠️ **Mit demselben Schlüssel signieren** (`android.keystore`, Alias `effyra`).
> Ein anderer Schlüssel bedeutet: Play lehnt das Update ab, und die
> Digital Asset Links stimmen nicht mehr – die App öffnete sich dann mit
> Browser-Adressleiste. Nach dem Bauen mit `bubblewrap fingerprint` gegenprüfen,
> dass der SHA-256 unverändert ist (siehe Abschnitt 4).

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
   - Verbrauchskauf `effyra_ai_boost` (KI-Credits)
   > **Kein Lifetime-Produkt.** Die SKU `effyra_lifetime` wird serverseitig zwar
   > behandelt, aber **nicht verkauft** – im Client gibt es nur `effyra_premium`,
   > `effyra_family` und `effyra_ai_boost` (geprüft 21.07.2026). Die Module sind
   > dauerhaft kostenlos, kostenpflichtig ist allein die KI.

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
