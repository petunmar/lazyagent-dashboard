<script setup lang="ts">
import type { PendingAttachment } from "../types";

const props = withDefaults(defineProps<{
  modelValue: string;
  attachments: PendingAttachment[];
  id?: string;
  rows?: number;
  placeholder?: string;
}>(), { rows: 3, placeholder: "" });

const emit = defineEmits<{
  "update:modelValue": [value: string];
  "update:attachments": [value: PendingAttachment[]];
  keydown: [event: KeyboardEvent];
}>();

function updateText(event: Event): void {
  emit("update:modelValue", (event.target as HTMLTextAreaElement).value);
}

async function addFiles(files: FileList | File[]): Promise<void> {
  const list = Array.from(files).filter(file => file.size > 0);
  if (!list.length) return;
  const next = [...props.attachments];
  for (const file of list) next.push(await toAttachment(file));
  emit("update:attachments", next);
}

function removeAttachment(id: string): void {
  emit("update:attachments", props.attachments.filter(item => item.id !== id));
}

async function onFileInput(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  if (input.files) await addFiles(input.files);
  input.value = "";
}

async function onPaste(event: ClipboardEvent): Promise<void> {
  const files = event.clipboardData?.files;
  if (!files?.length) return;
  event.preventDefault();
  await addFiles(files);
}

async function onDrop(event: DragEvent): Promise<void> {
  event.preventDefault();
  if (event.dataTransfer?.files?.length) await addFiles(event.dataTransfer.files);
}

function toAttachment(file: File): Promise<PendingAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("failed to read file"));
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve({
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name || "pasted-file",
        type: file.type || "application/octet-stream",
        size: file.size,
        dataBase64: result.includes(",") ? result.split(",").pop() || "" : result,
      });
    };
    reader.readAsDataURL(file);
  });
}

function sizeLabel(size: number): string {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}
</script>

<template>
  <div class="attachment-composer" @dragover.prevent @drop="onDrop">
    <textarea :id="id" :value="modelValue" :rows="rows" :placeholder="placeholder" @input="updateText" @paste="onPaste" @keydown="emit('keydown', $event)"></textarea>
    <div class="attachment-bar">
      <label class="attachment-button" title="Attach files">
        <input type="file" multiple @change="onFileInput" />
        📎 attach
      </label>
      <span>paste, drag here, or click the paperclip</span>
    </div>
    <div v-if="attachments.length" class="attachment-list" aria-label="Attached files">
      <article v-for="file in attachments" :key="file.id" class="attachment-chip">
        <div><strong>{{ file.name }}</strong><small>{{ file.type || 'file' }} · {{ sizeLabel(file.size) }}</small></div>
        <button class="ghost" type="button" @click="removeAttachment(file.id)">remove</button>
      </article>
    </div>
  </div>
</template>
