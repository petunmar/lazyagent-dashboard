<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import type { useAgentMonitor } from "../composables/useAgentMonitor";
import type { WidgetManifest, WidgetSlot } from "../types";
import { extensionApiBase } from "../utils";

const props = defineProps<{ widget: WidgetManifest; slotName: WidgetSlot; sessionId?: string; monitor: ReturnType<typeof useAgentMonitor> }>();
const key = computed(() => `${props.widget.id}:${props.slotName}:${props.sessionId || "all"}`);
const src = computed(() => {
  const params = new URLSearchParams({ slot: props.slotName });
  if (props.sessionId) params.set("session_id", props.sessionId);
  return `${extensionApiBase()}/widgets/${props.widget.id}/${props.widget.entry}?${params}`;
});
const height = computed(() => props.monitor.state.widgetFrameHeights[key.value] ?? 0);

function onMessage(event: MessageEvent): void {
  if (event.data?.type === "lazyagent-widget-height" && event.data.widget === props.widget.id && event.data.slot === props.slotName) {
    props.monitor.setWidgetFrameHeight(key.value, Number(event.data.height) || 220);
  }
  if (event.data?.type === "lazyagent-widget-refresh") void props.monitor.loadWidgetStatuses();
}

onMounted(() => window.addEventListener("message", onMessage));
onUnmounted(() => window.removeEventListener("message", onMessage));
</script>

<template>
  <iframe class="widget-frame" :src="src" :title="widget.name" :style="{ height: `${height}px` }"></iframe>
</template>
