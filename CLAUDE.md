# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Ordela (formerly Effyra — technical IDs, repo name, package name, and the live URL still say `effyra`) is a family/everyday-life organizer delivered as a **single-file PWA**: photograph letters and understand them, extract deadlines, manage tasks/calendar, and an AI chat that plans the day. Vanilla JavaScript, no framework, local-first (`localStorage`), with an optional Supabase backend. Packaged for Google Play as a TWA.

Live: `https://darekkk80-neuss.github.io/Effyra/` · Git remote `Darekkk80-Neuss/Effyra`, branch `master`.

## The one rule that matters most

**Edit `index.dev.html` (the ~16,900-line readable source). NEVER edit `index.html`** — it is the minified build artifact produced by `build.mjs`. Editing `index.html` directly is silently overwritten on the next build, and `check-build.mjs` will reject the commit anyway.

## Commands

```bash
npm install                          # once — installs esbuild (devDependency)
node build.mjs                       # index.dev.html → minified index.html; stamps build ID
node check-build.mjs                 # verifies index.html was built from current source (exit 1 = stale)
git config core.hooksPath .githooks  # once per clone — enables build enforcement (or: npm run hooks)
```

There is **no test suite and no linter.** Verification is done by rendering the app (e.g. headless Chrome via `puppeteer-core`) and checking `check-build.mjs` passes. Ad-hoc verification scripts belong in the scratchpad, not the repo.

### Build pipeline

`build.mjs` minifies **only inline `<script>` and `<style>`** blocks (esbuild) — no HTML minification (the markup has browser-tolerated quirks a strict parser rejects), and the external Supabase `<script src>` is skipped. It then stamps a time-based build ID `YYYYMMDD-HHMM` into `index.html`, `sw.js` (the `const BUILD` line — drives the service-worker cache name), and `version.json`. `check-build.mjs` recomputes a sha256 fingerprint of the source and compares it to `<meta name="effyra-src">` in the output; the `.githooks/` (pre-commit, pre-merge-commit, pre-push) run it automatically. Because the build ID is time-based, two builds never produce byte-identical files — this is why the check uses a content fingerprint, not a rebuild-and-diff.

### Deploying the client

`node build.mjs` → `git add -A` (covers `index.dev.html`, `index.html`, `sw.js`, `version.json`) → commit → `git push origin master`. GitHub Pages auto-deploys; it queues builds and can take several minutes, which is the usual reason a change "isn't live yet." Confirm with `version.json` at the live URL. To force-upgrade clients out of the field, set `min` in `version.json` to the oldest allowed build ID (build.mjs preserves it; empty `""` lifts the block).

## Architecture landmarks (all in `index.dev.html`)

Line numbers drift — search for the marker rather than trusting the number.

- **Feature flags** (~line 5440–5511): `ENFORCE_TIERS` (currently `false`), `ENFORCE_AI_CREDITS` (`true`), `BACKEND_V2`, `AI_VOICE`. Guard clauses throughout key off these — flipping one changes gating app-wide.
- **Domain lock** (~5439–5446): `SUPABASE_URL`/`SUPABASE_ANON_KEY` (the anon key is public and belongs in the repo), `ALLOWED_HOSTS`, `HOST_OK`, `CLOUD`. The backend only activates on an allowed host; copies of the app on any other domain run local-only. Edge functions are reached via `FN_URL(name)`.
- **Two i18n systems.** (1) An explicit `const I18N = {de,en,...}` map read by `t(key)` (~2805). (2) `TDICT_SRC` (~3113) where **the German UI text IS the dictionary key**. The six core languages (`de/en/fr/es/it/pl`, see `CORE_LANGS`) are **fully static — no AI-translation fallback.** Consequence: if you change any German UI string (even removing an emoji) without updating its `TDICT_SRC` key, the other five languages silently fall back to German. Always update the key alongside the German text.
- **esbuild escapes emoji.** In the built `index.html`, emoji become `\u{1F34C}`-style code-point escapes (also `\uNNNN`, `\xNN`). When grepping the built output, decode `\u{...}` **first**. Prefer searching `index.dev.html`.
- **Local preview gotcha.** Open the app via `http://[::1]:<port>/`, **not** `localhost` — `localhost`/`127.0.0.1` are in `ALLOWED_HOSTS`, so they enter CLOUD mode and discard a locally-injected test account. Under `[::1]`, `HOST_OK` is false → pure local mode, and a `localStorage['effyra_account']` (`loggedIn:true`) is accepted.
- **Local-first data model.** `localStorage` keys `effyra_account` and `effyra_data`; optional Supabase sync mirrors into `user_state`.

## Backend (Supabase) — read RUNBOOK.md first

`RUNBOOK.md` is the **authoritative source** for deploy order, per-function flags, and secrets. Do not deploy or run SQL without it. The essentials:

- **~23 `supabase-*.sql` files are run BY HAND** in the dashboard SQL editor in a **mandatory order** (several redefine the same functions; last-run wins). The order and the "deliberately duplicated" functions are tabulated in RUNBOOK §1.
- **~15 edge functions** deploy with `supabase functions deploy <name>`. `--no-verify-jwt` is a **per-function setting reset on every deploy**: cron/webhook functions (`due-reminder`, `morning-push`, `overdue-reminder`, `weather-push`, `play-verify`, `stripe-webhook`) **must** use it; client-auth functions (`claude-proxy`, `fuel-proxy`, `meal-translate`, …) must **not**. A blanket deploy without the flag silently 401s all cron pushes. Full split in RUNBOOK §2.
- Before any deploy or SQL run: `git fetch && git status` — multiple sessions push to `master`, and `functions deploy` ships whatever is on disk with no relation to git state (RUNBOOK §0).
- Post-deploy health: `select * from public.cron_health();` and `public.cron_http_health();`.

## Documentation map

Rich docs already exist — consult them rather than re-deriving:

| File | Covers |
|---|---|
| `RUNBOOK.md` | **Authoritative** deploy order, flags, secrets, health checks, CRON_SECRET rotation |
| `BUILD.md` | Build details and rationale |
| `BACKEND.md` | Supabase backend setup |
| `ANDROID.md`, `GOOGLE_PLAY_SETUP.md` | TWA packaging + Google Play (the Android build toolchain lives outside this repo) |
| `KONZEPT.md` | Product concept, tiers, pricing/credit model |
| `legal/` | DSGVO/compliance, data-flow, disclaimers, audit trail |

## License

Proprietary — all rights reserved. The repository is public only so the official app can serve from GitHub Pages; this is not an open-source license.
