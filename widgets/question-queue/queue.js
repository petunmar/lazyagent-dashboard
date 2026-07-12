const params = new URLSearchParams(location.search);
const slot = params.get("slot") || "dashboard:top";
const sessionId = params.get("session_id") || "";
const list = document.querySelector("#questions");
const empty = document.querySelector("#empty");
const badge = document.querySelector("#badge");
const heading = document.querySelector("#queue-heading");
const queueStatus = document.querySelector("#queue-status");
const header = document.querySelector(".queue-shell > header");
const drafts = new Map();
const busyQuestionIds = new Set();

let pendingQuestions = [];
let voiceConfig = { enabled: false };
let voiceMode = false;
let activeVoiceQuestionId = "";
let mediaRecorder = null;
let recordedChunks = [];
let activeAudio = null;
let voicePhase = "idle";
let heardText = "";
let statusText = "Voice mode is ready.";
let voiceOperation = 0;
let loadOperation = 0;

const voiceControls = document.createElement("div");
voiceControls.className = "voice-controls";
header.append(voiceControls);

async function load() {
  const operation = ++loadOperation;
  const response = await fetch("/api/widgets/question-queue/questions");
  const { questions } = await response.json();
  if (operation !== loadOperation) return;
  const scoped = slot.startsWith("detail:") && sessionId ? questions.filter(question => question.session_id === sessionId) : questions;
  pendingQuestions = scoped.filter(question => question.status === "pending");
  if (voiceMode && activeVoiceQuestionId && !pendingQuestions.some(question => question.id === activeVoiceQuestionId)) {
    const removedId = activeVoiceQuestionId;
    cancelActiveVoiceFlow();
    advanceVoiceQueue(removedId);
    return;
  }
  render(pendingQuestions);
}

async function loadVoiceConfig() {
  try {
    const response = await fetch("/api/widgets/question-queue/voice/config");
    voiceConfig = await response.json();
  } catch {
    voiceConfig = { enabled: false };
  }
}

function render(questions) {
  badge.textContent = `${questions.length} pending`;
  empty.hidden = questions.length > 0;
  document.body.classList.toggle("is-empty", questions.length === 0 && !voiceMode);
  renderVoiceControls();
  const activeElement = document.activeElement;
  const focusedQuestion = activeElement?.closest?.("[data-question-id]")?.dataset.questionId || "";
  const nextIds = new Set(questions.slice(0, 8).map(question => question.id));

  for (const existing of [...list.querySelectorAll("[data-question-id]")]) {
    if (!nextIds.has(existing.dataset.questionId)) existing.remove();
  }

  for (const question of questions.slice(0, 8)) {
    const existing = list.querySelector(`[data-question-id="${cssEscape(question.id)}"]`);
    if (existing && question.id === focusedQuestion && question.status === "pending" && !(voiceMode && question.id === activeVoiceQuestionId)) continue;
    const rendered = renderQuestion(question);
    if (existing) existing.replaceWith(rendered);
    else list.append(rendered);
  }
  notifyHeight();
}

function renderVoiceControls() {
  voiceControls.innerHTML = "";
  const button = document.createElement("button");
  button.type = "button";
  button.className = voiceMode ? "voice-toggle active" : "voice-toggle";
  button.textContent = voiceMode ? "exit voice" : "voice mode";
  button.disabled = !voiceConfig.enabled;
  button.addEventListener("click", () => voiceMode ? exitVoiceMode() : enterVoiceMode());
  voiceControls.append(button);

  if (!voiceConfig.enabled) {
    const hint = document.createElement("span");
    hint.className = "voice-hint";
    hint.textContent = "Set ELEVENLABS_API_KEY to enable voice.";
    voiceControls.append(hint);
    return;
  }

  const hint = document.createElement("span");
  hint.className = "voice-hint";
  hint.textContent = voiceMode ? `${voiceConfig.voice_name || "Bradford"} · ${statusText}` : `${voiceConfig.voice_name || "Bradford"} ready`;
  voiceControls.append(hint);
}

