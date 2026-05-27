const canvas = document.querySelector("#court");
const ctx = canvas.getContext("2d");
const playerScoreEl = document.querySelector("#player-score");
const botScoreEl = document.querySelector("#bot-score");
const rallyEl = document.querySelector("#rally-count");
const curtain = document.querySelector("#curtain");
const commentaryEl = document.querySelector("#commentary");
const serveButton = document.querySelector("#serve");
const modeButton = document.querySelector("#mode");
const restReminder = document.querySelector("#rest-reminder");

const W = canvas.width;
const H = canvas.height;
const keys = new Set();
const sparks = [];
const quips = [
  "The crowd is just your CPU fan.",
  "Tiny forehand. Serious consequences.",
  "If the agent is thinking, so is the ball.",
  "Polite applause from /dev/null.",
  "The umpire has accepted all cookies.",
  "Spin it like a dependency graph."
];

let zen = false;
let waiting = true;
let last = performance.now();
let playerScore = 0;
let botScore = 0;
let rally = 0;
let shake = 0;
let cometHue = 80;
let agentActive = false;
let agentLastActivity = Date.now();
let restTimer = 0;
let resting = false;
let hasPlayed = false;

const player = { x: 52, y: H / 2 - 42, w: 14, h: 84, targetX: 52, targetY: H / 2, speed: 520, footwork: 430, lastX: 52, lastY: H / 2 - 42, vx: 0, vy: 0 };
const bot = { x: W - 66, y: H / 2 - 42, w: 14, h: 84, targetX: W - 66, targetY: H / 2, speed: 390, footwork: 360, nerve: 0.78, lastX: W - 66, lastY: H / 2 - 42, vx: 0, vy: 0 };
const ball = { x: W / 2, y: H / 2, r: 8, vx: 0, vy: 0, spin: 0, speed: 520 };
const playerBounds = { minX: 34, maxX: W * 0.42 - player.w };
const botBounds = { minX: W * 0.58, maxX: W - 34 - bot.w };

function postHeight() {
  const params = new URLSearchParams(location.search);
  parent.postMessage({
    type: "lazyagent-widget-height",
    widget: "court-break",
    slot: params.get("slot") || "detail:top",
    height: hasPlayed ? Math.ceil(document.documentElement.scrollHeight) : 0
  }, "*");
}

function resetBall(direction = 1) {
  waiting = true;
  ball.x = W / 2;
  ball.y = H / 2;
  ball.vx = direction * ball.speed;
  ball.vy = 0;
  ball.spin = 0;
  rally = 0;
  updateHud();
  curtain.classList.add("show");
}

function serve() {
  if (resting || !waiting) return;
  waiting = false;
  curtain.classList.remove("show");
  const direction = Math.random() > 0.5 ? 1 : -1;
  ball.vx = direction * (460 + Math.random() * 120);
  ball.vy = (Math.random() - 0.5) * 260;
  ball.spin = (Math.random() - 0.5) * 0.7;
  commentaryEl.textContent = quips[Math.floor(Math.random() * quips.length)];
}

function updateHud() {
  playerScoreEl.textContent = playerScore;
  botScoreEl.textContent = botScore;
  rallyEl.textContent = rally;
}

