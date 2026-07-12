import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { handle, status as questionQueueStatus } from "../widgets/question-queue/backend.js";

function questionEvent(index, timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()) {
  return {
    kind: "assistant",
    line: index + 1,
    timestamp,
    text: `\`\`\`lazyagent-question\n${JSON.stringify({
      widget: "question-queue",
      question: `Question ${index}?`,
      details: `Details ${index}`,
      options: [{ label: `Choice ${index}`, value: `choice-${index}` }],
    })}\n\`\`\``,
  };
}

function makeHarness(stateDir, transcripts = []) {
  const sentMessages = [];
  const context = {
    stateDir,
    async readJson(req) {
      return req.body;
    },
    writeJson(res, statusCode, payload) {
      res.statusCode = statusCode;
      res.payload = payload;
    },
    httpError(statusCode, message) {
      const error = new Error(message);
      error.statusCode = statusCode;
      return error;
    },
    async listAgentSessionTranscripts() {
      return transcripts;
    },
    async sendAgentMessage(message) {
      sentMessages.push(message);
    },
  };
  return { context, sentMessages };
}

async function request(context, method, pathname, body) {
  const req = { method, body, headers: {} };
  const res = {};
  const handled = await handle(req, res, new URL(pathname, "http://widget.test"), context);
  assert.equal(handled, true);
  return res;
}

async function temporaryState(t) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "question-queue-test-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  return stateDir;
}

test("dismiss does not message the agent and survives resync, reload, and repeated dismissal", async t => {
  const stateDir = await temporaryState(t);
  const transcripts = [{ session_id: "session-one", cwd: "/tmp/project", events: [questionEvent(1)] }];
  const first = makeHarness(stateDir, transcripts);

  const initial = await request(first.context, "GET", "/questions");
  assert.equal(initial.payload.questions.length, 1);
  assert.equal(initial.payload.questions[0].status, "pending");
  const id = initial.payload.questions[0].id;

  const dismissed = await request(first.context, "POST", `/questions/${encodeURIComponent(id)}/dismiss`);
  assert.equal(dismissed.statusCode, 200);
  assert.equal(dismissed.payload.question.status, "dismissed");
  assert.ok(dismissed.payload.question.dismissed_at);
  assert.equal(first.sentMessages.length, 0);
  const dismissedAt = dismissed.payload.question.dismissed_at;

  const repeated = await request(first.context, "POST", `/questions/${encodeURIComponent(id)}/dismiss`);
  assert.equal(repeated.statusCode, 200);
  assert.equal(repeated.payload.question.dismissed_at, dismissedAt);
  assert.equal(first.sentMessages.length, 0);

  const reloaded = makeHarness(stateDir, transcripts);
  const afterReload = await request(reloaded.context, "GET", "/questions");
  assert.equal(afterReload.payload.questions.length, 1);
  assert.equal(afterReload.payload.questions[0].status, "dismissed");
  assert.equal(afterReload.payload.questions[0].dismissed_at, dismissedAt);
  assert.equal((await questionQueueStatus(reloaded.context)).pending, 0);
  assert.equal(reloaded.sentMessages.length, 0);

  const persisted = JSON.parse(await readFile(path.join(stateDir, "questions.json"), "utf8"));
  assert.equal(persisted[0].status, "dismissed");
  assert.equal(persisted[0].dismissed_at, dismissedAt);
});

