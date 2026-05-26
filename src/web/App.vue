<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import DashboardView from "./components/DashboardView.vue";
import DetailView from "./components/DetailView.vue";
import PiResourcesView from "./components/PiResourcesView.vue";
import CommandModal from "./components/CommandModal.vue";
import { useAgentMonitor } from "./composables/useAgentMonitor";
import { formatCompact, formatMoney, summarizeSessions } from "./utils";

const monitor = useAgentMonitor();
const { state } = monitor;
const summary = computed(() => summarizeSessions(state.sessions));
const now = computed(() => new Date());
const subtitle = computed(() => state.view === "detail" ? "session detail" : state.view === "pi-resources" ? "skills + extensions" : "multi-agent dashboard");
const totalTokens = computed(() => state.selectedDetail ? state.selectedDetail.input_tokens + state.selectedDetail.output_tokens : 0);
const totalCost = computed(() => state.sessions.reduce((sum, session) => sum + (session.cost_usd || 0), 0));

onMounted(() => {
  window.addEventListener("popstate", monitor.handlePopstate);
  if (state.view === "pi-resources") void monitor.loadPiResources();
});
onUnmounted(() => window.removeEventListener("popstate", monitor.handlePopstate));
</script>

<template>
  <main class="monitor-shell" :class="{ 'detail-view': state.view === 'detail', 'resources-view': state.view === 'pi-resources' }">
    <header class="monitor-topbar">
      <div class="brand-lockup">
        <button class="brand-mark" type="button" aria-label="Back to dashboard" @click="monitor.navigateTo('dashboard')">A</button>
        <div><h1>Agent Monitor</h1><p>{{ subtitle }}</p></div>
      </div>
      <dl class="hero-stats">
        <div><dt>{{ state.stats?.total_sessions ?? (state.sessions.length || '—') }}</dt><dd>agents</dd></div>
        <div class="accent"><dt>{{ summary.working }}</dt><dd>working</dd></div>
        <div><dt>{{ summary.idle }}</dt><dd>idle</dd></div>
        <div class="danger"><dt>{{ summary.errored }}</dt><dd>errored</dd></div>
        <div><dt>{{ formatCompact(totalTokens) }}</dt><dd>tokens</dd></div>
        <div class="money"><dt>{{ formatMoney(totalCost) }}</dt><dd>today</dd></div>
      </dl>
      <button class="live-clock" type="button" aria-label="Open connection settings" @click="monitor.openModal('connect')">
        <strong><span></span>{{ state.connected ? 'LIVE' : 'SETUP' }}</strong>
        <time>{{ now.toLocaleDateString() }} · {{ now.toLocaleTimeString() }}</time>
      </button>
    </header>

    <p v-if="state.error" class="error-banner">{{ state.error }}</p>

    <DetailView v-if="state.view === 'detail'" :monitor="monitor" />
    <PiResourcesView v-else-if="state.view === 'pi-resources'" :monitor="monitor" />
    <DashboardView v-else :monitor="monitor" />
    <CommandModal v-if="state.modal" :monitor="monitor" />
  </main>
</template>
