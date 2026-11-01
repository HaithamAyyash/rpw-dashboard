# NAKHEL Cloud — Implementation Plan

Status: **draft for team review**. No code has been written yet. Answer the questions in §6 (or reply "defaults OK" to any of them); M0 starts once D2, D6 and D9 and the §5 questions marked **(schema)** are settled.

Inputs read: the build brief and `docs/design/nakhel_dashboard (1).html` (the prototype).
**Not found in the repo:** `docs/report/sdp_report.pdf` and `docs/design/nakhel_logo.png`. Until the report is added I treat the brief as the authoritative summary of it and cannot check the brief against it. Please add the PDF; I'll re-check §5 against Table 3.1 before M1 starts.

---

## 1. Architecture

```
 Raspberry Pi cluster heads (Python daemon, SQLite buffer)
        │  HTTPS POST JSON, Authorization: Bearer <cluster key>
        ▼
 ┌──────────── nginx (TLS 1.2+, limit_req, client_max_body_size 64k) ───────────┐
 │                                                                              │
 │   Next.js app (one deployable, `standalone` output, role nakhel_web)         │
 │   ├─ /api/v1/ingest/*      cluster-head API key → SECURITY DEFINER lookup   │
 │   ├─ /api/v1/auth/*, /api/v1/orgs/{org_id}/*   session cookie (JWT)          │
 │   └─ React pages /login, /invite/[token], /[org]/...  (TanStack Query, 60 s) │
 └───────────────┬──────────────────────────────────────────────────────────────┘
                 │ pg (node-postgres), every txn: set_config('app.current_org', …, true)
                 ▼
     PostgreSQL 17 + TimescaleDB  (one DB, all orgs, RLS fails closed)
                 ▲
                 │ psycopg2, role nakhel_worker (BYPASSRLS)
     Python worker: poll pending → preprocess → Classifier → status → alerts → SMTP
                                                                          │
                                                               Mailpit (dev) / SMTP provider (prod)
```

Key properties:
- **One write path from Pis, one read path for humans.** The ingest handler only validates and inserts (`status='pending'`). Everything slow happens in the worker.
- **Tenancy is enforced in the database, not only in the API.** The web role cannot read a row unless `app.current_org` is set to that row's org. The app sets it with `SELECT set_config('app.current_org', $1, true)`, the parameterisable equivalent of `SET LOCAL`, inside a single helper `withOrg(orgId, fn)`. No handler gets a raw connection.
- **The worker is the only cross-org process.** It copies `org_id` from source rows and never takes it from anywhere else.
- **Time:** everything is stored as `timestamptz` (UTC). Conversion to the org's time zone happens only in the UI, plus in emails and in the TDMA schedule logic of the simulator and seed.

## 2. Repo layout

```
web/                      Next.js (TypeScript strict)
  app/
    (auth)/login, invite/[token]
    [org]/                page.tsx (Overview), map/, acoustic/, classification/,
                          alerts/, history/, health/, settings/
    api/v1/
      ingest/measurements/route.ts
      auth/{login,logout,me}/route.ts
      invites/[token]/accept/route.ts
      orgs/[orgId]/...    one folder per endpoint in brief §7
  lib/
    db/                   pool.ts, withOrg.ts, sql.ts (loads ../db/queries/*.sql at build)
    auth/                 session.ts (jose), password.ts (argon2id), requireRole.ts, csrf.ts
    schemas/              Zod: ingest.ts, dashboard.ts … (source of truth)
    api/                  error shape, pagination, 404-not-403 helper
  components/             Sidebar, TopBar, OrgSwitcher, StatCard, TreeCard, StatusBadge, …
  scripts/                create-org.ts, register-cluster.ts, gen-contracts.ts (Zod → JSON Schema / OpenAPI)
  tests/                  vitest (unit + route tests against a real test DB), e2e/ (Playwright)
worker/                   Python package `nakhel_worker`
  nakhel_worker/          main.py, db.py, preprocess.py, classifier/{base,stub,torchscript}.py,
                          status.py, alerts.py, mailer.py, config.py
  tests/                  pytest
  pyproject.toml, .pylintrc, Dockerfile
db/
  migrations/             dbmate: 0001_roles.sql, 0002_tenancy.sql, 0003_devices.sql,
                          0004_hypertables.sql, 0005_rls.sql, 0006_lookup_functions.sql, …
  queries/                one .sql per dashboard need (named params via $1…)
  tests/                  pytest + psycopg2: constraints, RLS, roles, queries
tools/
  nakhel_fake/            shared fake-data module (grid layout, TDMA schedule, SNR gating, MFCC gen)
  seed.py, simulate_cluster.py, pi_client_example.py, backup.sh
docs/
  PLAN.md, DECISIONS.md, database.md, deploy.md (M9)
  contracts/              cluster_head_to_cloud.md, measurement.schema.json (generated)
  api/openapi.yaml        (generated)
  design/                 prototype, logo
docker-compose.yml        timescaledb, dbmate (one-shot), web, worker, mailpit
docker-compose.test.yml   throwaway DB for test runs
.env.example, Makefile    `make db-up`, `make migrate`, `make seed`, `make test`, …
.github/workflows/ci.yml
```

