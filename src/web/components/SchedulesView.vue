<script setup lang="ts">
import { computed, reactive } from "vue";
import type { useAgentMonitor } from "../composables/useAgentMonitor";
import type { Schedule } from "../types";
import { relativeTime, shortId } from "../utils";

const props = defineProps<{ monitor: ReturnType<typeof useAgentMonitor> }>();
const state = props.monitor.state;
const emptyForm = () => ({ id: "", name: "", enabled: true, cwd: state.cwdDraft || "~/coding", prompt: "", kind: "recurring" as "one-off" | "recurring", cron: "0 9 * * *", run_at: "", model: "", thinking: "", readonly: false });
const form = reactive(emptyForm());
const editing = computed(() => Boolean(form.id));
const sortedSchedules = computed(() => [...state.schedules].sort((a, b) => (a.next_fire_at || "9999").localeCompare(b.next_fire_at || "9999")));

function reset() { Object.assign(form, emptyForm()); }
function edit(schedule: Schedule) {
  Object.assign(form, {
    id: schedule.id,
    name: schedule.name,
    enabled: schedule.enabled,
    cwd: schedule.cwd,
    prompt: schedule.prompt,
    kind: schedule.kind,
    cron: schedule.cron || "0 9 * * *",
    run_at: schedule.run_at ? formatInputTimestamp(schedule.run_at) : "",
    model: schedule.model || "",
    thinking: schedule.thinking || "",
    readonly: !!schedule.readonly,
  });
}
async function save() {
  const ok = await props.monitor.persistSchedule({ ...form, run_at: form.kind === "one-off" ? form.run_at : "", cron: form.kind === "recurring" ? form.cron : "" });
  if (ok) reset();
}
async function browse(path = form.cwd || "~/coding") { await props.monitor.openDirectoryPicker(path); form.cwd = state.cwdDraft || form.cwd; }
function chooseDirectory(path: string) { props.monitor.selectDirectory(path); form.cwd = path; }
function formatInputTimestamp(value: string): string {
  const date = new Date(value);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")} ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}
function statusLabel(schedule: Schedule): string {
  if (!schedule.enabled) return "disabled";
  if (!schedule.next_fire_at) return "no next fire";
  return `next ${relativeTime(schedule.next_fire_at)}`;
}
</script>

<template>
  <section class="schedules-layout">
    <aside class="console-card schedule-editor" aria-label="Schedule editor">
      <div class="console-head"><span>GMT+0 · Reykjavík</span><h2>{{ editing ? 'Edit Schedule' : 'New Schedule' }}</h2></div>
      <form class="schedule-form" @submit.prevent="save">
        <label>Name<input v-model="form.name" maxlength="80" placeholder="Daily repo check" /></label>
        <label class="checkbox"><input v-model="form.enabled" type="checkbox" /> enabled</label>
        <div class="directory-field"><label>Working directory<input v-model="form.cwd" autocomplete="off" @input="state.cwdDraft = form.cwd" /></label><button class="directory-browse" type="button" @click="browse()">browse</button></div>
        <section v-if="state.directoryPicker.open" class="directory-picker" aria-label="Choose working directory"><header><div><span>vm folders</span><code>{{ state.directoryPicker.path || 'loading…' }}</code></div><div class="directory-picker-actions"><button v-if="state.directoryPicker.parent" class="pill" type="button" @click="browse(state.directoryPicker.parent)">↑ up</button><button v-if="state.directoryPicker.home" class="pill" type="button" @click="browse(state.directoryPicker.home)">home</button><button class="pill" type="button" @click="state.directoryPicker.open = false">close</button></div></header><p v-if="state.directoryPicker.error" class="directory-error">{{ state.directoryPicker.error }}</p><p v-if="state.directoryPicker.loading" class="empty loading">Loading folders…</p><div v-else class="directory-list"><div v-for="entry in state.directoryPicker.entries" :key="entry.path" class="directory-row" :title="entry.path"><button class="directory-name" type="button" @click="browse(entry.path)">📁 {{ entry.name }}</button><button class="directory-select" type="button" @click="chooseDirectory(entry.path)">choose</button></div><p v-if="!state.directoryPicker.entries.length" class="empty">No subfolders here.</p></div><div class="directory-current-actions"><button type="button" @click="chooseDirectory(state.directoryPicker.path)">choose this folder</button></div></section>
        <label>Kind<select v-model="form.kind"><option value="recurring">recurring cron</option><option value="one-off">one-off</option></select></label>
        <label v-if="form.kind === 'recurring'">5-field cron<input v-model="form.cron" placeholder="0 9 * * *" /><small>Standard minute hour day month weekday. Interpreted in Reykjavík/GMT+0; fires within 5 minutes.</small></label>
        <label v-else>Run at<input v-model="form.run_at" placeholder="2026-06-09 14:30" /><small>ISO-like Reykjavík/GMT+0 timestamp.</small></label>
        <label>Prompt<textarea v-model="form.prompt" rows="8" placeholder="Tell the scheduled agent what to do."></textarea></label>
        <div class="agent-options"><label>Model<input v-model="form.model" placeholder="optional" /></label><label>Thinking<select v-model="form.thinking"><option value="">default</option><option>minimal</option><option>low</option><option>medium</option><option>high</option><option>xhigh</option></select></label><label class="checkbox"><input v-model="form.readonly" type="checkbox" /> read-only tools</label></div>
        <div class="agent-actions"><button v-if="editing" class="secondary" type="button" @click="reset">cancel</button><button type="submit">{{ editing ? 'save schedule' : 'create schedule' }}</button></div>
      </form>
      <p v-if="state.schedulesStatus" class="schedule-status">{{ state.schedulesStatus }}</p>
    </aside>

    <section class="schedules-main">
      <div class="view-head"><div><span>core functionality</span><h2>Schedules</h2><p>One-off and recurring Agent launches. Cron and timestamps use Reykjavík/GMT+0.</p></div><button type="button" @click="monitor.loadSchedules()">refresh</button></div>
      <article v-if="!sortedSchedules.length" class="console-card empty-card"><h3>No Schedules</h3><p>Create a Schedule to launch normal Agent runs in the future.</p></article>
      <article v-for="schedule in sortedSchedules" :key="schedule.id" class="console-card schedule-card" :class="{ disabled: !schedule.enabled }">
        <header>
          <div><span>{{ schedule.kind }} · {{ statusLabel(schedule) }}</span><h3>{{ schedule.name }}</h3><code>{{ schedule.kind === 'recurring' ? schedule.cron : formatInputTimestamp(schedule.run_at) }}</code></div>
          <div class="schedule-actions"><button class="secondary" type="button" @click="monitor.runSchedule(schedule.id)">run now</button><button class="ghost" type="button" @click="edit(schedule)">edit</button><button class="ghost danger-button" type="button" @click="monitor.removeSchedule(schedule.id)">delete</button></div>
        </header>
        <p class="schedule-prompt">{{ schedule.prompt }}</p>
        <dl class="schedule-meta"><div><dt>CWD</dt><dd>{{ schedule.cwd }}</dd></div><div><dt>Options</dt><dd>{{ [schedule.model, schedule.thinking, schedule.readonly ? 'read-only' : ''].filter(Boolean).join(' · ') || 'default' }}</dd></div><div><dt>Updated</dt><dd>{{ relativeTime(schedule.updated_at) }}</dd></div></dl>
        <section class="schedule-history" aria-label="Schedule run history">
          <h4>Recent Schedule Runs</h4>
          <p v-if="!schedule.history?.length" class="low-focus-note">No runs yet.</p>
          <div v-for="run in (schedule.history || []).slice(0, 5)" :key="run.id" class="schedule-run-row" :class="run.status">
            <strong>{{ run.status }}</strong><span>{{ run.source }} · fired {{ relativeTime(run.fired_at) }}</span><button v-if="run.session_id" class="rename-chip" type="button" @click="monitor.selectSession(run.session_id)">session {{ shortId(run.session_id) }}</button><code v-if="run.error">{{ run.error }}</code>
          </div>
        </section>
      </article>
    </section>
  </section>
</template>
