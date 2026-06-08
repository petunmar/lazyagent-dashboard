export type SessionFilter = "all" | "working" | "idle" | "errored";
export type ViewMode = "dashboard" | "detail" | "pi-resources" | "schedules";
export type ModalType = "launch" | "message" | "connect" | "rename";
export type TranscriptMode = "recent" | "full";
export type PiResourceKind = "all" | "skill" | "extension";
export type WidgetSlot = "dashboard:top" | "detail:top";

export type ToolSparkItem = { name: string; timestamp?: string; detail: string };
export type DirectoryEntry = { name: string; path: string };
export type DirectoryListing = { path: string; parent: string; home: string; entries: DirectoryEntry[] };
export type DirectoryPickerState = DirectoryListing & { open: boolean; loading: boolean; error: string };

export type PendingAttachment = {
  id: string;
  name: string;
  type: string;
  size: number;
  dataBase64: string;
};

export type SavedAttachment = {
  name: string;
  type: string;
  size: number;
  path: string;
};

export type SharedDocument = {
  name: string;
  url: string;
  size: number;
  modified_at: string;
  type: string;
};

export type PiResource = {
  key: string;
  kind: "skill" | "extension";
  scope: string;
  name: string;
  description: string;
  path: string;
  root: string;
  content: string;
};

export type PiResourcesPayload = {
  cwd: string;
  generated_at: string;
  settings: { path: string; content: string }[];
  packages: { name: string; root: string; missing?: boolean }[];
  resources: PiResource[];
};

export type GitShortstat = { files_changed: number; insertions: number; deletions: number };
export type GitInfo = {
  cwd: string;
  generated_at: string;
  is_git_repo: boolean;
  cached?: boolean;
  error?: string;
  root?: string;
  worktree?: string;
  main_worktree?: string;
  is_worktree?: boolean;
  branch?: string;
  upstream?: { ahead: number; behind: number; has_upstream: boolean };
  status?: { changed: number; staged: number; unstaged: number; untracked: number; added: number; modified: number; deleted: number; renamed: number; conflicted: number };
  diff?: { files_changed: number; insertions: number; deletions: number; unstaged: GitShortstat; staged: GitShortstat };
  worktrees?: number;
};

export type SystemPromptConfig = {
  prompt: string;
  path: string;
  env_prompt: string;
  widgets: { id: string; name: string; prompt: string }[];
};

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

export type ToolItem = { name: string; timestamp?: string };
export type ConversationItem = { role: string; text: string; timestamp?: string };

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

export type Stats = { total_sessions: number; active_sessions: number; window_minutes: number };
export type SpendDay = { date: string; cost_usd: number; tokens: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number };
export type SpendSummary = { generated_at: string; days: number; today: string; today_usd: number; today_tokens: number; daily: SpendDay[] };

export type SessionEventImage = {
  mimeType: string;
  data: string;
  path?: string;
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
  details?: unknown;
  images?: SessionEventImage[];
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

export type QueuedMessage = {
  id: string;
  session_id: string;
  cwd: string;
  prompt: string;
  created_at: string;
  status: "waiting" | "sending" | "sent" | "error";
  error?: string;
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

export type WidgetVisibilityRule = "always" | "has_pending" | "has_session_highlight";

export type WidgetManifest = {
  id: string;
  name: string;
  description: string;
  version: string;
  slots: WidgetSlot[];
  entry: string;
  status_visibility?: Partial<Record<WidgetSlot, WidgetVisibilityRule>>;
};

export type WidgetStatus = {
  id: string;
  pending?: number;
  session_highlights?: string[];
};

export type ScheduleRun = {
  id: string;
  status: "running" | "launched" | "failed" | "skipped";
  source: "scheduled" | "manual";
  scheduled_at: string;
  fired_at: string;
  finished_at?: string;
  run_id?: string;
  session_id?: string;
  error?: string;
};

export type Schedule = {
  id: string;
  name: string;
  enabled: boolean;
  cwd: string;
  prompt: string;
  kind: "one-off" | "recurring";
  cron: string;
  run_at: string;
  model: string;
  thinking: string;
  readonly: boolean;
  created_at: string;
  updated_at: string;
  next_fire_at: string;
  history: ScheduleRun[];
};

export type SchedulePayload = { schedules: Schedule[]; generated_at: string };

export type EventsUpdate = { sessions: SessionItem[]; stats: Stats };
