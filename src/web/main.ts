import "./styles.css";
import { LazyagentBrowserClient, type AgentRun, type ConversationItem, type EventsUpdate, type RawSessionEvents, type SessionDetail, type SessionEvent, type SessionItem, type Stats, type ToolItem } from "./lazyagent-browser-client";

type SessionFilter = "all" | "working" | "idle" | "errored";
type ViewMode = "dashboard" | "detail" | "pi-resources";
type ModalType = "launch" | "message" | "connect" | "rename";
type TranscriptMode = "recent" | "full";
type ToolSparkItem = {
  name: string;
  timestamp?: string;
  detail: string;
};

type DirectoryEntry = {
  name: string;
  path: string;
};

type DirectoryListing = {
  path: string;
  parent: string;
  home: string;
  entries: DirectoryEntry[];
};

type DirectoryPickerState = {
  open: boolean;
  path: string;
  parent: string;
  home: string;
  entries: DirectoryEntry[];
  loading: boolean;
  error: string;
};

type PiResourceKind = "all" | "skill" | "extension";

type PiResource = {
  key: string;
  kind: "skill" | "extension";
  scope: string;
  name: string;
  description: string;
  path: string;
  root: string;
  content: string;
};

type PiResourcesPayload = {
  cwd: string;
  generated_at: string;
  settings: { path: string; content: string }[];
  packages: { name: string; root: string; missing?: boolean }[];
  resources: PiResource[];
};

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
};

const state: State = {
  baseUrl: localStorage.getItem("lazyagent.baseUrl") || "http://127.0.0.1:7421",
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
  directoryPicker: {
    open: false,
    path: "",
    parent: "",
    home: "",
    entries: [],
    loading: false,
    error: "",
  },
  piResources: null,
  piResourcesLoading: false,
  piResourcesError: "",
  piResourceFilter: "all",
  selectedResourceKey: "",
};

const lowFocusAfterMinutes = 10;

function initialView(): ViewMode {
  return location.pathname.startsWith("/pi-resources") ? "pi-resources" : "dashboard";
}

let client: LazyagentBrowserClient | null = null;
let events: EventSource | null = null;

const app = document.querySelector<HTMLDivElement>("#app")!;

function render(): void {
  const focus = captureFocus();
  const transcriptWasNearBottom = isTranscriptNearBottom();
  const selected = state.sessions.find(s => s.session_id === state.selectedId) || state.sessions[0];
  const visibleSessions = state.sessions.filter(matchesFilter);
  const summary = summarizeSessions(state.sessions);
  const now = new Date();

  app.innerHTML = `
    <main class="monitor-shell ${state.view === "detail" ? "detail-view" : ""} ${state.view === "pi-resources" ? "resources-view" : ""}">
      <header class="monitor-topbar">
        <div class="brand-lockup">
          <button class="brand-mark" data-view="dashboard" type="button" aria-label="Back to dashboard">A</button>
          <div>
            <h1>Agent Monitor</h1>
            <p>${viewSubtitle()}</p>
          </div>
        </div>
        <dl class="hero-stats">
          <div><dt>${state.stats?.total_sessions ?? (state.sessions.length || "—")}</dt><dd>agents</dd></div>
          <div class="accent"><dt>${summary.working}</dt><dd>working</dd></div>
          <div><dt>${summary.idle}</dt><dd>idle</dd></div>
          <div class="danger"><dt>${summary.errored}</dt><dd>errored</dd></div>
          <div><dt>${formatCompact(totalTokens())}</dt><dd>tokens</dd></div>
          <div class="money"><dt>${formatMoney(totalCost())}</dt><dd>today</dd></div>
        </dl>
        <button class="live-clock" type="button" data-open-modal="connect" aria-label="Open connection settings">
          <strong><span></span>${state.connected ? "LIVE" : "SETUP"}</strong>
          <time>${now.toLocaleDateString()} · ${now.toLocaleTimeString()}</time>
        </button>
      </header>

      ${state.error ? `<p class="error-banner">${escapeHtml(state.error)}</p>` : ""}

      ${state.view === "detail" ? renderDetailPage(selected) : state.view === "pi-resources" ? renderPiResourcesPage() : renderDashboard(visibleSessions)}
      ${renderModal(selected)}
    </main>
  `;

  bindEvents();
  restoreTranscriptPosition(transcriptWasNearBottom);
  restoreFocus(focus);
}

function viewSubtitle(): string {
  if (state.view === "detail") return "session detail";
  if (state.view === "pi-resources") return "skills + extensions";
  return "multi-agent dashboard";
}

function renderDashboard(visibleSessions: SessionItem[]): string {
  const focusSessions = visibleSessions.filter(session => !isLowFocusSession(session));
  const lowFocusSessions = visibleSessions.filter(isLowFocusSession);
  return `
    <section class="dashboard-controls">
      <div class="filter-pills">
        ${(["all", "working", "idle", "errored"] as SessionFilter[]).map(filter => `<button class="pill ${state.filter === filter ? "active" : ""}" data-filter="${filter}" type="button">${filter}</button>`).join("")}
        <button class="pill" type="button" data-view="pi-resources">skills + extensions</button>
        <button class="pill create" type="button" data-open-modal="launch">+ new agent</button>
      </div>
    </section>

    <section class="agent-grid">
      ${focusSessions.length ? focusSessions.map(agentCard).join("") : emptyAgentsCard(lowFocusSessions.length > 0)}
    </section>

    ${lowFocusSessions.length ? renderLowFocusSessions(lowFocusSessions) : ""}
  `;
}

function renderDetailPage(selected?: SessionItem): string {
  if (!selected) return `<section class="console-card"><p class="empty">Select an agent from the dashboard.</p></section>`;
  return `
    <section class="detail-actions">
      <button class="pill" type="button" data-view="dashboard">← dashboard</button>
      <div class="detail-action-group"><button class="pill" type="button" data-view="pi-resources">skills + extensions</button><button class="pill create" type="button" data-open-modal="launch">+ new agent</button></div>
    </section>

    <section class="detail-layout">
      <aside class="console-card detail-card">
        <div class="console-head"><span>focus</span><div class="focus-title"><h2>${escapeHtml(displaySessionName(selected))}</h2><button class="rename-chip" type="button" data-open-modal="rename" data-session-id="${escapeAttr(selected.session_id)}">rename</button></div></div>
        ${sessionDetail(state.selectedDetail || selected)}
      </aside>
      <section class="console-card transcript-card inline-transcript">
        <div class="console-head"><span>stream</span><h2>Live transcript</h2></div>
        ${rawTranscriptCard(selected)}
      </section>
    </section>
  `;
}

