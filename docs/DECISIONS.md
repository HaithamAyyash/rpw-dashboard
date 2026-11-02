# NAKHEL Cloud — Decision Log

For citation in the Senior Design II report. Each entry records what the report or brief says, what we did, and why.

**Source note:** `docs/report/sdp_report.pdf` was not available when M1 was built. "The report says" entries come from the team's build brief, not from the PDF. They should be checked against the PDF once it is in the repo.

**Status:** *Team decision* = stated by the team. *Assumed* = a default chosen by the developer in `docs/PLAN.md`, not yet confirmed; these are easy to reverse unless noted.

## Team changes to the report (brief §13)

| # | Report says | We did | Why |
|---|---|---|---|
| T1 | Flask REST API, psycopg2, plain HTML/CSS/JS dashboard (§7.6.2) | Next.js + TypeScript for the web app and all HTTP APIs, with node-postgres. Worker stays Python. | Team decision: one web deployable. |
| T2 | MQTT v3.1.1 between cluster head and cloud (§§3.3, 4.1.2, 4.3.1, 4.4.1, FR4) | HTTPS POST with JSON | Team decision. |
| T3 | Node sends 15 × 13 int8 MFCC + scale | The Pi reconstructs and sends a 30 × 13 float matrix; `mfcc real[]` is checked as 30 × 13. Table 3.1 and §§4.3.1/4.3.3 need updating. | Team decision. |
| T4 | Single-tenant; varchar IDs for nodes and cluster heads | Multi-tenant: tenancy tables, `org_id` on every tenant table, row-level security, internal `nodes.node_id` (bigint) separate from the radio's `lora_id`, uuid `cluster_id` with a per-organization `name`. | Team decision. |

## Report inconsistencies (brief §13)

| # | Issue | Resolution |
|---|---|---|
| R1 | 2-byte node IDs with 8,000-ID blocks per cluster head allow at most 8 cluster heads | Resolved by T4: LoRa IDs need only be unique per cluster head. |
| R2 | `node_health` fields aren't in the LoRa packet, and there is no heartbeat | `node_health` exists but stays empty until D2 is delivered. See A2. |
| R3 | User accounts are in the database, but no users table is defined | Added `users`. |
| R4 | `alert_log` is called a hypertable in §4.3.2.3, but Table 3.1 and §4.3.2.4 count four | Regular table: it needs updates and indefinite retention. |
| R5 | Prototype model names (InceptionResNet-V2 / MixConvNet / BiLSTM) differ from the report's candidates (CNN / CNN-LSTM / Mamba) | UI will display `model_version` from the database. |
| R6 | Prototype shows BFCC/CQCC; only MFCC is sent | Not stored. Columns dropped from the UI (M8). |
| R7 | Team-roles table mentions SMS/push; FR7 says email | Email only. |

## New issues found during M1

