import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { randomBytes, scryptSync, timingSafeEqual, createHmac, pbkdf2Sync } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const host = process.env.EXTENSION_HOST || "127.0.0.1";
const port = Number(process.env.EXTENSION_PORT || 5174);
const piSessionsDir = process.env.PI_SESSIONS_DIR || path.join(homedir(), ".pi", "agent", "sessions");
const maxEvents = Number(process.env.MAX_SESSION_EVENTS || 250);
const maxToolResultChars = Number(process.env.MAX_TOOL_RESULT_CHARS || 12_000);
const maxThinkingChars = Number(process.env.MAX_THINKING_CHARS || 2_000);
const sessionNamesFile = process.env.SESSION_NAMES_FILE || path.join(homedir(), ".pi", "lazyagent-extension", "session-names.json");
const dashboardSystemPromptFile = process.env.DASHBOARD_SYSTEM_PROMPT_FILE || path.join(homedir(), ".pi", "lazyagent-extension", "system-prompt.md");
const widgetDirs = (process.env.WIDGETS_DIR || path.join(projectRoot, "widgets")).split(path.delimiter).map(value => expandUserPath(value.trim())).filter(Boolean);
const widgetStateDir = process.env.WIDGET_STATE_DIR || path.join(homedir(), ".pi", "lazyagent-extension", "widgets");
const agentAppendSystemPrompt = process.env.AGENT_APPEND_SYSTEM_PROMPT || "";
const lazyagentUrl = (process.env.LAZYAGENT_URL || "http://127.0.0.1:7421").replace(/\/$/, "");
const lazyagentPassphrase = process.env.LAZYAGENT_API_PASSPHRASE || "";
let lazyagentBearerCache = null;
const dashboardPasswordHash = process.env.DASHBOARD_PASSWORD_HASH || "";
const dashboardAuthSecret = process.env.DASHBOARD_AUTH_SECRET || "";
const authEnabled = Boolean(dashboardPasswordHash && dashboardAuthSecret);
const authCookieName = process.env.DASHBOARD_AUTH_COOKIE || "lazyagent_dashboard_session";
const authSessionDays = Math.max(1, Number(process.env.DASHBOARD_AUTH_SESSION_DAYS || 30));
const authSecureCookies = parseBoolean(process.env.DASHBOARD_AUTH_SECURE_COOKIES, true);
const loginAttempts = new Map();
const tennisPlayers = [
  "Serena Williams", "Roger Federer", "Rafael Nadal", "Novak Djokovic", "Steffi Graf",
  "Martina Navratilova", "Billie Jean King", "Chris Evert", "Pete Sampras", "Björn Borg",
  "Rod Laver", "John McEnroe", "Andre Agassi", "Monica Seles", "Venus Williams",
  "Iga Świątek", "Carlos Alcaraz", "Jannik Sinner", "Coco Gauff", "Aryna Sabalenka"
];
const runs = new Map();
const gitInfoCache = new Map();
const gitInfoTtlMs = Math.max(30_000, Number(process.env.GIT_INFO_TTL_MS || 300_000));
const widgetsReady = loadWidgets();

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);
  setSecurityHeaders(req, res);
  if (req.method === "OPTIONS") {
    if (authEnabled && !sameOrigin(req)) {
      writeJson(res, 403, { error: "cross-origin request blocked" });
    } else {
      res.writeHead(204).end();
    }
    return;
  }

  try {
    if (req.method === "GET" && url.pathname === "/api/dashboard-auth/status") {
      writeJson(res, 200, { enabled: authEnabled, authenticated: !authEnabled || isAuthenticated(req) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/dashboard-auth/login") {
      const payload = await loginDashboard(req, res);
      writeJson(res, 200, payload);
      return;
    }

    if (authEnabled && !isAuthenticated(req)) {
      if (req.method === "GET" && acceptsHtml(req)) {
        serveLoginPage(res);
      } else {
        writeJson(res, 401, { error: "dashboard authentication required" });
      }
      return;
    }

    if (authEnabled) enforceSameOrigin(req);

    if (url.pathname.startsWith("/lazyagent/")) {
      await proxyLazyagent(req, res, url);
      return;
    }

    const widgets = await widgetsReady;

    if (req.method === "GET" && url.pathname === "/api/widgets") {
      writeJson(res, 200, { widgets: widgets.map(({ manifest }) => manifest) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/widgets/status") {
      writeJson(res, 200, { widgets: await widgetStatuses(widgets) });
      return;
    }

    if (url.pathname.startsWith("/api/widgets/")) {
      const handled = await handleWidgetApi(widgets, req, res, url);
      if (handled) return;
    }

    if (url.pathname.startsWith("/widgets/")) {
      const handled = await serveWidgetAsset(widgets, url.pathname, res);
      if (handled) return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/session-events/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/session-events/".length));
      const limit = parseLimit(url.searchParams.get("limit"));
      const payload = await sessionEvents(id, limit);
      writeJson(res, 200, payload);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/recent-sessions") {
      const hours = parseHours(url.searchParams.get("hours"), 12);
      writeJson(res, 200, { sessions: await recentLocalSessions(hours), hours });
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/session-summary/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/session-summary/".length));
      writeJson(res, 200, await localSessionDetail(id));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/directories") {
      const payload = await listDirectories(url.searchParams.get("path"));
      writeJson(res, 200, payload);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/session-names") {
      writeJson(res, 200, { names: await readSessionNames() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/pi-resources") {
      const payload = await piResources(url.searchParams.get("cwd"));
      writeJson(res, 200, payload);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/git-info") {
      const payload = await gitInfo(url.searchParams.get("cwd"));
      writeJson(res, 200, payload);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/system-prompt") {
      writeJson(res, 200, await systemPromptConfig(widgets));
      return;
    }

    if (req.method === "PUT" && url.pathname === "/api/system-prompt") {
      const body = await readJson(req);
      await writeDashboardSystemPrompt(body?.prompt);
      writeJson(res, 200, await systemPromptConfig(widgets));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/spend") {
      writeJson(res, 200, await spendSummary());
      return;
    }

    if ((req.method === "PATCH" || req.method === "POST") && url.pathname.startsWith("/api/session-names/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/session-names/".length));
      const body = await readJson(req);
      const payload = await renameSession(id, body);
      writeJson(res, 200, payload);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/agents/start") {
      const body = await readJson(req);
      const payload = await startAgent(body);
      writeJson(res, 202, payload);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/agents/message") {
      const body = await readJson(req);
      const payload = await sendAgentMessage(body);
      writeJson(res, 202, payload);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/agent-runs") {
      writeJson(res, 200, { runs: [...runs.values()].sort((a, b) => b.started_at.localeCompare(a.started_at)) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      writeJson(res, 200, { ok: true, piSessionsDir });
      return;
    }

    if (req.method === "GET") {
      const served = await serveStatic(url.pathname, res);
      if (served) return;
    }

    writeJson(res, 404, { error: "not found" });
  } catch (error) {
    writeJson(res, error.statusCode || 500, { error: error.message || String(error) });
  }
});

server.listen(port, host, () => {
  console.log(`lazyagent-extension backend listening on http://${host}:${port}`);
  console.log(`proxying lazyagent API from ${lazyagentUrl} at /lazyagent`);
  console.log(`dashboard password auth ${authEnabled ? "enabled" : "disabled (set DASHBOARD_PASSWORD_HASH and DASHBOARD_AUTH_SECRET for public access)"}`);
  console.log(`reading pi sessions from ${piSessionsDir}`);
  console.log(`loading widgets from ${widgetDirs.join(", ") || "(none)"}`);
});

async function startAgent(body) {
  const cwd = expandUserPath(String(body?.cwd || "").trim());
  const prompt = String(body?.prompt || "").trim();
  if (!cwd) throw httpError(400, "cwd is required");
  if (!prompt) throw httpError(400, "prompt is required");
  await assertDirectory(cwd);

  const sessionDir = sessionDirForCwd(cwd);
  await mkdir(sessionDir, { recursive: true });
  const args = await piRunArgs(["-p", "--session-dir", sessionDir]);
  if (body?.model) args.push("--model", String(body.model));
  if (body?.thinking) args.push("--thinking", String(body.thinking));
  if (body?.tools) args.push("--tools", String(body.tools));
  if (body?.readonly) args.push("--tools", "read,grep,find,ls");
  args.push(prompt);
  return spawnPiRun({ kind: "start", cwd, sessionDir, args, prompt });
}

async function sendAgentMessage(body) {
  const cwd = expandUserPath(String(body?.cwd || "").trim());
  const sessionId = String(body?.session_id || "").trim();
  const prompt = String(body?.prompt || "").trim();
  if (!cwd) throw httpError(400, "cwd is required");
  if (!sessionId) throw httpError(400, "session_id is required");
  if (!prompt) throw httpError(400, "prompt is required");
  if (!/^[A-Za-z0-9_.:T-]+$/.test(sessionId)) throw httpError(400, "invalid session id");
  await assertDirectory(cwd);

  const sessionFile = await findSessionFile(sessionId);
  const sessionDir = path.dirname(sessionFile);
  const args = await piRunArgs(["-p", "--session-dir", sessionDir, "--session", sessionFile]);
  args.push(prompt);
  return spawnPiRun({ kind: "message", cwd, sessionDir, args, prompt, sessionId });
}

async function piRunArgs(baseArgs) {
  const prompts = [];
  if (agentAppendSystemPrompt.trim()) prompts.push(agentAppendSystemPrompt.trim());
  const dashboardPrompt = await readDashboardSystemPrompt();
  if (dashboardPrompt.trim()) prompts.push(dashboardPrompt.trim());
  for (const widget of await widgetsReady) {
    const prompt = await widgetSystemPrompt(widget);
    if (prompt) prompts.push(prompt);
  }
  const args = [...baseArgs];
  for (const prompt of prompts) args.push("--append-system-prompt", prompt);
  return args;
}

async function widgetSystemPrompt(widget) {
  if (typeof widget.backend?.systemPrompt === "string") return widget.backend.systemPrompt.trim();
  if (typeof widget.backend?.systemPrompt === "function") {
    const prompt = await widget.backend.systemPrompt(widgetContext(widget));
    return typeof prompt === "string" ? prompt.trim() : "";
  }
  return "";
}

async function systemPromptConfig(widgets) {
  const widgetPrompts = [];
  for (const widget of widgets) {
    const prompt = await widgetSystemPrompt(widget);
    if (!prompt) continue;
    widgetPrompts.push({
      id: widget.manifest.id,
      name: widget.manifest.name || widget.manifest.id,
      prompt,
    });
  }
  return {
    prompt: await readDashboardSystemPrompt(),
    path: dashboardSystemPromptFile,
    env_prompt: agentAppendSystemPrompt,
    widgets: widgetPrompts,
  };
}

async function readDashboardSystemPrompt() {
  try {
    const content = await readFile(dashboardSystemPromptFile, "utf8");
    if (dashboardSystemPromptFile.endsWith(".json")) {
      const parsed = JSON.parse(content);
      return typeof parsed?.prompt === "string" ? parsed.prompt : "";
    }
    return content;
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

async function writeDashboardSystemPrompt(value) {
  const prompt = String(value || "");
  if (prompt.length > 40_000) throw httpError(400, "system prompt must be 40,000 characters or fewer");
  await mkdir(path.dirname(dashboardSystemPromptFile), { recursive: true });
  await writeFile(dashboardSystemPromptFile, prompt, "utf8");
}

function spawnPiRun({ kind, cwd, sessionDir, args, prompt, sessionId = "" }) {
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = new Date().toISOString();
  const run = {
    run_id: runId,
    kind,
    status: "running",
    cwd,
    session_dir: sessionDir,
    session_id: sessionId,
    prompt_preview: prompt.slice(0, 240),
    started_at: startedAt,
    finished_at: "",
    exit_code: null,
    stdout_tail: "",
    stderr_tail: "",
  };
  runs.set(runId, run);

  const child = spawn("pi", args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", chunk => run.stdout_tail = tail(run.stdout_tail + chunk.toString()));
  child.stderr.on("data", chunk => run.stderr_tail = tail(run.stderr_tail + chunk.toString()));
  child.on("error", error => {
    run.status = "error";
    run.finished_at = new Date().toISOString();
    run.stderr_tail = tail(`${run.stderr_tail}\n${error.message}`);
  });
  child.on("exit", code => {
    run.status = code === 0 ? "exited" : "failed";
    run.exit_code = code;
    run.finished_at = new Date().toISOString();
    void attachNewestSession(run, startedAt);
  });

  void attachNewestSession(run, startedAt);
  return run;
}

async function attachNewestSession(run, startedAt) {
  if (run.session_id) return;
  const deadline = Date.now() + 10_000;
  while (!run.session_id && Date.now() < deadline) {
    const newest = await newestSession(run.session_dir, startedAt).catch(() => null);
    if (newest) {
      run.session_id = newest.id;
      if (run.kind === "start") await assignDefaultSessionName(newest.id);
      return;
    }
    await sleep(300);
  }
}

async function newestSession(sessionDir, startedAt) {
  const files = await readdir(sessionDir, { withFileTypes: true });
  const candidates = [];
  for (const file of files) {
    if (!file.isFile() && !file.isSymbolicLink()) continue;
    if (!file.name.endsWith(".jsonl")) continue;
    const full = path.join(sessionDir, file.name);
    const info = await stat(full);
    if (info.mtimeMs + 5_000 < Date.parse(startedAt)) continue;
    candidates.push({ id: file.name.replace(/\.jsonl$/, ""), mtimeMs: info.mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0] || null;
}

function sessionDirForCwd(cwd) {
  const encoded = `--${cwd.replace(/^\/+/, "").replace(/\/+$/g, "").replaceAll("/", "-")}--`;
  return path.join(piSessionsDir, encoded);
}

async function assertDirectory(dir) {
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) throw httpError(400, `cwd is not a directory: ${dir}`);
}

function expandUserPath(value) {
  return path.resolve(value.replace(/^~(?=\/|$)/, homedir()));
}

async function assignDefaultSessionName(sessionId) {
  if (!/^[A-Za-z0-9_.:T-]+$/.test(sessionId)) return;
  const names = await readSessionNames();
  if (names[sessionId]) return;
  names[sessionId] = randomTennisPlayer(names);
  await writeSessionNames(names);
}

async function renameSession(sessionId, body) {
  if (!/^[A-Za-z0-9_.:T-]+$/.test(sessionId)) throw httpError(400, "invalid session id");
  const names = await readSessionNames();
  const name = body?.auto ? randomTennisPlayer(names) : String(body?.name || "").trim();
  if (name.length > 80) throw httpError(400, "name must be 80 characters or fewer");
  if (name) names[sessionId] = name;
  else delete names[sessionId];
  await writeSessionNames(names);
  return { session_id: sessionId, name: names[sessionId] || "", names };
}

async function readSessionNames() {
  try {
    const parsed = JSON.parse(await readFile(sessionNamesFile, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([id, name]) => /^[A-Za-z0-9_.:T-]+$/.test(id) && typeof name === "string"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeSessionNames(names) {
  await mkdir(path.dirname(sessionNamesFile), { recursive: true });
  await writeFile(sessionNamesFile, `${JSON.stringify(names, null, 2)}\n`, "utf8");
}

function randomTennisPlayer(names) {
  const used = new Set(Object.values(names));
  const available = tennisPlayers.filter(player => !used.has(player));
  const pool = available.length ? available : tennisPlayers;
  return pool[Math.floor(Math.random() * pool.length)];
}

async function listDirectories(requestedPath) {
  const fallback = path.join(homedir(), "coding");
  const target = path.resolve(String(requestedPath || fallback).replace(/^~(?=\/|$)/, homedir()));
  const info = await stat(target).catch(() => null);
  if (!info?.isDirectory()) throw httpError(400, `not a directory: ${target}`);

  const entries = await readdir(target, { withFileTypes: true });
  const directories = entries
    .filter(entry => entry.isDirectory())
    .map(entry => ({ name: entry.name, path: path.join(target, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    path: target,
    parent: path.dirname(target) === target ? "" : path.dirname(target),
    home: homedir(),
    entries: directories,
  };
}

async function piResources(requestedCwd) {
  const cwd = path.resolve(String(requestedCwd || process.cwd()).replace(/^~(?=\/|$)/, homedir()));
  const settingsFiles = [path.join(homedir(), ".pi", "agent", "settings.json"), path.join(cwd, ".pi", "settings.json")];
  const settings = await Promise.all(settingsFiles.map(readSettingsFile));
  const packageSpecs = settings.flatMap(item => Array.isArray(item.settings?.packages) ? item.settings.packages : []);
  const packages = await packageRoots(packageSpecs);
  const availablePackages = packages.filter(pkg => pkg.root && !pkg.missing);
  const skillRoots = [
    { scope: "global", root: path.join(homedir(), ".pi", "agent", "skills") },
    { scope: "global", root: path.join(homedir(), ".agents", "skills") },
    { scope: "project", root: path.join(cwd, ".pi", "skills") },
    { scope: "project", root: path.join(cwd, ".agents", "skills") },
    ...availablePackages.map(pkg => ({ scope: `package:${pkg.name}`, root: path.join(pkg.root, "skills") })),
  ];
  const extensionRoots = [
    { scope: "global", root: path.join(homedir(), ".pi", "agent", "extensions") },
    { scope: "project", root: path.join(cwd, ".pi", "extensions") },
    ...availablePackages.map(pkg => ({ scope: `package:${pkg.name}`, root: path.join(pkg.root, "extensions") })),
  ];

  const [skills, extensions] = await Promise.all([
    collectSkills(skillRoots),
    collectExtensions(extensionRoots),
  ]);

  return {
    cwd,
    generated_at: new Date().toISOString(),
    settings: settings.filter(item => item.exists),
    packages,
    resources: [...skills, ...extensions].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)),
  };
}

async function gitInfo(requestedCwd) {
  const cwd = path.resolve(String(requestedCwd || process.cwd()).replace(/^~(?=\/|$)/, homedir()));
  await assertDirectory(cwd);
  const cached = gitInfoCache.get(cwd);
  if (cached && Date.now() - cached.fetchedAt < gitInfoTtlMs) return { ...cached.payload, cached: true };

  const payload = await computeGitInfo(cwd);
  gitInfoCache.set(cwd, { fetchedAt: Date.now(), payload });
  return payload;
}

async function computeGitInfo(cwd) {
  const generatedAt = new Date().toISOString();
  const inside = (await git(cwd, ["rev-parse", "--is-inside-work-tree"]).catch(() => "")).trim() === "true";
  if (!inside) return { cwd, generated_at: generatedAt, is_git_repo: false, error: "not a git work tree" };

  const [topLevelRaw, branchRaw, commonDirRaw, gitDirRaw, statusRaw, diffRaw, stagedRaw, upstreamRaw, worktreesRaw] = await Promise.all([
    git(cwd, ["rev-parse", "--show-toplevel"]),
    git(cwd, ["branch", "--show-current"]).catch(() => ""),
    git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => ""),
    git(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"]).catch(() => ""),
    git(cwd, ["status", "--porcelain=v1"]).catch(() => ""),
    git(cwd, ["diff", "--shortstat"]).catch(() => ""),
    git(cwd, ["diff", "--cached", "--shortstat"]).catch(() => ""),
    git(cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]).catch(() => ""),
    git(cwd, ["worktree", "list", "--porcelain"]).catch(() => ""),
  ]);

  const root = topLevelRaw.trim();
  const worktrees = parseWorktrees(worktreesRaw);
  const currentWorktree = worktrees.find(item => item.path === root) || null;
  const upstream = parseAheadBehind(upstreamRaw);
  const status = parseGitStatus(statusRaw);
  const unstaged = parseShortstat(diffRaw);
  const staged = parseShortstat(stagedRaw);
  const commonDir = commonDirRaw.trim();
  const gitDir = gitDirRaw.trim();
  const mainWorktree = worktrees[0]?.path || root;
  const branch = branchRaw.trim() || currentWorktree?.branch?.replace(/^refs\/heads\//, "") || (currentWorktree?.detached ? "detached" : "");

  return {
    cwd,
    generated_at: generatedAt,
    is_git_repo: true,
    root,
    worktree: root,
    main_worktree: mainWorktree,
    is_worktree: Boolean(commonDir && gitDir && commonDir !== gitDir) || (worktrees.length > 1 && root !== mainWorktree),
    branch,
    upstream,
    status,
    diff: {
      files_changed: unstaged.files_changed + staged.files_changed,
      insertions: unstaged.insertions + staged.insertions,
      deletions: unstaged.deletions + staged.deletions,
      unstaged,
      staged,
    },
    worktrees: worktrees.length,
    cached: false,
  };
}

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = execFile("git", args, { cwd, timeout: 2500, maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.message = (stderr || error.message).trim();
        reject(error);
      } else {
        resolve(stdout);
      }
    });
    child.stdin?.end();
  });
}

function parseGitStatus(output) {
  const counts = { changed: 0, staged: 0, unstaged: 0, untracked: 0, added: 0, modified: 0, deleted: 0, renamed: 0, conflicted: 0 };
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const x = line[0];
    const y = line[1];
    counts.changed += 1;
    if (line.startsWith("??")) { counts.untracked += 1; continue; }
    if ("ADMRCT".includes(x)) counts.staged += 1;
    if ("ADMRCT".includes(y)) counts.unstaged += 1;
    if (x === "A" || y === "A") counts.added += 1;
    if (x === "M" || y === "M") counts.modified += 1;
    if (x === "D" || y === "D") counts.deleted += 1;
    if (x === "R" || y === "R") counts.renamed += 1;
    if (x === "U" || y === "U" || ("AD".includes(x) && "AD".includes(y))) counts.conflicted += 1;
  }
  return counts;
}

function parseShortstat(output) {
  const files = output.match(/(\d+) files? changed/);
  const insertions = output.match(/(\d+) insertions?\(\+\)/);
  const deletions = output.match(/(\d+) deletions?\(-\)/);
  return { files_changed: Number(files?.[1] || 0), insertions: Number(insertions?.[1] || 0), deletions: Number(deletions?.[1] || 0) };
}

function parseAheadBehind(output) {
  const [behind, ahead] = output.trim().split(/\s+/).map(value => Number(value));
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return { ahead: 0, behind: 0, has_upstream: false };
  return { ahead, behind, has_upstream: true };
}

function parseWorktrees(output) {
  const worktrees = [];
  let current = null;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      if (current) worktrees.push(current);
      current = null;
      continue;
    }
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ").trim();
    if (key === "worktree") current = { path: value, branch: "", detached: false, bare: false };
    else if (current && key === "branch") current.branch = value;
    else if (current && key === "detached") current.detached = true;
    else if (current && key === "bare") current.bare = true;
  }
  if (current) worktrees.push(current);
  return worktrees;
}

async function readSettingsFile(file) {
  try {
    const content = await readFile(file, "utf8");
    return { path: file, exists: true, settings: JSON.parse(content), content };
  } catch (error) {
    if (error.code === "ENOENT") return { path: file, exists: false, settings: null, content: "" };
    return { path: file, exists: true, settings: null, content: `Unable to read settings: ${error.message}` };
  }
}

async function packageRoots(specs) {
  const roots = [];
  for (const rawSpec of specs) {
    const spec = String(rawSpec || "").trim();
    if (!spec) continue;
    if (spec.startsWith("file:")) {
      const root = expandUserPath(spec.slice("file:".length));
      if (await isDirectory(root)) roots.push({ name: spec, root });
      continue;
    }
    if (spec.startsWith("npm:")) {
      const name = spec.slice("npm:".length);
      const root = await firstExistingDirectory(npmPackageCandidates(name));
      roots.push({ name: spec, root: root || "", missing: !root });
      continue;
    }
    if (spec.startsWith("github:") || spec.startsWith("git+")) {
      roots.push({ name: spec, root: "", missing: true });
    }
  }
  return roots;
}

function npmPackageCandidates(name) {
  const candidates = [];
  const nodeDir = path.dirname(process.execPath);
  candidates.push(path.resolve(nodeDir, "..", "lib", "node_modules", name));
  candidates.push(path.join(homedir(), ".nvm", "versions", "node", process.version, "lib", "node_modules", name));
  candidates.push(path.join("/usr/local/lib/node_modules", name));
  candidates.push(path.join("/opt/homebrew/lib/node_modules", name));
  return candidates;
}

async function firstExistingDirectory(candidates) {
  for (const candidate of candidates) {
    if (await isDirectory(candidate)) return candidate;
  }
  return "";
}

async function isDirectory(dir) {
  const info = await stat(dir).catch(() => null);
  return Boolean(info?.isDirectory());
}

async function collectSkills(roots) {
  const resources = [];
  for (const { scope, root } of roots) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const base = path.join(root, entry.name);
      const file = entry.isDirectory() ? path.join(base, "SKILL.md") : base;
      if (!file.endsWith(".md")) continue;
      const content = await readFile(file, "utf8").catch(() => "");
      if (!content) continue;
      const meta = parseFrontmatter(content);
      resources.push({
        key: `skill:${file}`,
        kind: "skill",
        scope,
        name: meta.name || entry.name.replace(/\.md$/, ""),
        description: meta.description || firstParagraph(content),
        path: file,
        root,
        content,
      });
    }
  }
  return resources;
}

async function collectExtensions(roots) {
  const resources = [];
  for (const { scope, root } of roots) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const base = path.join(root, entry.name);
      const file = entry.isDirectory() ? path.join(base, "index.ts") : base;
      if (!/\.(ts|js|mjs|cjs)$/.test(file)) continue;
      const content = await readFile(file, "utf8").catch(() => "");
      if (!content) continue;
      resources.push({
        key: `extension:${file}`,
        kind: "extension",
        scope,
        name: entry.isDirectory() ? entry.name : entry.name.replace(/\.(ts|js|mjs|cjs)$/, ""),
        description: extensionSummary(content),
        path: file,
        root,
        content,
      });
    }
  }
  return resources;
}

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (item) meta[item[1]] = item[2].replace(/^['"]|['"]$/g, "");
  }
  return meta;
}

function firstParagraph(content) {
  return content
    .replace(/^---\n[\s\S]*?\n---/, "")
    .split(/\n\s*\n/)
    .map(part => part.replace(/^#+\s*/gm, "").trim())
    .find(Boolean) || "";
}

function extensionSummary(content) {
  const description = content.match(/description\s*:\s*[`'"]([^`'"]+)/i);
  if (description) return description[1].trim();
  const comment = content.match(/\/\/\s*(.+)/);
  if (comment) return comment[1].trim();
  const exported = content.match(/export\s+default\s+[^({]*\(?\s*{?[\s\S]{0,400}?name\s*:\s*[`'"]([^`'"]+)/i);
  return exported ? `Extension ${exported[1].trim()}` : "Pi extension module";
}

function tail(value, max = 12_000) {
  return value.length > max ? value.slice(value.length - max) : value;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sessionEvents(sessionId, limit = maxEvents) {
  if (!/^[A-Za-z0-9_.:T-]+$/.test(sessionId)) throw httpError(400, "invalid session id");
  const file = await findSessionFile(sessionId);
  const text = await readFile(file, "utf8");
  const parsed = parseJsonl(text, file);
  return {
    session_id: sessionId,
    file,
    event_count: parsed.events.length,
    events: parsed.events.slice(-limit),
    truncated: parsed.events.length > limit,
  };
}

function parseLimit(value) {
  const parsed = Number(value || maxEvents);
  if (!Number.isFinite(parsed)) return maxEvents;
  return Math.min(Math.max(Math.floor(parsed), 1), 5000);
}

function parseHours(value, fallback) {
  const parsed = Number(value || fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), 1), 72);
}

async function findSessionFile(sessionId) {
  const projects = await readdir(piSessionsDir, { withFileTypes: true }).catch(() => []);
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const candidate = path.join(piSessionsDir, project.name, `${sessionId}.jsonl`);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // keep looking
    }
  }
  throw httpError(404, `session file not found for ${sessionId}`);
}

async function listSessionFiles() {
  const files = [];
  const projects = await readdir(piSessionsDir, { withFileTypes: true }).catch(() => []);
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = path.join(piSessionsDir, project.name);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

async function recentLocalSessions(hours = 12) {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const summaries = [];
  for (const file of await listSessionFiles()) {
    const info = await stat(file).catch(() => null);
    if (!info || info.mtimeMs < cutoff) continue;
    const summary = await summarizeLocalSessionFile(file, info);
    if (Date.parse(summary.last_activity) >= cutoff) summaries.push(summary);
  }
  summaries.sort((a, b) => Date.parse(b.last_activity) - Date.parse(a.last_activity));
  return summaries;
}

async function localSessionDetail(sessionId) {
  if (!/^[A-Za-z0-9_.:T-]+$/.test(sessionId)) throw httpError(400, "invalid session id");
  const file = await findSessionFile(sessionId);
  const info = await stat(file).catch(() => null);
  return summarizeLocalSessionFile(file, info, true);
}

async function summarizeLocalSessionFile(file, info, detail = false) {
  const sessionId = path.basename(file, ".jsonl");
  const parsed = parseJsonl(await readFile(file, "utf8").catch(() => ""), file);
  const sessionEvent = parsed.events.find(event => event.kind === "session");
  const cwd = sessionEvent?.cwd || decodeSessionDirName(path.basename(path.dirname(file)));
  const timestamps = parsed.events.map(event => Date.parse(event.timestamp || "")).filter(Number.isFinite);
  const lastActivity = new Date(timestamps.length ? Math.max(...timestamps) : (info?.mtimeMs || Date.now())).toISOString();
  const userMessages = parsed.events.filter(event => event.kind === "user").length;
  const assistantMessages = parsed.events.filter(event => event.kind === "assistant").length;
  const recentTools = parsed.events
    .filter(event => event.kind === "tool_call" && event.name)
    .slice(-12)
    .map(event => ({ name: event.name, timestamp: event.timestamp }));
  const recentMessages = parsed.events
    .filter(event => (event.kind === "user" || event.kind === "assistant") && event.text)
    .slice(-8)
    .map(event => ({ role: event.kind, text: event.text, timestamp: event.timestamp }));
  const base = {
    session_id: sessionId,
    source: "pi-session-log",
    cwd,
    short_name: path.basename(cwd) || sessionId.slice(0, 8),
    activity: "archived · idle",
    is_active: false,
    model: [...parsed.events].reverse().find(event => event.kind === "model")?.model || "",
    git_branch: "",
    cost_usd: 0,
    last_activity: lastActivity,
    total_messages: userMessages + assistantMessages,
  };
  if (!detail) return base;
  const lastTool = [...recentTools].reverse()[0];
  return {
    ...base,
    version: sessionEvent?.version || "",
    is_worktree: false,
    main_repo: "",
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    user_messages: userMessages,
    assistant_messages: assistantMessages,
    current_tool: lastTool?.name || "",
    last_file_write: "",
    last_file_write_at: "",
    recent_tools: recentTools,
    recent_messages: recentMessages,
    resume_command: `pi -p --session ${file}`,
  };
}

function decodeSessionDirName(name) {
  if (!name.startsWith("--") || !name.endsWith("--")) return path.join(piSessionsDir, name);
  return `/${name.slice(2, -2).replaceAll("-", "/")}`;
}

async function spendSummary(days = 14) {
  const keys = recentLocalDateKeys(days);
  const byDate = Object.fromEntries(keys.map(date => [date, { cost_usd: 0, tokens: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }]));
  const wanted = new Set(keys);
  for (const file of await listSessionFiles()) {
    const lines = (await readFile(file, "utf8").catch(() => "")).split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const usage = entry?.message?.usage ?? entry?.usage;
      const cost = usageCost(usage);
      const tokens = usageTokens(usage);
      if (!cost && !tokens.total) continue;
      const date = localDateKey(entry.timestamp || entry.message?.timestamp);
      if (!wanted.has(date)) continue;
      byDate[date].cost_usd += cost;
      byDate[date].tokens += tokens.total;
      byDate[date].input_tokens += tokens.input;
      byDate[date].output_tokens += tokens.output;
      byDate[date].cache_read_tokens += tokens.cacheRead;
      byDate[date].cache_write_tokens += tokens.cacheWrite;
    }
  }
  const daily = keys.map(date => ({
    date,
    cost_usd: roundMoney(byDate[date].cost_usd),
    tokens: byDate[date].tokens,
    input_tokens: byDate[date].input_tokens,
    output_tokens: byDate[date].output_tokens,
    cache_read_tokens: byDate[date].cache_read_tokens,
    cache_write_tokens: byDate[date].cache_write_tokens,
  }));
  const today = daily[daily.length - 1];
  return {
    generated_at: new Date().toISOString(),
    days,
    today: keys[keys.length - 1],
    today_usd: today?.cost_usd || 0,
    today_tokens: today?.tokens || 0,
    daily,
  };
}

function usageCost(usage) {
  if (!usage || typeof usage !== "object") return 0;
  const cost = usage.cost;
  const value = typeof cost === "number" ? cost : cost?.total ?? usage.cost_usd ?? usage.costUsd;
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function usageTokens(usage) {
  if (!usage || typeof usage !== "object") return { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const input = positiveInteger(usage.input ?? usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens);
  const output = positiveInteger(usage.output ?? usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens);
  const cacheRead = positiveInteger(usage.cacheRead ?? usage.cache_read ?? usage.cache_read_tokens ?? usage.cacheReadTokens);
  const cacheWrite = positiveInteger(usage.cacheWrite ?? usage.cache_write ?? usage.cache_creation_tokens ?? usage.cacheWriteTokens ?? usage.cacheCreationTokens);
  const total = positiveInteger(usage.totalTokens ?? usage.total_tokens ?? usage.total) || input + output + cacheRead + cacheWrite;
  return { total, input, output, cacheRead, cacheWrite };
}

function positiveInteger(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

function recentLocalDateKeys(days) {
  const keys = [];
  const cursor = new Date();
  cursor.setHours(12, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(cursor);
    day.setDate(cursor.getDate() - i);
    keys.push(formatLocalDate(day));
  }
  return keys;
}

function localDateKey(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? formatLocalDate(new Date()) : formatLocalDate(date);
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function roundMoney(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function parseJsonl(text, file) {
  const events = [];
  const lines = text.split(/\r?\n/).filter(Boolean);
  for (let index = 0; index < lines.length; index++) {
    let entry;
    try {
      entry = JSON.parse(lines[index]);
    } catch {
      events.push({ kind: "parse_error", line: index + 1, text: lines[index].slice(0, 500) });
      continue;
    }

    if (entry.type === "session") {
      events.push({ kind: "session", line: index + 1, timestamp: entry.timestamp, cwd: entry.cwd, version: entry.version, id: entry.id });
      continue;
    }
    if (entry.type === "model_change") {
      events.push({ kind: "model", line: index + 1, timestamp: entry.timestamp, provider: entry.provider, model: entry.modelId });
      continue;
    }
    if (entry.type === "thinking_level_change") {
      events.push({ kind: "thinking_level", line: index + 1, timestamp: entry.timestamp, level: entry.thinkingLevel });
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;

    const message = entry.message;
    const timestamp = entry.timestamp;
    const content = normalizeContent(message.content);

    if (message.role === "user") {
      for (const block of content) {
        if (block.type === "text" && block.text) events.push({ kind: "user", line: index + 1, timestamp, text: block.text });
      }
      continue;
    }

    if (message.role === "assistant") {
      for (const block of content) {
        if (block.type === "text" && block.text) {
          events.push({ kind: "assistant", line: index + 1, timestamp, text: block.text });
        } else if (block.type === "thinking" && block.thinking) {
          events.push({
            kind: "thinking",
            line: index + 1,
            timestamp,
            text: truncate(block.thinking, maxThinkingChars),
            truncated: block.thinking.length > maxThinkingChars,
          });
        } else if (block.type === "toolCall") {
          events.push({
            kind: "tool_call",
            line: index + 1,
            timestamp,
            id: block.id,
            name: block.name,
            arguments: block.arguments ?? null,
          });
        }
      }
      continue;
    }

    if (message.role === "toolResult") {
      const resultText = content.map(block => block.text || block.content || "").filter(Boolean).join("\n");
      events.push({
        kind: "tool_result",
        line: index + 1,
        timestamp,
        tool_call_id: message.toolCallId,
        tool_name: message.toolName,
        text: truncate(resultText, maxToolResultChars),
        truncated: resultText.length > maxToolResultChars,
      });
    }
  }
  return { file, events };
}

function normalizeContent(content) {
  if (!content) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content;
  return [];
}

function truncate(value, max) {
  if (typeof value !== "string" || value.length <= max) return value;
  return `${value.slice(0, max)}\n… truncated ${value.length - max} chars`;
}

async function loadWidgets() {
  const widgets = [];
  for (const dir of widgetDirs) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(error => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const root = path.join(dir, entry.name);
      const manifest = await readWidgetManifest(root).catch(error => {
        console.warn(`skipping widget ${root}: ${error.message}`);
        return null;
      });
      if (!manifest) continue;
      const backendFile = path.join(root, manifest.backend || "backend.js");
      const backend = await importIfExists(backendFile);
      widgets.push({ manifest, root, backend });
    }
  }
  return widgets;
}

async function readWidgetManifest(root) {
  const manifest = JSON.parse(await readFile(path.join(root, "widget.json"), "utf8"));
  if (!/^[a-z0-9][a-z0-9-]*$/.test(manifest.id || "")) throw new Error("widget id must be kebab-case");
  return {
    id: manifest.id,
    name: String(manifest.name || manifest.id),
    description: String(manifest.description || ""),
    version: String(manifest.version || "0.0.0"),
    slots: Array.isArray(manifest.slots) ? manifest.slots : [],
    entry: String(manifest.entry || "index.html"),
    backend: manifest.backend ? String(manifest.backend) : "backend.js",
  };
}

async function importIfExists(file) {
  try {
    await access(file);
    return import(`${pathToFileURL(file).href}?t=${Date.now()}`);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function widgetStatuses(widgets) {
  const statuses = [];
  for (const widget of widgets) {
    if (typeof widget.backend?.status !== "function") continue;
    statuses.push({ id: widget.manifest.id, ...(await widget.backend.status(widgetContext(widget))) });
  }
  return statuses;
}

async function handleWidgetApi(widgets, req, res, url) {
  const [, , , id, ...rest] = url.pathname.split("/");
  const widget = widgets.find(item => item.manifest.id === id);
  if (!widget) return false;
  if (typeof widget.backend?.handle !== "function") return false;
  const widgetUrl = new URL(url);
  widgetUrl.pathname = `/${rest.join("/")}`;
  return !!(await widget.backend.handle(req, res, widgetUrl, widgetContext(widget)));
}

async function serveWidgetAsset(widgets, requestPath, res) {
  const [, , id, ...rest] = requestPath.split("/");
  const widget = widgets.find(item => item.manifest.id === id);
  if (!widget) return false;
  const relative = rest.join("/") || widget.manifest.entry;
  const file = path.resolve(widget.root, relative);
  if (!file.startsWith(widget.root)) return false;
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
  } catch {
    return false;
  }
  res.writeHead(200, { "Content-Type": contentType(file) });
  createReadStream(file).pipe(res);
  return true;
}

function widgetContext(widget) {
  const stateDir = path.join(widgetStateDir, widget.manifest.id);
  return { stateDir, readJson, writeJson, httpError, sendAgentMessage, listAgentQuestionCandidates };
}

async function listAgentQuestionCandidates() {
  const candidates = [];
  const projects = await readdir(piSessionsDir, { withFileTypes: true }).catch(() => []);
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = path.join(piSessionsDir, project.name);
    const files = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const full = path.join(dir, file.name);
      const sessionId = file.name.replace(/\.jsonl$/, "");
      const parsed = parseJsonl(await readFile(full, "utf8"), full);
      const sessionEvent = parsed.events.find(event => event.kind === "session");
      for (const event of parsed.events) {
        if (event.kind !== "assistant" || !event.text) continue;
        for (const question of extractQuestionSchemas(event.text)) {
          candidates.push({
            id: `schema:${sessionId}:${event.line}:${stableHash(JSON.stringify(question))}`,
            session_id: sessionId,
            cwd: sessionEvent?.cwd || path.resolve(dir),
            question: question.question,
            details: question.details || "",
            options: question.options,
            created_at: event.timestamp || new Date().toISOString(),
            chat_answer: findChatAnswerAfterQuestion(parsed.events, event.line, question),
          });
        }
      }
    }
  }
  candidates.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  return candidates;
}

function extractQuestionSchemas(text) {
  const schemas = [];
  const fencePattern = /```(?:lazyagent-question|question-queue)\s*\n([\s\S]*?)```/gi;
  for (const match of text.matchAll(fencePattern)) {
    const parsed = parseQuestionSchema(match[1]);
    if (parsed) schemas.push(parsed);
  }
  return schemas;
}

function findChatAnswerAfterQuestion(events, line, question) {
  const createdAt = Date.parse(events.find(event => event.line === line)?.timestamp || "");
  const cutoff = Number.isFinite(createdAt) ? createdAt + 6 * 60 * 60 * 1000 : Infinity;
  for (const event of events) {
    if (event.kind !== "user" || !event.text || (event.line || 0) <= line) continue;
    const timestamp = Date.parse(event.timestamp || "");
    if (Number.isFinite(timestamp) && timestamp > cutoff) continue;
    if (looksLikeQuestionAnswer(event.text, question)) return { text: event.text, answered_at: event.timestamp || new Date().toISOString() };
  }
  return null;
}

function looksLikeQuestionAnswer(text, question) {
  const normalized = normalizeSearchText(text);
  if (!normalized) return false;
  const questionWords = significantWords(question.question).slice(0, 8);
  if (questionWords.length >= 5 && questionWords.every(word => normalized.includes(word))) return true;
  for (const option of question.options || []) {
    const value = normalizeSearchText(option.value || "");
    if (value.length >= 4 && normalized.includes(value)) return true;
    const words = significantWords(option.label || option.value || "").slice(0, 4);
    if (words.length >= 3 && words.every(word => normalized.includes(word))) return true;
  }
  return false;
}

function significantWords(value) {
  return normalizeSearchText(value)
    .split(/\s+/)
    .filter(word => word.length >= 4 && !new Set(["should", "only", "with", "this", "that", "from", "into", "including", "recommended"]).has(word));
}

function normalizeSearchText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9áéíóúýþæöð]+/gi, " ").trim();
}

function parseQuestionSchema(raw) {
  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed?.widget !== "question-queue" && parsed?.lazyagent_widget !== "question-queue") return null;
    const question = String(parsed.question || "").trim();
    const options = Array.isArray(parsed.options) ? parsed.options.map(normalizeQuestionOption).filter(Boolean) : [];
    if (!question || !options.length) return null;
    return { question, details: String(parsed.details || "").trim(), options };
  } catch {
    return null;
  }
}

function normalizeQuestionOption(option) {
  if (typeof option === "string") return { label: option, value: option };
  if (!option || typeof option !== "object") return null;
  const label = String(option.label || option.value || "").trim();
  const value = String(option.value || option.label || "").trim();
  if (!label || !value) return null;
  return { label, value, description: typeof option.description === "string" ? option.description : "" };
}

function stableHash(value) {
  let hash = 5381;
  for (let index = 0; index < value.length; index++) hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  return (hash >>> 0).toString(36);
}

async function proxyLazyagent(req, res, url) {
  const targetPath = url.pathname.slice("/lazyagent".length) || "/";
  const target = `${lazyagentUrl}${targetPath}${url.search}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (!value) continue;
    const lower = name.toLowerCase();
    if (["host", "connection", "cookie", "content-length"].includes(lower)) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  if (!headers.has("Authorization") && targetPath !== "/api/auth" && lazyagentPassphrase) {
    headers.set("Authorization", `Bearer ${await lazyagentBearerToken()}`);
  }

  const init = { method: req.method, headers };
  if (!['GET', 'HEAD'].includes(req.method || 'GET')) {
    init.body = await readRawBody(req);
  }

  const upstream = await fetch(target, init);
  const responseHeaders = {};
  for (const [name, value] of upstream.headers) {
    if (["connection", "content-encoding", "content-length", "transfer-encoding"].includes(name.toLowerCase())) continue;
    responseHeaders[name] = value;
  }
  res.writeHead(upstream.status, responseHeaders);
  if (!upstream.body) {
    res.end();
    return;
  }
  for await (const chunk of upstream.body) res.write(Buffer.from(chunk));
  res.end();
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function lazyagentBearerToken() {
  if (lazyagentBearerCache) return lazyagentBearerCache;
  const authRes = await fetch(`${lazyagentUrl}/api/auth`);
  if (!authRes.ok) throw httpError(502, "lazyagent auth unavailable");
  const auth = await authRes.json();
  lazyagentBearerCache = pbkdf2Sync(lazyagentPassphrase.trim(), auth.salt, auth.iterations, auth.key_length, "sha256").toString("base64url");
  return lazyagentBearerCache;
}

async function loginDashboard(req, res) {
  if (!authEnabled) return { ok: true, authenticated: true };
  const key = clientKey(req);
  const attempt = loginAttempts.get(key) || { count: 0, resetAt: 0 };
  if (attempt.resetAt > Date.now() && attempt.count >= 8) throw httpError(429, "too many login attempts; wait and try again");
  if (attempt.resetAt <= Date.now()) {
    attempt.count = 0;
    attempt.resetAt = Date.now() + 15 * 60 * 1000;
  }

  const body = await readJson(req);
  const password = String(body?.password || "");
  if (!verifyPassword(password, dashboardPasswordHash)) {
    attempt.count += 1;
    loginAttempts.set(key, attempt);
    throw httpError(401, "invalid password");
  }

  loginAttempts.delete(key);
  res.setHeader("Set-Cookie", serializeCookie(authCookieName, createAuthToken(), req));
  return { ok: true, authenticated: true };
}

function isAuthenticated(req) {
  const token = parseCookies(req.headers.cookie || "")[authCookieName];
  return Boolean(token && verifyAuthToken(token));
}

function createAuthToken() {
  const payload = Buffer.from(JSON.stringify({ iat: Date.now(), exp: Date.now() + authSessionDays * 86400_000, n: randomBytes(16).toString("base64url") })).toString("base64url");
  const signature = createHmac("sha256", dashboardAuthSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyAuthToken(token) {
  const [payload, signature] = String(token).split(".");
  if (!payload || !signature) return false;
  const expected = createHmac("sha256", dashboardAuthSecret).update(payload).digest("base64url");
  if (!safeEqual(signature, expected)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Number(parsed.exp) > Date.now();
  } catch {
    return false;
  }
}

function verifyPassword(password, encoded) {
  try {
    const parts = String(encoded).split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [, n, r, p, saltRaw, hashRaw] = parts;
    const hash = Buffer.from(hashRaw, "base64url");
    const derived = scryptSync(password, Buffer.from(saltRaw, "base64url"), hash.length, { N: Number(n), r: Number(r), p: Number(p) });
    return safeEqual(derived, hash);
  } catch {
    return false;
  }
}

function safeEqual(left, right) {
  const a = Buffer.isBuffer(left) ? left : Buffer.from(String(left));
  const b = Buffer.isBuffer(right) ? right : Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseCookies(header) {
  const cookies = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

function serializeCookie(name, value, req) {
  const secure = authSecureCookies && requestIsHttps(req);
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${authSessionDays * 86400}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function requestIsHttps(req) {
  return req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted;
}

function acceptsHtml(req) {
  return String(req.headers.accept || "").includes("text/html") || String(req.url || "/") === "/";
}

function clientKey(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function enforceSameOrigin(req) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method || "")) return;
  if (!sameOrigin(req)) throw httpError(403, "cross-origin write blocked");
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const expected = `${requestIsHttps(req) ? "https" : "http"}://${req.headers.host}`;
  return origin === expected;
}

function parseBoolean(value, fallback) {
  if (value == null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function serveLoginPage(res) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lazyagent Dashboard Login</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#09090b;color:#fafafa;font:16px system-ui,sans-serif}.card{width:min(92vw,420px);padding:28px;border:1px solid #27272a;border-radius:18px;background:#18181b;box-shadow:0 24px 80px #0008}h1{margin:0 0 8px;font-size:24px}p{color:#a1a1aa}input,button{width:100%;box-sizing:border-box;border-radius:12px;padding:12px 14px;font:inherit}input{border:1px solid #3f3f46;background:#09090b;color:#fff}button{margin-top:14px;border:0;background:#84cc16;color:#111827;font-weight:700;cursor:pointer}.error{min-height:22px;color:#fb7185}</style></head><body><form class="card"><h1>Lazyagent Dashboard</h1><p>Enter the dashboard password for this device.</p><input name="password" type="password" autocomplete="current-password" autofocus required><button>Unlock</button><p class="error" role="alert"></p></form><script>const f=document.querySelector('form'),e=document.querySelector('.error');f.addEventListener('submit',async ev=>{ev.preventDefault();e.textContent='';const r=await fetch('/api/dashboard-auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:f.password.value})});if(r.ok) location.reload(); else e.textContent='Invalid password or too many attempts.'});</script></body></html>`);
}

async function serveStatic(requestPath, res) {
  if (requestPath.startsWith("/api/")) return false;
  const root = path.join(projectRoot, "dist");
  const safePath = requestPath === "/" ? "/index.html" : requestPath;
  const file = path.resolve(root, `.${safePath}`);
  if (!file.startsWith(root)) return false;
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
  } catch {
    if (requestPath !== "/index.html") return serveStatic("/index.html", res);
    return false;
  }
  res.writeHead(200, { "Content-Type": contentType(file) });
  createReadStream(file).pipe(res);
  return true;
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, "invalid JSON body");
  }
}

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function setSecurityHeaders(req, res) {
  const requestPath = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`).pathname;
  const widgetFrame = requestPath.startsWith("/widgets/");
  res.setHeader("X-Frame-Options", widgetFrame ? "SAMEORIGIN" : "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "connect-src 'self'",
    "frame-src 'self'",
    "img-src 'self' data:",
    "media-src 'self' blob:",
    "base-uri 'none'",
    `frame-ancestors ${widgetFrame ? "'self'" : "'none'"}`,
  ].join("; "));
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (!authEnabled) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (sameOrigin(req) && req.headers.origin) {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
    res.setHeader("Vary", "Origin");
  }
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
