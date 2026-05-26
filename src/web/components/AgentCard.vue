<script setup lang="ts">
import { computed } from "vue";
import type { useAgentMonitor } from "../composables/useAgentMonitor";
import type { SessionItem } from "../types";
import { compactPath, currentWork, displaySessionName, formatCompact, formatMoney, relativeTime, sessionTone, shortId, statusLabel, toolClass } from "../utils";

const props = defineProps<{ session: SessionItem; monitor: ReturnType<typeof useAgentMonitor> }>();
const state = props.monitor.state;
const detail = computed(() => props.session.session_id === state.selectedId ? state.selectedDetail : null);
const name = computed(() => displaySessionName(props.session, state.sessionNames));
const work = computed(() => currentWork(props.session, detail.value));
const tools = computed(() => state.cardTools[props.session.session_id] || []);
function height(name: string, i: number) { return `${18 + ((name.length * 5 + i * 7) % 24)}px`; }
</script>

<template>
  <article class="agent-card" :class="[sessionTone(session), { selected: session.session_id === state.selectedId }]" tabindex="0" role="button" :aria-label="`Open ${name} detail`" @click="monitor.selectSession(session.session_id)">
    <button class="card-hit" type="button" :aria-label="`Select ${name}`"></button>
    <header class="card-head">
      <div class="agent-title"><span class="agent-dot"></span><h3>{{ name }}</h3></div>
      <div class="status-stack"><button class="rename-chip" type="button" @click.stop="monitor.openModal('rename', session.session_id)">rename</button><span class="state-badge">{{ statusLabel(session) }}</span><span class="model-tag">{{ session.model || 'model ?' }}</span></div>
    </header>
    <p class="path-line">{{ compactPath(session.cwd) }} · {{ shortId(session.session_id) }}</p>
    <div class="current-work"><div><span>{{ work.label }}</span><strong>{{ work.text }}</strong></div><time>{{ relativeTime(session.last_activity) }}</time></div>
    <div class="tool-spark"><div class="spark-head"><span>last {{ tools.length }} tool calls</span><span>now →</span></div><div class="bars"><span v-if="!tools.length" class="spark-empty">loading…</span><i v-for="(tool, i) in tools" :key="`${tool.name}-${i}`" class="bar" :class="toolClass(tool.name)" :style="{ height: height(tool.name, i) }" :data-tooltip="tool.detail" :aria-label="tool.detail"></i></div></div>
    <dl class="card-metrics">
      <div><dt>{{ detail ? `${detail.user_messages}/${detail.assistant_messages}` : session.total_messages }}</dt><dd>msgs</dd></div>
      <div><dt>{{ detail ? formatCompact(detail.input_tokens) : '—' }}<small v-if="detail?.cache_read_tokens"> +{{ formatCompact(detail.cache_read_tokens) }}</small></dt><dd>tok in</dd></div>
      <div><dt>{{ detail ? formatCompact(detail.output_tokens) : '—' }}</dt><dd>tok out</dd></div>
      <div><dt>{{ typeof session.cost_usd === 'number' ? formatMoney(session.cost_usd) : '—' }}</dt><dd>cost</dd></div>
    </dl>
  </article>
</template>
