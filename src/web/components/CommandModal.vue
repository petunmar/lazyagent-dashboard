<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import AttachmentComposer from "./AttachmentComposer.vue";
import type { useAgentMonitor } from "../composables/useAgentMonitor";
import type { PendingAttachment } from "../types";
import { displaySessionName, relativeTime, shortId } from "../utils";

const props = defineProps<{ monitor: ReturnType<typeof useAgentMonitor> }>();
const state = props.monitor.state;
const selected = computed(() => props.monitor.selectedSession.value);
const isMessage = computed(() => state.modal === "message");
const form = reactive({ cwd: "", sessionId: "", prompt: "", model: "", thinking: "", readonly: false, name: "" });
const attachments = ref<PendingAttachment[]>([]);

watch(() => state.modal, () => reset(), { immediate: true });
function reset() {
  form.cwd = state.cwdDraft || selected.value?.cwd || "~/coding";
  form.sessionId = isMessage.value ? state.selectedId : "";
  form.prompt = ""; form.model = ""; form.thinking = ""; form.readonly = false;
  attachments.value = [];
  form.name = selected.value ? (state.sessionNames[selected.value.session_id] || displaySessionName(selected.value, state.sessionNames)) : "";
}
function closeOnBackdrop(event: MouseEvent) { if (event.target === event.currentTarget) props.monitor.closeModal(); }
async function submitAgent() { await props.monitor.sendAgent({ mode: isMessage.value ? "message" : "start", ...form, attachments: attachments.value }); form.prompt = ""; attachments.value = []; }
async function queueAgent() { if (await props.monitor.queueAgentMessage({ cwd: form.cwd, sessionId: form.sessionId, prompt: form.prompt, attachments: attachments.value })) { form.prompt = ""; attachments.value = []; props.monitor.closeModal(); } }
async function browse(path = form.cwd || "~/coding") { await props.monitor.openDirectoryPicker(path); form.cwd = state.cwdDraft || form.cwd; }
function chooseDirectory(path: string) { props.monitor.selectDirectory(path); form.cwd = path; }
async function rename(mode: "save" | "auto" | "clear") { await props.monitor.renameSelected(mode, form.name); }
</script>

<template>
  <div class="modal-backdrop" @click="closeOnBackdrop">
    <section v-if="state.modal === 'connect'" class="modal-card connect-modal" role="dialog" aria-modal="true" aria-label="Connection settings">
      <button class="modal-close" type="button" @click="monitor.closeModal()">×</button><div class="console-head"><span>connection</span><h2>Lazyagent API</h2></div>
      <form class="connect-form" @submit.prevent="monitor.connect(state.baseUrl, state.passphrase)"><label>API <input v-model="state.baseUrl" placeholder="http://127.0.0.1:7421" /></label><label>Passphrase <input v-model="state.passphrase" type="password" autocomplete="current-password" placeholder="lazyagent --api passphrase" /></label><div class="connect-actions"><div class="connection-state" :class="{ ok: state.connected }">{{ state.status }}</div><button type="submit">{{ state.connected ? 'reconnect' : 'connect' }}</button></div></form>
    </section>

    <section v-else-if="state.modal === 'rename' && selected" class="modal-card rename-modal" role="dialog" aria-modal="true" aria-label="Rename session">
      <button class="modal-close" type="button" @click="monitor.closeModal()">×</button><div class="console-head"><span>readable name</span><h2>Rename session</h2></div>
      <form class="rename-form" @submit.prevent="rename('save')"><label>Name<input id="session-name-input" v-model="form.name" maxlength="80" autocomplete="off" /></label><p class="rename-hint">This only changes the app label. Session ID and context stay unchanged: <code>{{ shortId(selected.session_id) }}</code></p><div class="agent-actions"><button type="submit">save name</button><button type="button" @click="rename('auto')">random name</button><button v-if="state.sessionNames[selected.session_id]" type="button" @click="rename('clear')">clear</button></div></form>
    </section>

    <section v-else class="modal-card" role="dialog" aria-modal="true" :aria-label="isMessage ? 'Message agent' : 'Launch new agent'">
      <button class="modal-close" type="button" @click="monitor.closeModal()">×</button><div class="console-head"><span>{{ isMessage ? 'follow-up' : 'compose' }}</span><h2>{{ isMessage ? 'Message agent' : 'Launch new agent' }}</h2></div>
      <form class="agent-form" @submit.prevent="submitAgent">
        <div class="directory-field"><label>Working directory<input id="agent-cwd" v-model="form.cwd" autocomplete="off" @input="state.cwdDraft = form.cwd" /></label><button class="directory-browse" type="button" @click="browse()">browse</button></div>
        <section v-if="state.directoryPicker.open" class="directory-picker" aria-label="Choose working directory"><header><div><span>vm folders</span><code>{{ state.directoryPicker.path || 'loading…' }}</code></div><div class="directory-picker-actions"><button v-if="state.directoryPicker.parent" class="pill" type="button" @click="browse(state.directoryPicker.parent)">↑ up</button><button v-if="state.directoryPicker.home" class="pill" type="button" @click="browse(state.directoryPicker.home)">home</button><button class="pill" type="button" @click="state.directoryPicker.open = false">close</button></div></header><p v-if="state.directoryPicker.error" class="directory-error">{{ state.directoryPicker.error }}</p><p v-if="state.directoryPicker.loading" class="empty loading">Loading folders…</p><div v-else class="directory-list"><div v-for="entry in state.directoryPicker.entries" :key="entry.path" class="directory-row" :title="entry.path"><button class="directory-name" type="button" @click="browse(entry.path)">📁 {{ entry.name }}</button><button class="directory-select" type="button" @click="chooseDirectory(entry.path)">choose</button></div><p v-if="!state.directoryPicker.entries.length" class="empty">No subfolders here.</p></div><div class="directory-current-actions"><button type="button" @click="chooseDirectory(state.directoryPicker.path)">choose this folder</button></div></section>
        <label>Session ID<input v-model="form.sessionId" placeholder="empty starts a new session" :readonly="isMessage" /></label><label class="prompt-field">Message<AttachmentComposer v-model="form.prompt" v-model:attachments="attachments" :rows="5" :placeholder="`→ ${isMessage ? `send a message to ${selected ? displaySessionName(selected, state.sessionNames) : 'agent'}` : 'tell the new agent what to do'}`" /></label>
        <div class="agent-options"><label>Model<input v-model="form.model" placeholder="optional · gpt-5.5" /></label><label>Thinking<select v-model="form.thinking"><option value="">default</option><option>minimal</option><option>low</option><option>medium</option><option>high</option><option>xhigh</option></select></label><label class="checkbox"><input v-model="form.readonly" type="checkbox" /> read-only tools</label></div><div class="agent-actions"><button v-if="isMessage" class="secondary" type="button" @click="queueAgent">queue</button><button type="submit">↵ {{ isMessage ? 'send now' : 'start' }}</button></div>
      </form>
      <div class="runs" :hidden="!state.runs.length"><article v-for="run in state.runs.slice(0, 3)" :key="run.run_id" class="run-row" :class="run.status"><strong>{{ run.kind }} · {{ run.status }}</strong><span>{{ run.session_id || 'session pending' }} · {{ relativeTime(run.started_at) }}</span><pre v-if="run.stderr_tail">{{ run.stderr_tail }}</pre></article></div>
    </section>
  </div>
</template>
