<script setup lang="ts">
import { computed } from "vue";
import type { useAgentMonitor } from "../composables/useAgentMonitor";
import type { PiResourceKind } from "../types";

const props = defineProps<{ monitor: ReturnType<typeof useAgentMonitor> }>();
const state = props.monitor.state;
const filters: PiResourceKind[] = ["all", "skill", "extension"];
const resources = computed(() => (state.piResources?.resources || []).filter(r => state.piResourceFilter === "all" || r.kind === state.piResourceFilter));
const selected = computed(() => resources.value.find(r => r.key === state.selectedResourceKey) || resources.value[0]);
const skills = computed(() => state.piResources?.resources.filter(r => r.kind === "skill").length || 0);
const extensions = computed(() => state.piResources?.resources.filter(r => r.kind === "extension").length || 0);
</script>

<template>
  <section class="detail-actions"><button class="pill" type="button" @click="monitor.navigateTo('dashboard')">← dashboard</button><button class="pill" type="button" @click="monitor.loadPiResources(true)">{{ state.piResourcesLoading ? 'refreshing…' : 'refresh' }}</button></section>
  <section class="resources-hero console-card">
    <div><div class="console-head"><span>pi setup</span><h2>Skills + extensions</h2></div><p>Browse the Pi resources installed on this VM, including global skills, extension modules, and package-provided resources that the dashboard can find.</p><code v-if="state.piResources">{{ state.piResources.cwd }}</code></div>
    <dl class="resource-counts"><div><dt>{{ skills }}</dt><dd>skills</dd></div><div><dt>{{ extensions }}</dt><dd>extensions</dd></div><div><dt>{{ state.piResources?.packages.length || 0 }}</dt><dd>packages</dd></div></dl>
  </section>
  <p v-if="state.piResourcesError" class="error-banner">{{ state.piResourcesError }}</p>
  <section v-if="state.piResourcesLoading && !state.piResources" class="console-card"><p class="empty loading">Loading Pi resources…</p></section>
  <section v-else-if="state.piResources" class="resources-layout">
    <aside class="console-card resources-list-card">
      <div class="console-head"><span>inventory</span><h2>{{ resources.length }} visible</h2></div>
      <div class="filter-pills resource-filters"><button v-for="filter in filters" :key="filter" class="pill" :class="{ active: state.piResourceFilter === filter }" type="button" @click="monitor.setResourceFilter(filter)">{{ filter }}</button></div>
      <div class="resource-list"><button v-for="resource in resources" :key="resource.key" class="resource-row" :class="{ active: selected?.key === resource.key }" type="button" @click="state.selectedResourceKey = resource.key"><span class="resource-kind" :class="resource.kind">{{ resource.kind }}</span><strong>{{ resource.name }}</strong><small>{{ resource.scope }}</small></button><p v-if="!resources.length" class="empty">No resources in this filter.</p></div>
      <div class="settings-summary"><h3>settings</h3><code v-for="setting in state.piResources.settings" :key="setting.path">{{ setting.path }}</code><p v-if="!state.piResources.settings.length" class="empty">No settings files found.</p><h3>packages</h3><p v-for="pkg in state.piResources.packages" :key="pkg.name"><code>{{ pkg.name }}</code> <span v-if="pkg.missing">missing</span><small v-else>{{ pkg.root }}</small></p><p v-if="!state.piResources.packages.length" class="empty">No package resources configured.</p></div>
    </aside>
    <section class="console-card resource-detail-card"><template v-if="selected"><div class="resource-detail-head"><div><span class="resource-kind" :class="selected.kind">{{ selected.kind }}</span><h2>{{ selected.name }}</h2><p>{{ selected.description || 'No description found.' }}</p></div><code>{{ selected.scope }}</code></div><dl class="resource-meta"><div><dt>path</dt><dd><code>{{ selected.path }}</code></dd></div><div><dt>root</dt><dd><code>{{ selected.root }}</code></dd></div></dl><pre class="resource-source"><code>{{ selected.content }}</code></pre></template><p v-else class="empty">Choose a skill or extension.</p></section>
  </section>
  <section v-else class="console-card"><p class="empty">No Pi resources loaded yet.</p></section>
</template>