function movePaddle(paddle, targetY, targetX, bounds, dt, speed = paddle.speed) {
  paddle.lastX = paddle.x;
  paddle.lastY = paddle.y;
  const centerY = paddle.y + paddle.h / 2;
  const deltaY = targetY - centerY;
  const stepY = Math.sign(deltaY) * Math.min(Math.abs(deltaY), speed * dt);
  paddle.y = clamp(paddle.y + stepY, 14, H - paddle.h - 14);

  const deltaX = targetX - paddle.x;
  const stepX = Math.sign(deltaX) * Math.min(Math.abs(deltaX), paddle.footwork * dt);
  paddle.x = clamp(paddle.x + stepX, bounds.minX, bounds.maxX);
  paddle.vx = dt ? (paddle.x - paddle.lastX) / dt : 0;
  paddle.vy = dt ? (paddle.y - paddle.lastY) / dt : 0;
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

function collide(paddle, side) {
  const overlaps = ball.x + ball.r > paddle.x && ball.x - ball.r < paddle.x + paddle.w && ball.y + ball.r > paddle.y && ball.y - ball.r < paddle.y + paddle.h;
  if (!overlaps) return;
  if ((side === "left" && ball.vx > 0) || (side === "right" && ball.vx < 0)) return;

  const impact = ((ball.y - (paddle.y + paddle.h / 2)) / (paddle.h / 2));
  const clean = 1 - Math.min(1, Math.abs(impact));
  const direction = side === "left" ? 1 : -1;
  const steppingIn = Math.max(0, paddle.vx * direction);
  const speed = Math.min(960, Math.hypot(ball.vx, ball.vy) + 24 + clean * 34 + steppingIn * 0.22);
  ball.vx = direction * speed;
  ball.vy = impact * 430 + paddle.vy * 0.34;
  ball.spin = impact * 1.45 + paddle.vx * 0.0012;
  ball.x = side === "left" ? paddle.x + paddle.w + ball.r : paddle.x - ball.r;
  rally += 1;
  cometHue = side === "left" ? 85 + clean * 70 : 175;
  shake = clean > 0.82 ? 8 : 3;
  addSparks(ball.x, ball.y, side === "left" ? -1 : 1, clean);
  updateHud();
}

function addSparks(x, y, dir, clean) {
  const count = Math.round(5 + clean * 10);
  for (let i = 0; i < count; i++) {
    sparks.push({ x, y, vx: dir * (80 + Math.random() * 180), vy: (Math.random() - 0.5) * 240, life: 0.35 + Math.random() * 0.35, age: 0 });
  }
}

function score(winner) {
  if (winner === "player") playerScore += 1;
  else botScore += 1;
  commentaryEl.textContent = winner === "player" ? "Point! The bot blames packet loss." : "Bot point. It trained during your last build.";
  updateHud();
  resetBall(winner === "player" ? -1 : 1);
}

function update(dt) {
  updateRestState(dt);
  if (resting) return;
  if (keys.has("arrowup") || keys.has("w")) player.targetY -= player.speed * dt * 1.6;
  if (keys.has("arrowdown") || keys.has("s")) player.targetY += player.speed * dt * 1.6;
  if (keys.has("arrowleft") || keys.has("a")) player.targetX -= player.footwork * dt * 1.7;
  if (keys.has("arrowright") || keys.has("d")) player.targetX += player.footwork * dt * 1.7;
  player.targetY = clamp(player.targetY, player.h / 2 + 14, H - player.h / 2 - 14);
  player.targetX = clamp(player.targetX, playerBounds.minX, playerBounds.maxX);
  movePaddle(player, player.targetY, player.targetX, playerBounds, dt);

  const botMistake = Math.sin(performance.now() / 700) * (zen ? 28 : 54) + (1 - bot.nerve) * 80;
  const botTargetY = ball.y + (ball.vx > 0 ? botMistake : 0);
  const homeX = zen ? botBounds.maxX - 6 : botBounds.maxX - 22;
  const attackX = botBounds.minX + clamp((ball.x - W * 0.50) / (W * 0.18), 0, 1) * (botBounds.maxX - botBounds.minX);
  bot.targetX = ball.vx > 0 ? attackX + Math.sin(performance.now() / 430) * (zen ? 8 : 16) : homeX;
  bot.targetX = clamp(bot.targetX, botBounds.minX, botBounds.maxX);
  bot.targetY = clamp(botTargetY, bot.h / 2 + 14, H - bot.h / 2 - 14);
  movePaddle(bot, bot.targetY, bot.targetX, botBounds, dt, zen ? 310 : bot.speed + rally * 3);

  if (!waiting) {
    ball.vy += ball.spin * 260 * dt;
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    ball.spin *= 0.995;

    if (ball.y < 20 || ball.y > H - 20) {
      ball.y = clamp(ball.y, 20, H - 20);
      ball.vy *= -0.96;
      ball.spin *= -0.35;
      shake = 2;
    }
    collide(player, "left");
    collide(bot, "right");
    if (ball.x < -32) score("bot");
    if (ball.x > W + 32) score("player");
  }

  for (const spark of sparks) {
    spark.age += dt;
    spark.x += spark.vx * dt;
    spark.y += spark.vy * dt;
    spark.vy += 300 * dt;
  }
  while (sparks.length && sparks[0].age > sparks[0].life) sparks.shift();
  shake = Math.max(0, shake - 30 * dt);
}

function draw() {
  const wiggleX = shake ? (Math.random() - 0.5) * shake : 0;
  const wiggleY = shake ? (Math.random() - 0.5) * shake : 0;
  ctx.save();
  ctx.translate(wiggleX, wiggleY);

  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, zen ? "#164e63" : "#166534");
  grad.addColorStop(1, zen ? "#312e81" : "#0f766e");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  ctx.globalAlpha = 0.16;
  for (let i = 0; i < 18; i++) {
    ctx.fillStyle = i % 2 ? "#ffffff" : "#bef264";
    ctx.fillRect(i * 58 - ((performance.now() / 80) % 58), 0, 1, H);
  }
  ctx.globalAlpha = 1;

  drawCourtLines();
  drawNet();
  drawPaddle(player, "#bef264", "#365314");
  drawPaddle(bot, "#67e8f9", "#164e63");
  drawBall();
  drawSparks();
  ctx.restore();
}