function renderPiResourcesPage(): string {
  const payload = state.piResources;
  const resources = (payload?.resources || []).filter(resource => state.piResourceFilter === "all" || resource.kind === state.piResourceFilter);
  const selected = resources.find(resource => resource.key === state.selectedResourceKey) || resources[0];
  if (selected && state.selectedResourceKey !== selected.key) state.selectedResourceKey = selected.key;
  const skills = payload?.resources.filter(resource => resource.kind === "skill").length || 0;
  const extensions = payload?.resources.filter(resource => resource.kind === "extension").length || 0;
  return `
    <section class="detail-actions">
      <button class="pill" type="button" data-view="dashboard">← dashboard</button>
      <button class="pill" type="button" data-refresh-pi-resources>${state.piResourcesLoading ? "refreshing…" : "refresh"}</button>
    </section>
    <section class="resources-hero console-card">
      <div>
        <div class="console-head"><span>pi setup</span><h2>Skills + extensions</h2></div>
        <p>Browse the Pi resources installed on this VM, including global skills, extension modules, and package-provided resources that the dashboard can find.</p>
        ${payload ? `<code>${escapeHtml(payload.cwd)}</code>` : ""}
      </div>
      <dl class="resource-counts">
        <div><dt>${skills}</dt><dd>skills</dd></div>
        <div><dt>${extensions}</dt><dd>extensions</dd></div>
        <div><dt>${payload?.packages.length || 0}</dt><dd>packages</dd></div>
      </dl>
    </section>
    ${state.piResourcesError ? `<p class="error-banner">${escapeHtml(state.piResourcesError)}</p>` : ""}
    ${state.piResourcesLoading && !payload ? `<section class="console-card"><p class="empty loading">Loading Pi resources…</p></section>` : renderPiResourcesBrowser(resources, selected, payload)}
  `;
}

function renderPiResourcesBrowser(resources: PiResource[], selected: PiResource | undefined, payload: PiResourcesPayload | null): string {
  if (!payload) return `<section class="console-card"><p class="empty">No Pi resources loaded yet.</p></section>`;
  return `
    <section class="resources-layout">
      <aside class="console-card resources-list-card">
        <div class="console-head"><span>inventory</span><h2>${resources.length} visible</h2></div>
        <div class="filter-pills resource-filters">
          ${(["all", "skill", "extension"] as PiResourceKind[]).map(filter => `<button class="pill ${state.piResourceFilter === filter ? "active" : ""}" data-resource-filter="${filter}" type="button">${filter}</button>`).join("")}
        </div>
        <div class="resource-list">
          ${resources.length ? resources.map(resourceListItem).join("") : `<p class="empty">No resources in this filter.</p>`}
        </div>
        ${renderPiSettingsSummary(payload)}
      </aside>
      <section class="console-card resource-detail-card">
        ${selected ? renderResourceDetail(selected) : `<p class="empty">Choose a skill or extension.</p>`}
      </section>
    </section>
  `;
}

function resourceListItem(resource: PiResource): string {
  return `
    <button class="resource-row ${state.selectedResourceKey === resource.key ? "active" : ""}" type="button" data-resource-key="${escapeAttr(resource.key)}">
      <span class="resource-kind ${resource.kind}">${resource.kind}</span>
      <strong>${escapeHtml(resource.name)}</strong>
      <small>${escapeHtml(resource.scope)}</small>
    </button>
  `;
}

function renderResourceDetail(resource: PiResource): string {
  return `
    <div class="resource-detail-head">
      <div>
        <span class="resource-kind ${resource.kind}">${resource.kind}</span>
        <h2>${escapeHtml(resource.name)}</h2>
        <p>${escapeHtml(resource.description || "No description found.")}</p>
      </div>
      <code>${escapeHtml(resource.scope)}</code>
    </div>
    <dl class="resource-meta">
      <div><dt>path</dt><dd><code>${escapeHtml(resource.path)}</code></dd></div>
      <div><dt>root</dt><dd><code>${escapeHtml(resource.root)}</code></dd></div>
    </dl>
    <pre class="resource-source"><code>${escapeHtml(resource.content)}</code></pre>
  `;
}

function renderPiSettingsSummary(payload: PiResourcesPayload): string {
  return `
    <div class="settings-summary">
      <h3>settings</h3>
      ${payload.settings.length ? payload.settings.map(setting => `<code>${escapeHtml(setting.path)}</code>`).join("") : `<p class="empty">No settings files found.</p>`}
      <h3>packages</h3>
      ${payload.packages.length ? payload.packages.map(pkg => `<p><code>${escapeHtml(pkg.name)}</code>${pkg.missing ? " <span>missing</span>" : ` <small>${escapeHtml(pkg.root)}</small>`}</p>`).join("") : `<p class="empty">No package resources configured.</p>`}
    </div>
  `;
}

