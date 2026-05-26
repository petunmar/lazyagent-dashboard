import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const host = process.env.EXTENSION_HOST || "127.0.0.1";
const port = Number(process.env.EXTENSION_PORT || 5174);
const piSessionsDir = process.env.PI_SESSIONS_DIR || path.join(homedir(), ".pi", "agent", "sessions");
const maxEvents = Number(process.env.MAX_SESSION_EVENTS || 250);
const maxToolResultChars = Number(process.env.MAX_TOOL_RESULT_CHARS || 12_000);
const maxThinkingChars = Number(process.env.MAX_THINKING_CHARS || 2_000);
const sessionNamesFile = process.env.SESSION_NAMES_FILE || path.join(homedir(), ".pi", "lazyagent-extension", "session-names.json");
const tennisPlayers = [
  "Serena Williams", "Roger Federer", "Rafael Nadal", "Novak Djokovic", "Steffi Graf",
  "Martina Navratilova", "Billie Jean King", "Chris Evert", "Pete Sampras", "Björn Borg",
  "Rod Laver", "John McEnroe", "Andre Agassi", "Monica Seles", "Venus Williams",
  "Iga Świątek", "Carlos Alcaraz", "Jannik Sinner", "Coco Gauff", "Aryna Sabalenka"
];
const runs = new Map();

const server = createServer(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);

  try {
    if (req.method === "GET" && url.pathname.startsWith("/api/session-events/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/session-events/".length));
      const limit = parseLimit(url.searchParams.get("limit"));
      const payload = await sessionEvents(id, limit);
      writeJson(res, 200, payload);
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
  console.log(`reading pi sessions from ${piSessionsDir}`);
});

async function startAgent(body) {
  const cwd = expandUserPath(String(body?.cwd || "").trim());
  const prompt = String(body?.prompt || "").trim();
  if (!cwd) throw httpError(400, "cwd is required");
  if (!prompt) throw httpError(400, "prompt is required");
  await assertDirectory(cwd);

  const sessionDir = sessionDirForCwd(cwd);
  await mkdir(sessionDir, { recursive: true });
  const args = ["-p", "--session-dir", sessionDir];
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
  const args = ["-p", "--session-dir", sessionDir, "--session", sessionFile, prompt];
  return spawnPiRun({ kind: "message", cwd, sessionDir, args, prompt, sessionId });
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

async function serveStatic(requestPath, res) {
  if (requestPath.startsWith("/api/")) return false;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist");
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

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
