<script setup lang="ts">
import { computed } from "vue";
import type { useAgentMonitor } from "../composables/useAgentMonitor";
import { displaySessionName, eventBody, eventTitle, relativeTime, shortId } from "../utils";

const props = defineProps<{ monitor: ReturnType<typeof useAgentMonitor> }>();
const state = props.monitor.state;
const selected = computed(() => props.monitor.selectedSession.value || state.sessions[0]);
const name = computed(() => selected.value ? displaySessionName(selected.value, state.sessionNames) : "");
const transcriptSummary = computed(() => {
  const raw = state.rawEvents;
  if (!raw) return "Loading raw transcript…";
  return state.transcriptMode === "full" ? `${raw.event_count} parsed events${raw.truncated ? ` · showing last ${raw.events.length}` : ""}` : `latest ${raw.events.length} events · ${raw.event_count} total`;
});
async function submitChat() {
  if (!selected.value) return;
  await props.monitor.sendAgent({ mode: "message", cwd: selected.value.cwd, sessionId: selected.value.session_id, prompt: state.chatDraft });
}
</script>

<template>
  <template v-if="selected">
    <section class="detail-actions">
      <button class="pill" type="button" @click="monitor.navigateTo('dashboard')">← dashboard</button>
      <div class="detail-action-group"><button class="pill" type="button" @click="monitor.navigateTo('pi-resources')">skills + extensions</button><button class="pill create" type="button" @click="monitor.openModal('launch')">+ new agent</button></div>
    </section>
    <section class="detail-layout">
      <aside class="console-card detail-card">
        <div class="console-head"><span>focus</span><div class="focus-title"><h2>{{ name }}</h2><button class="rename-chip" type="button" @click="monitor.openModal('rename', selected.session_id)">rename</button></div></div>
        <dl class="detail-list">
          <div><dt>Name</dt><dd>{{ name }}</dd></div><div><dt>Path</dt><dd>{{ selected.cwd }}</dd></div><div><dt>Session</dt><dd><code>{{ selected.session_id }}</code></dd></div><div><dt>Activity</dt><dd>{{ selected.activity }} {{ selected.is_active ? '· active' : '· inactive' }}</dd></div><div><dt>Current</dt><dd>{{ state.selectedDetail?.current_tool || '—' }}</dd></div><div><dt>Last write</dt><dd>{{ state.selectedDetail?.last_file_write || '—' }}</dd></div><div><dt>Branch</dt><dd>{{ selected.git_branch || '—' }}</dd></div><div><dt>Resume</dt><dd><code v-if="state.selectedDetail?.resume_command">{{ state.selectedDetail.resume_command }}</code><template v-else>—</template></dd></div>
        </dl>
        <p v-if="!state.selectedDetail" class="empty loading">Loading detail…</p>
      </aside>
      <section class="console-card transcript-card inline-transcript">
        <div class="console-head"><span>stream</span><h2>Live transcript</h2></div>
        <div class="transcript-body" aria-live="polite">
          <div class="transcript-meta"><span>{{ transcriptSummary }}</span><div class="transcript-tools"><button class="pill" :class="{ active: state.transcriptMode === 'recent' }" type="button" @click="monitor.setTranscriptMode('recent')">latest</button><button class="pill" :class="{ active: state.transcriptMode === 'full' }" type="button" @click="monitor.setTranscriptMode('full')">full transcript</button></div></div>
          <code v-if="state.rawEvents?.file" class="transcript-file">{{ state.rawEvents.file }}</code>
          <div v-if="state.transcriptMode === 'full' && state.selectedDetail" class="mini-cards"><section><h3>Recent messages</h3><article v-for="message in state.selectedDetail.recent_messages" :key="`${message.role}-${message.timestamp}-${message.text}`" class="message"><header><strong>{{ message.role }}</strong><span>{{ message.timestamp ? relativeTime(message.timestamp) : '' }}</span></header><p>{{ message.text }}</p></article><p v-if="!state.selectedDetail.recent_messages.length" class="empty">No recent messages exposed by lazyagent.</p></section><section><h3>Recent tool calls</h3><article v-for="tool in state.selectedDetail.recent_tools" :key="`${tool.name}-${tool.timestamp}`" class="tool-row"><strong>{{ tool.name }}</strong><span>{{ tool.timestamp ? relativeTime(tool.timestamp) : '' }}</span></article><p v-if="!state.selectedDetail.recent_tools.length" class="empty">No recent tool calls exposed by lazyagent.</p></section></div>
          <section class="timeline-block raw-events"><h3>Raw session events</h3><article v-for="event in state.rawEvents?.events || []" :key="`${event.kind}-${event.line}`" class="raw-event" :class="event.kind"><header><strong>{{ eventTitle(event) }}</strong><span>{{ event.timestamp ? `${relativeTime(event.timestamp)} · ` : '' }}line {{ event.line ?? '?' }}</span></header><pre v-if="eventBody(event)">{{ eventBody(event) }}</pre></article><p v-if="!state.rawEvents" class="empty">Reading pi JSONL transcript from disk…</p></section>
        </div>
        <form class="chat-compose" aria-label="Send a follow-up message to this agent" @submit.prevent="submitChat">
          <textarea id="chat-prompt" v-model="state.chatDraft" rows="3" :placeholder="`Message ${name}…`" @keydown.meta.enter.prevent="submitChat" @keydown.ctrl.enter.prevent="submitChat"></textarea>
          <div class="chat-compose-actions"><span>{{ shortId(selected.session_id) }} · ⌘/ctrl+enter sends</span><button name="mode" value="message" type="submit">send ↵</button></div>
        </form>
      </section>
    </section>
  </template>
  <section v-else class="console-card"><p class="empty">Select an agent from the dashboard.</p></section>
</template>
