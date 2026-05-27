<script setup lang="ts">
import { computed } from "vue";
import AgentCard from "./AgentCard.vue";
import WidgetFrame from "./WidgetFrame.vue";
import type { useAgentMonitor } from "../composables/useAgentMonitor";
import type { SessionFilter } from "../types";
import { isLowFocusSession, lowFocusAfterMinutes } from "../utils";

const props = defineProps<{ monitor: ReturnType<typeof useAgentMonitor> }>();
const state = props.monitor.state;
const filters: SessionFilter[] = ["all", "working", "idle", "errored"];
const focusSessions = computed(() => props.monitor.visibleSessions.value.filter(session => !isLowFocusSession(session)));
const lowFocusSessions = computed(() => props.monitor.visibleSessions.value.filter(isLowFocusSession));
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
      <button class="pill create" type="button" @click="monitor.openModal('launch')">+ new agent</button>
    </div>
  </section>

  <section v-if="topWidgets.length" class="widget-strip" aria-label="Dashboard widgets">
    <WidgetFrame v-for="widget in topWidgets" :key="widget.id" :widget="widget" slot-name="dashboard:top" :monitor="monitor" />
  </section>

  <section class="agent-grid">
    <AgentCard v-for="session in focusSessions" :key="session.session_id" :session="session" :monitor="monitor" />
    <article v-if="!focusSessions.length" class="agent-card empty-card"><h3>No matching agents</h3><p>{{ lowFocusSessions.length ? 'No high-focus agents. Older idle sessions are listed below.' : 'Connect lazyagent or change the filter.' }}</p></article>
  </section>

  <section v-if="lowFocusSessions.length" class="low-focus-panel console-card" aria-label="Inactive recent sessions">
    <div class="console-head"><span>recent idle</span><h2>Quiet sessions</h2></div>
    <p class="low-focus-note">Idle for {{ lowFocusAfterMinutes }}+ minutes. Includes archived agents from local Pi session logs for the past 12 hours.</p>
    <div class="low-focus-list">
      <article v-for="session in lowFocusSessions" :key="session.session_id" class="low-focus-row" :class="{ 'widget-alert': monitor.sessionHasWidgetAlert(session.session_id) }" tabindex="0" role="button" @click="monitor.selectSession(session.session_id)">
        <div><strong>{{ session.short_name }}</strong><span>{{ session.cwd }} · {{ session.session_id.replaceAll('-', '').slice(0, 8) }}</span></div>
        <div class="low-focus-meta"><span>{{ session.activity }}</span><time>{{ session.last_activity }}</time><button class="rename-chip" type="button" @click.stop="monitor.openModal('rename', session.session_id)">rename</button></div>
      </article>
    </div>
  </section>
</template>
