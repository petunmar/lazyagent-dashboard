import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const systemPrompt = `This Agent Monitor installation has a Question Queue Widget for dashboard-mediated user questions.

If you need input from the user, do not call an interactive question tool. Instead, write exactly one fenced lazyagent-question block and then stop. The widget imports only this explicit schema from assistant transcript text and will send the user's selected answer back as a follow-up message.

Use this schema:

\`\`\`lazyagent-question
{"widget":"question-queue","question":"What do you want to ask?","details":"Optional context for the user.","options":[{"label":"Option shown to the user","value":"value-sent-back"}]}
\`\`\`

Rules: include at least one option; keep values short and stable; do not also restate the question outside the fenced block; after writing the block, wait for the dashboard follow-up unless you can continue safely without the answer.`;

export async function status(context) {
  const questions = await syncedQuestions(context);
  const pending = questions.filter(question => question.status === "pending");
  return {
    pending: pending.length,
    session_highlights: [...new Set(pending.map(question => question.session_id).filter(Boolean))],
  };
}

export async function handle(req, res, url, context) {
  if (req.method === "GET" && url.pathname === "/questions") {
    context.writeJson(res, 200, { questions: await syncedQuestions(context) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/questions") {
    const body = await context.readJson(req);
    const question = await createQuestion(context.stateDir, body, context.httpError);
    context.writeJson(res, 201, { question });
    return true;
  }

  const answerMatch = url.pathname.match(/^\/questions\/([^/]+)\/answer$/);
  if (req.method === "POST" && answerMatch) {
    const body = await context.readJson(req);
    const question = await answerQuestion(context, decodeURIComponent(answerMatch[1]), body);
    context.writeJson(res, 200, { question });
    return true;
  }

  return false;
}

async function syncedQuestions(context) {
  const storedQuestions = await readQuestions(context.stateDir);
  const questions = storedQuestions.filter(question => question.source !== "ask_user_question");
  const existing = new Set(questions.map(question => question.id));
  const candidates = typeof context.listAgentQuestionCandidates === "function" ? await context.listAgentQuestionCandidates() : [];
  let changed = false;
  for (const candidate of candidates) {
    if (existing.has(candidate.id)) continue;
    questions.unshift({
      id: candidate.id,
      session_id: candidate.session_id,
      cwd: candidate.cwd,
      question: candidate.question,
      details: candidate.details || "",
      options: candidate.options || [],
      status: "pending",
      answer: "",
      created_at: candidate.created_at,
      answered_at: "",
      source: "question_schema",
    });
    existing.add(candidate.id);
    changed = true;
  }
  questions.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  if (changed || questions.length !== storedQuestions.length) await writeQuestions(context.stateDir, questions);
  return questions;
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

async function answerQuestion(context, id, body) {
  await syncedQuestions(context);
  const answer = String(body?.answer || "").trim();
  if (!answer) throw context.httpError(400, "answer is required");

  const questions = await readQuestions(context.stateDir);
  const question = questions.find(item => item.id === id);
  if (!question) throw context.httpError(404, "question not found");
  if (question.status !== "answered") {
    question.status = "answered";
    question.answer = answer;
    question.answered_at = new Date().toISOString();
    await context.sendAgentMessage({
      cwd: question.cwd,
      session_id: question.session_id,
      prompt: `Answer to your pending question:\n\nQuestion: ${question.question}\n\nAnswer: ${answer}`,
    });
    await writeQuestions(context.stateDir, questions);
  }
  return question;
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
  await mkdir(stateDir, { recursive: true });
  await writeFile(storeFile(stateDir), `${JSON.stringify(questions.slice(0, 200), null, 2)}\n`);
}

function storeFile(stateDir) {
  return path.join(stateDir, "questions.json");
}

function isQuestion(value) {
  return value && typeof value.id === "string" && typeof value.session_id === "string" && typeof value.question === "string";
}
