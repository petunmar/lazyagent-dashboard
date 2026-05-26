export type AuthInfo = {
  salt: string;
  iterations: number;
  key_length: number;
  hash: string;
  encoding: string;
};

export type SessionItem = {
  session_id: string;
  agent?: string;
  source?: string;
  cwd: string;
  short_name: string;
  custom_name?: string;
  activity: string;
  is_active: boolean;
  model?: string;
  git_branch?: string;
  cost_usd?: number;
  last_activity: string;
  total_messages: number;
};

export type ToolItem = {
  name: string;
  timestamp?: string;
};

export type ConversationItem = {
  role: string;
  text: string;
  timestamp?: string;
};

export type SessionDetail = SessionItem & {
  version: string;
  is_worktree: boolean;
  main_repo: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  user_messages: number;
  assistant_messages: number;
  current_tool: string;
  last_file_write: string;
  last_file_write_at: string;
  recent_tools: ToolItem[];
  recent_messages: ConversationItem[];
  resume_command?: string;
};

export type Stats = {
  total_sessions: number;
  active_sessions: number;
  window_minutes: number;
};

export type SessionEvent = {
  kind: string;
  line?: number;
  timestamp?: string;
  text?: string;
  truncated?: boolean;
  id?: string;
  name?: string;
  arguments?: unknown;
  tool_call_id?: string;
  tool_name?: string;
  cwd?: string;
  model?: string;
  provider?: string;
  level?: string;
};

export type RawSessionEvents = {
  session_id: string;
  file: string;
  event_count: number;
  events: SessionEvent[];
  truncated: boolean;
};

export type AgentRun = {
  run_id: string;
  kind: "start" | "message";
  status: string;
  cwd: string;
  session_dir: string;
  session_id: string;
  prompt_preview: string;
  started_at: string;
  finished_at: string;
  exit_code: number | null;
  stdout_tail: string;
  stderr_tail: string;
};

export type EventsUpdate = {
  sessions: SessionItem[];
  stats: Stats;
};

export class LazyagentBrowserClient {
  readonly baseUrl: string;
  private token = "";

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async authInfo(): Promise<AuthInfo> {
    const res = await fetch(`${this.baseUrl}/api/auth`);
    if (!res.ok) throw new Error(`GET /api/auth failed: ${res.status} ${res.statusText}`);
    return res.json();
  }

  async setPassphrase(passphrase: string): Promise<string> {
    const auth = await this.authInfo();
    this.token = await deriveToken(passphrase, auth);
    return this.token;
  }

  setBearerToken(token: string): void {
    this.token = token.trim();
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.token) throw new Error("Connect first");
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    if (!res.ok) throw new Error(`${init.method || "GET"} ${path} failed: ${res.status} ${res.statusText}`);
    return res.json();
  }

  sessions(): Promise<SessionItem[]> {
    return this.request<SessionItem[]>("/api/sessions");
  }

  session(id: string): Promise<SessionDetail> {
    return this.request<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`);
  }

  stats(): Promise<Stats> {
    return this.request<Stats>("/api/stats");
  }

  eventsUrl(): string {
    if (!this.token) throw new Error("Connect first");
    return `${this.baseUrl}/api/events?token=${encodeURIComponent(this.token)}`;
  }
}

async function deriveToken(passphrase: string, auth: AuthInfo): Promise<string> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase.trim()),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: enc.encode(auth.salt),
      iterations: auth.iterations,
    },
    baseKey,
    auth.key_length * 8,
  );
  const bytes = new Uint8Array(bits);
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
