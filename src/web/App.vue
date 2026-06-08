<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import DashboardView from "./components/DashboardView.vue";
import DetailView from "./components/DetailView.vue";
import PiResourcesView from "./components/PiResourcesView.vue";
import SchedulesView from "./components/SchedulesView.vue";
import CommandModal from "./components/CommandModal.vue";
import { useAgentMonitor } from "./composables/useAgentMonitor";
import { formatCompact, formatMoney, summarizeSessions } from "./utils";

const monitor = useAgentMonitor();
const { state } = monitor;
const summary = computed(() => summarizeSessions(state.sessions));
const now = computed(() => new Date());
const subtitle = computed(() => state.view === "detail" ? "session detail" : state.view === "pi-resources" ? "skills + extensions" : state.view === "schedules" ? "schedules" : "multi-agent dashboard");
const totalTokens = computed(() => state.spend?.today_tokens ?? 0);
const totalCost = computed(() => state.spend?.today_usd ?? 0);
const maxDailyTokens = computed(() => Math.max(...(state.spend?.daily.map(day => day.tokens) || [0]), 1));
const maxDailySpend = computed(() => Math.max(...(state.spend?.daily.map(day => day.cost_usd) || [0]), 0.001));
const spendBars = computed(() => (state.spend?.daily || []).map(day => {
  const label = new Date(`${day.date}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return {
    ...day,
    label,
    tooltip: `${label}: ${formatMoney(day.cost_usd)}`,
    height: `${Math.max(10, (day.cost_usd / maxDailySpend.value) * 42)}px`,
  };
}));
const tokenBars = computed(() => (state.spend?.daily || []).map(day => {
  const label = new Date(`${day.date}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const cache = day.cache_read_tokens + day.cache_write_tokens;
  return {
    ...day,
    label,
    tooltip: `${label}: ${formatCompact(day.tokens)} tokens · ${formatCompact(day.input_tokens)} in / ${formatCompact(day.output_tokens)} out${cache ? ` · ${formatCompact(cache)} cache` : ""}`,
    height: `${Math.max(10, (day.tokens / maxDailyTokens.value) * 42)}px`,
  };
}));
const spendUpdated = computed(() => state.spend ? new Date(state.spend.generated_at).toLocaleTimeString() : "");

onMounted(() => {
  window.addEventListener("popstate", monitor.handlePopstate);
  monitor.useManagedProxy();
  void monitor.loadWidgets();
  void monitor.loadSchedules();
  if (!state.connected && state.baseUrl.startsWith("/")) void monitor.connect(state.baseUrl, state.passphrase);
  if (state.view === "pi-resources") void monitor.loadPiResources();
  if (state.view === "schedules") void monitor.loadSchedules();
});
onUnmounted(() => window.removeEventListener("popstate", monitor.handlePopstate));
</script>

<template>
  <main class="monitor-shell" :class="{ 'detail-view': state.view === 'detail', 'resources-view': state.view === 'pi-resources', 'schedules-view': state.view === 'schedules' }">
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
        <div class="trend-stat" tabindex="0">
          <dt>{{ formatCompact(totalTokens) }}</dt><dd>today tokens</dd>
          <div class="trend-popover" role="tooltip">
            <div class="trend-popover-head"><strong>token usage</strong><span>past 14 days</span></div>
            <div class="bars trend-bars" aria-label="Tokens over past 14 days">
              <i v-for="day in tokenBars" :key="day.date" class="bar token-bar" :style="{ height: day.height }" :data-tooltip="day.tooltip" :aria-label="day.tooltip" tabindex="0"></i>
            </div>
            <p>summed from Pi transcript usage tokens{{ spendUpdated ? ` · updated ${spendUpdated}` : '' }}</p>
          </div>
        </div>
        <div class="money trend-stat" tabindex="0">
          <dt>{{ formatMoney(totalCost) }}</dt><dd>today</dd>
          <div class="trend-popover" role="tooltip">
            <div class="trend-popover-head"><strong>real spend</strong><span>past 14 days</span></div>
            <div class="bars trend-bars" aria-label="Spend over past 14 days">
              <i v-for="day in spendBars" :key="day.date" class="bar spend-bar" :style="{ height: day.height }" :data-tooltip="day.tooltip" :aria-label="day.tooltip" tabindex="0"></i>
            </div>
            <p>summed from Pi transcript usage costs{{ spendUpdated ? ` · updated ${spendUpdated}` : '' }}</p>
          </div>
        </div>
      </dl>
      <button class="live-clock" type="button" aria-label="Open connection settings" @click="monitor.openModal('connect')">
        <strong><span></span>{{ state.connected ? 'LIVE' : 'SETUP' }}</strong>
        <time>{{ now.toLocaleDateString() }} · {{ now.toLocaleTimeString() }}</time>
      </button>
    </header>

    <p v-if="state.error" class="error-banner">{{ state.error }}</p>

    <DetailView v-if="state.view === 'detail'" :monitor="monitor" />
    <PiResourcesView v-else-if="state.view === 'pi-resources'" :monitor="monitor" />
    <SchedulesView v-else-if="state.view === 'schedules'" :monitor="monitor" />
    <DashboardView v-else :monitor="monitor" />
    <CommandModal v-if="state.modal" :monitor="monitor" />
  </main>
</template>
