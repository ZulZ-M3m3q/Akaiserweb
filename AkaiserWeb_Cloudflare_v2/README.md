# AkaiserEvodroid account website - Cloudflare version

Same website and same app API as the Netlify/Render versions. Pages are in `public/`,
the API is one Cloudflare Worker (`worker/index.mjs` + `src/core.mjs`), data is in Cloudflare D1 (SQLite).

## Deploy from GitHub
1. Create a GitHub repo and upload the CONTENTS of this folder (so `wrangler.jsonc` is in the repo root).
2. Cloudflare dashboard -> **Workers & Pages** -> **Create** -> **Import a repository** -> pick the repo.
3. Build settings: leave the build command empty, deploy command `npx wrangler deploy` (the default). Deploy.
   The D1 database `akaiser-db` is created automatically on the first deploy and the table is created on the first request.
4. Open `https://akaiser-account.YOUR-SUBDOMAIN.workers.dev`: you should see the sign-up page.
5. Check the API:
   `curl -i -X POST https://YOUR-SITE.workers.dev/api/device/status -H "Authorization: Device aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" -H "Content-Type: application/json" -d "{}"`
   It must answer `200` and `{"linked":false,"code":"XXXX-XXXX",...}`.
6. Build the APK with `web_url` = your workers.dev URL (no slash at the end).

If the first deploy complains about the database: Cloudflare -> Storage & Databases -> D1 -> Create database `akaiser-db`,
then add `database_id = "<its id>"` under `d1_databases` in `wrangler.jsonc` and push.

## Settings
Edit `vars` in `wrangler.jsonc` (or Worker -> Settings -> Variables):
| name | default | meaning |
|---|---|---|
| `MAX_DEVICES` | 5 | phones one account may link |
| `GACHA_UTC_OFFSET_MIN` | 0 | daily gacha reset offset in minutes (420 = Jakarta) |

## Test on your PC
    node test.mjs        # 95 checks against an in-memory fake store
    npm i && npx wrangler dev   # run locally with a local D1

## Notes
- D1 is strongly consistent and "create only if new" is atomic, so username/link-code races are safe (better than the Netlify version).
- A daily cron (`03:17 UTC`) removes expired sessions, link codes and rate-limit counters.
- Forgotten passwords: Cloudflare -> D1 -> `akaiser-db` -> Console: `DELETE FROM kv WHERE k = 'u:<username in lowercase>';`
- Security headers are in `public/_headers`.
- Card list: `src/cards.mjs` (generated from the app's `cards.tsv`).
