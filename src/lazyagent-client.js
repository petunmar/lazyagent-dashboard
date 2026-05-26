import { pbkdf2Sync } from "node:crypto";

const DEFAULT_BASE_URL = "http://127.0.0.1:7421";

export class LazyagentClient {
  constructor({ baseUrl = process.env.LAZYAGENT_URL || DEFAULT_BASE_URL, passphrase = process.env.LAZYAGENT_API_PASSPHRASE } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.passphrase = passphrase;
    this.token = process.env.LAZYAGENT_BEARER_TOKEN || "";
  }

  async authInfo() {
    const res = await fetch(`${this.baseUrl}/api/auth`);
    if (!res.ok) throw new Error(`GET /api/auth failed: ${res.status} ${res.statusText}`);
    return res.json();
  }

  async bearerToken() {
    if (this.token) return this.token;
    if (!this.passphrase) {
      throw new Error("Set LAZYAGENT_API_PASSPHRASE or LAZYAGENT_BEARER_TOKEN");
    }
    const auth = await this.authInfo();
    const key = pbkdf2Sync(
      this.passphrase.trim(),
      auth.salt,
      auth.iterations,
      auth.key_length,
      "sha256",
    );
    this.token = key.toString("base64url");
    return this.token;
  }

  async request(path, init = {}) {
    const token = await this.bearerToken();
    const headers = new Headers(init.headers || {});
    headers.set("Authorization", `Bearer ${token}`);
    const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    if (!res.ok) throw new Error(`${init.method || "GET"} ${path} failed: ${res.status} ${res.statusText}`);
    return res.json();
  }

  sessions(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request(`/api/sessions${qs ? `?${qs}` : ""}`);
  }

  session(id) {
    return this.request(`/api/sessions/${encodeURIComponent(id)}`);
  }

  stats() {
    return this.request("/api/stats");
  }

  config() {
    return this.request("/api/config");
  }

  async setSessionName(id, name) {
    return this.request(`/api/sessions/${encodeURIComponent(id)}/name`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
  }

  async clearSessionName(id) {
    return this.request(`/api/sessions/${encodeURIComponent(id)}/name`, { method: "DELETE" });
  }

  async *events() {
    const token = await this.bearerToken();
    const res = await fetch(`${this.baseUrl}/api/events?token=${encodeURIComponent(token)}`);
    if (!res.ok || !res.body) throw new Error(`GET /api/events failed: ${res.status} ${res.statusText}`);

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let split;
        while ((split = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const data = raw
            .split("\n")
            .filter(line => line.startsWith("data:"))
            .map(line => line.slice(5).trimStart())
            .join("\n");
          if (data) yield JSON.parse(data);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
