# Lazyagent Dashboard

A local-first dashboard for monitoring and steering coding-agent sessions through [lazyagent](https://github.com/loft-sh/lazyagent) and the `pi` CLI.

The app combines lazyagent's HTTP/SSE API with a small local backend that can read local `pi` JSONL session files, show recent transcript activity, and launch follow-up non-interactive `pi` runs.

## Features

- Live dashboard of lazyagent sessions
- Session detail view with recent transcript events
- Local session aliases/renames
- Launch a new `pi` agent run from the browser
- Send follow-up prompts to an existing session
- Directory browser for choosing working directories
- Browser-side lazyagent token derivation from the API passphrase
- Widget runtime for add-on dashboard capabilities
- Question Queue Widget for pending agent questions

## Privacy and security

This project is intended for local development. It does not require checked-in secrets.

- Do not commit `.env` files, API keys, bearer tokens, passphrases, local session dumps, or build output.
- The backend binds to `127.0.0.1` by default.
- For public access, put nginx/Caddy/Hostinger TLS in front of the backend and enable dashboard password auth with `DASHBOARD_PASSWORD_HASH` and `DASHBOARD_AUTH_SECRET`.
- Public deployments should expose only the dashboard port; keep lazyagent bound to `127.0.0.1` and use the dashboard's `/lazyagent` proxy.
- The frontend stores the lazyagent API URL and passphrase in browser `localStorage` for convenience. Use a dedicated passphrase and clear site data if you do not want it persisted.
- The transcript backend reads from local `pi` session files and may display sensitive prompts, tool output, file paths, or code snippets.

## Requirements

- Node.js 22+
- npm
- `lazyagent` with API mode enabled
- `pi` CLI available on `PATH` for agent launch/follow-up actions

## Install

```bash
git clone https://github.com/petunmar/lazyagent-dashboard.git
cd lazyagent-dashboard
npm install
```

## Run in development

Start lazyagent's local API in one terminal:

```bash
export LAZYAGENT_API_PASSPHRASE='change-this-local-passphrase'
lazyagent --api --agent pi --host 127.0.0.1:7421
```

Start the dashboard in another terminal:

```bash
npm run dev
```

`npm run dev` starts:

- local backend: `http://127.0.0.1:5174`
- Vite frontend: `http://127.0.0.1:5173`

Open the Vite URL and connect with:

- API URL: `http://127.0.0.1:7421`
- Passphrase: the value from `LAZYAGENT_API_PASSPHRASE`

## Build and run production assets

```bash
npm run build
npm run start
```

Then open:

```text
http://127.0.0.1:5174
```

## Configuration

The backend uses environment variables for local paths and limits:

| Variable | Default | Description |
| --- | --- | --- |
| `EXTENSION_HOST` | `127.0.0.1` | Backend host |
| `EXTENSION_PORT` | `5174` | Backend port |
| `PI_SESSIONS_DIR` | `~/.pi/agent/sessions` | Root directory for pi JSONL sessions |
| `SESSION_NAMES_FILE` | `~/.pi/lazyagent-extension/session-names.json` | Local session alias store |
| `WIDGETS_DIR` | `./widgets` | Widget folders to load, separated by the platform path delimiter |
| `WIDGET_STATE_DIR` | `~/.pi/lazyagent-extension/widgets` | Local Widget state directory |
| `AGENT_APPEND_SYSTEM_PROMPT` | empty | Extra global system prompt appended to `pi -p` runs launched from the dashboard; Widget-specific prompt guidance is provided by loaded Widgets |
| `LAZYAGENT_URL` | `http://127.0.0.1:7421` | Upstream lazyagent API for the authenticated `/lazyagent` proxy |
| `DASHBOARD_PASSWORD_HASH` | empty | Enables dashboard login when set with `DASHBOARD_AUTH_SECRET`; generate with `node scripts/hash-password.js 'password'` |
| `DASHBOARD_AUTH_SECRET` | empty | Random HMAC secret for signed device cookies; generate with `openssl rand -base64 48` |
| `DASHBOARD_AUTH_SECURE_COOKIES` | `true` | Adds `Secure` to auth cookies when requests arrive over HTTPS |
| `DASHBOARD_AUTH_SESSION_DAYS` | `30` | How long a device stays logged in before it must enter the password again |
| `MAX_SESSION_EVENTS` | `250` | Default max transcript events returned |
| `MAX_TOOL_RESULT_CHARS` | `12000` | Tool result truncation limit |
| `MAX_THINKING_CHARS` | `2000` | Thinking block truncation limit |

## Public Hostinger deployment

The production backend serves the built frontend and proxies lazyagent at `/lazyagent`, so browsers on other devices do not need direct access to port `7421`.

1. Install dependencies and build once:

```bash
cd /home/petur/coding/lazyagent-extension
npm install
npm run build
```

2. Create private env files from the examples in `deploy/`:

```bash
sudo cp deploy/lazyagent-dashboard.env.example /etc/lazyagent-dashboard.env
sudo cp deploy/lazyagent-api.env.example /etc/lazyagent-api.env
node scripts/hash-password.js 'use-a-long-unique-password'
openssl rand -base64 48
sudo chmod 600 /etc/lazyagent-dashboard.env /etc/lazyagent-api.env
```

Paste the generated hash into `DASHBOARD_PASSWORD_HASH`, the random secret into `DASHBOARD_AUTH_SECRET`, and a separate lazyagent passphrase into `LAZYAGENT_API_PASSPHRASE` in both env files. Keeping the same lazyagent passphrase in the dashboard env lets authenticated browsers auto-connect through `/lazyagent` without entering a second password.

3. Install and enable the services:

```bash
sudo cp deploy/lazyagent-api.service /etc/systemd/system/
sudo cp deploy/lazyagent-dashboard.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lazyagent-api lazyagent-dashboard
```

Both services start on boot and use `RuntimeMaxSec=3h` with `Restart=always`, which gives them a clean restart every three hours.

4. Put HTTPS in front of the dashboard only. Use `deploy/nginx-lazyagent-dashboard.conf.example` as the nginx site template, replace the domain and certificate paths, then reload nginx.

5. Open the Hostinger link. The first visit from a new device shows the dashboard password screen. After login, the app auto-connects to the managed `/lazyagent` proxy. If you manually open connection settings, use API URL `/lazyagent`; no lazyagent passphrase is needed when `LAZYAGENT_API_PASSPHRASE` is present in the dashboard env.

## Local backend API

```text
GET  /health
GET  /api/session-events/:sessionId
GET  /api/session-events/:sessionId?limit=40
GET  /api/directories?path=~/coding
GET  /api/session-names
POST /api/session-names/:sessionId
GET  /api/widgets
GET  /api/widgets/status
POST /api/agents/start
POST /api/agents/message
GET  /api/agent-runs
```

Widgets can add their own local API below `/api/widgets/:widgetId/*` and static frontend assets below `/widgets/:widgetId/*`. The bundled Question Queue Widget imports only explicit `lazyagent-question` fenced JSON schemas from assistant transcript text; it does not import `ask_user_question` tool calls. It exposes:

```text
GET  /api/widgets/question-queue/questions
POST /api/widgets/question-queue/questions
POST /api/widgets/question-queue/questions/:questionId/answer
```

Agent control is an MVP layer: it starts non-interactive `pi -p` processes and records local process status. It does not stream input into an already-running TUI process.

## CLI examples

The example Node clients can query lazyagent directly:

```bash
LAZYAGENT_API_PASSPHRASE='change-this-local-passphrase' npm run sessions
LAZYAGENT_API_PASSPHRASE='change-this-local-passphrase' npm run watch
```

You can also set `LAZYAGENT_BEARER_TOKEN` directly if you generated one with lazyagent.