| # | Issue | What we did | Why / action needed |
|---|---|---|---|
| N1 | **TDMA capacity (resolved by N8).** 8,000 nodes × 900 ms slots = 2 h per round, but the night schedule wakes nodes hourly. At most 4,000 nodes fit one hourly round. | No schema impact. The fake-data generator wraps slot offsets at 1 h. | **Hardware team must resolve:** fewer nodes per cluster head, or shorter slots. |
| N2 | **Prototype vs brief thresholds.** The prototype colours bars at 25% / 55%; the brief says 0.5 / 0.8. | Thresholds are per-organization, default 0.5 / 0.8. | Brief takes priority. |
| N3 | **Prototype assumes hourly reports from every node** ("18 nodes × 1/hr"), which SNR gating contradicts. | Seed follows the gate. | The Measurements/hr card will be much lower than the prototype implies. |
| N4 | **Row-level security can be bypassed through TimescaleDB chunks.** Chunks inherit the hypertable's GRANTs but not its RLS, so `nakhel_web` could read every organization's rows by naming a chunk. Found by a test. | Migration 0008: app roles' grants on chunks are revoked by `lock_down_chunks()`, which a TimescaleDB job runs every minute. | Closing the schema is impossible (the planner needs it). **Limitation:** a brand-new chunk stays exposed for up to 1 minute. It's reachable only by SQL that names the chunk, and the app's parameterized queries never do. |
| N5 | **"Only two lookups bypass RLS" isn't enough.** Login needs the password hash (a separate need from memberships), and invite links need a token lookup before the organization is known. | Four `SECURITY DEFINER` functions: `ingest_auth`, `auth_user_by_email`, `auth_memberships`, `invite_by_token`. Two more guard the owner rule inside triggers. A test fails if any other appears. | Brief §5 lists two. |
| N6 | **The brief doesn't list `schema_version` in `acoustic_features`**, but §4 says to store it. | Added, default 1. | Internal consistency of the brief. |
| N8 | **The node ID is 1 byte (team, 2026-11-01).** The brief says 2 bytes (0–65535), up to 8,000 nodes per cluster head. 1 byte allows at most 256 nodes per cluster head, so 8,000 trees need at least 32 cluster heads. | `lora_id` is limited to 0–255 in the database, API, Settings and CSV import (migration 0011). The internal `node_id` is unaffected. Nodes are added by manual entry or CSV, as decided by the team. | Report, brief and the 214-byte packet layout need updating. It also removes N1's TDMA overrun: 256 × 900 ms is about 4 minutes. **All 256 IDs are allowed for now: confirm whether any are reserved, such as 255 for broadcast.** |
| N7 | **A reverted setting is `''`, not NULL.** After `SET LOCAL` ends on a pooled connection, the brief's policy `current_setting(...)::uuid` would raise an error, rather than return nothing. | `current_org_id()` applies `NULLIF(..., '')`. Tested. | Keeps "fails closed" returning no rows, as the brief specifies. |

## Other schema additions

| # | Addition | Why |
|---|---|---|
| S1 | `users` has row-level security | It has no `org_id`, and a careless query could otherwise list every organization's users. You see yourself and members of your current organization. |
| S2 | `alert_log.created_at`, `measurement_ts` | Ingest → alert latency for report Table 6.3. |
| S3 | `users.token_version` | Lets a password change end existing sessions. |
| S4 | `ingest_rejects.http_status` | Separates 400 / 413 / 422 rejects. |
| S5 | Unique `(node_id, timestamp)` on `node_health`, `(cluster_id, timestamp)` on `cluster_health` | The Pi retries these too, so they need idempotency like measurements. |
| S6 | Unique `(node_id, timestamp, model_version)` on `classification_results` | Worker retries can't double-write, while a new model can re-score old data. |
| S7 | `node_status` view | One definition of tree status for all screens and the worker. |
| S8 | Reserved slugs (`api`, `login`, `invite`, ...) | A slug is the first URL segment, so it must not shadow a route. |
| S9 | Emails stored lower-case | Prevents `A@x.com` and `a@x.com` becoming two accounts. |
| S10 | Column-level grants | `org_id` can't be changed after insert. Password, API-key and invite-token hashes aren't readable by app roles. New measurements can't set their own `status`. |
| S11 | Deferred trigger: an organization must have an owner by commit | Second half of "must always have at least one owner"; the first half is the last-owner trigger. |
| S12 | No foreign key from `classification_results` to `acoustic_features` | They join on `(node_id, timestamp)`; FKs into hypertables complicate retention and compression. |
| S14 | `node_current` table, maintained by triggers | Computing status per node took 200-700 ms per query at 8,000 nodes. It's a cache, so the triggers keep it in the same transaction as the write. Adds five `SECURITY DEFINER` functions beyond N5, none callable by app roles. |
| S13 | Compression not enabled | The worker updates `status`, and backlogs insert into old chunks. Decide in M9 from measured sizes. RLS is already on, so enabling it later is safe. |

## Assumed defaults (PLAN.md, unconfirmed)