function renderModal(selected?: SessionItem): string {
  if (!state.modal) return "";
  const mode = state.modal;
  if (mode === "connect") return renderConnectModal();
  if (mode === "rename") return renderRenameModal(selected);
  const isMessage = mode === "message";
  const title = isMessage ? "Message agent" : "Launch new agent";
  const session = isMessage ? selected : undefined;
  const cwd = state.cwdDraft || session?.cwd || selected?.cwd || "~/coding";
  return `
    <div class="modal-backdrop" data-close-modal>
      <section class="modal-card" role="dialog" aria-modal="true" aria-label="${title}">
        <button class="modal-close" type="button" data-close-modal>×</button>
        <div class="console-head"><span>${isMessage ? "follow-up" : "compose"}</span><h2>${title}</h2></div>
        <form id="agent-form" class="agent-form">
          <div class="directory-field">
            <label>Working directory<input id="agent-cwd" name="cwd" value="${escapeAttr(cwd)}" autocomplete="off" /></label>
            <button class="directory-browse" type="button" data-open-directory-picker>browse</button>
          </div>
          ${renderDirectoryPicker()}
          <label>Session ID<input name="sessionId" value="${escapeAttr(isMessage ? state.selectedId : "")}" placeholder="empty starts a new session" ${isMessage ? "readonly" : ""} /></label>
          <label class="prompt-field">Message<textarea name="prompt" rows="5" placeholder="→ ${isMessage ? `send a message to ${escapeAttr(session ? displaySessionName(session) : "agent")}` : "tell the new agent what to do"}"></textarea></label>
          <div class="agent-options">
            <label>Model<input name="model" placeholder="optional · gpt-5.5" /></label>
            <label>Thinking<select name="thinking"><option value="">default</option><option>minimal</option><option>low</option><option>medium</option><option>high</option><option>xhigh</option></select></label>
            <label class="checkbox"><input name="readonly" type="checkbox" /> read-only tools</label>
          </div>
          <div class="agent-actions">
            <button name="mode" value="${isMessage ? "message" : "start"}" type="submit">↵ ${isMessage ? "send" : "start"}</button>
          </div>
        </form>
        ${renderRunsList()}
      </section>
    </div>
  `;
}

function renderDirectoryPicker(): string {
  const picker = state.directoryPicker;
  if (!picker.open) return "";
  return `
    <section class="directory-picker" aria-label="Choose working directory">
      <header>
        <div>
          <span>vm folders</span>
          <code>${escapeHtml(picker.path || "loading…")}</code>
        </div>
        <div class="directory-picker-actions">
          ${picker.parent ? `<button class="pill" type="button" data-directory-path="${escapeAttr(picker.parent)}">↑ up</button>` : ""}
          ${picker.home ? `<button class="pill" type="button" data-directory-path="${escapeAttr(picker.home)}">home</button>` : ""}
          <button class="pill" type="button" data-close-directory-picker>close</button>
        </div>
      </header>
      ${picker.error ? `<p class="directory-error">${escapeHtml(picker.error)}</p>` : ""}
      ${picker.loading ? `<p class="empty loading">Loading folders…</p>` : `
        <div class="directory-list">
          ${picker.entries.length ? picker.entries.map(entry => `
            <div class="directory-row" title="${escapeAttr(entry.path)}">
              <button class="directory-name" type="button" data-directory-path="${escapeAttr(entry.path)}">📁 ${escapeHtml(entry.name)}</button>
              <button class="directory-select" type="button" data-directory-select="${escapeAttr(entry.path)}">choose</button>
            </div>
          `).join("") : `<p class="empty">No subfolders here.</p>`}
        </div>
      `}
      <div class="directory-current-actions">
        <button type="button" data-directory-select="${escapeAttr(picker.path)}">choose this folder</button>
      </div>
    </section>
  `;
}

function renderRenameModal(selected?: SessionItem): string {
  if (!selected) return "";
  const currentName = displaySessionName(selected);
  const localName = state.sessionNames[selected.session_id] || "";
  return `
    <div class="modal-backdrop" data-close-modal>
      <section class="modal-card rename-modal" role="dialog" aria-modal="true" aria-label="Rename session">
        <button class="modal-close" type="button" data-close-modal>×</button>
        <div class="console-head"><span>readable name</span><h2>Rename session</h2></div>
        <form id="rename-form" class="rename-form">
          <input type="hidden" name="sessionId" value="${escapeAttr(selected.session_id)}" />
          <label>Name<input id="session-name-input" name="name" value="${escapeAttr(localName || currentName)}" maxlength="80" autocomplete="off" /></label>
          <p class="rename-hint">This only changes the app label. Session ID and context stay unchanged: <code>${escapeHtml(shortId(selected.session_id))}</code></p>
          <div class="agent-actions">
            <button name="renameMode" value="save" type="submit">save name</button>
            <button name="renameMode" value="auto" type="submit">random name</button>
            ${localName ? `<button name="renameMode" value="clear" type="submit">clear</button>` : ""}
          </div>
        </form>
      </section>
    </div>
  `;
}

function renderConnectModal(): string {
  return `
    <div class="modal-backdrop" data-close-modal>
      <section class="modal-card connect-modal" role="dialog" aria-modal="true" aria-label="Connection settings">
        <button class="modal-close" type="button" data-close-modal>×</button>
        <div class="console-head"><span>connection</span><h2>Lazyagent API</h2></div>
        <form id="connect-form" class="connect-form">
          <label>API <input name="baseUrl" value="${escapeAttr(state.baseUrl)}" placeholder="http://127.0.0.1:7421" /></label>
          <label>Passphrase <input name="passphrase" type="password" autocomplete="current-password" value="${escapeAttr(state.passphrase)}" placeholder="lazyagent --api passphrase" /></label>
          <div class="connect-actions">
            <div class="connection-state ${state.connected ? "ok" : ""}">${escapeHtml(state.status)}</div>
            <button type="submit">${state.connected ? "reconnect" : "connect"}</button>
          </div>
        </form>
      </section>
    </div>
  `;
}

