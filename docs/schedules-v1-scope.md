# Schedules v1 scope

Schedules are a first-class Agent Monitor feature, not a Widget. A Schedule is a configured one-off or recurring time-based trigger that launches a normal Agent run.

## Product language

- Use **Schedule** for the configured trigger.
- Use **Schedule Run** for one recorded execution outcome: successful launch, failure, skipped overlap, or manual run.
- Avoid **Scheduled Agent** and **Automation**.

## Supported schedule types

- One-off Schedules.
- Recurring Schedules.
- Time-based only; no event-based triggers in v1.

## Time and recurrence

- Recurring Schedules use standard 5-field cron: `minute hour day-of-month month day-of-week`.
- Cron is interpreted in Reykjavík/GMT+0 time.
- One-off Schedules accept an ISO-like timestamp such as `2026-06-09 14:30`, interpreted in Reykjavík/GMT+0.
- Scheduler precision is 5 minutes. Any valid cron minute value is allowed, but firing may happen up to 5 minutes late.
- Disabled Schedules should show the hypothetical next fire time, but must not be treated as due.
- Editing timing or enabled state recomputes the next fire time from the edit timestamp and does not catch up occurrences from the old definition.

## Agent launch behavior

- Every Schedule fire starts a new Agent session.
- Scheduled runs inherit the same system prompt chain as manually launched Agents: env prompt, Dashboard System Prompt, and Widget System Prompts.
- No Schedule-specific stop control in v1; scheduled runs are normal Agent runs and the Schedules UI should link to the created run/session when available.
- Schedule prompts are literal text in v1; no template variables.

## Schedule fields

Required:

- `name`
- `enabled`
- `cwd`
- `prompt`
- `kind`: `one-off` or `recurring`
- `run_at` for one-off Schedules, or `cron` for recurring Schedules

Optional launch fields matching manual launch:

- `model`
- `thinking`
- `readonly`

Out of scope in v1:

- Attachments
- Event-based triggers
- Continue/message existing sessions
- Prompt template variables
- Import/export UI
- Retry policy
- Separate notification channels
- Per-Schedule authorization

## Execution guarantees

- Schedules are persisted locally and run by the Agent Monitor backend.
- If the backend is down, it performs best-effort catch-up on next start.
- Missed one-off Schedules run once on catch-up.
- Missed recurring Schedules run once if at least one occurrence was missed, then compute the next fire time.
- If a Schedule fires while a previous run from the same Schedule is still active, skip the overlapping fire and record a Schedule Run with skipped status.
- Failed launches do not retry automatically; record failure and leave the next recurring fire unchanged.

## History and naming

- Store the last 50 Schedule Runs per Schedule.
- Schedule Runs record status, timestamps, manual vs scheduled source, run/session identifiers when available, and error text when applicable.
- Sessions created by a Schedule get a default alias derived from Schedule name plus fire time, e.g. `Daily repo check · 2026-06-09 09:00`.
- Deleting a Schedule hard-deletes its bounded history. Users can disable a Schedule if they want to preserve history.

## UI scope

- Add a first-class Schedules view reachable from dashboard controls.
- Add a compact dashboard summary card showing next due Schedules and recent Schedule Runs.
- Include Run now for testing a Schedule immediately; record the resulting Schedule Run as manual.
- Show failure/skipped status in the Schedules UI/history only; no Question Queue item or browser notification in v1.

## Storage and access

- Store Schedule definitions and history in `~/.pi/lazyagent-extension/schedules.json`.
- Any authenticated dashboard user can create, edit, disable, delete, and run Schedules.
