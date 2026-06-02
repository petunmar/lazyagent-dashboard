import type { AgentRun, AuthInfo, DirectoryListing, GitInfo, PendingAttachment, PiResourcesPayload, RawSessionEvents, SavedAttachment, SessionDetail, SessionItem, SharedDocument, SpendSummary, Stats, SystemPromptConfig, WidgetManifest, WidgetStatus } from "./types";
import { extensionApiBase } from "./utils";

export class LazyagentBrowserClient {
  readonly baseUrl: string;
  private token = "";
  private readonly managedProxy: boolean;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.managedProxy = this.baseUrl.startsWith("/");
  }

  async authInfo(): Promise<AuthInfo> {
    const res = await fetch(`${this.baseUrl}/api/auth`);
    if (!res.ok) throw new Error(`GET /api/auth failed: ${res.status} ${res.statusText}`);
    return res.json();
  }

  async setPassphrase(passphrase: string): Promise<string> {
    if (this.managedProxy && !passphrase.trim()) return "managed-proxy";
    const auth = await this.authInfo();
    this.token = await deriveToken(passphrase, auth);
    return this.token;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.token && !this.managedProxy) throw new Error("Connect first");
    const headers = new Headers(init.headers);
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
    const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    if (!res.ok) throw new Error(`${init.method || "GET"} ${path} failed: ${res.status} ${res.statusText}`);
    return res.json();
  }

  sessions(): Promise<SessionItem[]> { return this.request<SessionItem[]>("/api/sessions"); }
  session(id: string): Promise<SessionDetail> { return this.request<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`); }
  stats(): Promise<Stats> { return this.request<Stats>("/api/stats"); }

  eventsUrl(): string {
    if (this.managedProxy && !this.token) return `${this.baseUrl}/api/events`;
    if (!this.token) throw new Error("Connect first");
    return `${this.baseUrl}/api/events?token=${encodeURIComponent(this.token)}`;
  }
}

export async function fetchSessionEvents(id: string, limit: number): Promise<RawSessionEvents> {
  const res = await fetch(`${extensionApiBase()}/api/session-events/${encodeURIComponent(id)}?limit=${limit}`);
  if (!res.ok) throw new Error(`raw transcript failed: ${res.status} ${res.statusText}`);
  return res.json();
}

export async function fetchRecentSessions(hours = 24): Promise<SessionItem[]> {
  const res = await fetch(`${extensionApiBase()}/api/recent-sessions?hours=${hours}`);
  if (!res.ok) return [];
  return ((await res.json()) as { sessions: SessionItem[] }).sessions || [];
}

export async function fetchSessionSummary(id: string): Promise<SessionDetail> {
  const res = await fetch(`${extensionApiBase()}/api/session-summary/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`session summary failed: ${res.status} ${res.statusText}`);
  return res.json();
}

export async function fetchDirectory(path: string): Promise<DirectoryListing> {
  const res = await fetch(`${extensionApiBase()}/api/directories?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchSharedDocuments(): Promise<SharedDocument[]> {
  const res = await fetch(`${extensionApiBase()}/api/shared-documents`);
  if (!res.ok) throw new Error(await res.text());
  return ((await res.json()) as { documents: SharedDocument[] }).documents || [];
}

export async function cleanSharedDocuments(): Promise<SharedDocument[]> {
  const res = await fetch(`${extensionApiBase()}/api/shared-documents`, { method: "DELETE" });
  if (!res.ok) throw new Error(await res.text());
  return ((await res.json()) as { documents: SharedDocument[] }).documents || [];
}

export function sharedDocumentUrl(document: SharedDocument): string {
  return `${extensionApiBase()}${document.url}`;
}

export async function fetchSessionNames(): Promise<Record<string, string>> {
  const res = await fetch(`${extensionApiBase()}/api/session-names`);
  const contentType = res.headers.get("content-type") || "";
  if (!res.ok || !contentType.includes("application/json")) return {};
  return ((await res.json()) as { names: Record<string, string> }).names || {};
}

export async function renameSession(sessionId: string, body: { name?: string; auto?: boolean }): Promise<{ name: string; names: Record<string, string> }> {
  const res = await fetch(`${extensionApiBase()}/api/session-names/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function uploadAttachments(cwd: string, attachments: PendingAttachment[]): Promise<SavedAttachment[]> {
  if (!attachments.length) return [];
  const res = await fetch(`${extensionApiBase()}/api/attachments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, attachments }),
  });
  if (!res.ok) throw new Error(await res.text());
  return ((await res.json()) as { attachments: SavedAttachment[] }).attachments || [];
}

export async function submitAgent(mode: "start" | "message", body: Record<string, unknown>): Promise<AgentRun> {
  const endpoint = mode === "message" ? "/api/agents/message" : "/api/agents/start";
  const res = await fetch(`${extensionApiBase()}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchAgentRuns(): Promise<AgentRun[]> {
  const res = await fetch(`${extensionApiBase()}/api/agent-runs`);
  if (!res.ok) throw new Error(`runs failed: ${res.status}`);
  return ((await res.json()) as { runs: AgentRun[] }).runs;
}

export async function fetchPiResources(cwd: string): Promise<PiResourcesPayload> {
  const res = await fetch(`${extensionApiBase()}/api/pi-resources?cwd=${encodeURIComponent(cwd)}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchGitInfo(cwd: string): Promise<GitInfo> {
  const res = await fetch(`${extensionApiBase()}/api/git-info?cwd=${encodeURIComponent(cwd)}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchSystemPrompt(): Promise<SystemPromptConfig> {
  const res = await fetch(`${extensionApiBase()}/api/system-prompt`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function saveSystemPrompt(prompt: string): Promise<SystemPromptConfig> {
  const res = await fetch(`${extensionApiBase()}/api/system-prompt`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchSpend(): Promise<SpendSummary> {
  const res = await fetch(`${extensionApiBase()}/api/spend`);
  if (!res.ok) throw new Error(`spend failed: ${res.status}`);
  return res.json();
}

export async function fetchWidgets(): Promise<WidgetManifest[]> {
  const res = await fetch(`${extensionApiBase()}/api/widgets`);
  if (!res.ok) throw new Error(`widgets failed: ${res.status}`);
  return ((await res.json()) as { widgets: WidgetManifest[] }).widgets;
}

export async function fetchWidgetStatuses(): Promise<WidgetStatus[]> {
  const res = await fetch(`${extensionApiBase()}/api/widgets/status`);
  if (!res.ok) throw new Error(`widget status failed: ${res.status}`);
  return ((await res.json()) as { widgets: WidgetStatus[] }).widgets;
}

async function deriveToken(passphrase: string, auth: AuthInfo): Promise<string> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey("raw", enc.encode(passphrase.trim()), { name: "PBKDF2" }, false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(auth.salt), iterations: auth.iterations }, baseKey, auth.key_length * 8);
  const bytes = new Uint8Array(bits);
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