function bindEvents(): void {
  app.querySelector<HTMLFormElement>("#connect-form")?.addEventListener("submit", onConnect);
  app.querySelector<HTMLFormElement>("#agent-form")?.addEventListener("submit", onAgentSubmit);
  app.querySelector<HTMLFormElement>("#rename-form")?.addEventListener("submit", onRenameSubmit);
  app.querySelector<HTMLInputElement>("#agent-cwd")?.addEventListener("input", event => {
    state.cwdDraft = (event.currentTarget as HTMLInputElement).value;
  });
  app.querySelector<HTMLButtonElement>("[data-open-directory-picker]")?.addEventListener("click", () => {
    const cwd = app.querySelector<HTMLInputElement>("#agent-cwd")?.value.trim() || state.cwdDraft || "~/coding";
    void openDirectoryPicker(cwd);
  });
  app.querySelector<HTMLButtonElement>("[data-close-directory-picker]")?.addEventListener("click", () => {
    state.directoryPicker.open = false;
    render();
  });
  app.querySelectorAll<HTMLButtonElement>("[data-directory-path]").forEach(button => {
    button.addEventListener("click", () => void openDirectoryPicker(button.dataset.directoryPath || state.directoryPicker.path));
  });
  app.querySelectorAll<HTMLButtonElement>("[data-directory-select]").forEach(button => {
    button.addEventListener("click", () => selectDirectory(button.dataset.directorySelect || state.directoryPicker.path));
  });
  app.querySelector<HTMLFormElement>("#chat-form")?.addEventListener("submit", onAgentSubmit);
  app.querySelector<HTMLTextAreaElement>("#chat-prompt")?.addEventListener("input", event => {
    state.chatDraft = (event.currentTarget as HTMLTextAreaElement).value;
  });
  app.querySelector<HTMLTextAreaElement>("#chat-prompt")?.addEventListener("keydown", event => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      const form = (event.currentTarget as HTMLTextAreaElement).form;
      const submitButton = form?.querySelector<HTMLButtonElement>('button[type="submit"][value="message"]');
      form?.requestSubmit(submitButton || undefined);
    }
  });
  app.querySelectorAll<HTMLElement>("[data-session-id]").forEach(element => {
    element.addEventListener("click", event => {
      event.stopPropagation();
      const id = element.dataset.sessionId || "";
      if (!element.dataset.openModal) selectSession(id);
    });
  });
  app.querySelectorAll<HTMLButtonElement>("[data-filter]").forEach(button => {
    button.addEventListener("click", () => {
      state.filter = (button.dataset.filter as SessionFilter) || "all";
      render();
      void loadVisibleCardTools();
    });
  });
  app.querySelectorAll<HTMLButtonElement>("[data-open-modal]").forEach(button => {
    button.addEventListener("click", event => {
      event.stopPropagation();
      openModal((button.dataset.openModal as ModalType) || "launch", button.dataset.sessionId || state.selectedId);
    });
  });
  app.querySelectorAll<HTMLElement>("[data-close-modal]").forEach(element => {
    element.addEventListener("click", event => {
      if (event.target === element || (event.target as HTMLElement).dataset.closeModal !== undefined) {
        state.modal = null;
        render();
      }
    });
  });
  app.querySelectorAll<HTMLButtonElement>("[data-view]").forEach(button => {
    button.addEventListener("click", () => navigateTo((button.dataset.view as ViewMode) || "dashboard"));
  });
  app.querySelectorAll<HTMLButtonElement>("[data-resource-filter]").forEach(button => {
    button.addEventListener("click", () => {
      state.piResourceFilter = (button.dataset.resourceFilter as PiResourceKind) || "all";
      state.selectedResourceKey = "";
      render();
    });
  });
  app.querySelectorAll<HTMLButtonElement>("[data-resource-key]").forEach(button => {
    button.addEventListener("click", () => {
      state.selectedResourceKey = button.dataset.resourceKey || "";
      render();
    });
  });
  app.querySelector<HTMLButtonElement>("[data-refresh-pi-resources]")?.addEventListener("click", () => void loadPiResources(true));
  app.querySelectorAll<HTMLButtonElement>("[data-transcript-mode]").forEach(button => {
    button.addEventListener("click", () => {
      state.transcriptMode = (button.dataset.transcriptMode as TranscriptMode) || "recent";
      state.rawEvents = null;
      render();
      void loadRawEvents();
    });
  });
}

function navigateTo(view: ViewMode): void {
  state.view = view;
  const target = view === "pi-resources" ? "/pi-resources" : "/";
  if (location.pathname !== target) history.pushState({ view }, "", target);
  render();
  if (view === "pi-resources") void loadPiResources();
}

function selectSession(id: string): void {
  state.selectedId = id;
  state.selectedDetail = null;
  state.rawEvents = null;
  state.chatDraft = "";
  state.transcriptMode = "recent";
  state.view = "detail";
  if (location.pathname !== "/") history.pushState({ view: "detail" }, "", "/");
  state.modal = null;
  render();
  void loadSelectedDetail();
  void loadRawEvents();
}

function openModal(modal: ModalType, sessionId = ""): void {
  if (sessionId && sessionId !== state.selectedId) {
    state.selectedId = sessionId;
    state.selectedDetail = null;
    state.rawEvents = null;
    state.chatDraft = "";
    state.transcriptMode = "recent";
    void loadSelectedDetail();
    void loadRawEvents();
  }
  state.modal = modal;
  state.directoryPicker.open = false;
  state.cwdDraft = modal === "connect" ? "" : (selectedSession()?.cwd || "~/coding");
  render();
}

function selectedSession(): SessionItem | undefined {
  return state.sessions.find(session => session.session_id === state.selectedId);
}

type FocusSnapshot = { id: string; start: number | null; end: number | null } | null;

function captureFocus(): FocusSnapshot {
  const element = document.activeElement;
  if (!(element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) || !element.id) return null;
  return { id: element.id, start: element.selectionStart, end: element.selectionEnd };
}

function restoreFocus(snapshot: FocusSnapshot): void {
  if (!snapshot) return;
  const element = document.getElementById(snapshot.id);
  if (!(element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement)) return;
  element.focus();
  if (snapshot.start !== null && snapshot.end !== null) element.setSelectionRange(snapshot.start, snapshot.end);
}

function transcriptBody(): HTMLElement | null {
  return app.querySelector<HTMLElement>(".transcript-body");
}

function isTranscriptNearBottom(): boolean {
  const element = transcriptBody();
  if (!element) return true;
  return element.scrollHeight - element.scrollTop - element.clientHeight < 96;
}

function restoreTranscriptPosition(wasNearBottom: boolean): void {
  if (state.view !== "detail" || (state.transcriptMode !== "recent" && !wasNearBottom)) return;
  const element = transcriptBody();
  if (element) element.scrollTop = element.scrollHeight;
}

