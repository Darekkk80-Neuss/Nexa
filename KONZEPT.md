# Effyra – Lizenz-, Rollen- & Credit-Modell (optimierte Version)

Ziel: höhere langfristige Einnahmen, bessere Nutzerpsychologie, planbare KI-Kosten und ein skalierbares SaaS-Modell.

**Positionierung:** „Der intelligente Familienassistent, der den Alltag organisiert, Zeit spart und die Familie verbindet."

---

## 1. Kostenloser Testzugang — Effyra Free Trial

- **Dauer:** 14 Tage
- **Enthalten:** Basisfunktionen, Kalender, Aufgaben, Erinnerungen, Dokumentenablage, Familiengrundfunktionen testen
- **Nicht enthalten:** Effyra AI · KI-Credits · eigener API-Key · erweiterte Synchronisierung
- **Nach Ablauf:** Der Account wechselt in den eingeschränkten Modus mit Plan-Auswahl (Lifetime Basic · Effyra AI Premium · Effyra Family). Daten bleiben erhalten.

## 2. Lifetime Basic — einmal kaufen, dauerhaft nutzen

- **Einführungspreis:** 4,99 € (später optional 7,99–9,99 €)
- **Enthalten:** komplette App **ohne KI**, keine monatlichen Gebühren, persönliche Datenverwaltung, Kalender, Aufgaben, Erinnerungen, Dokumente
- **Nicht enthalten:** Effyra AI · KI-Credits · Familien-KI-Funktionen
- **Optional:** Erwachsene Nutzer können einen **eigenen KI-API-Key** hinterlegen (BYOK).

## 3. Effyra AI Premium — für Einzelpersonen

- **Preis:** 4,99 €/Monat · oder 49,99 €/Jahr
- **Voraussetzung:** mindestens 18 Jahre
- **Enthalten:** **500 Effyra Credits pro Monat** plus alle KI-Funktionen: Effyra AI Sprachassistent, Dokumentenanalyse, intelligente Vorschläge, automatische Planung, Zusammenfassungen, persönliche Auswertungen, Automatisierungen

## 4. Effyra Family — der digitale Familienassistent

- **Preis:** 15,99 €/Monat · oder 149,99 €/Jahr
- **Enthalten:** Familienverwaltung mit **1 Administrator + 1 weiterer Erwachsener + bis zu 3 Kinder**
- **Zusätzlich:** Familienzentrale, gemeinsamer Familienbereich, Synchronisierung, Rollenverwaltung, Berechtigungen, Haushaltsorganisation
- **Familien-Credits:** **1500 Effyra Credits/Monat** – gemeinsamer Pool, **nur Erwachsene** verbrauchen Credits.

  *Beispiel:* Darius 900 + Sandra 600 = 1500/1500 verbraucht · Kinder 0 Credits.

## 5. Effyra Credit Boost

Wenn die Credits verbraucht sind:

- **Family Boost:** 4,99 € → **+1500 Effyra Credits**
- **Credit-Boost (Effyra AI):** 4,99 € → **+500 Effyra Credits**
- **Gültigkeit:** bis Ende des aktuellen Abrechnungszeitraums

## 6. Familien-Erweiterungen

Ausschließlich über die **Familienzentrale → Mitglieder verwalten → Mitglied hinzufügen**.

| Erweiterung | Preis | Enthalten |
|---|---|---|
| Zusätzliches Erwachsenen-Mitglied | 3,99 €/Monat | Vollzugriff, Familiensynchronisierung, eigenes Profil, **500 Effyra Credits/Monat** |
| Zusätzliches Kinder-Mitglied | 0,99 €/Monat | Kinderkonto, eigene Aufgaben, Termine, Erinnerungen, freigegebene Inhalte — **ohne** KI, Credits, eigenen API-Key |

## 7. Effyra Credit-System

Die KI wird **nicht pro Anfrage**, sondern über **Credits** abgerechnet:

| Funktion | Credits |
|---|---|
| einfache KI-Frage | 1 |
| Text erstellen | 2 |
| Sprachassistent | 2 |
| Bild/Dokument scannen | 5 |
| Wochenplanung erstellen | 5 |
| Rechnung analysieren | 10 |
| Große Dokumentenanalyse | 20 |

## 8. Eigene KI-Verbindung (BYOK)

- **Nur Erwachsene**, nie Kinderkonten.
- Eigener API-Key → eigene KI-Kosten, **keine Effyra Credits nötig**, unbegrenzte Nutzung.

## 9. Rollenmodell (Backend)

| User Role | Subscription Status |
|---|---|
| `OWNER` | `FREE_TRIAL` |
| `ADULT_MEMBER` | `BASIC_LIFETIME` |
| `CHILD_MEMBER` | `AI_MONTHLY` · `AI_YEARLY` |
| | `FAMILY_MONTHLY` · `FAMILY_YEARLY` |
| | `EXPIRED` |

