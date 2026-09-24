# blog-scheduler-webflow

A Webflow App that adds an editorial calendar and scheduled publishing for CMS blog posts. Plan posts on a month/week calendar inside the Designer, move them through an idea → draft → review → scheduled → published pipeline, and let a server-side scheduler publish them at the right moment.

Stack: Node.js 20, TypeScript, Express, better-sqlite3 (behind a swappable `Db` adapter), Webflow Data API v2 via a hand-rolled fetch client (no SDK), vanilla TypeScript Designer Extension bundled with esbuild.

## Layout

```
server/                    Express app
  routes/                  oauth.ts, webhooks.ts, api.ts (App Panel API)
  services/                webflow-client.ts, token-store.ts, rate-limiter.ts, installations.ts,
                           mapping.ts, posts.ts, scheduler.ts, reconcile.ts, publish-log.ts
  db.ts                    Db adapter interface + SQLite implementation
designer-extension/        App Panel (index.html, src/panel.ts, esbuild.config.mjs, webflow.json)
shared/                    types.ts, time.ts (DST-safe timezone helpers, used by server and panel)
db/schema.sql              installations, oauth_tokens, posts, publish_runs, publish_log
```

## OAuth scopes

| Scope | Why |
| --- | --- |
| `cms:read` | Discover collections/fields, read items, reconcile edits |
| `cms:write` | Create/update draft items, publish items |
| `sites:read` | List authorised sites and their collections, list webhooks |
| `sites:write` | Register the `collection_item_changed` webhook |

Install flow: `GET /oauth/authorize` (signed, expiring `state`) -> Webflow -> `GET /oauth/callback` exchanges the code, creates the installation, stores the token encrypted (AES-256-GCM, key derived from `TOKEN_ENCRYPTION_KEY`, behind the `TokenStore` interface), registers the webhook and redirects to the panel with the site id and panel token in the URL fragment.

## Data API endpoints used

| Purpose | Request |
| --- | --- |
| List authorised sites | `GET /v2/sites` |
| Collection discovery | `GET /v2/sites/{site_id}/collections`, `GET /v2/collections/{id}` |
| Create draft | `POST /v2/collections/{id}/items` |
| Update draft | `PATCH /v2/collections/{id}/items/{item_id}` |
| Read item (crash recovery) | `GET /v2/collections/{id}/items/{item_id}` |
| Publish (item level) | `POST /v2/collections/{id}/items/publish` |
| Webhooks | `GET/POST /v2/sites/{site_id}/webhooks` |
| Token exchange / refresh | `POST /oauth/access_token` |

Example requests:

```http
POST /v2/collections/COLLECTION_ID/items
{ "isArchived": false, "isDraft": true,
  "fieldData": { "name": "Spring launch", "slug": "spring-launch", "post-body": "<p>...</p>", "publish-date": "2026-03-20T14:00:00.000Z" } }

PATCH /v2/collections/COLLECTION_ID/items/ITEM_ID
{ "isDraft": true, "fieldData": { "publish-date": "2026-03-21T14:00:00.000Z" } }

POST /v2/collections/COLLECTION_ID/items/publish
Idempotency-Key: 9f2c...
{ "itemIds": ["ITEM_ID"] }
```

Staged items with `isDraft: true` are skipped by the publish endpoint, so the scheduler clears `isDraft` right before publishing.

## Scheduler and idempotency

`services/scheduler.ts` polls every `SCHEDULER_POLL_MS` (default 30 s). For each due post (`status = scheduled`, `scheduled_at <= now`):

1. Atomically claims it (`UPDATE ... WHERE publish_state IN ('idle','retrying') AND attempts = ?`), storing an idempotency key `sha256(postId | scheduledAt | attempt)`.
2. Clears `isDraft`, calls item-level publish with the key, and marks it `published`.
3. `publish_log` has a unique index on the key for success outcomes, so one attempt is recorded as published at most once.
4. **Crash safety:** posts found in `publishing` on startup are checked against Webflow (`lastPublished` after the claim time). If live, they are recorded as `recovered` and never re-published; otherwise they re-enter the retry queue.
5. **Failures:** retried with backoff (30 s, 60 s, 120 s, ... capped at 30 min) up to `PUBLISH_MAX_ATTEMPTS`; permanent 4xx errors fail immediately. Failed posts appear in the Failures tab (`GET /api/failures`) and can be retried.

## Timezones

Each site has an IANA timezone (default `UTC`). Everything is stored as UTC ISO-8601. `shared/time.ts` converts wall-clock time to UTC using `Intl` only: ambiguous times (fall back) take the earlier occurrence, non-existent times (spring forward) move forward by the gap, and bulk shifts move whole local days so 09:00 stays 09:00 across DST changes.

## Webhooks

- `POST /webhooks/collection-item-changed` (registered automatically on install): reconciles edits made in the Designer/Editor (title, slug, body, author, publish date, manual publish, archive) back into the calendar; unknown items in the mapped collection are imported.
- `POST /webhooks/app-uninstalled`: purges the encrypted token, config, posts, runs and logs. Set this URL as the app's uninstall notification endpoint in your Webflow app settings.

Both verify `x-webflow-signature` (HMAC-SHA256 of `timestamp:rawBody` with the client secret) and reject timestamps older than 5 minutes.

## Rate-limit strategy

- Per-site token bucket: 60 tokens, refilled continuously at 60/min, acquired before every request.
- `429`: honours `Retry-After` (using the larger of it and 1 s x 2^n), pauses the whole site bucket, retries up to 5 times.
- `401`: exchanges the refresh token once and retries; if that fails the install is flagged `needs_reauth`.

## App Panel API

All `/api` calls send `X-Site-Id` and `X-Panel-Token`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/config` | Site config (timezone, mapping) |
| PUT | `/api/config/timezone` | Set IANA timezone |
| GET | `/api/collections` | Collection discovery with suggested field mapping |
| PUT | `/api/mapping` | Save blog collection and title/slug/body/author/publishDate mapping |
| GET | `/api/posts?from&to` | Calendar range plus unscheduled backlog |
| POST / PATCH / DELETE | `/api/posts[/:id]` | Create, update, delete |
| POST | `/api/posts/:id/move` | Drag-to-reschedule |
| POST | `/api/posts/bulk-reschedule` | `{ moves: [{id, scheduledAt}] }` or `{ ids, shiftDays }` |
| POST | `/api/posts/:id/publish-now`, `/retry` | Manual publish / retry a failed post |
| GET | `/api/failures` | Failure list |
| GET | `/api/publish-runs`, `/api/publish-log`, `/api/publish-log.csv` | Per-run results and CSV export |
| POST | `/api/scheduler/run` | Trigger a run |

## Local development

1. Copy `.env.example` to `.env`; set `WEBFLOW_CLIENT_ID`, `WEBFLOW_CLIENT_SECRET` and a long random `TOKEN_ENCRYPTION_KEY`.
2. `npm install`, then `npm run dev` (port 3000; the SQLite file is created from `db/schema.sql`).
3. Webflow needs an HTTPS URL. Use a tunnel such as ngrok yourself (`ngrok http 3000`; none is started by this repo), then set `APP_PUBLIC_URL` and `WEBFLOW_REDIRECT_URI` to the tunnel URL and register the same redirect URI in your Webflow app.
4. `npm run build:extension` bundles the panel to `designer-extension/dist/panel.js` (`watch:extension` for development).
5. Visit `/oauth/authorize` to install; you land on the panel already connected.

To use another database, implement the `Db` interface in `server/db.ts` and export it as `db`.
