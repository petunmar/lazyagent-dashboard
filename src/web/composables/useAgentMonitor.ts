import { computed, nextTick, reactive } from "vue";
import { fetchAgentRuns, fetchDirectory, fetchGitInfo, fetchPiResources, fetchRecentSessions, fetchSessionEvents, fetchSessionNames, fetchSessionSummary, fetchSpend, fetchSystemPrompt, fetchWidgets, fetchWidgetStatuses, LazyagentBrowserClient, renameSession, saveSystemPrompt, submitAgent } from "../api";
import type { AgentRun, DirectoryPickerState, EventsUpdate, GitInfo, ModalType, PiResourceKind, PiResourcesPayload, QueuedMessage, RawSessionEvents, SessionDetail, SessionFilter, SessionItem, SpendSummary, Stats, SystemPromptConfig, ToolSparkItem, TranscriptMode, ViewMode, WidgetManifest, WidgetStatus } from "../types";
import { extractToolNames, matchesFilter, sortSessions } from "../utils";

type State = {
  baseUrl: string;
  passphrase: string;
  connected: boolean;
  status: string;
  error: string;
  sessions: SessionItem[];
  stats: Stats | null;
  spend: SpendSummary | null;
  selectedId: string;
  selectedDetail: SessionDetail | null;
  rawEvents: RawSessionEvents | null;
  runs: AgentRun[];
  filter: SessionFilter;
  view: ViewMode;
  modal: ModalType | null;
  sessionNames: Record<string, string>;
  cardTools: Record<string, ToolSparkItem[]>;
  loadingCardTools: Set<string>;
  chatDraft: string;
  cwdDraft: string;
  transcriptMode: TranscriptMode;
  directoryPicker: DirectoryPickerState;
  piResources: PiResourcesPayload | null;
  gitInfoByCwd: Record<string, GitInfo>;
  gitInfoLoading: Record<string, boolean>;
  piResourcesLoading: boolean;
  piResourcesError: string;
  piResourceFilter: PiResourceKind;
  selectedResourceKey: string;
  systemPrompt: SystemPromptConfig | null;
  systemPromptDraft: string;
  systemPromptSaving: boolean;
  systemPromptStatus: string;
  widgets: WidgetManifest[];
  widgetStatuses: WidgetStatus[];
  widgetFrameHeights: Record<string, number>;
  messageQueue: QueuedMessage[];
};

function initialView(): ViewMode {
  return location.pathname.startsWith("/pi-resources") ? "pi-resources" : "dashboard";
}

function isLocalHost(): boolean {
  return location.hostname === "127.0.0.1" || location.hostname === "localhost";
}

function defaultLazyagentBaseUrl(): string {
  if (!isLocalHost()) return "/lazyagent";
  return localStorage.getItem("lazyagent.baseUrl") || "http://127.0.0.1:7421";
}

const state = reactive<State>({
  baseUrl: defaultLazyagentBaseUrl(),
  passphrase: localStorage.getItem("lazyagent.passphrase") || "",
  connected: false,
  status: "offline",
  error: "",
  sessions: [],
  stats: null,
  spend: null,
  selectedId: "",
  selectedDetail: null,
  rawEvents: null,
  runs: [],
  filter: "all",
  view: initialView(),
  modal: null,
  sessionNames: {},
  cardTools: {},
  loadingCardTools: new Set(),
  chatDraft: "",
  cwdDraft: "",
  transcriptMode: "recent",
  directoryPicker: { open: false, path: "", parent: "", home: "", entries: [], loading: false, error: "" },
  piResources: null,
  gitInfoByCwd: {},
  gitInfoLoading: {},
  piResourcesLoading: false,
  piResourcesError: "",
  piResourceFilter: "all",
  selectedResourceKey: "",
  systemPrompt: null,
  systemPromptDraft: "",
  systemPromptSaving: false,
  systemPromptStatus: "",
  widgets: [],
  widgetStatuses: [],
  widgetFrameHeights: {},
  messageQueue: loadMessageQueue(),
});

let client: LazyagentBrowserClient | null = null;
let events: EventSource | null = null;
let queueTimer: number | null = null;
const queuedSessionReadiness = new Map<string, { key: string; since: number }>();
const queueIdleMs = 10_000;

