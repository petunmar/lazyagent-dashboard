import { computed, nextTick, reactive } from "vue";
import { fetchAgentRuns, fetchDirectory, fetchPiResources, fetchSessionEvents, fetchSessionNames, fetchWidgets, fetchWidgetStatuses, LazyagentBrowserClient, renameSession, submitAgent } from "../api";
import type { AgentRun, DirectoryPickerState, EventsUpdate, ModalType, PiResourceKind, PiResourcesPayload, RawSessionEvents, SessionDetail, SessionFilter, SessionItem, Stats, ToolSparkItem, TranscriptMode, ViewMode, WidgetManifest, WidgetStatus } from "../types";
import { extractToolNames, matchesFilter, sortSessions } from "../utils";

type State = {
  baseUrl: string;
  passphrase: string;
  connected: boolean;
  status: string;
  error: string;
  sessions: SessionItem[];
  stats: Stats | null;
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
  piResourcesLoading: boolean;
  piResourcesError: string;
  piResourceFilter: PiResourceKind;
  selectedResourceKey: string;
  widgets: WidgetManifest[];
  widgetStatuses: WidgetStatus[];
  widgetFrameHeights: Record<string, number>;
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
  piResourcesLoading: false,
  piResourcesError: "",
  piResourceFilter: "all",
  selectedResourceKey: "",
  widgets: [],
  widgetStatuses: [],
  widgetFrameHeights: {},
});

let client: LazyagentBrowserClient | null = null;
let events: EventSource | null = null;

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
      const [stats, sessions] = await Promise.all([client.stats(), client.sessions(), loadSessionNames()]);
      state.stats = stats;
      state.sessions = sortSessions(sessions);
      const previous = state.selectedId;
      state.selectedId ||= state.sessions[0]?.session_id || "";
      if (state.selectedId !== previous) clearSelectedPayload();
      state.error = "";
      void loadSelectedDetail();
      void loadRawEvents();
      void loadVisibleCardTools();
      void loadWidgetStatuses();
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
    void loadRawEvents();
  }

  function openModal(modal: ModalType, sessionId = ""): void {
    if (sessionId && sessionId !== state.selectedId) {
      state.selectedId = sessionId;
      clearSelectedPayload();
      state.chatDraft = "";
      state.transcriptMode = "recent";
      void loadSelectedDetail();
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
      if (state.selectedId === id) state.selectedDetail = detail;
    } catch (error) {
      if (state.selectedId === id) state.error = error instanceof Error ? error.message : String(error);
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
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    }
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
      state.piResources = await fetchPiResources(selectedSession.value?.cwd || "/home/petur");
      state.selectedResourceKey ||= state.piResources.resources[0]?.key || "";
    } catch (error) {
      state.piResourcesError = error instanceof Error ? error.message : String(error);
    } finally {
      state.piResourcesLoading = false;
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

  function connectEvents(): void {
    if (!client) return;
    events = new EventSource(client.eventsUrl());
    events.addEventListener("update", event => {
      const update = JSON.parse((event as MessageEvent).data) as EventsUpdate;
      state.stats = update.stats;
      state.sessions = sortSessions(update.sessions);
      state.selectedId ||= state.sessions[0]?.session_id || "";
      state.status = `live · ${new Date().toLocaleTimeString()}`;
      void loadSessionNames();
      void loadSelectedDetail();
      void loadRawEvents();
      void loadVisibleCardTools();
      void loadWidgetStatuses();
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
    loadRawEvents,
    setTranscriptMode,
    loadVisibleCardTools,
    renameSelected,
    sendAgent,
    loadWidgets,
    loadWidgetStatuses,
    sessionHasWidgetAlert,
    setWidgetFrameHeight,
    refreshRuns,
    openDirectoryPicker,
    selectDirectory,
    loadPiResources,
    setResourceFilter,
    handlePopstate,
    useManagedProxy,
  };
}
