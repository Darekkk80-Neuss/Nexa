# Digital Asset Links (TWA-Vertrauensanker)

`assetlinks.json` verknüpft die Android-TWA mit der Web-Domain. **Ohne diese Datei zeigt die App
eine Browser-Adressleiste** → Google Play wertet sie als reinen Webview (Ablehnungsgrund).

## 1. SHA-256-Fingerprint einsetzen
`REPLACE_WITH_PLAY_APP_SIGNING_SHA256_FINGERPRINT` in `assetlinks.json` ersetzen durch den
**SHA-256-Fingerprint des Play-App-Signing-Zertifikats**:

- **Play Console** → App → *Release* → *Setup* → *App signing* → „App signing key certificate"
  → SHA-256-Fingerprint kopieren (Format `AB:CD:…`).
- **Wichtig:** Nicht den Upload-Key, sondern den **App-Signing-Key** (den Google zum Signieren der
  ausgelieferten App nutzt). Bei Play App Signing sind das unterschiedliche Schlüssel.
- Zusätzlich kann der lokale Upload-Key-Fingerprint mit aufgenommen werden (mehrere Einträge im
  Array), damit auch lokal signierte Test-APKs vertraut werden:
  `keytool -list -v -keystore android.keystore -alias effyra`

## 2. An die **Domain-Wurzel** deployen
Android sucht die Datei ausschließlich unter:
```
https://<DEINE-DOMAIN>/.well-known/assetlinks.json
```
`packageId` = `app.effyra.twa` (siehe `twa-manifest.json`).

- **Wird die TWA von `darekkk80-neuss.github.io/Effyra/` geladen**, muss die Datei an der
  **Root** `https://darekkk80-neuss.github.io/.well-known/assetlinks.json` liegen → das gehört
  einem **separaten Repo** namens `darekkk80-neuss.github.io` (User-Pages-Site). Diese Datei dorthin
  kopieren.
- **Wird die TWA von einer eigenen Domain** (z. B. `gonsoft-labs.de`) geladen, die aus **diesem**
  Repo bedient wird, liegt sie hier bereits richtig (`.well-known/assetlinks.json`). Dann `host`,
  `webManifestUrl`, `startUrl` in `twa-manifest.json` und `ALLOWED_HOSTS` in `index.dev.html` auf
  diese Domain anpassen.

## 3. Prüfen
```
https://developers.google.com/digital-asset-links/tools/generator
```
oder direkt die URL im Browser öffnen (muss das JSON ausliefern, Content-Type application/json).