function loadMessageQueue(): QueuedMessage[] {
  try {
    const parsed = JSON.parse(localStorage.getItem("agentMonitor.messageQueue") || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(item => item && typeof item.session_id === "string" && typeof item.cwd === "string" && typeof item.prompt === "string")
      .map(item => ({ ...item, status: item.status === "error" ? "error" : "waiting" }));
  } catch { return []; }
}

function saveMessageQueue(): void {
  localStorage.setItem("agentMonitor.messageQueue", JSON.stringify(state.messageQueue));
}

export function useAgentMonitor() {
  const selectedSession = computed(() => state.sessions.find(session => session.session_id === state.selectedId));
  const visibleSessions = computed(() => state.sessions.filter(session => matchesFilter(state.filter, session)));

  async function connect(baseUrl = state.baseUrl, passphrase = state.passphrase): Promise<void> {
    const managedProxy = baseUrl.trim().startsWith("/");
    if (!baseUrl || (!managedProxy && !passphrase)) {
      state.error = "Enter the lazyagent API URL and passphrase.";
      return;
    }
    disconnectEvents();
    state.baseUrl = baseUrl;
    state.passphrase = passphrase;
    localStorage.setItem("lazyagent.baseUrl", baseUrl);
    if (passphrase) localStorage.setItem("lazyagent.passphrase", passphrase);
    else localStorage.removeItem("lazyagent.passphrase");
    client = new LazyagentBrowserClient(baseUrl);
    state.status = "connecting";
    state.error = "";
    try {
      await client.setPassphrase(passphrase);
      state.connected = true;
      state.status = "connected";
      state.modal = null;
      await loadWidgets();
      await refresh();
      connectEvents();
    } catch (error) {
      state.connected = false;
      state.status = "offline";
      state.error = error instanceof Error ? error.message : String(error);
    }
  }

  async function refresh(): Promise<void> {
    if (!client) return;
    try {
      const [stats, sessions] = await Promise.all([client.stats(), loadSessions(), loadSessionNames()]);
      state.stats = { ...stats, total_sessions: Math.max(stats.total_sessions, sessions.length) };
      state.sessions = sortSessions(sessions);
      const previous = state.selectedId;
      state.selectedId ||= state.sessions[0]?.session_id || "";
      if (state.selectedId !== previous) clearSelectedPayload();
      state.error = "";
      void loadSelectedDetail();
      void loadSelectedGitInfo();
      void loadRawEvents();
      void loadVisibleCardTools();
      void loadWidgetStatuses();
      void loadSpend();
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    }
  }

  function navigateTo(view: ViewMode): void {
    state.view = view;
    const target = view === "pi-resources" ? "/pi-resources" : "/";
    if (location.pathname !== target) history.pushState({ view }, "", target);
    if (view === "pi-resources") void loadPiResources();
  }

  function selectSession(id: string): void {
    state.selectedId = id;
    clearSelectedPayload();
    state.chatDraft = "";
    state.transcriptMode = "recent";
    state.view = "detail";
    if (location.pathname !== "/") history.pushState({ view: "detail" }, "", "/");
    state.modal = null;
    void loadSelectedDetail();
    void loadSelectedGitInfo();
    void loadRawEvents();
  }

  function openModal(modal: ModalType, sessionId = ""): void {
    if (sessionId && sessionId !== state.selectedId) {
      state.selectedId = sessionId;
      clearSelectedPayload();
      state.chatDraft = "";
      state.transcriptMode = "recent";
      void loadSelectedDetail();
      void loadSelectedGitInfo();
      void loadRawEvents();
    }
    state.modal = modal;
    state.directoryPicker.open = false;
    state.cwdDraft = modal === "connect" ? "" : (selectedSession.value?.cwd || "~/coding");
  }

  function closeModal(): void {
    state.modal = null;
  }

  async function loadSelectedDetail(): Promise<void> {
    if (!client || !state.selectedId) return;
    const id = state.selectedId;
    try {
      const detail = await client.session(id);
      if (state.selectedId === id) {
        state.selectedDetail = detail;
        void loadSelectedGitInfo();
      }
    } catch (error) {
      try {
        const detail = await fetchSessionSummary(id);
        if (state.selectedId === id) {
          state.selectedDetail = detail;
          state.error = "";
          void loadSelectedGitInfo();
        }
      } catch {
        if (state.selectedId === id) state.error = error instanceof Error ? error.message : String(error);
      }
    }
  }

  async function loadSelectedGitInfo(force = false): Promise<void> {
    const cwd = gitTargetCwd(selectedSession.value, state.selectedDetail);
    if (!cwd || state.gitInfoLoading[cwd]) return;
    if (!force && state.gitInfoByCwd[cwd]) return;
    state.gitInfoLoading[cwd] = true;
    try {
      state.gitInfoByCwd[cwd] = await fetchGitInfo(cwd);
    } catch (error) {
      state.gitInfoByCwd[cwd] = { cwd, generated_at: new Date().toISOString(), is_git_repo: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      state.gitInfoLoading[cwd] = false;
    }
  }

  async function loadRawEvents(): Promise<void> {
    if (!state.selectedId) return;
    const id = state.selectedId;
    try {
      const raw = await fetchSessionEvents(id, state.transcriptMode === "full" ? 1000 : 40);
      if (state.selectedId === id) {
        state.rawEvents = raw;
        state.cardTools[id] = extractToolNames(raw.events);
        state.error = "";
        await nextTick();
        pinTranscriptIfRecent();
        scheduleQueueCheck();
      }
    } catch (error) {
      if (state.selectedId === id) {
        state.rawEvents = null;
        state.error = error instanceof Error ? error.message : String(error);
      }
    }
  }

  async function setTranscriptMode(mode: TranscriptMode): Promise<void> {
    state.transcriptMode = mode;
    state.rawEvents = null;
    await loadRawEvents();
  }

  async function loadVisibleCardTools(): Promise<void> {
    const visible = state.sessions.filter(session => matchesFilter(state.filter, session)).slice(0, 24);
    await Promise.all(visible.map(async session => {
      const id = session.session_id;
      if (state.cardTools[id] || state.loadingCardTools.has(id)) return;
      state.loadingCardTools.add(id);
      try {
        const raw = await fetchSessionEvents(id, 40);
        state.cardTools[id] = extractToolNames(raw.events);
        if (state.selectedId === id && state.transcriptMode === "recent") state.rawEvents = raw;
      } catch {
        state.cardTools[id] = [];
      } finally {
        state.loadingCardTools.delete(id);
      }
    }));
  }

  async function loadSessionNames(): Promise<void> {
    try { state.sessionNames = await fetchSessionNames(); } catch { /* optional sugar */ }
  }

  async function loadSessions(): Promise<SessionItem[]> {
    if (!client) return [];
    const [active, recent] = await Promise.all([client.sessions(), fetchRecentSessions(12)]);
    return mergeSessions(active, recent);
  }

  function mergeSessions(active: SessionItem[], recent: SessionItem[]): SessionItem[] {
    const byId = new Map<string, SessionItem>();
    for (const session of recent) byId.set(session.session_id, session);
    for (const session of active) byId.set(session.session_id, session);
    return [...byId.values()];
  }

  async function loadSpend(): Promise<void> {
    try { state.spend = await fetchSpend(); } catch { /* optional dashboard sugar */ }
  }

  async function renameSelected(mode: "save" | "auto" | "clear", name = ""): Promise<void> {
    const sessionId = state.selectedId;
    if (!sessionId) return;
    const body = mode === "auto" ? { auto: true } : { name: mode === "clear" ? "" : name.trim() };
    try {
      const payload = await renameSession(sessionId, body);
      state.sessionNames = payload.names;
      state.modal = null;
      state.error = "";
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    }
  }

  async function sendAgent(form: { mode: "start" | "message"; cwd: string; prompt: string; sessionId?: string; model?: string; thinking?: string; readonly?: boolean }): Promise<void> {
    const cwd = form.cwd.trim();
    const prompt = form.prompt.trim();
    const sessionId = (form.sessionId || "").trim();
    if (!cwd || !prompt) {
      state.error = "Working directory and message are required.";
      return;
    }
    if (form.mode === "message" && !sessionId) {
      state.error = "Choose or enter a session ID to send a message.";
      return;
    }
    try {
      const run = await submitAgent(form.mode, { cwd, prompt, session_id: sessionId, model: form.model || "", thinking: form.thinking || "", readonly: !!form.readonly });
      state.runs = [run, ...state.runs.filter(r => r.run_id !== run.run_id)];
      state.error = "";
      state.modal = null;
      state.chatDraft = "";
      window.setTimeout(() => void refreshRuns(), 1000);
      scheduleQueueCheck();
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    }
  }

  function queueAgentMessage(form: { cwd: string; prompt: string; sessionId?: string }): boolean {
    const cwd = form.cwd.trim();
    const prompt = form.prompt.trim();
    const sessionId = (form.sessionId || "").trim();
    if (!cwd || !prompt) {
      state.error = "Working directory and message are required.";
      return false;
    }
    if (!sessionId) {
      state.error = "Choose or enter a session ID to queue a message.";
      return false;
    }
    state.messageQueue.push({ id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, session_id: sessionId, cwd, prompt, created_at: new Date().toISOString(), status: "waiting" });
    saveMessageQueue();
    state.error = "";
    state.chatDraft = "";
    scheduleQueueCheck();
    return true;
  }

  async function sendQueuedNow(id: string): Promise<void> {
    const item = state.messageQueue.find(message => message.id === id);
    if (!item) return;
    await dispatchQueuedMessage(item);
  }

  function removeQueuedMessage(id: string): void {
    const index = state.messageQueue.findIndex(message => message.id === id);
    if (index >= 0) {
      state.messageQueue.splice(index, 1);
      saveMessageQueue();
    }
  }

  async function dispatchQueuedMessage(item: QueuedMessage): Promise<void> {
    if (item.status === "sending") return;
    item.status = "sending";
    item.error = "";
    saveMessageQueue();
    try {
      const run = await submitAgent("message", { cwd: item.cwd, prompt: item.prompt, session_id: item.session_id });
      state.runs = [run, ...state.runs.filter(r => r.run_id !== run.run_id)];
      queuedSessionReadiness.delete(item.session_id);
      removeQueuedMessage(item.id);
      state.error = "";
      window.setTimeout(() => void refreshRuns(), 1000);
    } catch (error) {
      item.status = "error";
      item.error = error instanceof Error ? error.message : String(error);
      saveMessageQueue();
    }
  }

  function scheduleQueueCheck(delay = 1000): void {
    if (queueTimer !== null) window.clearTimeout(queueTimer);
    if (!state.messageQueue.some(message => message.status === "waiting" || message.status === "error")) return;
    queueTimer = window.setTimeout(() => void processMessageQueue(), delay);
  }

  async function processMessageQueue(): Promise<void> {
    queueTimer = null;
    const waiting = state.messageQueue.filter(message => message.status === "waiting" || message.status === "error");
    const checkedSessions = new Set<string>();
    for (const item of waiting) {
      if (checkedSessions.has(item.session_id)) continue;
      checkedSessions.add(item.session_id);
      const ready = await queuedSessionIsReady(item.session_id).catch(() => false);
      if (ready) await dispatchQueuedMessage(item);
    }
    if (state.messageQueue.some(message => message.status === "waiting" || message.status === "error")) scheduleQueueCheck(2000);
  }

  async function queuedSessionIsReady(sessionId: string): Promise<boolean> {
    const raw = state.selectedId === sessionId && state.rawEvents ? state.rawEvents : await fetchSessionEvents(sessionId, 20);
    const last = raw.events.at(-1);
    if (!last || last.kind !== "assistant") {
      queuedSessionReadiness.delete(sessionId);
      return false;
    }
    const key = `${last.line ?? ""}:${last.timestamp ?? ""}:${(last.text || "").length}:${raw.event_count}`;
    const now = Date.now();
    const readiness = queuedSessionReadiness.get(sessionId);
    if (!readiness || readiness.key !== key) {
      queuedSessionReadiness.set(sessionId, { key, since: now });
      return false;
    }
    return now - readiness.since >= queueIdleMs;
  }

  async function loadWidgets(): Promise<void> {
    try {
      state.widgets = await fetchWidgets();
      await loadWidgetStatuses();
    } catch { /* widgets are optional */ }
  }

  async function loadWidgetStatuses(): Promise<void> {
    try { state.widgetStatuses = await fetchWidgetStatuses(); } catch { /* widgets are optional */ }
  }

  function sessionHasWidgetAlert(sessionId: string): boolean {
    return state.widgetStatuses.some(status => status.session_highlights?.includes(sessionId));
  }

  function setWidgetFrameHeight(key: string, height: number): void {
    state.widgetFrameHeights[key] = height <= 0 ? 0 : Math.max(120, Math.min(900, height));
  }

  async function refreshRuns(): Promise<void> {
    try {
      const next = await fetchAgentRuns();
      state.runs = next;
      if (next.some(run => run.status === "running")) window.setTimeout(() => void refreshRuns(), 2000);
    } catch { /* best effort */ }
  }

  async function openDirectoryPicker(path: string): Promise<void> {
    state.directoryPicker = { ...state.directoryPicker, open: true, path, loading: true, error: "" };
    try {
      const listing = await fetchDirectory(path);
      state.directoryPicker = { open: true, path: listing.path, parent: listing.parent, home: listing.home, entries: listing.entries, loading: false, error: "" };
    } catch (error) {
      state.directoryPicker = { ...state.directoryPicker, open: true, loading: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  function selectDirectory(path: string): void {
    state.cwdDraft = path;
    state.directoryPicker.open = false;
  }

  async function loadPiResources(force = false): Promise<void> {
    if (state.piResourcesLoading || (state.piResources && !force)) return;
    state.piResourcesLoading = true;
    state.piResourcesError = "";
    try {
      const [resources, prompt] = await Promise.all([fetchPiResources(selectedSession.value?.cwd || "/home/petur"), fetchSystemPrompt()]);
      state.piResources = resources;
      state.systemPrompt = prompt;
      state.systemPromptDraft = prompt.prompt;
      state.selectedResourceKey ||= state.piResources.resources[0]?.key || "";
    } catch (error) {
      state.piResourcesError = error instanceof Error ? error.message : String(error);
    } finally {
      state.piResourcesLoading = false;
    }
  }

  async function saveDashboardSystemPrompt(): Promise<void> {
    state.systemPromptSaving = true;
    state.systemPromptStatus = "";
    try {
      const prompt = await saveSystemPrompt(state.systemPromptDraft);
      state.systemPrompt = prompt;
      state.systemPromptDraft = prompt.prompt;
      state.systemPromptStatus = "saved";
    } catch (error) {
      state.systemPromptStatus = error instanceof Error ? error.message : String(error);
    } finally {
      state.systemPromptSaving = false;
    }
  }

  function setResourceFilter(filter: PiResourceKind): void {
    state.piResourceFilter = filter;
    state.selectedResourceKey = "";
  }

  function useManagedProxy(): void {
    if (isLocalHost()) return;
    state.baseUrl = "/lazyagent";
    state.passphrase = "";
    localStorage.setItem("lazyagent.baseUrl", "/lazyagent");
    localStorage.removeItem("lazyagent.passphrase");
  }

  function handlePopstate(): void {
    state.view = initialView();
    if (state.view === "pi-resources") void loadPiResources();
  }

  function clearSelectedPayload(): void {
    state.selectedDetail = null;
    state.rawEvents = null;
  }

  function gitTargetCwd(session: SessionItem | undefined, detail: SessionDetail | null): string {
    const lastWrite = detail?.last_file_write || "";
    if (lastWrite.startsWith("/")) return lastWrite.replace(/\/[^/]*$/, "") || lastWrite;
    return session?.cwd || detail?.cwd || "";
  }

  function connectEvents(): void {
    if (!client) return;
    events = new EventSource(client.eventsUrl());
    events.addEventListener("update", event => {
      const update = JSON.parse((event as MessageEvent).data) as EventsUpdate;
      state.stats = update.stats;
      state.sessions = sortSessions(mergeSessions(update.sessions, state.sessions));
      void loadSessions().then(sessions => {
        state.sessions = sortSessions(sessions);
        if (state.stats) state.stats = { ...state.stats, total_sessions: Math.max(state.stats.total_sessions, sessions.length) };
      }).catch(() => {});
      state.selectedId ||= state.sessions[0]?.session_id || "";
      state.status = `live · ${new Date().toLocaleTimeString()}`;
      void loadSessionNames();
      void loadSelectedDetail();
      void loadSelectedGitInfo();
      void loadRawEvents();
      void loadVisibleCardTools();
      void loadWidgetStatuses();
      void loadSpend();
      scheduleQueueCheck();
    });
    events.addEventListener("error", () => { state.status = "reconnecting"; });
  }

  function disconnectEvents(): void {
    events?.close();
    events = null;
  }

  function pinTranscriptIfRecent(): void {
    if (state.view !== "detail" || state.transcriptMode !== "recent") return;
    const element = document.querySelector<HTMLElement>(".transcript-body");
    if (element) element.scrollTop = element.scrollHeight;
  }

  return {
    state,
    selectedSession,
    visibleSessions,
    connect,
    refresh,
    navigateTo,
    selectSession,
    openModal,
    closeModal,
    loadSelectedDetail,
    loadSelectedGitInfo,
    loadRawEvents,
    setTranscriptMode,
    loadVisibleCardTools,
    renameSelected,
    sendAgent,
    queueAgentMessage,
    sendQueuedNow,
    removeQueuedMessage,
    loadWidgets,
    loadWidgetStatuses,
    sessionHasWidgetAlert,
    setWidgetFrameHeight,
    refreshRuns,
    openDirectoryPicker,
    selectDirectory,
    loadPiResources,
    saveDashboardSystemPrompt,
    setResourceFilter,
    handlePopstate,
    useManagedProxy,
  };
}
