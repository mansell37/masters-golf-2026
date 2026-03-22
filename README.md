# Golf Sweepstake (Railway Ready)

This app is now set up to deploy on Railway from GitHub with auto-deploys.

## What changed for hosting

- Added a Node web server (`server.js`) to:
  - serve the static app files (`index.html`, `css`, `js`)
  - provide a backend proxy endpoint at `/api/espn` for ESPN data
  - provide shared app state endpoints at `/api/state` for teams/groups/bonus
  - expose a health endpoint at `/health`
- Added `package.json` with `start` script for Railway.
- Added `railway.json` for deployment policy.
- Updated frontend ESPN fetch logic to use:
  - `/api/espn` when hosted
  - direct ESPN URL when opening `index.html` from local file system

## Local run

1. Open terminal in this folder.
2. Install dependencies:
   - `npm install`
3. Start server:
   - `npm start`
4. Open:
   - `http://localhost:3000`

## Deploy to Railway (GitHub integration)

1. Push this folder to a GitHub repo.
2. In Railway:
   - New Project -> Deploy from GitHub Repo
   - Select your repo
3. Railway auto-detects Node and uses:
   - install: `npm install`
   - start: `npm start`
4. (Optional) In Railway Variables, set:
   - `ESPN_LEADERBOARD_URL`
   - Default is already set to ESPN PGA scoreboard, so this is optional.
5. After first deploy, open your Railway domain and verify:
   - `/health` returns `{ "ok": true }`
   - app loads and leaderboard updates

## Suggested GitHub workflow

- Make Railway your production branch deploy target (usually `main`).
- Push updates to GitHub; Railway redeploys automatically.
- Use pull requests for changes before merge to `main`.

## Data storage behavior

- Team entries, groups, and bonus questions are now stored on the server via `/api/state`, so they are shared across devices.
- The browser still keeps a local cache for resilience, but server data is the source of truth when hosted.
- Current server persistence uses a JSON file (`data/state.json`).
  - For production durability across restarts/redeploys, attach a Railway volume or move to Postgres.
