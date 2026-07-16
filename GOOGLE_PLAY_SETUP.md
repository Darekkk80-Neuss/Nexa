# Google Play – Setup & Billing-Verschmelzung (Effyra)

Diese Checkliste ist so gebaut, dass du sie **von oben nach unten** abarbeitest, sobald du im
Google-Play-Konto bist. Der Code (Client + Server) ist bereits darauf vorbereitet – die
Produkt-IDs, der Kauf-Weg und die Entitlement-Logik warten nur auf die echten Play-Produkte.

> **Wichtig:** In einer Play-App (TWA) **müssen** digitale Käufe über **Google Play Billing**
> laufen (Stripe ist dafür nicht erlaubt). Der Client nutzt das automatisch, sobald er in der
> TWA läuft (`hasPlayBilling()`), und fällt im Web auf Stripe/Freischalt-Code zurück.

---

## 0. Voraussetzungen (einmalig)
- [ ] **Google-Play-Entwicklerkonto** (einmalig 25 $): https://play.google.com/console
- [ ] TWA-Build mit **Play Billing aktiviert** (Bubblewrap): in `twa-manifest.json`
      `"features": { "playBilling": { "enabled": true } }` – siehe `ANDROID.md`.
- [ ] AAB in Play hochgeladen (mind. **Interner Test**), damit Produkte testbar sind.

---

## 1. Produkte in der Play Console anlegen  →  *exakt diese IDs*

**Play Console → Monetarisierung → Produkte.** Die IDs müssen **1:1** mit dem Code übereinstimmen
(`PLAY_PRODUCTS` in `index.dev.html`, `ADDON_PRODUCTS`, sowie `grant_play_purchase` in der SQL).

| Produkt-ID (SKU)      | Typ                | Preis        | Was es freischaltet |
|-----------------------|--------------------|--------------|----------------------|
| `effyra_premium`      | **Abo** (subs)     | 4,99 €/Monat | Pro: KI + 500 Credits/Monat |
| `effyra_family`       | **Abo** (subs)     | 14,99 €/Monat| Familie: gemeinsames KI-Kontingent |
| `effyra_lifetime`     | **Einmalkauf** (in-app) | **12,99 €** | Komplette App dauerhaft, **ohne** KI |
| `effyra_ai_boost`     | **Verbrauchbar** (consumable) | 4,99 € | +500 KI-Credits (Nachbuchung) |
| `effyra_adult_addon`  | **Abo** (subs)     | 3,99 €/Monat | +1 Erwachsener im Familienabo |
| `effyra_child_addon`  | **Abo** (subs)     | 0,99 €/Monat | +1 Kind im Familienabo |

- [ ] Alle 6 Produkte angelegt, **IDs exakt** wie oben, Status **aktiv**.
- [ ] Für die Abos je ein **Basisplan** (monatlich) + Preis in EUR (weitere Länder optional).
- [ ] `effyra_lifetime` als **einmaliges** In-App-Produkt (nicht verbrauchbar).
- [ ] `effyra_ai_boost` als **verbrauchbares** Produkt (mehrfach kaufbar).

---

## 2. Server-Verifikation vorbereiten (Play Developer API)

Käufe werden serverseitig verifiziert, damit niemand das Entitlement fälscht.

- [ ] **Google Cloud Projekt** mit der Play Console verknüpfen
      (Play Console → *Einstellungen → API-Zugriff*).
- [ ] **Service-Account** anlegen, Rolle „**Finanzdaten anzeigen / Bestellungen verwalten**".
      JSON-Schlüssel herunterladen.
- [ ] In Supabase als Secret hinterlegen:
      `supabase secrets set PLAY_SERVICE_ACCOUNT_JSON='<inhalt-der-json>'`
      `supabase secrets set PLAY_PACKAGE_NAME='app.effyra.twa'`

Die fertige Verify-Function liegt schon bereit: **`supabase/functions/play-verify`**
(nimmt `{sku, token, type}` vom Client, prüft bei Google, ruft `grant_play_purchase`).
- [ ] `supabase functions deploy play-verify`

---

## 3. RTDN – Renewals & Kündigungen (empfohlen)

Real-time Developer Notifications halten Abos aktuell (Verlängerung, Storno, Rückerstattung).

- [ ] In **Google Cloud → Pub/Sub** ein Topic `play-rtdn` anlegen.
- [ ] Play Console → *Monetarisierung → Monetarisierungs-Setup → Echtzeit-Benachrichtigungen*
      → Topic eintragen.
- [ ] Pub/Sub-**Push-Abo** auf die URL der Verify-Function (Endpoint `?rtdn=1`) zeigen lassen.
      (Die Function erkennt RTDN-Nachrichten und ruft dieselben Entitlement-Funktionen.)

---

## 4. Datenbank: Trial + Entitlements scharf schalten

Die SQL liegt bereit: **`supabase-trial-and-play.sql`** – im Supabase **SQL-Editor** ausführen.
Sie bewirkt:
- Free-Trial mit **50 KI-Credits / 14 Tagen** wird **serverseitig** durchgesetzt
  (heute blockiert `consume_ai` alle Nicht-Premium komplett!).
- `grant_play_purchase(user, sku)` setzt je Produkt das richtige Entitlement.

- [ ] `supabase-trial-and-play.sql` ausgeführt (vorher gegen deine aktuelle
      `get_entitlements`-Version aus `supabase-family-entitlements.sql` gegengelesen – siehe
      Kommentar oben in der Datei).

---

## 5. Testen (vor dem Live-Gang)
- [ ] **Lizenz-Tester** in der Play Console eintragen (deine Test-Accounts).
- [ ] In der TWA jeden Kauf 1× durchspielen (Pro, Familie, Lifetime, Boost, Add-ons).
- [ ] Prüfen: Nach Kauf zeigt das Dashboard-Widget die richtige Stufe (kommt aus
      `get_entitlements` → `syncEntitlements()`).
- [ ] Trial-Ende simulieren (Test-Account, `trial_start` zurückdatieren) → KI gesperrt,
      App ohne KI weiter nutzbar.

---

## Mapping auf einen Blick (Client ↔ Play ↔ Server)

| Paywall-Button (`data-buy`) | Play-SKU            | `grant_play_purchase` → Wirkung |
|-----------------------------|---------------------|----------------------------------|
| `premium`                   | `effyra_premium`    | tier=premium, +32 Tage, 500 Credits |
| `family`                    | `effyra_family`     | Familienabo (`apply_family_purchase`) |
| `lifetime`                  | `effyra_lifetime`   | lifetime=true, App dauerhaft (ohne KI) |
| `topup`                     | `effyra_ai_boost`   | ai_extra += 500 |
| `bookAdult` / `bookChild`   | `effyra_*_addon`    | Familien-Platz +1 |

**Reihenfolge am Anmeldetag:** 1 → 2 → 4 → 5 → (3 optional). Danach ist die App verkaufsbereit.