function agentCard(s: SessionItem): string {
  const detail = s.session_id === state.selectedId ? state.selectedDetail : null;
  const cls = sessionTone(s);
  const current = currentWork(s, detail);
  const spark = sparkline(s);
  const active = s.session_id === state.selectedId ? "selected" : "";
  const name = displaySessionName(s);
  return `
    <article class="agent-card ${cls} ${active}" data-session-id="${escapeAttr(s.session_id)}" tabindex="0" role="button" aria-label="Open ${escapeAttr(name)} detail">
      <button class="card-hit" type="button" aria-label="Select ${escapeAttr(name)}"></button>
      <header class="card-head">
        <div class="agent-title"><span class="agent-dot"></span><h3>${escapeHtml(name)}</h3></div>
        <div class="status-stack"><button class="rename-chip" type="button" data-open-modal="rename" data-session-id="${escapeAttr(s.session_id)}">rename</button><span class="state-badge">${statusLabel(s)}</span><span class="model-tag">${escapeHtml(s.model || "model ?")}</span></div>
      </header>
      <p class="path-line">${escapeHtml(compactPath(s.cwd))} · ${escapeHtml(shortId(s.session_id))}</p>
      <div class="current-work"><div><span>${current.label}</span><strong>${escapeHtml(current.text)}</strong></div><time>${relativeTime(s.last_activity)}</time></div>
      <div class="tool-spark"><div class="spark-head"><span>last ${state.cardTools[s.session_id]?.length || 0} tool calls</span><span>now →</span></div><div class="bars">${spark}</div></div>
      <dl class="card-metrics">
        <div><dt>${detail ? `${detail.user_messages}/${detail.assistant_messages}` : s.total_messages}</dt><dd>msgs</dd></div>
        <div><dt>${detail ? formatCompact(detail.input_tokens) : "—"}${detail?.cache_read_tokens ? `<small> +${formatCompact(detail.cache_read_tokens)}</small>` : ""}</dt><dd>tok in</dd></div>
        <div><dt>${detail ? formatCompact(detail.output_tokens) : "—"}</dt><dd>tok out</dd></div>
        <div><dt>${typeof s.cost_usd === "number" ? formatMoney(s.cost_usd) : "—"}</dt><dd>cost</dd></div>
      </dl>
    </article>
  `;
}

function renderLowFocusSessions(sessions: SessionItem[]): string {
  return `
    <section class="low-focus-panel console-card" aria-label="Inactive recent sessions">
      <div class="console-head"><span>recent idle</span><h2>Quiet sessions</h2></div>
      <p class="low-focus-note">Idle for ${lowFocusAfterMinutes}+ minutes. Lazyagent will remove these from this view after its 30 minute window.</p>
      <div class="low-focus-list">
        ${sessions.map(lowFocusRow).join("")}
      </div>
    </section>
  `;
}

function lowFocusRow(s: SessionItem): string {
  const name = displaySessionName(s);
  return `
    <article class="low-focus-row" data-session-id="${escapeAttr(s.session_id)}" tabindex="0" role="button" aria-label="Open ${escapeAttr(name)} detail">
      <div>
        <strong>${escapeHtml(name)}</strong>
        <span>${escapeHtml(compactPath(s.cwd))} · ${escapeHtml(shortId(s.session_id))}</span>
      </div>
      <div class="low-focus-meta">
        <span>${escapeHtml(statusLabel(s))}</span>
        <time>${relativeTime(s.last_activity)}</time>
        <button class="rename-chip" type="button" data-open-modal="rename" data-session-id="${escapeAttr(s.session_id)}">rename</button>
      </div>
    </article>
  `;
}

function emptyAgentsCard(hasLowFocusSessions = false): string {
  const message = hasLowFocusSessions ? "No high-focus agents. Older idle sessions are listed below." : "Connect lazyagent or change the filter.";
  return `<article class="agent-card empty-card"><h3>No matching agents</h3><p>${escapeHtml(message)}</p></article>`;
}

function renderRunsList(): string {
  return `<div class="runs" data-runs ${state.runs.length ? "" : "hidden"}>${renderRunRows()}</div>`;
}

function renderRunRows(): string {
  return state.runs.slice(0, 3).map(runRow).join("");
}

function updateRunsList(): void {
  const container = app.querySelector<HTMLElement>("[data-runs]");
  if (!container) return;
  container.hidden = state.runs.length === 0;
  container.innerHTML = renderRunRows();
}

function runsFingerprint(runs: AgentRun[]): string {
  return runs.map(run => [run.run_id, run.status, run.session_id || "", run.started_at, run.stderr_tail || ""].join("\u0001")).join("\u0002");
}

function runRow(run: AgentRun): string {
  return `
    <article class="run-row ${escapeAttr(run.status)}">
      <strong>${escapeHtml(run.kind)} · ${escapeHtml(run.status)}</strong>
      <span>${escapeHtml(run.session_id || "session pending")} · ${relativeTime(run.started_at)}</span>
      ${run.stderr_tail ? `<pre>${escapeHtml(run.stderr_tail)}</pre>` : ""}
    </article>
  `;
}

function sessionDetail(s: SessionItem | SessionDetail): string {
  const detail = isDetail(s) ? s : null;
  return `
    <dl class="detail-list">
      <div><dt>Name</dt><dd>${escapeHtml(displaySessionName(s))}</dd></div>
      <div><dt>Path</dt><dd>${escapeHtml(s.cwd)}</dd></div>
      <div><dt>Session</dt><dd><code>${escapeHtml(s.session_id)}</code></dd></div>
      <div><dt>Activity</dt><dd>${escapeHtml(s.activity)} ${s.is_active ? "· active" : "· inactive"}</dd></div>
      <div><dt>Current</dt><dd>${escapeHtml(detail?.current_tool || "—")}</dd></div>
      <div><dt>Last write</dt><dd>${escapeHtml(detail?.last_file_write || "—")}</dd></div>
      <div><dt>Branch</dt><dd>${escapeHtml(s.git_branch || "—")}</dd></div>
      <div><dt>Resume</dt><dd>${detail?.resume_command ? `<code>${escapeHtml(detail.resume_command)}</code>` : "—"}</dd></div>
    </dl>
    ${detail ? "" : `<p class="empty loading">Loading detail…</p>`}
  `;
}

function isDetail(s: SessionItem | SessionDetail): s is SessionDetail {
  return "recent_tools" in s;
}

