// Cribbage sync server.
//
//   GET    /health                     → { ok: true, scan } (scan: whether hand scanning is set up)
//   POST   /scan                       → read the cards in a photo: { image: base64, type } → { hand, cut, note }
//                                        The photo is passed to Claude and not kept. Needs the
//                                        ANTHROPIC_API_KEY secret; capped per phone and per day.
//   GET    /tables                     → { tables: [...] } tables in use that are listed, busiest first
//   DELETE /t/<table>                  → delete the table: its game, its finished games and its list entry.
//                                        Needs the X-Owner-Key header from the phone that started the table.
//   GET    /t/<table>/ws               → WebSocket: live game for that table
//   GET    /t/<table>/state            → { doc } (the live game, or null)
//   GET    /t/<table>/games            → { games: [...] } newest first
//   PUT    /t/<table>/games/<id>       → save one finished game
//   DELETE /t/<table>/games/<id>       → delete one finished game
//
// WebSocket messages
//   server → client  { type: "state", doc }   on connect and after every change
//                    (on connect, `deleted: true` too if the table was deleted and not started again)
//                    { type: "games" }        the table's history changed; re-fetch it
//                    { type: "deleted" }      the table was just deleted
//   client → server  { type: "set", doc: { state, by }, owner? }
//                    `owner` is a secret key sent by the phone that starts the table; only the
//                    first write to an empty table records it, and deleting the table needs it.
//
// Anyone who knows a table name can read and write it, so table names act as a
// shared code for a group. A table shows in /tables unless its game sets
// `listed: false`; hidden tables can still be joined by name. Sizes are capped
// so one table can't grow without limit.
import { DurableObject } from "cloudflare:workers";
import { readHand } from "./scan.js";

const MAX_STATE = 120 * 1024;   // one live game, including its undo steps
const MAX_GAME = 64 * 1024;     // one finished game
const MAX_GAMES = 500;          // finished games kept per table
const TABLE_RE = /^[a-z0-9-]{1,24}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const HOUR = 60 * 60 * 1000;
const LISTED_FOR = 24 * HOUR;    // a table stays in the list for a day after its last change
const KEEP_FOR = 7 * 24 * HOUR;  // directory entries are dropped after a week
const CONNECTED_FOR = 6 * HOUR;  // connection counts older than this are treated as stale
const SCANS_PER_HOUR = 40;       // scans one phone (by IP address) may make in an hour
const SCANS_PER_DAY = 400;       // scans everyone together may make in a day (SCAN_DAILY_LIMIT overrides)

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

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
    creator: typeof s.creator === "string" ? s.creator.slice(0, 40) : null,
    devices,
    updatedAt: Number(doc.updatedAt) || Date.now(),
    seenAt: Date.now(),
  };
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Owner-Key",
  "Access-Control-Max-Age": "86400",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS },
  });
}

// Read a photo of a hand. Each phone and the whole server have a cap so the
// API key can't be run up by someone who finds the address.
async function scan(req, env) {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!env.ANTHROPIC_API_KEY) return json({ error: "scan_not_configured" }, 503);
  const size = Number(req.headers.get("Content-Length") || 0);
  if (size > 3 * 1024 * 1024) return json({ error: "bad_image" }, 413);
  let body;
  try { body = await req.json(); } catch { return json({ error: "bad_image" }, 400); }
  if (!body || typeof body.image !== "string" || !body.image) return json({ error: "bad_image" }, 400);
  const who = await sha256("scan:" + (req.headers.get("CF-Connecting-IP") || "unknown"));
  const perDay = Number(env.SCAN_DAILY_LIMIT) > 0 ? Number(env.SCAN_DAILY_LIMIT) : SCANS_PER_DAY;
  const allowed = await lobby(env).meter(who.slice(0, 32), SCANS_PER_HOUR, perDay);
  if (!allowed) return json({ error: "too_many_scans" }, 429);
  const { status, data } = await readHand(env, body);
  return json(data, status);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true, service: "cribbage-sync", scan: !!env.ANTHROPIC_API_KEY });
    }
    if (url.pathname === "/scan") return scan(req, env);
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
      const deleted = !doc && !!(await this.ctx.storage.get("deletedAt"));
      pair[1].send(JSON.stringify(deleted ? { type: "state", doc, deleted } : { type: "state", doc }));
      await this.report();
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // Delete the table: tell connected phones, then clear its game, its finished games and its list entry.
    // A note of the deletion stays, so a phone that was offline learns of it instead of re-creating the table.
    if (rest === "/" && req.method === "DELETE") {
      // Only the phone that started the table may delete it. Tables started before creators were
      // recorded have no key, so anyone can delete those.
      const ownerHash = await this.ctx.storage.get("ownerHash");
      if (ownerHash) {
        const key = req.headers.get("X-Owner-Key") || "";
        if (!key || (await sha256(key)) !== ownerHash) return json({ error: "not_creator" }, 403);
      }
      const name = await this.tableName(url);
      for (const ws of this.ctx.getWebSockets()) {
        try { ws.send(JSON.stringify({ type: "deleted" })); ws.close(4000, "table deleted"); } catch {}
      }
      await this.ctx.storage.deleteAll();
      if (name) await this.ctx.storage.put("name", name);
      await this.ctx.storage.put("deletedAt", Date.now());
      try { if (name) await lobby(this.env).remove(name); } catch {}
      return json({ ok: true });
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
      // The write that creates the table records its creator's key
      if (!prev && typeof m.owner === "string" && m.owner.length >= 16 && m.owner.length <= 128) {
        await this.ctx.storage.put("ownerHash", await sha256(m.owner));
      }
      const doc = {
        state: m.doc.state,
        by: String(m.doc.by || "").slice(0, 40),
        updatedAt: Date.now(),
        rev: ((prev && prev.rev) || 0) + 1,
      };
      await this.ctx.storage.put("state", doc);
      await this.ctx.storage.delete("deletedAt");
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

  async remove(name) {
    if (TABLE_RE.test(String(name))) await this.ctx.storage.delete("t:" + name);
  }

  // Count one scan; false if this phone or the whole server is over its cap
  async meter(who, perHour, perDay) {
    const now = Date.now();
    const dayKey = "s:d:" + new Date(now).toISOString().slice(0, 10);
    const hourKey = "s:h:" + Math.floor(now / HOUR) + ":" + String(who).slice(0, 32);
    const [day, hour] = await Promise.all([this.ctx.storage.get(dayKey), this.ctx.storage.get(hourKey)]);
    if ((day || 0) >= perDay || (hour || 0) >= perHour) return false;
    await this.ctx.storage.put({ [dayKey]: (day || 0) + 1, [hourKey]: (hour || 0) + 1 });
    if (!day || day % 25 === 0) {
      // Drop counts from earlier hours and days
      const old = [...(await this.ctx.storage.list({ prefix: "s:" })).keys()]
        .filter((k) => k !== dayKey && !k.startsWith("s:h:" + Math.floor(now / HOUR) + ":"));
      if (old.length) await this.ctx.storage.delete(old.slice(0, 128));
    }
    return true;
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