test("dismissed questions cannot be answered and unknown dismissals return 404", async t => {
  const stateDir = await temporaryState(t);
  const transcripts = [{ session_id: "session-two", cwd: "/tmp/project", events: [questionEvent(2)] }];
  const harness = makeHarness(stateDir, transcripts);
  const initial = await request(harness.context, "GET", "/questions");
  const id = initial.payload.questions[0].id;
  await request(harness.context, "POST", `/questions/${encodeURIComponent(id)}/dismiss`);

  await assert.rejects(
    request(harness.context, "POST", `/questions/${encodeURIComponent(id)}/answer`, { answer: "choice-2" }),
    error => error.statusCode === 409 && /dismissed/.test(error.message),
  );
  assert.equal(harness.sentMessages.length, 0);

  await assert.rejects(
    request(harness.context, "POST", "/questions/missing-id/dismiss"),
    error => error.statusCode === 404,
  );
  await assert.rejects(
    request(harness.context, "POST", "/questions/%/dismiss"),
    error => error.statusCode === 400 && /malformed/.test(error.message),
  );
  assert.equal(harness.sentMessages.length, 0);
});

test("retains every pending and dismissed question while capping answered history at 200", async t => {
  const stateDir = await temporaryState(t);
  const events = Array.from({ length: 205 }, (_, index) => questionEvent(index));
  const transcripts = [{ session_id: "history-session", cwd: "/tmp/project", events }];
  const harness = makeHarness(stateDir, transcripts);

  const initial = await request(harness.context, "GET", "/questions");
  assert.equal(initial.payload.questions.length, 205);
  assert.equal(initial.payload.questions.every(question => question.status === "pending"), true);

  const pendingId = initial.payload.questions[0].id;
  const dismissedId = initial.payload.questions[1].id;
  const dismissed = await request(harness.context, "POST", `/questions/${encodeURIComponent(dismissedId)}/dismiss`);
  const dismissedAt = dismissed.payload.question.dismissed_at;
  for (const question of initial.payload.questions.slice(2)) {
    await request(
      harness.context,
      "POST",
      `/questions/${encodeURIComponent(question.id)}/answer`,
      { answer: `answer for ${question.question}` },
    );
  }
  assert.equal(harness.sentMessages.length, 203);

  const afterCap = await request(harness.context, "GET", "/questions");
  assert.equal(afterCap.payload.questions.length, 202);
  assert.equal(afterCap.payload.questions.filter(question => question.status === "answered").length, 200);
  assert.equal(afterCap.payload.questions.find(question => question.id === pendingId)?.status, "pending");
  assert.equal(afterCap.payload.questions.find(question => question.id === dismissedId)?.status, "dismissed");
  const tombstones = JSON.parse(await readFile(path.join(stateDir, "question-tombstones.json"), "utf8"));
  assert.equal(tombstones.length, 3);

  const reloaded = makeHarness(stateDir, transcripts);
  const afterReloadAndResync = await request(reloaded.context, "GET", "/questions");
  assert.equal(afterReloadAndResync.payload.questions.length, 202);
  assert.equal(afterReloadAndResync.payload.questions.filter(question => question.status === "pending").length, 1);
  assert.equal(afterReloadAndResync.payload.questions.find(question => question.id === pendingId)?.status, "pending");
  assert.equal(afterReloadAndResync.payload.questions.find(question => question.id === dismissedId)?.dismissed_at, dismissedAt);
  assert.equal(reloaded.sentMessages.length, 0);
});

test("serializes simultaneous answer and dismiss actions", async t => {
  const stateDir = await temporaryState(t);
  const transcripts = [{ session_id: "racing-session", cwd: "/tmp/project", events: [questionEvent(9)] }];
  const harness = makeHarness(stateDir, transcripts);
  const initial = await request(harness.context, "GET", "/questions");
  const id = initial.payload.questions[0].id;

  const results = await Promise.allSettled([
    request(harness.context, "POST", `/questions/${encodeURIComponent(id)}/answer`, { answer: "choice-9" }),
    request(harness.context, "POST", `/questions/${encodeURIComponent(id)}/dismiss`),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected" && result.reason.statusCode === 409).length, 1);

  const final = await request(harness.context, "GET", "/questions");
  assert.notEqual(final.payload.questions[0].status, "pending");
  assert.equal(harness.sentMessages.length, final.payload.questions[0].status === "answered" ? 1 : 0);
});
