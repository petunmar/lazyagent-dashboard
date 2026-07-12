import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY || "";
const elevenLabsVoiceName = process.env.ELEVENLABS_VOICE_NAME || "Bradford";
const elevenLabsVoiceIdOverride = process.env.ELEVENLABS_VOICE_ID || "";
const elevenLabsTtsModel = process.env.ELEVENLABS_TTS_MODEL || "eleven_flash_v2_5";
const elevenLabsSttModel = process.env.ELEVENLABS_STT_MODEL || "scribe_v1";
let resolvedVoiceId = "";
const stateOperations = new Map();

export const systemPrompt = `This Agent Monitor installation has a Question Queue Widget for dashboard-mediated user questions.

If you need input from the user, do not call an interactive question tool. Instead, write exactly one fenced lazyagent-question block and then stop. The widget imports only this explicit schema from assistant transcript text and will send the user's selected answer back as a follow-up message.

Use this schema:

\`\`\`lazyagent-question
{"widget":"question-queue","question":"What do you want to ask?","details":"Optional context for the user.","options":[{"label":"Option shown to the user","value":"value-sent-back"}]}
\`\`\`

Rules: include at least one option; keep values short and stable; do not also restate the question outside the fenced block; after writing the block, wait for the dashboard follow-up unless you can continue safely without the answer.`;

export async function status(context) {
  return withStateLock(context.stateDir, async () => {
    const questions = await syncedQuestions(context);
    const pending = questions.filter(question => question.status === "pending");
    return {
      pending: pending.length,
      session_highlights: [...new Set(pending.map(question => question.session_id).filter(Boolean))],
    };
  });
}

export async function handle(req, res, url, context) {
  if (req.method === "GET" && url.pathname === "/questions") {
    const questions = await withStateLock(context.stateDir, () => syncedQuestions(context));
    context.writeJson(res, 200, { questions });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/questions") {
    const body = await context.readJson(req);
    const question = await withStateLock(context.stateDir, () => createQuestion(context.stateDir, body, context.httpError));
    context.writeJson(res, 201, { question });
    return true;
  }

  const dismissMatch = url.pathname.match(/^\/questions\/([^/]+)\/dismiss$/);
  if (req.method === "POST" && dismissMatch) {
    const id = decodeQuestionId(dismissMatch[1], context.httpError);
    const question = await withStateLock(context.stateDir, () => dismissQuestion(context, id));
    context.writeJson(res, 200, { question });
    return true;
  }

  const answerMatch = url.pathname.match(/^\/questions\/([^/]+)\/answer$/);
  if (req.method === "POST" && answerMatch) {
    const body = await context.readJson(req);
    const id = decodeQuestionId(answerMatch[1], context.httpError);
    const question = await withStateLock(context.stateDir, () => answerQuestion(context, id, body));
    context.writeJson(res, 200, { question });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/voice/config") {
    context.writeJson(res, 200, {
      enabled: Boolean(elevenLabsApiKey),
      voice_name: elevenLabsVoiceName,
      voice_id_configured: Boolean(elevenLabsVoiceIdOverride),
      tts_model: elevenLabsTtsModel,
      stt_model: elevenLabsSttModel,
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/voice/speak") {
    await speakQuestion(req, res, context);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/voice/transcribe") {
    await transcribeAudio(req, res, context);
    return true;
  }

  return false;
}

function decodeQuestionId(value, httpError) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw httpError(400, "question id is malformed");
  }
}

async function withStateLock(stateDir, operation) {
  const previous = stateOperations.get(stateDir) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  stateOperations.set(stateDir, current);
  try {
    return await current;
  } finally {
    if (stateOperations.get(stateDir) === current) stateOperations.delete(stateDir);
  }
}

