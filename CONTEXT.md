# Context

## Glossary

- **Agent Monitor** — the product surface for observing and directing local coding-agent sessions.
- **Dashboard** — the first-screen overview in Agent Monitor, focused on live Agent activity rather than detailed controls.
- **Agent** — one local coding-agent session shown in the monitor.
- **Activity Card** — a dashboard card that summarizes one Agent's status, current or last work, recent tool rhythm, message/token usage, cost, and quick follow-up affordance.
- **Agent Detail** — the drill-down view for one Agent's metadata and transcript.
- **Command Modal** — a temporary composer used to start a new Agent or send a follow-up to the selected Agent without leaving the current view.
- **Live Transcript** — the chronological activity stream for the selected Agent, including messages, reasoning markers, tool calls, and tool results when available.
- **Pi Resources** — the installed Pi skills, extensions, and Agent Monitor prompt surfaces available to inspect from Agent Monitor.
- **Dashboard System Prompt** — user-editable operating instructions that Agent Monitor appends to every Agent it launches or continues.
- **Widget System Prompt** — read-only operating instructions supplied by a Widget and appended to Agents launched or continued by Agent Monitor.
- **Widget** — an independently packaged add-on that augments Agent Monitor without being part of the dashboard source code. Avoid: Dashboard Extension, Plugin.
- **Widget Slot** — a named place in Agent Monitor where a Widget can appear.
- **Question Queue** — a Widget that gathers questions from Agents, keeps unanswered questions visible, and records user answers.
- **Pending Question** — an unanswered question from one Agent to the user; it belongs to exactly one Agent until answered.
- **Question Schema** — the explicit transcript format an Agent writes to create a Pending Question for the Question Queue. The schema must include options; generic tool calls are not questions for the dashboard.
