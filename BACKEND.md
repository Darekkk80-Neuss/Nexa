# NEXA – Backend einrichten (Supabase, kostenlos)

Mit dem Backend werden Nutzer **zentral verwaltet**: Du siehst alle Konten in einem Dashboard, die 3-Tage-Testphase startet serverseitig (nicht manipulierbar), und Premium-Codes sind einmalig einlösbar. Der kostenlose Tarif reicht für bis zu **50.000 monatlich aktive Nutzer**.

Die App erkennt automatisch, ob das Backend konfiguriert ist:
- **Ohne Konfiguration** → lokaler Modus wie bisher (Konto nur auf dem Gerät)
- **Mit Konfiguration** → echte Cloud-Konten mit E-Mail + Passwort

---

## Einrichtung in ~10 Minuten

### 1. Supabase-Konto erstellen
[supabase.com](https://supabase.com) → **Start your project** → am einfachsten **mit GitHub anmelden** (kostenlos, keine Kreditkarte).

### 2. Projekt anlegen
**New project** → Name z. B. `nexa`, Region **Central EU (Frankfurt)** (Datenschutz/DSGVO), Datenbank-Passwort generieren lassen und sicher notieren. Dann ~2 Minuten warten, bis das Projekt bereit ist.

### 3. Datenbank einrichten
Linke Seitenleiste → **SQL Editor** → **New query** → den **kompletten Inhalt** der Datei [`supabase-setup.sql`](supabase-setup.sql) einfügen → **Run**. Unten sollte „Success" erscheinen.

**Optional – Familien-Sync:** Wer die **Familienzentrale mit dem Partner synchronisieren** möchte, führt zusätzlich [`supabase-family.sql`](supabase-family.sql) im SQL-Editor aus (gleicher Ablauf). Ohne dieses Script funktioniert die Familienzentrale lokal auf dem Gerät; nur die Partner-Synchronisierung braucht es. Der Notfallbereich bleibt bewusst immer nur lokal (sensible Daten).

### 4. E-Mail-Bestätigung ausschalten (empfohlen)
**Authentication → Sign In / Providers → Email** → Schalter **„Confirm email" ausschalten** → Save.

> Warum? Im kostenlosen Tarif verschickt Supabase nur ~2 Bestätigungs-Mails pro Stunde – neue Nutzer könnten sich sonst nicht sofort anmelden. Später (mit eigenem SMTP-Server, z. B. Resend kostenlos) kannst du die Bestätigung wieder aktivieren.

### 5. Site-URL eintragen (für „Passwort vergessen")
**Authentication → URL Configuration** → **Site URL**: `https://darekkk80-neuss.github.io/Nexa/` → Save.

### 6. Die zwei Schlüsselwerte kopieren
**Project Settings (Zahnrad) → API**:
- **Project URL** (sieht aus wie `https://abcdefgh.supabase.co`)
- Der öffentliche Key: je nach Projekt-Alter heißt er **„anon public"** (beginnt mit `eyJ…`) oder — bei neuen Projekten — **„Publishable key"** (beginnt mit `sb_publishable_…`). Beide funktionieren gleich.

### 7. In die App eintragen
In `index.html` ganz oben im Script-Block die markierte Stelle ausfüllen:

```js
const SUPABASE_URL = 'https://DEIN-PROJEKT.supabase.co';
const SUPABASE_ANON_KEY = 'eyJ…';
```

Dann committen und pushen – fertig. *(Oder gib mir die beiden Werte, dann trage ich sie ein und teste alles durch.)*

> 🔓 **Ist der anon-Key im öffentlichen Repo ein Problem? Nein.** Er ist dafür gemacht, im Browser zu stehen. Die Sicherheit kommt aus den Datenbank-Regeln (Row Level Security), die das SQL-Script setzt: Jeder Nutzer sieht nur sein eigenes Profil, und `plan`/`trial_start` kann niemand selbst ändern – nur die serverseitige Code-Einlösung.

---

## Nutzer verwalten (dein Admin-Bereich)

| Was | Wo im Supabase-Dashboard |
|---|---|
| Alle Nutzer sehen, löschen, sperren | **Authentication → Users** |
| Plan & Testphase einsehen/ändern | **Table Editor → profiles** (Spalte `plan` auf `premium` setzen = manuell freischalten) |
| Eingelöste Codes sehen | **Table Editor → premium_codes** |
| Neue Premium-Codes anlegen | **SQL Editor**: `insert into public.premium_codes (code_hash) values (encode(digest(upper('NEXA-DEIN-CODE'), 'sha256'), 'hex'));` |

**Wichtig:** Im Cloud-Modus ist jeder Code **einmalig** einlösbar (anders als im lokalen Modus).

---

## Was das Backend abdeckt – und was (noch) nicht

✅ Zentrale Konten (E-Mail + Passwort, gehasht bei Supabase) · ✅ Testphase serverseitig · ✅ Premium-Einlösung serverseitig, einmalig · ✅ Admin-Dashboard · ✅ Passwort-vergessen per E-Mail-Link

⚠️ **Bewusst noch lokal:** Aufgaben, Termine, Dokumente und Chat bleiben auf dem Gerät (Datenschutz-Versprechen der App). ⚠️ Die **Anzeige**-Sperre in der App bleibt clientseitig – wirklich wasserdicht wird es erst mit dem KI-Proxy aus Phase 2 (siehe unten), der bei jedem KI-Aufruf serverseitig Plan und Limit prüft. Das Backend hier ist dafür bereits die richtige Grundlage.

---

# Phase 2 – Gehostete KI (Proxy) + Stripe-Bezahlung

Damit läuft **Premium mit vom Anbieter gestelltem Schlüssel** sicher: Der echte Claude-Schlüssel liegt **nur auf dem Server**, das **500/Monat-Kontingent wird serverseitig** gezählt (fälschungssicher), und **Medium/Premium/Nachbestellung** werden per **Stripe** bezahlt.

> Der Client ist vorbereitet, aber standardmäßig **aus**: In `index.html` steht `const BACKEND_V2 = false;`. Erst nach den folgenden Schritten auf `true` setzen, committen, pushen.

## A. Datenbank erweitern
SQL-Editor → **kompletten Inhalt** von [`supabase-tiers.sql`](supabase-tiers.sql) einfügen → **Run**. (Fügt Stufen-/Kontingent-Spalten und die RPCs `get_entitlements`, `consume_ai`, `apply_purchase` hinzu; setzt bestehende Premium-Nutzer auf `tier='premium'`.)

## B. Supabase CLI installieren & anmelden
```bash
npm i -g supabase        # oder: scoop install supabase (Windows)
supabase login
supabase link --project-ref DEINE-PROJEKT-REF   # Ref = Subdomain der Project URL
```

## C. Secrets setzen
```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...        # der echte Claude-Schlüssel (gibst du mir/hier später)
supabase secrets set STRIPE_SECRET_KEY=sk_test_...
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...      # aus Schritt E
supabase secrets set STRIPE_PRICE_MEDIUM=price_...        # aus Schritt D
supabase secrets set STRIPE_PRICE_PREMIUM=price_...
supabase secrets set STRIPE_PRICE_TOPUP=price_...
supabase secrets set APP_URL=https://darekkk80-neuss.github.io/Nexa/
```
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` sind in Functions automatisch vorhanden.

## D. Stripe-Produkte anlegen
[dashboard.stripe.com](https://dashboard.stripe.com) → **Test-Modus** → **Products**:
- **Medium** – Einmalzahlung 4,99 € → Price-ID kopieren → `STRIPE_PRICE_MEDIUM`
- **Premium** – wiederkehrend 4,99 €/Monat → `STRIPE_PRICE_PREMIUM`
- **KI-Kontingent +500** – Einmalzahlung 4,99 € → `STRIPE_PRICE_TOPUP`

## E. Functions deployen
```bash
supabase functions deploy claude-proxy
supabase functions deploy stripe-checkout
supabase functions deploy stripe-webhook --no-verify-jwt
```
(Der Webhook prüft die Stripe-Signatur selbst, daher `--no-verify-jwt`.)

## F. Stripe-Webhook eintragen
Stripe → **Developers → Webhooks → Add endpoint**
- URL: `https://DEIN-PROJEKT.functions.supabase.co/stripe-webhook`
- Events: `checkout.session.completed`, `invoice.paid`, `customer.subscription.deleted`
- **Signing secret** (`whsec_…`) kopieren → als `STRIPE_WEBHOOK_SECRET` setzen (Schritt C) und `stripe-webhook` erneut deployen.

## G. Aktivieren
In `index.html`: `const BACKEND_V2 = true;` → committen & pushen. Fertig.

### Danach automatisch
- **Premium-Nutzer ohne eigenen Schlüssel** → KI läuft über den Proxy, jede Abfrage zählt serverseitig, Balken/Nachbestellen sind live, Reset am 1.
- **Kauf-Buttons** öffnen Stripe-Checkout; nach Zahlung setzt der Webhook die Stufe. Bei Rückkehr (`?checkout=success`) gleicht die App den Stand ab.
- **Eigener Schlüssel** in den Einstellungen bleibt die unbegrenzte Alternative (läuft direkt an Anthropic, kein Kontingentverbrauch).

> Sicherheit: `consume_ai`/`apply_purchase` sind `security definer` und für normale Nutzer gesperrt – nur Proxy/Webhook (service_role) dürfen sie aufrufen. Der Anthropic-Schlüssel steht ausschließlich als Function-Secret, nie im Client.