function drawCourtLines() {
  ctx.strokeStyle = "rgba(240,253,244,0.72)";
  ctx.lineWidth = 3;
  ctx.strokeRect(26, 24, W - 52, H - 48);
  ctx.beginPath();
  ctx.moveTo(W / 2, 24); ctx.lineTo(W / 2, H - 24);
  ctx.moveTo(26, H / 2); ctx.lineTo(W - 26, H / 2);
  ctx.moveTo(W * 0.25, 24); ctx.lineTo(W * 0.25, H - 24);
  ctx.moveTo(W * 0.75, 24); ctx.lineTo(W * 0.75, H - 24);
  ctx.stroke();
}

function drawNet() {
  ctx.strokeStyle = "rgba(15,23,42,0.62)";
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(W / 2, 18); ctx.lineTo(W / 2, H - 18);
  ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,0.42)";
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 9]);
  ctx.beginPath();
  ctx.moveTo(W / 2, 18); ctx.lineTo(W / 2, H - 18);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawPaddle(paddle, fill, shadow) {
  ctx.fillStyle = shadow;
  roundRect(paddle.x + 4, paddle.y + 4, paddle.w, paddle.h, 8);
  ctx.fillStyle = fill;
  roundRect(paddle.x, paddle.y, paddle.w, paddle.h, 8);
}