function rawTranscriptCard(session = selectedSession()): string {
  const raw = state.rawEvents;
  const detail = state.selectedDetail;
  return `
    <div class="transcript-body" aria-live="polite">
      <div class="transcript-meta">
        <span>${raw ? transcriptSummary(raw) : "Loading raw transcript…"}</span>
        <div class="transcript-tools">
          <button class="pill ${state.transcriptMode === "recent" ? "active" : ""}" type="button" data-transcript-mode="recent">latest</button>
          <button class="pill ${state.transcriptMode === "full" ? "active" : ""}" type="button" data-transcript-mode="full">full transcript</button>
        </div>
      </div>
      ${raw?.file ? `<code class="transcript-file">${escapeHtml(raw.file)}</code>` : ""}
      ${state.transcriptMode === "full" && detail ? `
        <div class="mini-cards">
          <section>
            <h3>Recent messages</h3>
            ${detail.recent_messages.length ? detail.recent_messages.map(messageRow).join("") : `<p class="empty">No recent messages exposed by lazyagent.</p>`}
          </section>
          <section>
            <h3>Recent tool calls</h3>
            ${detail.recent_tools.length ? detail.recent_tools.map(toolRow).join("") : `<p class="empty">No recent tool calls exposed by lazyagent.</p>`}
          </section>
        </div>
      ` : ""}
      <section class="timeline-block raw-events">
        <h3>Raw session events</h3>
        ${raw ? raw.events.map(rawEventRow).join("") : `<p class="empty">Reading pi JSONL transcript from disk…</p>`}
      </section>
    </div>
    ${transcriptComposer(session)}
  `;
}

function transcriptSummary(raw: RawSessionEvents): string {
  if (state.transcriptMode === "full") return `${raw.event_count} parsed events${raw.truncated ? ` · showing last ${raw.events.length}` : ""}`;
  return `latest ${raw.events.length} events · ${raw.event_count} total`;
}

function transcriptComposer(session?: SessionItem): string {
  if (!session) return "";
  return `
    <form id="chat-form" class="chat-compose" aria-label="Send a follow-up message to this agent">
      <input type="hidden" name="cwd" value="${escapeAttr(session.cwd)}" />
      <input type="hidden" name="sessionId" value="${escapeAttr(session.session_id)}" />
      <textarea id="chat-prompt" name="prompt" rows="3" placeholder="Message ${escapeAttr(displaySessionName(session))}…">${escapeHtml(state.chatDraft)}</textarea>
      <div class="chat-compose-actions">
        <span>${escapeHtml(shortId(session.session_id))} · ⌘/ctrl+enter sends</span>
        <button name="mode" value="message" type="submit">send ↵</button>
      </div>
    </form>
  `;
}

function messageRow(message: ConversationItem): string {
  return `
    <article class="message">
      <header><strong>${escapeHtml(message.role)}</strong><span>${message.timestamp ? relativeTime(message.timestamp) : ""}</span></header>
      <p>${escapeHtml(message.text)}</p>
    </article>
  `;
}

function toolRow(tool: ToolItem): string {
  return `
    <article class="tool-row">
      <strong>${escapeHtml(tool.name)}</strong>
      <span>${tool.timestamp ? relativeTime(tool.timestamp) : ""}</span>
    </article>
  `;
}

function rawEventRow(event: SessionEvent): string {
  const title = eventTitle(event);
  const body = eventBody(event);
  return `
    <article class="raw-event ${escapeAttr(event.kind)}">
      <header>
        <strong>${escapeHtml(title)}</strong>
        <span>${event.timestamp ? `${relativeTime(event.timestamp)} · ` : ""}line ${event.line ?? "?"}</span>
      </header>
      ${body ? `<pre>${escapeHtml(body)}</pre>` : ""}
    </article>
  `;
}

function eventTitle(event: SessionEvent): string {
  if (event.kind === "tool_call") return `tool call · ${event.name || "unknown"}`;
  if (event.kind === "tool_result") return `tool result · ${event.tool_name || "unknown"}`;
  if (event.kind === "assistant") return "assistant message";
  if (event.kind === "user") return "user message";
  if (event.kind === "thinking") return "thinking block";
  if (event.kind === "model") return `model · ${event.model || "unknown"}`;
  if (event.kind === "session") return "session started";
  return event.kind.replaceAll("_", " ");
}

function eventBody(event: SessionEvent): string {
  if (event.kind === "tool_call") return JSON.stringify(event.arguments ?? {}, null, 2);
  if (event.kind === "tool_result") return event.text || "";
  if (event.text) return event.truncated ? `${event.text}\n[truncated]` : event.text;
  if (event.kind === "session") return event.cwd || "";
  if (event.kind === "model") return [event.provider, event.model].filter(Boolean).join(" / ");
  if (event.kind === "thinking_level") return event.level || "";
  return "";
}