function renderQuestion(question) {
  const article = document.createElement("article");
  article.className = `question ${question.status}${voiceMode && question.id === activeVoiceQuestionId ? " voice-active" : ""}`;
  article.dataset.questionId = question.id;
  const qHeader = document.createElement("header");
  qHeader.innerHTML = `<code>${escapeHtml(question.session_id)}</code><time>${new Date(question.created_at).toLocaleTimeString()}</time>`;
  const text = document.createElement("p");
  text.textContent = question.question;
  article.append(qHeader, text);
  if (question.details) {
    const details = document.createElement("p");
    details.className = "details";
    details.textContent = question.details;
    article.append(details);
  }

  if (Array.isArray(question.options) && question.options.length) {
    const recommendation = document.createElement("p");
    recommendation.className = "recommendation";
    recommendation.textContent = `Recommendation: ${question.options[0].label || question.options[0].value || String(question.options[0])}`;
    article.append(recommendation);
  }

  if (question.status === "answered") {
    const answer = document.createElement("p");
    answer.className = "answer";
    answer.textContent = question.answer;
    article.append(answer);
    return article;
  }

  const busy = busyQuestionIds.has(question.id);
  const textarea = document.createElement("textarea");
  textarea.placeholder = "Answer this agent…";
  textarea.value = drafts.get(question.id) || "";
  textarea.disabled = busy;
  textarea.addEventListener("input", () => drafts.set(question.id, textarea.value));
  if (Array.isArray(question.options) && question.options.length) {
    const options = document.createElement("div");
    options.className = "options";
    for (const option of question.options) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "option";
      chip.textContent = option.label || option.value || String(option);
      chip.disabled = busy;
      chip.addEventListener("click", () => { textarea.value = option.value || option.label || String(option); drafts.set(question.id, textarea.value); textarea.focus(); });
      options.append(chip);
    }
    article.append(options);
  }

  if (voiceMode && question.id === activeVoiceQuestionId) article.append(renderVoicePanel(question, textarea));

  const status = document.createElement("span");
  status.className = "status";
  status.setAttribute("aria-live", "polite");
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "secondary dismiss";
  dismiss.textContent = "dismiss";
  dismiss.disabled = busy;
  dismiss.setAttribute("aria-label", `Dismiss question: ${question.question}`);
  const send = document.createElement("button");
  send.type = "button";
  send.textContent = "send answer";
  send.disabled = busy;
  dismiss.addEventListener("click", () => dismissQuestion(question, status));
  send.addEventListener("click", () => sendAnswer(question, textarea.value.trim(), send, status));
  const buttons = document.createElement("div");
  buttons.className = "action-buttons";
  buttons.append(dismiss, send);
  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(status, buttons);
  article.append(textarea, actions);
  if (busy) {
    for (const control of article.querySelectorAll("button, textarea")) control.disabled = true;
  }
  return article;
}

function renderVoicePanel(question, textarea) {
  const panel = document.createElement("section");
  panel.className = `voice-panel phase-${voicePhase}`;

  const orb = document.createElement("div");
  orb.className = "voice-orb";
  orb.setAttribute("aria-hidden", "true");

  const copy = document.createElement("div");
  copy.className = "voice-copy";
  const title = document.createElement("strong");
  title.textContent = voicePhase === "recording" ? "Listening…" : voicePhase === "confirm" ? "Confirm response" : "Jarvis channel open";
  const line = document.createElement("p");
  line.textContent = voicePhase === "confirm" && heardText ? `I heard: “${heardText}”` : statusText;
  copy.append(title, line);

  const controls = document.createElement("div");
  controls.className = "voice-panel-actions";

  const replay = document.createElement("button");
  replay.type = "button";
  replay.className = "secondary";
  replay.textContent = "replay question";
  replay.addEventListener("click", () => speakQuestion(question));
  controls.append(replay);

  if (voicePhase === "recording") {
    const stop = document.createElement("button");
    stop.type = "button";
    stop.textContent = "stop listening";
    stop.addEventListener("click", stopRecording);
    controls.append(stop);
  } else if (voicePhase === "confirm") {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "secondary";
    retry.textContent = "retry";
    retry.addEventListener("click", () => startRecording(question, textarea));
    const send = document.createElement("button");
    send.type = "button";
    send.textContent = "send this";
    send.addEventListener("click", async () => {
      const sent = await sendAnswer(question, heardText, send, line);
      if (sent) heardText = "";
    });
    controls.append(retry, send);
  } else {
    const record = document.createElement("button");
    record.type = "button";
    record.textContent = "answer by voice";
    record.addEventListener("click", () => startRecording(question, textarea));
    controls.append(record);
  }

  panel.append(orb, copy, controls);
  return panel;
}

