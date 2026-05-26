import { LazyagentClient } from "../src/lazyagent-client.js";

const client = new LazyagentClient();
console.log("Watching lazyagent SSE updates. Ctrl-C to stop.");

for await (const update of client.events()) {
  const now = new Date().toLocaleTimeString();
  console.log(`\n[${now}] ${update.stats.active_sessions}/${update.stats.total_sessions} active`);
  for (const s of update.sessions) {
    console.log(`- ${s.activity.padEnd(10)} ${String(s.agent || "?").padEnd(8)} ${s.short_name}`);
  }
}