function drawBall() {
  const trail = Math.min(28, Math.hypot(ball.vx, ball.vy) / 22);
  const angle = Math.atan2(ball.vy, ball.vx);
  ctx.strokeStyle = `hsla(${cometHue}, 92%, 72%, 0.45)`;
  ctx.lineWidth = 9;
  ctx.beginPath();
  ctx.moveTo(ball.x - Math.cos(angle) * trail, ball.y - Math.sin(angle) * trail);
  ctx.lineTo(ball.x, ball.y);
  ctx.stroke();
  ctx.fillStyle = "#fef08a";
  ctx.beginPath();
  ctx.arc(ball.x, ball.y, ball.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(22,101,52,0.8)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(ball.x - 2, ball.y, ball.r * 0.55, -1.2, 1.2);
  ctx.arc(ball.x + 2, ball.y, ball.r * 0.55, 1.95, 4.35);
  ctx.stroke();
}

function drawSparks() {
  for (const spark of sparks) {
    const alpha = 1 - spark.age / spark.life;
    ctx.fillStyle = `rgba(254, 240, 138, ${alpha})`;
    ctx.fillRect(spark.x, spark.y, 3, 3);
  }
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.fill();
}

function updateRestState(dt) {
  if (!hasPlayed) return;
  const inactiveFor = agentActive ? 0 : Math.max(0, Date.now() - agentLastActivity);
  restTimer = inactiveFor >= 10_000 ? restTimer + dt : 0;
  const shouldRest = restTimer > 0;
  if (shouldRest === resting) return;
  resting = shouldRest;
  document.body.classList.toggle("agent-resting", resting);
  if (resting) {
    keys.clear();
    commentaryEl.textContent = "Agent quiet. Rally fading so you can return to the real match.";
    restReminder?.setAttribute("aria-hidden", "false");
  } else {
    restReminder?.setAttribute("aria-hidden", "true");
    commentaryEl.textContent = quips[Math.floor(Math.random() * quips.length)];
  }
}

function loop(now) {
  const dt = Math.min(0.033, (now - last) / 1000);
  last = now;
  update(dt);
  draw();
  requestAnimationFrame(loop);
}

function pointerToTarget(event) {
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width * W;
  const y = (event.clientY - rect.top) / rect.height * H;
  player.targetX = clamp(x - player.w / 2, playerBounds.minX, playerBounds.maxX);
  player.targetY = clamp(y, player.h / 2 + 14, H - player.h / 2 - 14);
}

function isControlKey(key) {
  return key === " " || key === "arrowup" || key === "arrowdown" || key === "arrowleft" || key === "arrowright" || key === "w" || key === "a" || key === "s" || key === "d";
}

function onSessionState(message) {
  if (message.session_id && new URLSearchParams(location.search).get("session_id") !== message.session_id) return;
  agentActive = Boolean(message.is_active);
  const parsedLastActivity = Date.parse(message.last_activity || "");
  agentLastActivity = Number.isFinite(parsedLastActivity) ? parsedLastActivity : Date.now();
  if (agentActive) {
    if (!hasPlayed) {
      hasPlayed = true;
      document.body.classList.add("has-played");
      requestAnimationFrame(postHeight);
    }
    restTimer = 0;
    if (resting) {
      resting = false;
      document.body.classList.remove("agent-resting");
      restReminder?.setAttribute("aria-hidden", "true");
      commentaryEl.textContent = "Agent is moving again. Ball is live.";
    }
  } else if (hasPlayed) {
    requestAnimationFrame(postHeight);
  }
}

window.addEventListener("keydown", event => {
  const key = event.key.toLowerCase();
  if (isControlKey(key)) event.preventDefault();
  keys.add(key);
  if (key === " ") serve();
}, { passive: false });
window.addEventListener("keyup", event => {
  const key = event.key.toLowerCase();
  if (isControlKey(key)) event.preventDefault();
  keys.delete(key);
}, { passive: false });
window.addEventListener("message", event => {
  if (event.data?.type === "lazyagent-widget-session-state") onSessionState(event.data);
});
canvas.addEventListener("wheel", event => event.preventDefault(), { passive: false });
canvas.addEventListener("touchmove", event => event.preventDefault(), { passive: false });
canvas.addEventListener("pointermove", pointerToTarget);
canvas.addEventListener("pointerdown", event => { canvas.focus({ preventScroll: true }); pointerToTarget(event); serve(); });
curtain.addEventListener("click", serve);
serveButton.addEventListener("click", serve);
modeButton.addEventListener("click", () => {
  zen = !zen;
  bot.nerve = zen ? 0.52 : 0.78;
  modeButton.textContent = zen ? "neon duel" : "zen court";
  commentaryEl.textContent = zen ? "Zen mode: softer bot, stranger sky." : "Neon duel: the bot found its shoes.";
});
window.addEventListener("resize", postHeight);

resetBall();
postHeight();
requestAnimationFrame(loop);
setInterval(postHeight, 1000);