async function openDirectoryPicker(path: string): Promise<void> {
  state.directoryPicker = {
    ...state.directoryPicker,
    open: true,
    path,
    loading: true,
    error: "",
  };
  render();

  try {
    const res = await fetch(`${extensionApiBase()}/api/directories?path=${encodeURIComponent(path)}`);
    if (!res.ok) throw new Error(await res.text());
    const listing = (await res.json()) as DirectoryListing;
    state.directoryPicker = {
      open: true,
      path: listing.path,
      parent: listing.parent,
      home: listing.home,
      entries: listing.entries,
      loading: false,
      error: "",
    };
  } catch (error) {
    state.directoryPicker = {
      ...state.directoryPicker,
      open: true,
      loading: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  render();
}

function selectDirectory(path: string): void {
  state.cwdDraft = path;
  state.directoryPicker.open = false;
  render();
}

async function onRenameSubmit(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const submitter = event.submitter as HTMLButtonElement | null;
  const form = event.currentTarget as HTMLFormElement;
  const data = new FormData(form);
  const sessionId = String(data.get("sessionId") || "").trim();
  const mode = submitter?.value || "save";
  const body = mode === "auto" ? { auto: true } : { name: mode === "clear" ? "" : String(data.get("name") || "").trim() };
  if (!sessionId) return;
  try {
    const res = await fetch(`${extensionApiBase()}/api/session-names/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    const payload = (await res.json()) as { name: string; names: Record<string, string> };
    state.sessionNames = payload.names;
    state.modal = null;
    state.error = "";
    render();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    render();
  }
}

async function onAgentSubmit(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const submitter = event.submitter as HTMLButtonElement | null;
  const form = event.currentTarget as HTMLFormElement;
  const mode = submitter?.value || (form.id === "chat-form" ? "message" : "start");
  const data = new FormData(form);
  const cwd = String(data.get("cwd") || "").trim();
  const prompt = String(data.get("prompt") || "").trim();
  const sessionId = String(data.get("sessionId") || "").trim();
  const model = String(data.get("model") || "").trim();
  const thinking = String(data.get("thinking") || "").trim();
  const readonly = data.has("readonly");
  if (!cwd || !prompt) {
    state.error = "Working directory and message are required.";
    render();
    return;
  }
  if (mode === "message" && !sessionId) {
    state.error = "Choose or enter a session ID to send a message.";
    render();
    return;
  }
  try {
    const endpoint = mode === "message" ? "/api/agents/message" : "/api/agents/start";
    const res = await fetch(`${extensionApiBase()}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, prompt, session_id: sessionId, model, thinking, readonly }),
    });
    if (!res.ok) throw new Error(await res.text());
    const run = (await res.json()) as AgentRun;
    state.runs = [run, ...state.runs.filter(r => r.run_id !== run.run_id)];
    state.error = "";
    state.modal = null;
    state.chatDraft = "";
    (form.elements.namedItem("prompt") as HTMLTextAreaElement).value = "";
    render();
    window.setTimeout(() => void refreshRuns(), 1000);
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    render();
  }
}

async function onConnect(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const data = new FormData(form);
  const baseUrl = String(data.get("baseUrl") || "").trim();
  const passphrase = String(data.get("passphrase") || "");
  if (!baseUrl || !passphrase) {
    state.error = "Enter the lazyagent API URL and passphrase.";
    render();
    return;
  }

  disconnectEvents();
  state.baseUrl = baseUrl;
  state.passphrase = passphrase;
  localStorage.setItem("lazyagent.baseUrl", baseUrl);
  localStorage.setItem("lazyagent.passphrase", passphrase);
  client = new LazyagentBrowserClient(baseUrl);
  state.status = "connecting";
  state.error = "";
  render();

  try {
    await client.setPassphrase(passphrase);
    state.connected = true;
    state.status = "connected";
    state.modal = null;
    await refresh();
    connectEvents();
  } catch (error) {
    state.connected = false;
    state.status = "offline";
    state.error = error instanceof Error ? error.message : String(error);
    render();
  }
}

async function refresh(): Promise<void> {
  if (!client) return;
  try {
    const [stats, sessions] = await Promise.all([client.stats(), client.sessions(), loadSessionNames()]);
    state.stats = stats;
    state.sessions = sortSessions(sessions);
    const previousSelected = state.selectedId;
    state.selectedId ||= state.sessions[0]?.session_id || "";
    if (state.selectedId !== previousSelected) {
      state.selectedDetail = null;
      state.rawEvents = null;
    }
    state.error = "";
    render();
    void loadSelectedDetail();
    void loadRawEvents();
    void loadVisibleCardTools();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    render();
  }
}

async function refreshRuns(): Promise<void> {
  try {
    const res = await fetch(`${extensionApiBase()}/api/agent-runs`);
    if (!res.ok) throw new Error(`runs failed: ${res.status}`);
    const nextRuns = ((await res.json()) as { runs: AgentRun[] }).runs;
    const changed = runsFingerprint(nextRuns) !== runsFingerprint(state.runs);
    state.runs = nextRuns;
    if (changed) updateRunsList();
    if (nextRuns.some(run => run.status === "running")) window.setTimeout(() => void refreshRuns(), 2000);
  } catch {
    // Runs are best-effort; transcript/lazyagent views still work without them.
  }
}

async function loadSelectedDetail(): Promise<void> {
  if (!client || !state.selectedId) return;
  const id = state.selectedId;
  try {
    const detail = await client.session(id);
    if (state.selectedId === id) {
      state.selectedDetail = detail;
      render();
    }
  } catch (error) {
    if (state.selectedId === id) {
      state.error = error instanceof Error ? error.message : String(error);
      render();
    }
  }
}

async function loadRawEvents(): Promise<void> {
  if (!state.selectedId) return;
  const id = state.selectedId;
  try {
    const raw = await fetchSessionEvents(id);
    if (state.selectedId === id) {
      state.rawEvents = raw;
      state.cardTools[id] = extractToolNames(raw);
      render();
    }
  } catch (error) {
    if (state.selectedId === id) {
      state.rawEvents = null;
      state.error = error instanceof Error ? error.message : String(error);
      render();
    }
  }
}

async function loadVisibleCardTools(): Promise<void> {
  const visible = state.sessions.filter(matchesFilter).slice(0, 24);
  await Promise.all(visible.map(async session => {
    const id = session.session_id;
    if (state.cardTools[id] || state.loadingCardTools.has(id)) return;
    state.loadingCardTools.add(id);
    try {
      const raw = await fetchSessionEvents(id, 40);
      state.cardTools[id] = extractToolNames(raw);
      if (state.selectedId === id && state.transcriptMode === "recent") state.rawEvents = raw;
    } catch {
      state.cardTools[id] = [];
    } finally {
      state.loadingCardTools.delete(id);
    }
  }));
  render();
}

async function fetchSessionEvents(id: string, limit = state.transcriptMode === "full" ? 1000 : 40): Promise<RawSessionEvents> {
  const res = await fetch(`${extensionApiBase()}/api/session-events/${encodeURIComponent(id)}?limit=${limit}`);
  if (!res.ok) throw new Error(`raw transcript failed: ${res.status} ${res.statusText}`);
  return res.json() as Promise<RawSessionEvents>;
}