`db/queries/*.sql` is shared by the M1 query tests (Python) and the M5 API (TypeScript), so a schema change that breaks a screen fails CI in M1's tests.

## 3. Technical choices (beyond what the brief fixes)

| Area | Choice | Why |
|---|---|---|
| Next.js | Current stable at M0 (16.x), App Router, `output: 'standalone'` | Brief. Note: Next 16 renames `middleware.ts` to `proxy.ts`; the auth redirect lives there. |
| Node | 24 LTS in containers; package manager **npm** | Boring and already on the host. (The host has Node 20, which is fine for editing; builds run in Docker/CI.) |
| Dashboard auth | **Hand-rolled with `jose` + `@node-rs/argon2`** (D11) | ~200 lines we fully understand. Auth.js discourages the credentials provider, and its multi-org/invite flows would be custom code anyway. Details in §4.5. |
| Validation → contracts | Zod 4 with its built-in `z.toJSONSchema()`; OpenAPI via `@asteasolutions/zod-to-openapi` | No hand-maintained schemas. |
| DB tests | pytest + psycopg2 against a throwaway TimescaleDB container | The DB is the product of M1; testing it in SQL/Python is closest to the metal and shares fixtures with the seed. |
| Web tests | Vitest, route handlers called directly against the test DB (no mocks for SQL) | Mocked SQL would hide exactly the RLS bugs we care about. |
| Migrations | dbmate via its pinned Docker image (no local install) | One command: `make migrate`. |
| Map | react-leaflet, `preferCanvas` + `circleMarker`, `leaflet.markercluster` only below a zoom level | Canvas handles 8,000 markers smoothly; clustering at farm zoom would hide the per-tree view. |
| Worker Python | **See question Q-PY.** Default: 3.12 for the worker container; `tools/` written to run on 3.10+ and CI-tested on 3.10 and 3.11. | Python 3.10 reached end of life in Oct 2026. |
| Compose | Pinned tags for `timescale/timescaledb:<2.x>-pg17`, `axllent/mailpit`, `ghcr.io/amacneil/dbmate`. Exact versions are chosen and recorded at M0. | Brief. |

## 4. Design notes

### 4.1 Schema adjustments to the brief (each becomes a DECISIONS.md entry)

