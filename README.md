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
- The frontend stores the lazyagent API URL and passphrase in browser `localStorage` for convenience. Use a dedicated local passphrase and clear site data if you do not want it persisted.
- The transcript backend reads from local `pi` session files and may display sensitive prompts, tool output, file paths, or code snippets. Avoid exposing it on a public network.

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
| `MAX_SESSION_EVENTS` | `250` | Default max transcript events returned |
| `MAX_TOOL_RESULT_CHARS` | `12000` | Tool result truncation limit |
| `MAX_THINKING_CHARS` | `2000` | Thinking block truncation limit |

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