async function enterVoiceMode() {
  voiceMode = true;
  activeVoiceQuestionId = pendingQuestions[0]?.id || "";
  voicePhase = activeVoiceQuestionId ? "ready" : "idle";
  statusText = activeVoiceQuestionId ? "Reading the question." : "No pending questions.";
  render(pendingQuestions);
  const question = pendingQuestions.find(item => item.id === activeVoiceQuestionId);
  if (question) await speakQuestion(question);
}

function exitVoiceMode() {
  cancelActiveVoiceFlow();
  voiceMode = false;
  activeVoiceQuestionId = "";
  statusText = "Voice mode is ready.";
  render(pendingQuestions);
}

function cancelActiveVoiceFlow() {
  voiceOperation += 1;
  heardText = "";
  recordedChunks = [];
  if (activeAudio) {
    activeAudio.onended = null;
    activeAudio.pause();
    activeAudio = null;
  }
  if (mediaRecorder?.state === "recording") mediaRecorder.stop();
  mediaRecorder = null;
  voicePhase = "idle";
}

async function speakQuestion(question) {
  if (!voiceMode || question.id !== activeVoiceQuestionId) return;
  const operation = ++voiceOperation;
  voicePhase = "speaking";
  statusText = "Speaking the question.";
  render(pendingQuestions);
  try {
    if (activeAudio) activeAudio.pause();
    const response = await fetch("/api/widgets/question-queue/voice/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: question.question }),
    });
    if (!response.ok) throw new Error(await response.text());
    const blob = await response.blob();
    if (operation !== voiceOperation || !voiceMode || question.id !== activeVoiceQuestionId) return;
    activeAudio = new Audio(URL.createObjectURL(blob));
    await activeAudio.play();
    if (operation !== voiceOperation) return;
    activeAudio.onended = () => {
      if (operation !== voiceOperation || question.id !== activeVoiceQuestionId) return;
      voicePhase = "ready";
      statusText = "Question read. Tap answer by voice when ready.";
      render(pendingQuestions);
    };
  } catch (error) {
    if (operation !== voiceOperation) return;
    voicePhase = "ready";
    statusText = error instanceof Error ? error.message : String(error);
    render(pendingQuestions);
  }
}

async function startRecording(question, textarea) {
  const operation = ++voiceOperation;
  try {
    if (activeAudio) activeAudio.pause();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (operation !== voiceOperation || question.id !== activeVoiceQuestionId) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream, preferredRecorderOptions());
    mediaRecorder.addEventListener("dataavailable", event => { if (operation === voiceOperation && event.data.size) recordedChunks.push(event.data); });
    mediaRecorder.addEventListener("stop", async () => {
      stream.getTracks().forEach(track => track.stop());
      if (operation !== voiceOperation) return;
      await transcribeRecording(question, textarea, operation);
    }, { once: true });
    voicePhase = "recording";
    statusText = "Listening for your answer.";
    render(pendingQuestions);
    mediaRecorder.start();
  } catch (error) {
    if (operation !== voiceOperation) return;
    voicePhase = "ready";
    statusText = error instanceof Error ? error.message : String(error);
    render(pendingQuestions);
  }
}

function stopRecording() {
  if (mediaRecorder?.state === "recording") {
    voicePhase = "thinking";
    statusText = "Transcribing your response.";
    render(pendingQuestions);
    mediaRecorder.stop();
  }
}

async function transcribeRecording(question, textarea, operation) {
  try {
    if (operation !== voiceOperation || question.id !== activeVoiceQuestionId) return;
    const type = recordedChunks[0]?.type || mediaRecorder?.mimeType || "audio/webm";
    const blob = new Blob(recordedChunks, { type });
    const response = await fetch("/api/widgets/question-queue/voice/transcribe", {
      method: "POST",
      headers: { "Content-Type": type },
      body: blob,
    });
    if (!response.ok) throw new Error(await response.text());
    const result = await response.json();
    if (operation !== voiceOperation || question.id !== activeVoiceQuestionId) return;
    heardText = String(result.text || "").trim();
    if (!heardText) throw new Error("I could not hear a response. Please retry.");
    textarea.value = heardText;
    drafts.set(question.id, heardText);
    voicePhase = "confirm";
    statusText = "Please confirm the response.";
  } catch (error) {
    if (operation !== voiceOperation) return;
    voicePhase = "ready";
    statusText = error instanceof Error ? error.message : String(error);
  }
  if (operation === voiceOperation) render(pendingQuestions);
}