1. **`confidence` means P(infested).** The brief averages "confidence of the last 3 classifications", which only works if every row's number points the same way. With `label=healthy, confidence=0.95` the average would be meaningless. So `classification_results.confidence` = model probability of *infested* (0–1), and `label` is derived from it (`infested` if ≥ 0.5). The prototype's "Avg. infestation prediction" reads the same way. → **Q-CONF**
2. **More pre-org lookups than the brief's two.** Login needs email → (user, password_hash, memberships). Accepting an invite needs token_hash → invite, and so would a password reset. All of these are `SECURITY DEFINER` functions that return only what the caller needs. Full list: `ingest_auth(key_hash)`, `auth_user_by_email(email)`, `auth_memberships(user_id)`, `invite_by_token(token_hash)`, plus `reset_by_token` if Q-RESET is yes.
3. **`users` gets RLS too.** It has no `org_id`, so a careless query could otherwise list every user's email. Policy: the row is your own (`app.current_user`) or shares a membership with `app.current_org`.
4. **No FK from `classification_results` to `acoustic_features`.** They join on `(node_id, timestamp)`. FKs into hypertables are new in TimescaleDB and interact badly with compression and retention.
5. **Extra columns** the brief's own features need: `alert_log.created_at` (for alert latency, separate from the event `timestamp`), `alert_log.measurement_ts` (which measurement triggered it), `users.token_version` (logs out all sessions on password change), `nodes.updated_at`, `ingest_rejects.http_status`.
6. **LoRa ID uniqueness among active nodes only** (partial unique index `(cluster_id, lora_id) WHERE active`), so a replaced node's ID can be reused while its history stays attached to the old row. → **Q-REUSE**
7. **Last-owner rule in the DB**: a trigger on `organization_members` refuses to delete or demote the last owner. The API also checks it, to return a friendly error.
8. **Time zone validity**: a trigger checks `organizations.timezone` against `pg_timezone_names`. A CHECK constraint can't do this because the lookup isn't immutable.
9. **Compression deferred.** RLS is enabled when the tables are created, as the brief requires. Compression is *not* enabled in M1. The worker updates `status`, and store-and-forward backlogs insert into old chunks; both are slow or awkward on compressed chunks. M1 measures size on the large seed, and M9 decides whether to compress chunks older than ~30 days.

### 4.2 What "offline" means before the heartbeat exists (D2)
With SNR gating, a healthy node is silent most of the time, so "no measurement recently" does not mean offline. Until `node_health` data arrives, a node's status comes only from classifications, and the UI shows **"no health data"**, not "offline". Once heartbeats exist: offline = 2 missed heartbeat windows. The prototype's `Active nodes 18/24` card shows "—/24" until then. → covered by D2.

### 4.3 Ingest handler flow
1. Reject over 64 KB by reading the stream with a counter. Don't trust `Content-Length` alone.
2. Hash the bearer key with SHA-256 and call `ingest_auth(hash)`. No match or revoked → 401.
3. Zod-parse → 400 with field-level `details`.
4. One transaction: `set_config('app.current_org')`, resolve `(cluster_id, lora_id)` → `node_id` (422 + `ingest_rejects` row if missing), then `INSERT … ON CONFLICT (node_id, timestamp) DO NOTHING RETURNING` → 201 or 200.
5. `server_time` in every response, including errors.

Rejects from authenticated keys (400/413/422) are written to `ingest_rejects`. Unauthenticated garbage is only logged, so an attacker can't fill the table.

### 4.4 Tree status (used by the worker, the queries and the UI)
`avg3 = mean(confidence of the node's last 3 classification_results)`. Status: `healthy` if avg3 < org.suspect_threshold, `suspected` if < alert_threshold, else `alert`. `offline` overrides once health data exists, and `unknown` covers a node with no classifications yet. It is computed **in SQL in one place** (`db/queries/tree_status.sql`, used as a CTE by the cards, map and summary queries), and the worker uses the same definition so emails and screens never disagree. A dedicated test checks that the SQL and Python implementations match.

### 4.5 Sessions
- Cookie `nakhel_session`: HS256 JWT `{sub: user_id, tv: token_version, iat, exp}`, httpOnly, Secure (except on localhost), SameSite=Lax, Path=/. It is valid for 12 h and silently re-issued after 6 h of use. → **Q-SESS**
- **Memberships are not stored in the token.** Every org request checks membership in the DB, so removing a member takes effect immediately.
- CSRF: state-changing requests must carry an `Origin` that matches `APP_ORIGIN`; SameSite=Lax is a second layer.
- `requireMember(orgId)` → 404 if not a member. `requireRole(org, 'owner')` is the single place roles are checked.

