// Cribbage sync server.
//
//   GET    /health                     → { ok: true }
//   GET    /tables                     → { tables: [...] } tables in use that are listed, busiest first
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
// shared code for a group. A table shows in /tables unless its game sets
// `listed: false`; hidden tables can still be joined by name. Sizes are capped
// so one table can't grow without limit.
import { DurableObject } from "cloudflare:workers";

const MAX_STATE = 120 * 1024;   // one live game, including its undo steps
const MAX_GAME = 64 * 1024;     // one finished game
const MAX_GAMES = 500;          // finished games kept per table
const TABLE_RE = /^[a-z0-9-]{1,24}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const HOUR = 60 * 60 * 1000;
const LISTED_FOR = 24 * HOUR;    // a table stays in the list for a day after its last change
const KEEP_FOR = 7 * 24 * HOUR;  // directory entries are dropped after a week
const CONNECTED_FOR = 6 * HOUR;  // connection counts older than this are treated as stale

function lobby(env) {
  return env.LOBBY.get(env.LOBBY.idFromName("lobby"));
}

// What the table list shows for one table: players, scores and connected phones
function summarize(name, doc, devices) {
  const s = doc && doc.state;
  if (!s || !Array.isArray(s.sides) || !s.sides.length) return null;
  const names = Array.isArray(s.names) ? s.names : [];
  const nameOf = (p) => String(names[p] || "Player " + (p + 1)).slice(0, 20);
  const players = s.mode === "partners"
    ? [nameOf(0) + " & " + nameOf(2), nameOf(1) + " & " + nameOf(3)]
    : s.sides.map((_, i) => nameOf(i));
  return {
    name,
    players: players.slice(0, 4),
    scores: s.sides.slice(0, 4).map((sd) => Math.max(0, Math.min(121, Number(sd && sd.score) || 0))),
    game: Number(s.game) || 1,
    over: s.winner !== null && s.winner !== undefined,
    listed: s.listed !== false,
    devices,
    updatedAt: Number(doc.updatedAt) || Date.now(),
    seenAt: Date.now(),
  };
}

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
    if (url.pathname === "/tables" && req.method === "GET") return json({ tables: await lobby(env).list() });
    const m = url.pathname.match(/^\/t\/([^/]+)(\/.*)?$/);
    if (!m || !TABLE_RE.test(m[1])) return json({ error: "not_found" }, 404);
    const stub = env.TABLES.get(env.TABLES.idFromName(m[1]));
    return stub.fetch(req);
  },
};

export class Table extends DurableObject {
  // A table's own name, remembered so it can report itself to the directory after waking
  async tableName(url) {
    if (this.name) return this.name;
    let name = await this.ctx.storage.get("name");
    const m = url && url.pathname.match(/^\/t\/([^/]+)/);
    if (!name && m && TABLE_RE.test(m[1])) {
      name = m[1];
      await this.ctx.storage.put("name", name);
    }
    this.name = name || null;
    return this.name;
  }

  // Tell the directory this table's players, scores and connected phones
  async report(leaving) {
    try {
      const name = await this.tableName();
      if (!name) return;
      const doc = await this.ctx.storage.get("state");
      const devices = this.ctx.getWebSockets().filter((w) => w !== leaving).length;
      const summary = summarize(name, doc, devices);
      if (summary) await lobby(this.env).update(summary);
    } catch {
      // The table keeps working even if the directory can't be reached
    }
  }

  async fetch(req) {
    const url = new URL(req.url);
    await this.tableName(url);
    const rest = url.pathname.replace(/^\/t\/[^/]+/, "") || "/";

    if (rest === "/ws") {
      if (req.headers.get("Upgrade") !== "websocket") return json({ error: "expected_websocket" }, 426);
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      const doc = (await this.ctx.storage.get("state")) || null;
      pair[1].send(JSON.stringify({ type: "state", doc }));
      await this.report();
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
      await this.report();
      this.broadcast({ type: "state", doc });
    } else if (m && m.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
    }
  }

  async webSocketClose(ws, code) {
    try { ws.close(code, "closing"); } catch {}
    await this.report(ws);
  }

  async webSocketError(ws) {
    await this.report(ws);
  }

  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(s); } catch {}
    }
  }
}

// The directory of tables: one entry per table, updated by the tables themselves
export class Lobby extends DurableObject {
  async update(summary) {
    if (!summary || !TABLE_RE.test(summary.name)) return;
    await this.ctx.storage.put("t:" + summary.name, summary);
  }

  async list() {
    const all = await this.ctx.storage.list({ prefix: "t:" });
    const now = Date.now(), out = [], stale = [];
    for (const [key, t] of all) {
      const connected = t.devices > 0 && now - (t.seenAt || t.updatedAt) < CONNECTED_FOR;
      if (!connected && now - t.updatedAt > KEEP_FOR) { stale.push(key); continue; }
      if (t.listed && (connected || now - t.updatedAt < LISTED_FOR)) out.push({ ...t, devices: connected ? t.devices : 0 });
    }
    if (stale.length) await this.ctx.storage.delete(stale.slice(0, 128));
    out.sort((a, b) => (b.devices > 0) - (a.devices > 0) || b.updatedAt - a.updatedAt);
    return out.slice(0, 50);
  }
}
