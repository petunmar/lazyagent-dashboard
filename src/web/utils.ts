import type { SessionDetail, SessionFilter, SessionItem, SessionEvent, ToolSparkItem } from "./types";

export const lowFocusAfterMinutes = 10;

export function extensionApiBase(): string {
  const local = location.hostname === "127.0.0.1" || location.hostname === "localhost";
  if (!local || location.port === "5174") return location.origin;
  return `${location.protocol}//${location.hostname}:5174`;
}

export function sortSessions(sessions: SessionItem[]): SessionItem[] {
  return [...sessions].sort((a, b) => Date.parse(b.last_activity) - Date.parse(a.last_activity));
}

export function sessionTone(s: SessionItem): Exclude<SessionFilter, "all"> {
  const activity = s.activity.toLowerCase();
  if (activity.includes("error") || activity.includes("failed")) return "errored";
  if (activity.includes("idle") || activity.includes("waiting") || !s.is_active) return "idle";
  return "working";
}

export function matchesFilter(filter: SessionFilter, s: SessionItem): boolean {
  return filter === "all" || sessionTone(s) === filter;
}

export function summarizeSessions(sessions: SessionItem[]): Record<SessionFilter, number> {
  const summary: Record<SessionFilter, number> = { all: sessions.length, working: 0, idle: 0, errored: 0 };
  for (const session of sessions) summary[sessionTone(session)] += 1;
  return summary;
}

export function isLowFocusSession(s: SessionItem): boolean {
  return !s.is_active && minutesSince(s.last_activity) >= lowFocusAfterMinutes;
}

export function minutesSince(value: string): number {
  const diff = Date.now() - Date.parse(value);
  if (!Number.isFinite(diff)) return 0;
  return diff / 60_000;
}

export function statusLabel(s: SessionItem): string {
  const tone = sessionTone(s);
  if (tone === "errored") return "errored";
  if (tone === "idle") return s.is_active ? "waiting" : "idle";
  return "working";
}

export function displaySessionName(s: SessionItem, names: Record<string, string>): string {
  return names[s.session_id] || s.custom_name || s.short_name || basename(s.cwd) || shortId(s.session_id);
}

export function currentWork(s: SessionItem, detail: SessionDetail | null): { label: string; text: string } {
  if (sessionTone(s) === "errored") return { label: "last · failed", text: detail?.current_tool || s.activity || "error" };
  if (detail?.current_tool) return { label: "current", text: detail.current_tool };
  if (detail?.last_file_write) return { label: "last write", text: detail.last_file_write };
  return { label: s.is_active ? "current" : "last", text: s.activity || "waiting" };
}

export function extractToolNames(events: SessionEvent[]): ToolSparkItem[] {
  return events
    .filter(event => event.kind === "tool_call" && event.name)
    .map(event => ({ name: event.name || "tool", timestamp: event.timestamp, detail: toolTooltip(event) }))
    .slice(-16);
}

export function toolTooltip(event: SessionEvent): string {
  const parts = [event.name || "tool"];
  if (event.timestamp) parts.push(relativeTime(event.timestamp));
  const summary = summarizeToolArguments(event.arguments);
  if (summary) parts.push(summary);
  return parts.join(" · ");
}

export function summarizeToolArguments(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  const preferred = ["path", "file", "command", "pattern", "query", "url", "cwd"];
  for (const key of preferred) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return `${key}: ${truncate(value.trim(), 90)}`;
  }
  const first = Object.entries(record).find(([, value]) => typeof value === "string" && value.trim());
  if (first) return `${first[0]}: ${truncate(String(first[1]).trim(), 90)}`;
  const keys = Object.keys(record).slice(0, 4);
  return keys.length ? `args: ${keys.join(", ")}` : "";
}

export function toolClass(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("write") || lower.includes("edit")) return "write";
  if (lower.includes("read")) return "read";
  if (lower.includes("grep") || lower.includes("find")) return "grep";
  if (lower.includes("bash") || lower.includes("shell")) return "bash";
  return "msg";
}

export function eventTitle(event: SessionEvent): string {
  if (event.kind === "tool_call") return `tool call · ${event.name || "unknown"}`;
  if (event.kind === "tool_result") return `tool result · ${event.tool_name || "unknown"}`;
  if (event.kind === "assistant") return "assistant message";
  if (event.kind === "user") return "user message";
  if (event.kind === "thinking") return "thinking block";
  if (event.kind === "model") return `model · ${event.model || "unknown"}`;
  if (event.kind === "session") return "session started";
  return event.kind.replaceAll("_", " ");
}

export function eventBody(event: SessionEvent): string {
  if (event.kind === "tool_call") return JSON.stringify(event.arguments ?? {}, null, 2);
  if (event.kind === "tool_result") return event.text || "";
  if (event.text) return event.truncated ? `${event.text}\n[truncated]` : event.text;
  if (event.kind === "session") return event.cwd || "";
  if (event.kind === "model") return [event.provider, event.model].filter(Boolean).join(" / ");
  if (event.kind === "thinking_level") return event.level || "";
  return "";
}

export function eventImageSrc(image: { mimeType: string; data: string }): string {
  return `data:${image.mimeType || "image/png"};base64,${image.data}`;
}

export function formatCompact(value: number): string {
  if (!value) return "0";
  if (value >= 1_000_000) return `${trimNumber(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trimNumber(value / 1_000)}K`;
  return String(value);
}

export function trimNumber(value: number): string {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
}

export function formatMoney(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function relativeTime(value: string): string {
  const diff = Date.now() - Date.parse(value);
  if (!Number.isFinite(diff)) return "unknown";
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function compactPath(path: string): string {
  return path.replace(/^\/home\/[^/]+/, "~");
}

export function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() || path;
}

export function shortId(id: string): string {
  return id.replaceAll("-", "").slice(0, 8);
}

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