| # | Question | Assumed | Reversible? |
|---|---|---|---|
| A1 | Q-CONF: meaning of `confidence` | P(infested), whatever the label. Team told to continue with this recommendation; not yet stated outright. | Hard after real data exists. **The model must output this.** |
| A2 | D2: heartbeat | One per night window; offline = no heartbeat for 56 h (2 missed × 24 h, plus the 8 h window width). No health data at all = not offline. | Change one line in the view. |
| A3 | D6: sign-up, `farms` | No self sign-up; no `farms` table | Additive later. |
| A4 | D9: acoustic energy | Mean of c0 over 30 frames, as a stored generated column. c0 is a log-energy value, so no 0–100% axis. | New migration. |
| A5 | Q-REUSE | LoRa ID unique among **active** nodes per cluster head | New migration. |
| A6 | Q-SEV | Seed severities: detected = critical, suspected = warning, low battery / offline / SD low = warning. Enforced by the alert engine in M4, not the schema. | Easy. |
| A7 | Q-422 | `ingest_rejects.request_body` holds up to 64 KB, so a rejected measurement could be replayed. The brief says "excerpt"; M2 chooses how much to store. | Easy. |
| A8 | Q-REJ | `ingest_rejects` kept 90 days | One line. |
| A9 | Q-GATE | Fake send rates: healthy 10%, suspected 50%, infested 90%. Affects fake data only. | One line. |
| A10 | Q-PY | Worker on Python 3.12, a deviation from the report's 3.10, which went end-of-life in Oct 2026. Pi-side tools stay on 3.10. Team told to continue with this recommendation. | Change one Docker image line. |
| A11 | Q-RESET | Not built: no reset-token table yet. | Additive in M5. |
| A12 | Uplink types | `wifi`, `4g` (from the report's "Wi-Fi or 4G") | One line. |

## Ingestion API (M2)

| # | Decision | Why |
|---|---|---|
| I1 | Reject timestamps older than 365 days with 400 `timestamp_too_old` (assumed, Q-OLD). The brief lists only a future limit. | A Pi whose clock reset to 1970 would otherwise get 201 for data the retention policy deletes at once. |
| I2 | Validate every value the database would refuse: magnitude within a `real`, `rssi_dbm` within −200 to 20, `schema_version` within a smallint. Values too small for a `real` round to zero. | Otherwise the insert fails with a 500, and the Pi retries that message forever. |
| I3 | Record 400 and 413 rejects as well as 422, in `ingest_rejects` (assumed). Unknown nodes keep the whole body; others keep 2 KB. Requests with a bad key are not recorded. | Helps the Pi team debug. Unauthenticated callers can't fill the table. |
| I4 | A repeat with different contents is still 200 `duplicate`; the first write wins. PLAN.md's proposed "conflict" counter wasn't built (Q-DUP). | Simplest behaviour matching the brief. Add the counter if the metrics need it. |
| I5 | The API key is checked before the body is read. | An unauthenticated caller can't make the server read 64 KB. |
| I6 | Unknown JSON fields are ignored, not rejected. | Newer Pi software keeps working against an older server. |
| I7 | `create-org.ts` built in M2, not M5. | M2 needs organizations to exist. |
| I8 | The 64 KB limit is enforced only in the handler so far. nginx's limit and rate limiting come with nginx in M9. | Brief asks for both; there's no nginx until M9. |

## Dashboard (M6 started ahead of M3-M5, at the team's request)

| # | Decision | Why |
|---|---|---|
| U1 | The UI was started before the worker and the full dashboard API. Only login, logout, `/auth/me`, `/orgs/{id}`, `/summary`, `/trees` and `/zones` exist. | Team request. Tree statuses come from fake seed data until the worker exists (M3); measurements sent to the live API stay `pending`. |
| U2 | Hand-rolled sessions with `jose` (D11, PLAN.md section 4.5): 12 h, re-issued after 6 h. Membership is read from the database on every request. | Removing a member takes effect at once. Assumed; Q-SESS unconfirmed. |
| U3 | `db/queries` is bundled into `lib/db/queries.generated.ts`; a test fails if it's stale. | The web image builds from `web/` alone and has no `db/` folder at runtime. |
| U4 | Prototype's tab bar dropped; sidebar collapses to icons below 900 px (assumed, Q-NAV). | The tab bar duplicated the sidebar, and the brief's layout doesn't include it. |
| U5 | Top-bar zone selector, kept in the URL, filters cards and summary (assumed, Q-ZONE). | An organization can have several zones. |
| U6 | Bar colours follow each organization's thresholds, not the prototype's 25% / 55% (N2). Battery shows % and mV, with % estimated linearly over 3,300–4,200 mV (assumed, D3). | The brief stores mV and the prototype shows %. The battery chemistry is still unknown. |
| U7 | Added beyond the prototype: LoRa ID, search box, Offline filter, last measurement, battery, Navigate to tree, paging. Kept the prototype's last-3-runs chips. | Brief section 8. Paging is needed for thousands of trees. |
| U8 | "Export report" opens a menu of the three CSVs for the last 30 days (Q-EXPORT, assumed). No PDF. | Brief section 7 defines CSV exports only. |
| U9 | The Live pill turns red ("Disconnected") when polling fails. | It shouldn't claim "Live" during an outage. |

## Worker and alerts (M3, M4)

| # | Decision | Why |
|---|---|---|
| W1 | One measurement per transaction, not batches. | Isolates failures and makes each row's latency real. Throughput still far exceeds what the schedule produces. |
| W2 | Anything wrong with one measurement marks it `failed` and the queue moves on, including a result the database refuses. Only a lost connection leaves it `pending`. | One bad row must not stop every organization. Found while reviewing the crash loop. |
| W3 | PyTorch isn't installed yet; the stub needs only numpy. It arrives with the real model (M10). | Keeps the image small until it's needed. |
| W4 | `StubClassifier` is deterministic, from the spread of c0 across frames, and its `model_version` is `stub-0.1-FAKE`. **It detects nothing.** | Brief section 6. Results can't be mistaken for a real model's. |
| W5 | An alert can fire on fewer than 3 classifications, using the average of what exists. | The dashboard's status works the same way, and emails and screens must not disagree. **A brand-new tree can alert on one reading**, so reconsider with the real model. |
| W6 | Infestation rule (Q-COOL, assumed): alerts on crossing a threshold; no repeat within 24 h while unacknowledged; repeats every 24 h if ignored; an escalation to detected always fires, as the cooldown is per type; acknowledged trees stay quiet until they cross again; never alerts while improving. | Brief section 6 gives the cooldown; the rest is assumed. |
| W7 | System alerts repeat every 24 h if unacknowledged and stay quiet 7 days once acknowledged (assumed). | A low battery has no "crossing" to detect. |
| W8 | Email only for `infestation_detected`, `infestation_suspected` and `cluster_offline` (Q-SEV, assumed). Others are dashboard-only. | Avoids flooding owners about routine maintenance. |
| W9 | `alert_log` is the email queue: `email_sent_at` empty means unsent. Sends happen after the commit. | A crash or SMTP outage loses nothing. **A crash between sending and stamping can send a repeat.** |
| W10 | One email per alert, to all that organization's owners together. | Simple. Owners of one organization can already see each other in Settings. |
| W11 | Cluster alerts stay silent until a cluster head has reported health at least once. | Same reasoning as D2: no data, no guess. |
| W12 | The worker's system scan is built now, though brief M7 pairs it with the health endpoints. Nothing triggers it on real Pis until those endpoints exist. | It's small, and seed data lets it be tested. |
| W13 | Email links go to `/{org}?q={tree label}`. | There's no tree page yet. |
| W14 | Duplicate requests aren't counted anywhere yet, though the report needs that metric. | They store nothing, so there's no row to count. Add in M9. |
| W15 | The simulator registers organizations directly in the database, and only its measurements go through the API. Its keys are in `tools/.sim_config.json`, git-ignored. | Dashboard registration doesn't exist yet. |

## Screens (M7, M8)

| # | Decision | Why |
|---|---|---|
| V1 | Tree markers are drawn with Leaflet directly on one canvas, not as a React component each; only alert trees get an animated marker. | Brief requires speed with thousands of markers. **Not yet measured at 8,000 nodes**; see K6. |
| V2 | Satellite tiles from Esri, switching to OpenStreetMap after 5 tile failures (D8). Attribution shown. | D8 default. Check Esri's terms before any commercial use. |
| V3 | Energy charts use the brief's status colours with a different dash per line, a legend and a table view. The palette validator passes contrast and colour-blind separation but fails its lightness band, which is a rule for categorical palettes. | Status colours are mandated by the brief, so dash patterns are the second cue. |
| V4 | Energy axis shows raw mean c0 with an auto scale, not the prototype's 0-100% (D9). Trees are grouped by current status, not status at the time. | c0 is a log-energy value and has no fixed scale. |
| V5 | Historical records show energy, SNR, RSSI and prediction. The prototype's BFCC, CQCC, LPC and feature-magnitude panel are dropped. | Only MFCC is sent (R6). |
| V6 | Web sends invite email itself with nodemailer. If sending fails, the owner still gets the link to share. | Tokens exist only at creation, so the worker can't send them. |
| V7 | Accepting an invite for an existing account requires being logged in as that account; new accounts need a password of 10+ characters (Q-INVITE, assumed). | The token alone must never grant access to an existing account. |
| V8 | CSV import is all or nothing, and lists every bad row by line. Exports stop at 200,000 rows and neutralize values that Excel would run as formulas. | A half-imported farm is hard to fix; tree labels are typed by users. |
| V9 | Rotating a key also brings a revoked cluster head back. There's no separate un-revoke. | A revoked key may be compromised, so coming back must mean a new key. |
| V10 | A node's cluster head is checked against the organization before anything else. | Otherwise the unique-LoRa error could reveal another organization's LoRa IDs. Found by a test. |
| V11 | Password reset and changing your own password aren't built (Q-RESET). | Not asked for yet. **A forgotten password currently needs an administrator.** |
| V12 | `docs/api/openapi.yaml` isn't generated yet. | Brief asks "if practical". Outstanding. |

## Tooling

| # | Decision | Why |
|---|---|---|
| K1 | `./db.sh` instead of the Makefile in PLAN.md | `make` wasn't on the development server. A bash script needs only bash and Docker. |
| K2 | Dev database on `127.0.0.1:5433` | 5432 was taken on the shared development server. |
| K3 | Roles created by an init script, not a migration | `BYPASSRLS` needs a superuser, and migrations run as the unprivileged `nakhel_owner`. |
| K5 | `shared_buffers` capped at 512 MB via `NAKHEL_DB_SHARED_BUFFERS` | The image takes 25% of host RAM by default, too much on a shared server. Revisit on the dedicated VM (M9). |
| K6 | Large-seed re-measurement stopped at the team's request | The `energy_overview` rewrite, the RAM cap and the cost of the triggers on bulk load are not yet measured at 8,000 nodes. Other queries measured under 200 ms. Re-run before relying on this at scale. |
| K7 | TypeScript 6.0.3 and ESLint 9.39.5, not the newest majors (7 and 10) | Next's lint plugins don't support them yet. |
| K8 | `node` Compose service for npm, tests and scripts; web app on `127.0.0.1:3100` | Nothing to install on the host; 3000 is commonly taken on this server. |
| K4 | Owner role doesn't use `FORCE ROW LEVEL SECURITY` | `SECURITY DEFINER` lookups and the seed script run as the owner and must see every organization. No app connects as the owner. |