## 10. Credit-Backend (Felder auf `profiles`)

`AI_ENABLED` · `CREDIT_BALANCE` (verbleibend) · `CREDIT_LIMIT_MONTHLY` · `CREDIT_USED_CURRENT_PERIOD` · `CREDIT_RESET_DATE` · `HAS_CUSTOM_API_KEY`

## 11. Sicherheitsregeln (serverseitig erzwungen)

- ✅ Kinder können **niemals** KI starten
- ✅ Kinder verbrauchen **keine** Credits
- ✅ Familienfunktionen nur mit aktivem Family-Abo
- ✅ Premium nur bei gültiger Zahlung
- ✅ Credits nicht manipulierbar (Verbrauch/Kauf nur über `service_role`-RPCs)
- ✅ API-Keys verschlüsselt speichern

## 12. Beispiel-Familienanzeige

```
Effyra Family
👤 Darius   Administrator
👤 Sandra   Erwachsen
👦 Liam     Kind

KI-Verbrauch — Effyra Credits: 800 / 1500 verbraucht
Reset: 01.08.2026
```

---

## Umsetzung im Code

- **Client (`index.html`):** interne Stufe `account.tier` ∈ `free | basic | ai | family`, Rolle `account.role`, Abo-Status `account.status`. 14-Tage-Testphase, Credit-Anzeige, Paywall mit Monats-/Jahres-Umschalter, Credit-Boost, Kinder-Sperren. Enforcement steht per `ENFORCE_TIERS`/`BACKEND_V2` bis zum Scharfschalten auf `false`.
- **Backend (`supabase-tiers.sql`):** Spalten für Stufe/Status/Rolle/Credits, RPCs `get_entitlements`, `consume_credits` (Credit-Kosten je Aktion, Family-Pool, Kinder-Sperre), `apply_purchase` (alle Kauf-Arten), `add_family_member`. Einrichtung → [BACKEND.md](BACKEND.md).

## Status & offene Punkte

**Fertig (dieses Update):**
- ✅ 14-Tage-Testphase, Stufen `free/basic/ai/family`, Rollen & Abo-Status
- ✅ Effyra Credits (Anzeige, Limits 500/1500, Boost) + Credit-Kosten-Tabelle
- ✅ Paywall mit drei Karten + Monats-/Jahres-Umschalter
- ✅ Kinder-Sperren im Client (keine KI/Credits/API-Key)
- ✅ Backend-RPCs inkl. Family-Pool, Kinder-Sperre und Migration aus `medium/premium`

**Zusätzlich umgesetzt:**
- ✅ **Familienzentrale → Mitglieder verwalten** – Roster mit Rollen, geteilter Credit-Pool, „Mitglied hinzufügen" (Erwachsener 3,99 € / Kind 0,99 €, enthaltenes Kontingent + Erweiterungen via Checkout). Server-seitiges Konten-Linking läuft nach Zahlung über den Webhook (`add_family_member`).
- ✅ **Medikamentenplan (Wochen-Vergabe)** – pro Person, mit Einnahmezeiten & Wochentagen, „Heute als Aufgaben eintragen", synchronisiert über die Familie.

**Noch offen (nächste Schritte):**
- ⏳ **Konten-Einladung/-Anlage** – echte Auth-Verknüpfung der Family-Mitglieder (Einladungslink/E-Mail) + Webhook-Provisionierung via `add_family_member`.
- ⏳ **Kinderkonten-Onboarding** – Anlage, Verknüpfung mit der Familie, eingeschränkte Ansicht (Aufgaben/Termine/Erinnerungen ohne KI).
- ⏳ **Scharfschalten** – `ENFORCE_TIERS`/`BACKEND_V2` auf `true`, KI-Proxy + Stripe-Produkte/Preise anlegen und deployen (siehe [BACKEND.md](BACKEND.md), Phase 2).
- ⏳ **Credit-Kosten im Proxy** – `consume_credits(user, cost)` je Aktion mit den Werten aus Abschnitt 7 verdrahten (einfache Frage 1 … große Analyse 20).
- ⏳ **Alterprüfung (ab 18)** für Effyra AI Premium serverseitig durchsetzen.

## Ehrliche Einordnung

Effyra ist eine reine Client-App: Solange die Enforcement-Schalter aus sind bzw. ohne KI-Proxy, ist die Sperre eine **Komfort-/Produktsperre**, kein wasserdichter Schutz. Wirklich fälschungssicher wird das Credit- und Rollenmodell erst mit dem serverseitigen Proxy aus Phase 2 (siehe [BACKEND.md](BACKEND.md)), der bei jedem KI-Aufruf Stufe, Rolle und Credits prüft. Das Supabase-Backend hier ist bereits die richtige Grundlage dafür.
