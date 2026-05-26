import { LazyagentClient } from "../src/lazyagent-client.js";

const client = new LazyagentClient();
const [stats, sessions] = await Promise.all([client.stats(), client.sessions()]);

console.log(`${stats.active_sessions}/${stats.total_sessions} active sessions in the last ${stats.window_minutes} minutes`);
for (const s of sessions) {
  console.log(`${s.activity.padEnd(10)} ${String(s.agent || "?").padEnd(8)} ${s.short_name} ${s.session_id}`);
}
