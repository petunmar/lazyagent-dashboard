<script setup lang="ts">
import { computed } from "vue";
import { sharedDocumentUrl } from "../api";
import type { useAgentMonitor } from "../composables/useAgentMonitor";

const props = defineProps<{ monitor: ReturnType<typeof useAgentMonitor> }>();
const documents = computed(() => props.monitor.state.sharedDocuments);

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
</script>

<template>
  <section v-if="documents.length" class="shared-documents console-card" aria-label="Shared documents">
    <div class="console-head">
      <span>shared documents</span>
      <h2>Files ready to read or print</h2>
      <button class="doc-button secondary" type="button" @click="monitor.cleanDocuments()">Clean</button>
    </div>
    <div class="shared-document-list">
      <article v-for="document in documents" :key="document.name" class="shared-document-row">
        <div>
          <strong>{{ document.name }}</strong>
          <span>{{ formatBytes(document.size) }} · {{ formatDate(document.modified_at) }}</span>
        </div>
        <div class="shared-document-actions">
          <a class="doc-button secondary" :href="sharedDocumentUrl(document)" target="_blank" rel="noopener">open</a>
          <a class="doc-button" :href="sharedDocumentUrl(document)" :download="document.name">download</a>
        </div>
      </article>
    </div>
  </section>
</template>
