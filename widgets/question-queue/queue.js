const params = new URLSearchParams(location.search);
const slot = params.get("slot") || "dashboard:top";
const sessionId = params.get("session_id") || "";
const list = document.querySelector("#questions");
const empty = document.querySelector("#empty");
const badge = document.querySelector("#badge");
const drafts = new Map();

async function load() {
  const response = await fetch("/api/widgets/question-queue/questions");
  const { questions } = await response.json();
  const scoped = slot.startsWith("detail:") && sessionId ? questions.filter(question => question.session_id === sessionId) : questions;
  render(scoped.filter(question => question.status === "pending"));
}

function render(questions) {
  badge.textContent = `${questions.length} pending`;
  empty.hidden = questions.length > 0;
  document.body.classList.toggle("is-empty", questions.length === 0);
  const activeElement = document.activeElement;
  const focusedQuestion = activeElement?.closest?.("[data-question-id]")?.dataset.questionId || "";
  const nextIds = new Set(questions.slice(0, 8).map(question => question.id));

  for (const existing of [...list.querySelectorAll("[data-question-id]")]) {
    if (!nextIds.has(existing.dataset.questionId)) existing.remove();
  }

  for (const question of questions.slice(0, 8)) {
    const existing = list.querySelector(`[data-question-id="${cssEscape(question.id)}"]`);
    if (existing && question.id === focusedQuestion && question.status === "pending") continue;
    const rendered = renderQuestion(question);
    if (existing) existing.replaceWith(rendered);
    else list.append(rendered);
  }
  notifyHeight();
}

function renderQuestion(question) {
  const article = document.createElement("article");
  article.className = `question ${question.status}`;
  article.dataset.questionId = question.id;
  const header = document.createElement("header");
  header.innerHTML = `<code>${escapeHtml(question.session_id)}</code><time>${new Date(question.created_at).toLocaleTimeString()}</time>`;
  const text = document.createElement("p");
  text.textContent = question.question;
  article.append(header, text);
  if (question.details) {
    const details = document.createElement("p");
    details.className = "details";
    details.textContent = question.details;
    article.append(details);
  }

  if (question.status === "answered") {
    const answer = document.createElement("p");
    answer.className = "answer";
    answer.textContent = question.answer;
    article.append(answer);
    return article;
  }

  const textarea = document.createElement("textarea");
  textarea.placeholder = "Answer this agent…";
  textarea.value = drafts.get(question.id) || "";
  textarea.addEventListener("input", () => drafts.set(question.id, textarea.value));
  if (Array.isArray(question.options) && question.options.length) {
    const options = document.createElement("div");
    options.className = "options";
    for (const option of question.options) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "option";
      chip.textContent = option.label || option.value || String(option);
      chip.addEventListener("click", () => { textarea.value = option.value || option.label || String(option); drafts.set(question.id, textarea.value); textarea.focus(); });
      options.append(chip);
    }
    article.append(options);
  }
  const status = document.createElement("span");
  status.className = "status";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "send answer";
  button.addEventListener("click", async () => {
    const answer = textarea.value.trim();
    if (!answer) return;
    button.disabled = true;
    status.textContent = "sending…";
    try {
      const response = await fetch(`/api/widgets/question-queue/questions/${encodeURIComponent(question.id)}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer }),
      });
      if (!response.ok) throw new Error(await response.text());
      drafts.delete(question.id);
      await load();
      window.parent?.postMessage({ type: "lazyagent-widget-refresh" }, "*");
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
      button.disabled = false;
    }
  });
  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(status, button);
  article.append(textarea, actions);
  return article;
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
load();
setInterval(load, 5000);