function preferredRecorderOptions() {
  for (const mimeType of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]) {
    if (MediaRecorder.isTypeSupported?.(mimeType)) return { mimeType };
  }
  return undefined;
}

async function sendAnswer(question, answer, button, status) {
  if (!answer || busyQuestionIds.has(question.id)) return false;
  setQuestionBusy(question.id, true, status, "sending…");
  try {
    const response = await fetch(`/api/widgets/question-queue/questions/${encodeURIComponent(question.id)}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer }),
    });
    if (!response.ok) throw new Error(await response.text());
    drafts.delete(question.id);
    busyQuestionIds.delete(question.id);
    await load();
    window.parent?.postMessage({ type: "lazyagent-widget-refresh" }, "*");
    return true;
  } catch (error) {
    setQuestionBusy(question.id, false, status, error instanceof Error ? error.message : String(error));
    button.disabled = false;
    return false;
  }
}

async function dismissQuestion(question, status) {
  if (busyQuestionIds.has(question.id)) return;
  const dismissedIndex = pendingQuestions.findIndex(item => item.id === question.id);
  const wasActiveVoiceQuestion = voiceMode && question.id === activeVoiceQuestionId;
  setQuestionBusy(question.id, true, status, "dismissing…");
  if (wasActiveVoiceQuestion) cancelActiveVoiceFlow();
  try {
    const response = await fetch(`/api/widgets/question-queue/questions/${encodeURIComponent(question.id)}/dismiss`, {
      method: "POST",
    });
    if (!response.ok) throw new Error(await response.text());
    drafts.delete(question.id);
    busyQuestionIds.delete(question.id);
    pendingQuestions = pendingQuestions.filter(item => item.id !== question.id);
    if (wasActiveVoiceQuestion) advanceVoiceQueue(question.id);
    else render(pendingQuestions);
    announce(`Dismissed: ${question.question}`);
    await load();
    focusAfterDismiss(dismissedIndex);
    window.parent?.postMessage({ type: "lazyagent-widget-refresh" }, "*");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setQuestionBusy(question.id, false, status, message);
    if (wasActiveVoiceQuestion) {
      activeVoiceQuestionId = question.id;
      voicePhase = "ready";
      statusText = message;
      render(pendingQuestions);
    }
  }
}

function setQuestionBusy(questionId, busy, status, message) {
  if (busy) busyQuestionIds.add(questionId);
  else busyQuestionIds.delete(questionId);
  status.textContent = message;
  const card = list.querySelector(`[data-question-id="${cssEscape(questionId)}"]`);
  for (const control of card?.querySelectorAll("button, textarea") || []) control.disabled = busy;
}

function advanceVoiceQueue(answeredId) {
  const remaining = pendingQuestions.filter(question => question.id !== answeredId);
  activeVoiceQuestionId = remaining[0]?.id || "";
  voicePhase = activeVoiceQuestionId ? "ready" : "idle";
  statusText = activeVoiceQuestionId ? "Advancing to the next question." : "No pending questions remain.";
  render(pendingQuestions);
  const next = pendingQuestions.find(question => question.id === activeVoiceQuestionId);
  if (next) setTimeout(() => speakQuestion(next), 450);
}

function announce(message) {
  queueStatus.textContent = "";
  requestAnimationFrame(() => { queueStatus.textContent = message; });
}

function focusAfterDismiss(dismissedIndex) {
  requestAnimationFrame(() => {
    const cards = [...list.querySelectorAll("[data-question-id]")];
    const nextCard = cards[Math.min(Math.max(dismissedIndex, 0), cards.length - 1)];
    if (nextCard && !voiceMode) {
      nextCard.tabIndex = -1;
      nextCard.focus();
    } else {
      heading.focus();
    }
  });
}

function cssEscape(value) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function notifyHeight() {
  requestAnimationFrame(() => {
    const height = document.body.classList.contains("is-empty") ? 0 : document.body.scrollHeight;
    window.parent?.postMessage({ type: "lazyagent-widget-height", height, widget: "question-queue", slot }, "*");
  });
}

window.addEventListener("resize", notifyHeight);
await loadVoiceConfig();
await load();
setInterval(load, 5000);