### 4.6 Large-seed size estimate (`--scale`)
8,000 nodes × 12 wake-ups × 90 days = 8.64 M wake-ups. With SNR gating, the default send rate is ~10% for healthy nodes and ~90% for infested ones (→ **Q-GATE**). That gives ≈ 0.9 M measurement rows plus as many classification rows. One MFCC is 390 × 4 B ≈ 1.6 KB, so the total is **~2–3 GB**. This machine has 48 GB free disk and 7 GB RAM, which is enough. The seed uses `COPY` and will take minutes, not hours.

## 5. Milestones

Every milestone ends with green tests, a "how to run it / what to look at" note in the PR description, a DECISIONS.md update, and a stop for your go-ahead. I propose splitting M1 into two review points, because it is the largest and most important milestone.

| # | Contents | Done when |
|---|---|---|
| **M0** | `git init`; folder scaffold; `docker-compose.yml` (TimescaleDB pinned, Mailpit, dbmate one-shot); `.env.example`; Makefile; ESLint + Prettier + Vitest in `web/` (empty Next app); Pylint + pytest in `worker/`, `tools/` and `db/tests`; GitHub Actions running lint + tests on every push; DECISIONS.md seeded with the §13 deviations; logo extracted from the prototype; prototype renamed to `nakhel_dashboard_prototype.html`. | `make up` starts the DB and Mailpit; `make test` passes (trivial tests); CI is green. |
| **M1a** | Migrations: roles, tenancy tables, devices, hypertables, RLS policies, lookup functions, constraints, triggers, retention policies, base indexes. DB tests: build from zero, every constraint, duplicates, roles' exact privileges, the full isolation suite from brief §11. `docs/database.md` (ER diagram, columns and units, RLS design, roles, GUI how-to). | `make db-reset` builds a fresh DB in one command; every constraint and isolation test passes. |
| **M1b** | `tools/nakhel_fake/` + `seed.py` (2 orgs, shared LoRa IDs, one shared user, 30 days, infested trees, alerts, low battery and offline nodes) + `--scale`; all `db/queries/*.sql`; `EXPLAIN ANALYZE` on the large seed with timings recorded in `database.md`; extra indexes; `backup.sh` + restore note. | You can browse the seed in DBeaver; every query returns the expected columns; every query p95 is < 200 ms on the large seed (→ **Q-PERF**). |
| **M2** | Ingest route + Zod schema; `withOrg` and the DB layer; `register-cluster.ts` (and `create-org.ts`, moved up from M5 because M2 tests need orgs); JSON Schema generation; contract doc with curl; `pi_client_example.py`; Vitest for every response row, duplicates, cross-org LoRa IDs and cross-org keys. | curl and the reference client store a measurement; a repeat returns 200; all tests pass. |
| **M3** | `simulate_cluster.py` (multi-org, TDMA in local time, gating, `--outage`, `--speed`, same retry rules as the client); worker: SKIP LOCKED polling, preprocessing, `Classifier` + `StubClassifier` (fake, and labelled fake in `model_version`), status calculation; latency columns. | Simulator → API → worker fills `classification_results` for both orgs; pytest is green. |
| **M4** | Alert engine (thresholds per org, cooldown, escalation suspected→detected, system alerts behind feature checks); SMTP mailer (to that org's owners only, org time zone, deep link). | An integration test sees an email in Mailpit for org A only. |
| **M5** | Dashboard API: auth (login/logout/me), invites, password reset (if Q-RESET), membership guard, every §7 endpoint on top of `db/queries/`, pagination, CSV export (streamed), OpenAPI generation. | Vitest covers every endpoint against seed data, including 404 on cross-org IDs; `openapi.yaml` is generated. |
| **M6** | UI shell: Tailwind tokens, IBM Plex via `next/font`, sidebar, top bar (org switcher, zone selector, org-local clock), `proxy.ts` auth redirects, login, invite and org picker pages, Overview. | Playwright: log in → Overview with real numbers; switching org changes the data. |
| **M7** | Sensor map (Esri imagery, canvas markers, cluster-head coverage circles, node list); System health page; `ingest/node-health` + `ingest/cluster-health` endpoints and their worker alert rules. | 8,000-marker seed pans smoothly; Playwright smoke test. |
| **M8** | Acoustic analysis, Classification, Alert log (+ acknowledge), Historical records, CSV exports, Settings (org, members, cluster heads with copy-once key, nodes + CSV import). | Playwright smoke test on every screen. |
| **M9** | nginx config (TLS, limit_req, body size), Let's Encrypt, systemd/compose restart policies, backups on a cron schedule, compression decision, `docs/deploy.md` runbook, report metrics queries (latency, rejects, duplicates, uptime). | Deployed to the VM; runbook tested from scratch. |
| **M10** | TorchScript classifier loader + normalisation stats + label map; model swap with no schema change. | Real `model_version` appears in the dashboard. |

## 6. Questions

### 6.1 Open decisions from brief §12

| ID | Question | My default |
|---|---|---|
| **D1** | Batch ingest endpoint? | Later, only if `--outage` flush timings in M3 show it's needed. Yardstick: flushing a 24 h backlog for 8,000 nodes takes more than ~10 min. |
| **D2** (schema) | Node heartbeat? | Agree with the brief's default: one heartbeat per night window → `POST /ingest/node-health`; offline after 2 missed. **Plus:** until heartbeats exist, show "no health data", never "offline" (§4.2). Is the firmware team committing to it, and in which semester? |
| **D3** | Thresholds | Per-org 0.5 / 0.8 on avg3; low battery 3,400 mV; SD low 1,024 MB; cluster offline after 15 min without cluster health. Battery **%** for display (the prototype shows %) = linear 3,300–4,200 mV → 0–100%, unless the hardware team gives a discharge curve. **Which battery chemistry and voltage range does the node use?** |
| **D4** | Hosting | One Ubuntu 22.04 VM + Docker Compose + nginx + Let's Encrypt. Provider and domain? (Note: Ubuntu 22.04 standard support ends in Apr 2027, soon after you graduate. 24.04 would be my pick unless the report fixes 22.04.) |
| **D5** | Email | SMTP from `.env`; Mailpit locally. Sender address, e.g. `alerts@<domain>`? Which provider (Brevo, SES, university SMTP)? |
| **D6** (schema) | Self sign-up / `farms` table | No / no, as the brief proposes. |
| **D7** | Model hand-off | TorchScript `.pt` + `norm_stats.json` (per-coefficient mean/std) + `labels.json`. **The model must output P(infested) (Q-CONF).** |
| **D8** | Map tiles | Esri World Imagery, OSM fallback, attribution shown. Fine for a non-commercial student project; revisit if it's commercialised. |
| **D9** (schema) | Acoustic energy | Mean of c0 over the 30 frames, stored in `acoustic_features.energy` at insert (a generated column, so it can never drift). **But:** c0 is a log-energy value (e.g., −312), not a percentage. The prototype's 0–100% axis can't show it honestly. Default: plot raw c0 in "dB (rel.)" with an auto-scaled axis, and drop the % axis. OK? |
| **D10** | Real-time | 60 s polling, as the brief proposes. |
| **D11** | Auth | Hand-rolled `jose` (§4.5). |

### 6.2 New questions from reading the brief and prototype

| ID | Question | My default |
|---|---|---|
| **Q-REPORT** | The report PDF and logo aren't in the repo. Can you add them? | I'll extract the logo from the prototype (it's an embedded JPEG; the brief calls it `.png`) and work from the brief until the report arrives. |
| **Q-PY** | The brief says Python 3.10. 3.10 is end of life as of Oct 2026, and Raspberry Pi OS Bookworm ships 3.11 (Trixie: 3.13). Which Python is actually on the Pi? | Worker on **3.12** (our container, our choice). Pi-side `tools/` target **3.10+**, CI on 3.10 and 3.11. Logged as a deviation. |
| **Q-CONF** (schema) | Confidence = P(infested)? (§4.1.1) | Yes. |
| **Q-GATE** | What fraction of wake-ups pass SNR > 4 dB, for healthy vs infested trees? Needed for realistic seed and simulator data. | 10% healthy, 90% infested, adjustable by flag. Note: the prototype assumes every node reports every hour ("18 nodes × 1/hr"). With gating, Measurements/hr will be much lower and the cards should say so. |
| **Q-THRESH** | The prototype colours confidence bars at 25% / 55% and its alert text mentions a "25% threshold". The brief says 0.5 / 0.8. | Use each org's thresholds everywhere, including bar colours. Log the prototype difference. |
| **Q-SEV** (schema) | Severity per alert type, and which types send email? | `infestation_detected` critical, email · `infestation_suspected` warning, email · `cluster_offline` critical, email · `node_offline`, `low_battery`, `sd_low` warning/info, dashboard only. A daily digest for system alerts can come later. |
| **Q-COOL** | Cooldown rule details | No new alert of the same type for the same node while an unacknowledged one is less than 24 h old. Escalation from suspected → detected always fires. After an acknowledgement, the next crossing fires again. Alerts never auto-resolve. |
| **Q-422** | Measurements from an unregistered node are rejected (422) and the Pi drops them. If the owner registers that node next day, the data is gone. Should we keep it? | Store the **full body** for 422s in `ingest_rejects` (≈ 6 KB each, 30-day retention). Add a "replay into newly registered node" action in Settings in M8. |
| **Q-DUP** | Same `(node, timestamp)` arrives with a *different* MFCC. | Still 200 duplicate, the first write wins, and we count it as `conflict` in the response body and the metrics. |
| **Q-OLD** | Oldest timestamp we accept? | 365 days (the retention window). Older → 400 `timestamp_too_old`. |
| **Q-REUSE** (schema) | Can a LoRa ID be reused after a node is replaced? | Yes, unique among *active* nodes per cluster head (§4.1.6). |
| **Q-RESET** | Password reset. There is no platform admin, so a forgotten password can't otherwise be recovered. | Add email reset links in M5 (single-use, hashed, 1 h expiry). |
| **Q-INVITE** | Invite for an email that already has an account | Accepting requires being logged in as that user. The token alone never grants access to an existing account. |
| **Q-SESS** | Session length | 12 h, sliding re-issue after 6 h. |
| **Q-ZONE** | The top bar and sidebar footer show "the zone", but an org can have several. | Zone selector in the top bar ("All zones" default, kept in the URL `?zone=`) filters every page. The footer badge shows the selected zone + cluster-head count. |
| **Q-EXPORT** | What does the top bar's "Export report" produce? | A menu: the current page's data as CSV for the selected range (features / classifications / alerts). A PDF report is out of scope unless you want it for the SDP-II demo. |
| **Q-NAV** | The prototype has both a sidebar and a duplicate tab bar. | Drop the tab bar; the sidebar collapses to icons below 900 px (tablet), as the prototype already does. |
| **Q-PERF** | What counts as "fast" for M1b? | p95 < 200 ms per dashboard query on the 8,000-node × 90-day seed, on this 2-CPU / 7 GB machine. |
| **Q-GIT** | The repo isn't under git. Where will it be hosted? | `git init` in M0 and GitHub Actions for CI. Tell me the GitHub org/repo, or I'll leave the remote unset. |
| **Q-REJ** | Retention for `ingest_rejects` | 90 days (hypertable + retention policy). Logged as a team default, since neither the report nor the brief says. |

## 7. Report deviations to log in M0 (brief §13 + new)

All of brief §13, plus: Next 16 `proxy.ts` instead of "middleware"; extra SECURITY DEFINER lookups (§4.1.2); RLS on `users`; confidence semantics; compression deferred; Python version (Q-PY); prototype thresholds and battery-% differences; the prototype's hourly-reporting assumption vs SNR gating; the energy axis units (D9); and the dropped tab bar.

## 8. Risks

- **Status for quiet healthy trees can be weeks old** (SNR gating means few classifications). Cards show "last measurement", and the summary counts trees with no data in 7 days separately.
- **RLS mistakes are silent** (empty results, not errors). Mitigation: the isolation suite runs in every milestone's CI, and a test enumerates `pg_tables` to fail if any table with `org_id` lacks RLS or a policy.
- **TimescaleDB + RLS + retention interplay**: verified by M1a tests on the pinned image, not assumed.