async function syncedQuestions(context) {
  const storedQuestions = await readQuestions(context.stateDir);
  // Keep dismissed legacy records as tombstones even though ask_user_question imports are no longer shown.
  const questions = storedQuestions.filter(question => question.source !== "ask_user_question" || question.status === "dismissed");
  const tombstones = await readQuestionTombstones(context.stateDir);
  const candidates = typeof context.listAgentSessionTranscripts === "function" ? await listQuestionCandidates(context) : [];
  let changed = false;
  for (const candidate of candidates) {
    const stored = questions.find(question => question.id === candidate.id);
    if (stored) {
      if (stored.status === "pending" && !stored.answer && candidate.chat_answer?.text) {
        stored.status = "answered";
        stored.answer = candidate.chat_answer.text;
        stored.answered_at = candidate.chat_answer.answered_at || new Date().toISOString();
        stored.source = "question_schema_chat_answer";
        changed = true;
      }
      continue;
    }
    if (tombstones.has(candidate.id)) continue;
    questions.unshift({
      id: candidate.id,
      session_id: candidate.session_id,
      cwd: candidate.cwd,
      question: candidate.question,
      details: candidate.details || "",
      options: candidate.options || [],
      status: candidate.chat_answer?.text ? "answered" : "pending",
      answer: candidate.chat_answer?.text || "",
      created_at: candidate.created_at,
      answered_at: candidate.chat_answer?.answered_at || "",
      source: candidate.chat_answer?.text ? "question_schema_chat_answer" : "question_schema",
    });
    changed = true;
  }
  questions.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const needsRetention = questions.filter(question => question.status === "answered").length > 200;
  if (changed || questions.length !== storedQuestions.length || needsRetention) {
    await writeQuestions(context.stateDir, questions);
    return readQuestions(context.stateDir);
  }
  return questions;
}

async function listQuestionCandidates(context) {
  const candidates = [];
  for (const transcript of await context.listAgentSessionTranscripts()) {
    for (const event of transcript.events || []) {
      if (event.kind !== "assistant" || !event.text) continue;
      for (const question of extractQuestionSchemas(event.text)) {
        candidates.push({
          id: `schema:${transcript.session_id}:${event.line}:${stableHash(JSON.stringify(question))}`,
          session_id: transcript.session_id,
          cwd: transcript.cwd,
          question: question.question,
          details: question.details || "",
          options: question.options,
          created_at: event.timestamp || new Date().toISOString(),
          chat_answer: findChatAnswerAfterQuestion(transcript.events, event.line, question),
        });
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

async function createQuestion(stateDir, body, httpError) {
  const sessionId = String(body?.session_id || "").trim();
  const cwd = String(body?.cwd || "").trim();
  const text = String(body?.question || body?.text || "").trim();
  if (!sessionId) throw httpError(400, "session_id is required");
  if (!cwd) throw httpError(400, "cwd is required");
  if (!text) throw httpError(400, "question is required");

  const questions = await readQuestions(stateDir);
  const now = new Date().toISOString();
  const question = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    session_id: sessionId,
    cwd,
    question: text,
    details: String(body?.details || "").trim(),
    options: Array.isArray(body?.options) ? body.options : [],
    status: "pending",
    answer: "",
    created_at: now,
    answered_at: "",
  };
  questions.unshift(question);
  await writeQuestions(stateDir, questions);
  return question;
}

async function dismissQuestion(context, id) {
  await syncedQuestions(context);
  const questions = await readQuestions(context.stateDir);
  const question = questions.find(item => item.id === id);
  if (!question) throw context.httpError(404, "question not found");
  if (question.status === "dismissed") return question;
  if (question.status !== "pending") throw context.httpError(409, "only pending questions can be dismissed");

  question.status = "dismissed";
  question.dismissed_at = new Date().toISOString();
  await writeQuestions(context.stateDir, questions);
  return question;
}

async function answerQuestion(context, id, body) {
  await syncedQuestions(context);
  const questions = await readQuestions(context.stateDir);
  const question = questions.find(item => item.id === id);
  if (!question) throw context.httpError(404, "question not found");
  if (question.status === "dismissed") throw context.httpError(409, "dismissed questions cannot be answered");
  if (question.status === "answered") return question;
  if (question.status !== "pending") throw context.httpError(409, "question is not pending");

  const answer = String(body?.answer || "").trim();
  if (!answer) throw context.httpError(400, "answer is required");
  question.status = "answered";
  question.answer = answer;
  question.answered_at = new Date().toISOString();
  await context.sendAgentMessage({
    cwd: question.cwd,
    session_id: question.session_id,
    prompt: `Answer to your pending question:\n\nQuestion: ${question.question}\n\nAnswer: ${answer}`,
  });
  await writeQuestions(context.stateDir, questions);
  return question;
}

async function speakQuestion(req, res, context) {
  requireElevenLabs(context);
  const body = await context.readJson(req);
  const text = String(body?.text || "").trim();
  if (!text) throw context.httpError(400, "text is required");
  if (text.length > 1200) throw context.httpError(400, "text is too long");

  const voiceId = await elevenLabsVoiceId(context);
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
    method: "POST",
    headers: {
      "xi-api-key": elevenLabsApiKey,
      "Content-Type": "application/json",
      "Accept": "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: elevenLabsTtsModel,
      voice_settings: {
        stability: 0.48,
        similarity_boost: 0.78,
        style: 0.18,
        use_speaker_boost: false,
      },
    }),
  });
  if (!response.ok) throw context.httpError(response.status, await elevenLabsError(response));
  const audio = Buffer.from(await response.arrayBuffer());
  res.writeHead(200, {
    "Content-Type": response.headers.get("content-type") || "audio/mpeg",
    "Cache-Control": "no-store",
  });
  res.end(audio);
}

