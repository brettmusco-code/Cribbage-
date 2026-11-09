// Cribbage sync server.
//
//   GET    /health                     → { ok: true }
//   GET    /t/<table>/ws               → WebSocket: live game for that table
//   GET    /t/<table>/state            → { doc } (the live game, or null)
//   GET    /t/<table>/games            → { games: [...] } newest first
//   PUT    /t/<table>/games/<id>       → save one finished game
//   DELETE /t/<table>/games/<id>       → delete one finished game
//
// WebSocket messages
//   server → client  { type: "state", doc }   on connect and after every change
//                    { type: "games" }        the table's history changed; re-fetch it
//   client → server  { type: "set", doc: { state, by } }
//
// Anyone who knows a table name can read and write it, so table names act as a
// shared code for a group. Sizes are capped so one table can't grow without limit.
import { DurableObject } from "cloudflare:workers";

const MAX_STATE = 120 * 1024;   // one live game, including its undo steps
const MAX_GAME = 64 * 1024;     // one finished game
const MAX_GAMES = 500;          // finished games kept per table
const TABLE_RE = /^[a-z0-9-]{1,24}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS },
  });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/" || url.pathname === "/health") return json({ ok: true, service: "cribbage-sync" });
    const m = url.pathname.match(/^\/t\/([^/]+)(\/.*)?$/);
    if (!m || !TABLE_RE.test(m[1])) return json({ error: "not_found" }, 404);
    const stub = env.TABLES.get(env.TABLES.idFromName(m[1]));
    return stub.fetch(req);
  },
};

export class Table extends DurableObject {
  async fetch(req) {
    const url = new URL(req.url);
    const rest = url.pathname.replace(/^\/t\/[^/]+/, "") || "/";

    if (rest === "/ws") {
      if (req.headers.get("Upgrade") !== "websocket") return json({ error: "expected_websocket" }, 426);
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      const doc = (await this.ctx.storage.get("state")) || null;
      pair[1].send(JSON.stringify({ type: "state", doc }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (rest === "/state" && req.method === "GET") {
      return json({ doc: (await this.ctx.storage.get("state")) || null });
    }

    if (rest === "/games" && req.method === "GET") {
      const map = await this.ctx.storage.list({ prefix: "game:" });
      const games = [...map.values()].sort((a, b) => b.endedAt - a.endedAt).slice(0, MAX_GAMES);
      return json({ games });
    }

    const gm = rest.match(/^\/games\/([^/]+)$/);
    if (gm && ID_RE.test(gm[1])) {
      const key = "game:" + gm[1];
      if (req.method === "PUT") {
        const text = await req.text();
        if (text.length > MAX_GAME) return json({ error: "too_large" }, 413);
        let g;
        try { g = JSON.parse(text); } catch { return json({ error: "bad_json" }, 400); }
        if (!g || typeof g !== "object" || g.id !== gm[1] || typeof g.endedAt !== "number") return json({ error: "invalid" }, 400);
        if (!(await this.ctx.storage.get(key))) {
          const count = (await this.ctx.storage.list({ prefix: "game:", limit: MAX_GAMES })).size;
          if (count >= MAX_GAMES) return json({ error: "full" }, 507);
        }
        await this.ctx.storage.put(key, g);
        this.broadcast({ type: "games" });
        return json({ ok: true });
      }
      if (req.method === "DELETE") {
        await this.ctx.storage.delete(key);
        this.broadcast({ type: "games" });
        return json({ ok: true });
      }
    }
    return json({ error: "not_found" }, 404);
  }

  async webSocketMessage(ws, msg) {
    if (typeof msg !== "string") return;
    if (msg.length > MAX_STATE) { ws.send(JSON.stringify({ type: "error", error: "too_large" })); return; }
    let m;
    try { m = JSON.parse(msg); } catch { return; }
    if (m && m.type === "set" && m.doc && typeof m.doc.state === "object" && m.doc.state) {
      const prev = await this.ctx.storage.get("state");
      const doc = {
        state: m.doc.state,
        by: String(m.doc.by || "").slice(0, 40),
        updatedAt: Date.now(),
        rev: ((prev && prev.rev) || 0) + 1,
      };
      await this.ctx.storage.put("state", doc);
      this.broadcast({ type: "state", doc });
    } else if (m && m.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
    }
  }

  async webSocketClose(ws, code) {
    try { ws.close(code, "closing"); } catch {}
  }

  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(s); } catch {}
    }
  }
}
