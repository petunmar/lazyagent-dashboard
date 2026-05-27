<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import type { useAgentMonitor } from "../composables/useAgentMonitor";
import type { WidgetManifest, WidgetSlot } from "../types";
import { extensionApiBase } from "../utils";

const props = defineProps<{ widget: WidgetManifest; slotName: WidgetSlot; sessionId?: string; monitor: ReturnType<typeof useAgentMonitor> }>();
const frame = ref<HTMLIFrameElement | null>(null);
const key = computed(() => `${props.widget.id}:${props.slotName}:${props.sessionId || "all"}`);
const src = computed(() => {
  const params = new URLSearchParams({ slot: props.slotName });
  if (props.sessionId) params.set("session_id", props.sessionId);
  return `${extensionApiBase()}/widgets/${props.widget.id}/${props.widget.entry}?${params}`;
});
const height = computed(() => props.monitor.state.widgetFrameHeights[key.value] ?? 260);
const sessionState = computed(() => props.sessionId ? props.monitor.state.sessions.find(session => session.session_id === props.sessionId) : null);

function postSessionState(): void {
  const session = sessionState.value;
  if (!frame.value?.contentWindow || !props.sessionId) return;
  frame.value.contentWindow.postMessage({
    type: "lazyagent-widget-session-state",
    widget: props.widget.id,
    slot: props.slotName,
    session_id: props.sessionId,
    is_active: Boolean(session?.is_active),
    activity: session?.activity || "",
    last_activity: session?.last_activity || "",
  }, "*");
}

function onMessage(event: MessageEvent): void {
  if (event.data?.type === "lazyagent-widget-height" && event.data.widget === props.widget.id && event.data.slot === props.slotName) {
    props.monitor.setWidgetFrameHeight(key.value, Number(event.data.height) || 220);
  }
  if (event.data?.type === "lazyagent-widget-refresh") void props.monitor.loadWidgetStatuses();
}

onMounted(() => {
  window.addEventListener("message", onMessage);
  void nextTick(postSessionState);
});
onUnmounted(() => window.removeEventListener("message", onMessage));
watch(sessionState, () => postSessionState(), { deep: true });
</script>

<template>
  <iframe ref="frame" class="widget-frame" :src="src" :title="widget.name" :style="{ height: `${height}px` }" allow="microphone; autoplay" @load="postSessionState"></iframe>
</template>