async function transcribeAudio(req, res, context) {
  requireElevenLabs(context);
  const audio = await readRequestBuffer(req, 15 * 1024 * 1024, context);
  if (!audio.length) throw context.httpError(400, "audio body is required");
  const contentType = String(req.headers["content-type"] || "audio/webm").split(";")[0] || "audio/webm";
  const extension = contentType.includes("ogg") ? "ogg" : contentType.includes("mp4") ? "mp4" : contentType.includes("mpeg") ? "mp3" : "webm";
  const form = new FormData();
  form.append("model_id", elevenLabsSttModel);
  form.append("file", new Blob([audio], { type: contentType }), `answer.${extension}`);

  const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": elevenLabsApiKey, "Accept": "application/json" },
    body: form,
  });
  if (!response.ok) throw context.httpError(response.status, await elevenLabsError(response));
  const transcript = await response.json();
  context.writeJson(res, 200, { text: String(transcript?.text || "").trim(), transcript });
}

function requireElevenLabs(context) {
  if (!elevenLabsApiKey) throw context.httpError(503, "ELEVENLABS_API_KEY is not configured");
}

async function elevenLabsVoiceId(context) {
  if (elevenLabsVoiceIdOverride) return elevenLabsVoiceIdOverride;
  if (resolvedVoiceId) return resolvedVoiceId;
  const response = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": elevenLabsApiKey, "Accept": "application/json" },
  });
  if (!response.ok) throw context.httpError(response.status, await elevenLabsError(response));
  const data = await response.json();
  const voices = Array.isArray(data?.voices) ? data.voices : [];
  const voice = voices.find(item => String(item?.name || "").toLowerCase() === elevenLabsVoiceName.toLowerCase())
    || voices.find(item => String(item?.name || "").toLowerCase().includes(elevenLabsVoiceName.toLowerCase()));
  if (!voice?.voice_id) throw context.httpError(503, `ElevenLabs voice '${elevenLabsVoiceName}' was not found; set ELEVENLABS_VOICE_ID to its voice id`);
  resolvedVoiceId = voice.voice_id;
  return resolvedVoiceId;
}

async function elevenLabsError(response) {
  const text = await response.text().catch(() => "");
  try {
    const json = JSON.parse(text);
    return json?.detail?.message || json?.detail || json?.message || text || `ElevenLabs request failed (${response.status})`;
  } catch {
    return text || `ElevenLabs request failed (${response.status})`;
  }
}

async function readRequestBuffer(req, maxBytes, context) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw context.httpError(413, "audio body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readQuestions(stateDir) {
  try {
    const parsed = JSON.parse(await readFile(storeFile(stateDir), "utf8"));
    return Array.isArray(parsed) ? parsed.filter(isQuestion) : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeQuestions(stateDir, questions) {
  const retained = [];
  const droppedAnsweredIds = [];
  let answeredCount = 0;
  for (const question of questions) {
    if (question.status === "answered") {
      answeredCount += 1;
      if (answeredCount > 200) {
        droppedAnsweredIds.push(question.id);
        continue;
      }
    }
    retained.push(question);
  }

  await mkdir(stateDir, { recursive: true });
  if (droppedAnsweredIds.length) {
    const tombstones = await readQuestionTombstones(stateDir);
    for (const id of droppedAnsweredIds) tombstones.add(id);
    // Write suppression IDs first, so an interrupted retention write cannot re-import old transcripts.
    await atomicWriteJson(tombstoneFile(stateDir), [...tombstones]);
  }
  await atomicWriteJson(storeFile(stateDir), retained);
}

async function readQuestionTombstones(stateDir) {
  try {
    const parsed = JSON.parse(await readFile(tombstoneFile(stateDir), "utf8"));
    return new Set(Array.isArray(parsed) ? parsed.filter(id => typeof id === "string") : []);
  } catch (error) {
    if (error.code === "ENOENT") return new Set();
    throw error;
  }
}

async function atomicWriteJson(file, value) {
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}

function storeFile(stateDir) {
  return path.join(stateDir, "questions.json");
}

function tombstoneFile(stateDir) {
  return path.join(stateDir, "question-tombstones.json");
}

function isQuestion(value) {
  return value && typeof value.id === "string" && typeof value.session_id === "string" && typeof value.question === "string";
}
