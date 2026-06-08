<script setup lang="ts">
import { computed } from "vue";
import AgentCard from "./AgentCard.vue";
import SharedDocumentsPanel from "./SharedDocumentsPanel.vue";
import WidgetFrame from "./WidgetFrame.vue";
import type { useAgentMonitor } from "../composables/useAgentMonitor";
import type { SessionFilter } from "../types";
import { displaySessionName, isLowFocusSession, quietSessionWindowHours, relativeTime } from "../utils";

const props = defineProps<{ monitor: ReturnType<typeof useAgentMonitor> }>();
const state = props.monitor.state;
const filters: SessionFilter[] = ["all", "working", "idle", "errored"];
const focusSessions = computed(() => props.monitor.visibleSessions.value.filter(session => !isLowFocusSession(session)));
const lowFocusSessions = computed(() => props.monitor.visibleSessions.value.filter(isLowFocusSession));
const upcomingSchedules = computed(() => state.schedules.filter(schedule => schedule.enabled).slice(0, 3));
const recentScheduleRuns = computed(() => state.schedules.flatMap(schedule => (schedule.history || []).slice(0, 2).map(run => ({ ...run, schedule }))).sort((a, b) => b.fired_at.localeCompare(a.fired_at)).slice(0, 3));
const topWidgets = computed(() => state.widgets.filter(widget => {
  const slot = "dashboard:top";
  if (!widget.slots.includes(slot)) return false;
  const rule = widget.status_visibility?.[slot] || "always";
  if (rule === "has_pending") return (state.widgetStatuses.find(status => status.id === widget.id)?.pending || 0) > 0;
  return true;
}));
</script>

<template>
  <section class="dashboard-controls">
    <div class="filter-pills">
      <button v-for="filter in filters" :key="filter" class="pill" :class="{ active: state.filter === filter }" type="button" @click="state.filter = filter; monitor.loadVisibleCardTools()">{{ filter }}</button>
      <button class="pill" type="button" @click="monitor.navigateTo('pi-resources')">skills + extensions</button>
      <button class="pill" type="button" @click="monitor.navigateTo('schedules')">schedules</button>
      <button class="pill create" type="button" @click="monitor.openModal('launch')">+ new agent</button>
    </div>
  </section>

  <section v-if="topWidgets.length" class="widget-strip" aria-label="Dashboard widgets">
    <WidgetFrame v-for="widget in topWidgets" :key="widget.id" :widget="widget" slot-name="dashboard:top" :monitor="monitor" />
  </section>

  <SharedDocumentsPanel :monitor="monitor" />

  <section class="schedule-summary console-card" aria-label="Schedules summary">
    <div class="console-head"><span>core</span><h2>Schedules</h2></div>
    <div class="schedule-summary-grid">
      <div>
        <h3>Next due</h3>
        <p v-if="!upcomingSchedules.length" class="low-focus-note">No enabled schedules yet.</p>
        <button v-for="schedule in upcomingSchedules" :key="schedule.id" class="schedule-summary-row" type="button" @click="monitor.navigateTo('schedules')">
          <strong>{{ schedule.name }}</strong><span>{{ schedule.next_fire_at ? relativeTime(schedule.next_fire_at) : 'not scheduled' }}</span>
        </button>
      </div>
      <div>
        <h3>Recent runs</h3>
        <p v-if="!recentScheduleRuns.length" class="low-focus-note">No schedule runs recorded.</p>
        <button v-for="run in recentScheduleRuns" :key="run.id" class="schedule-summary-row" type="button" @click="monitor.navigateTo('schedules')">
          <strong>{{ run.schedule.name }}</strong><span>{{ run.status }} · {{ relativeTime(run.fired_at) }}</span>
        </button>
      </div>
    </div>
    <div class="agent-actions"><button class="secondary" type="button" @click="monitor.loadSchedules()">refresh</button><button type="button" @click="monitor.navigateTo('schedules')">manage schedules</button></div>
  </section>

  <section class="agent-grid">
    <AgentCard v-for="session in focusSessions" :key="session.session_id" :session="session" :monitor="monitor" />
    <article v-if="!focusSessions.length" class="agent-card empty-card"><h3>No matching agents</h3><p>{{ lowFocusSessions.length ? 'No high-focus agents. Quiet sessions from the last 24 hours are listed below.' : 'Connect lazyagent or change the filter.' }}</p></article>
  </section>

  <section v-if="lowFocusSessions.length" class="low-focus-panel console-card" aria-label="Inactive recent sessions">
    <div class="console-head"><span>last {{ quietSessionWindowHours }}h</span><h2>Quiet sessions</h2></div>
    <p class="low-focus-note">All inactive sessions with activity in the last {{ quietSessionWindowHours }} hours, including archived agents from local Pi session logs.</p>
    <div class="low-focus-list">
      <article v-for="session in lowFocusSessions" :key="session.session_id" class="low-focus-row" :class="{ 'widget-alert': monitor.sessionHasWidgetAlert(session.session_id) }" tabindex="0" role="button" @click="monitor.selectSession(session.session_id)">
        <div><strong>{{ displaySessionName(session, state.sessionNames) }}</strong><span><template v-if="session.agent">{{ session.agent }} · </template>{{ session.cwd }} · {{ session.session_id.replaceAll('-', '').slice(0, 8) }}</span></div>
        <div class="low-focus-meta"><span>{{ session.activity }}</span><time>{{ session.last_activity }}</time><button class="rename-chip" type="button" @click.stop="monitor.openModal('rename', session.session_id)">rename</button></div>
      </article>
    </div>
  </section>
</template>