async function loadPiResources(force = false): Promise<void> {
  if (state.piResourcesLoading || (state.piResources && !force)) return;
  state.piResourcesLoading = true;
  state.piResourcesError = "";
  render();
  try {
    const cwd = selectedSession()?.cwd || "/home/petur";
    const res = await fetch(`${extensionApiBase()}/api/pi-resources?cwd=${encodeURIComponent(cwd)}`);
    if (!res.ok) throw new Error(await res.text());
    state.piResources = await res.json() as PiResourcesPayload;
    state.selectedResourceKey ||= state.piResources.resources[0]?.key || "";
  } catch (error) {
    state.piResourcesError = error instanceof Error ? error.message : String(error);
  } finally {
    state.piResourcesLoading = false;
    render();
  }
}

function extractToolNames(raw: RawSessionEvents): ToolSparkItem[] {
  return raw.events
    .filter(event => event.kind === "tool_call" && event.name)
    .map(event => ({
      name: event.name || "tool",
      timestamp: event.timestamp,
      detail: toolTooltip(event),
    }))
    .slice(-16);
}

function toolTooltip(event: SessionEvent): string {
  const parts = [event.name || "tool"];
  if (event.timestamp) parts.push(relativeTime(event.timestamp));
  const summary = summarizeToolArguments(event.arguments);
  if (summary) parts.push(summary);
  return parts.join(" · ");
}

function summarizeToolArguments(args: unknown): string {
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

function extensionApiBase(): string {
  if (location.port === "5174") return location.origin;
  return `${location.protocol}//${location.hostname}:5174`;
}

async function loadSessionNames(): Promise<void> {
  try {
    const res = await fetch(`${extensionApiBase()}/api/session-names`);
    const contentType = res.headers.get("content-type") || "";
    if (!res.ok || !contentType.includes("application/json")) return;
    const payload = (await res.json()) as { names: Record<string, string> };
    state.sessionNames = payload.names || {};
  } catch {
    // Readable names are extension-local sugar; keep the monitor usable if the helper API is not available yet.
  }
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
    void loadSessionNames().then(() => render()).catch(() => render());
    render();
    void loadSelectedDetail();
    void loadRawEvents();
    void loadVisibleCardTools();
  });
  events.addEventListener("error", () => {
    state.status = "reconnecting";
    render();
  });
}

function disconnectEvents(): void {
  events?.close();
  events = null;
}

function sortSessions(sessions: SessionItem[]): SessionItem[] {
  return [...sessions].sort((a, b) => Date.parse(b.last_activity) - Date.parse(a.last_activity));
}

function matchesFilter(s: SessionItem): boolean {
  if (state.filter === "all") return true;
  return sessionTone(s) === state.filter;
}

function summarizeSessions(sessions: SessionItem[]): Record<SessionFilter, number> {
  const summary: Record<SessionFilter, number> = { all: sessions.length, working: 0, idle: 0, errored: 0 };
  for (const session of sessions) summary[sessionTone(session)] += 1;
  return summary;
}

function sessionTone(s: SessionItem): Exclude<SessionFilter, "all"> {
  const activity = s.activity.toLowerCase();
  if (activity.includes("error") || activity.includes("failed")) return "errored";
  if (activity.includes("idle") || activity.includes("waiting") || !s.is_active) return "idle";
  return "working";
}

function isLowFocusSession(s: SessionItem): boolean {
  return !s.is_active && minutesSince(s.last_activity) >= lowFocusAfterMinutes;
}

function minutesSince(value: string): number {
  const diff = Date.now() - Date.parse(value);
  if (!Number.isFinite(diff)) return 0;
  return diff / 60_000;
}

function statusLabel(s: SessionItem): string {
  const tone = sessionTone(s);
  if (tone === "errored") return "errored";
  if (tone === "idle") return s.is_active ? "waiting" : "idle";
  return "working";
}

function displaySessionName(s: SessionItem): string {
  return state.sessionNames[s.session_id] || s.custom_name || s.short_name || basename(s.cwd) || shortId(s.session_id);
}

function currentWork(s: SessionItem, detail: SessionDetail | null): { label: string; text: string } {
  if (sessionTone(s) === "errored") return { label: "last · failed", text: detail?.current_tool || s.activity || "error" };
  if (detail?.current_tool) return { label: "current", text: detail.current_tool };
  if (detail?.last_file_write) return { label: "last write", text: detail.last_file_write };
  return { label: s.is_active ? "current" : "last", text: s.activity || "waiting" };
}

function sparkline(s: SessionItem): string {
  const names = state.cardTools[s.session_id] || [];
  if (!names.length) return `<span class="spark-empty">loading…</span>`;
  return names.map((tool, i) => {
    const height = 18 + ((tool.name.length * 5 + i * 7) % 24);
    return `<i class="bar ${toolClass(tool.name)}" style="height:${height}px" data-tooltip="${escapeAttr(tool.detail)}" aria-label="${escapeAttr(tool.detail)}"></i>`;
  }).join("");
}

function toolClass(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("write") || lower.includes("edit")) return "write";
  if (lower.includes("read")) return "read";
  if (lower.includes("grep") || lower.includes("find")) return "grep";
  if (lower.includes("bash") || lower.includes("shell")) return "bash";
  return "msg";
}

function totalTokens(): number {
  return state.selectedDetail ? state.selectedDetail.input_tokens + state.selectedDetail.output_tokens : 0;
}

function totalCost(): number {
  return state.sessions.reduce((sum, session) => sum + (session.cost_usd || 0), 0);
}

function formatCompact(value: number): string {
  if (!value) return "0";
  if (value >= 1_000_000) return `${trimNumber(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trimNumber(value / 1_000)}K`;
  return String(value);
}

function trimNumber(value: number): string {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
}

function formatMoney(value: number): string {
  return `$${value.toFixed(value >= 10 ? 2 : 2)}`;
}

function relativeTime(value: string): string {
  const diff = Date.now() - Date.parse(value);
  if (!Number.isFinite(diff)) return "unknown";
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function compactPath(path: string): string {
  return path.replace(/^\/home\/[^/]+/, "~");
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() || path;
}

function shortId(id: string): string {
  return id.replaceAll("-", "").slice(0, 8);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] || char);
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

window.addEventListener("popstate", () => {
  state.view = initialView();
  render();
  if (state.view === "pi-resources") void loadPiResources();
});

render();
if (state.view === "pi-resources") void loadPiResources();
