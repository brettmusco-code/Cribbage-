// Checks a deployed sync server end to end: health, live updates between two
// connections on one table, and saving, listing and deleting a finished game.
// Usage: node smoke-test.mjs https://cribbage-sync.<name>.workers.dev
const base = (process.argv[2] || "").replace(/\/+$/, "");
if (!base) { console.error("Usage: node smoke-test.mjs <server url>"); process.exit(2); }
const table = "smoke-test";
const by = "smoke-" + Date.now().toString(36);
const fail = (msg) => { console.error("FAIL: " + msg); process.exit(1); };
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what + " timed out")), ms))]);

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^http/, "ws") + "/t/" + table + "/ws");
    const queue = [], waiters = [];
    ws.onmessage = (e) => { const m = JSON.parse(e.data); const w = waiters.shift(); w ? w(m) : queue.push(m); };
    ws.onerror = () => reject(new Error("WebSocket error"));
    ws.onopen = () => resolve({ ws, next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r)) });
  });
}

const health = await (await fetch(base + "/health")).json();
if (!health.ok) fail("health check returned " + JSON.stringify(health));
console.log("health ok");

const a = await withTimeout(connect(), 10000, "first connection");
const b = await withTimeout(connect(), 10000, "second connection");
const first = await withTimeout(b.next(), 10000, "initial state");
if (first.type !== "state") fail("expected the current state on connect, got " + JSON.stringify(first));
await withTimeout(a.next(), 10000, "initial state");
a.ws.send(JSON.stringify({ type: "set", doc: { state: { v: 2, smoke: true }, by } }));
let got;
do { got = await withTimeout(b.next(), 10000, "live update"); } while (!(got.type === "state" && got.doc && got.doc.by === by));
console.log("live update ok (rev " + got.doc.rev + ")");
a.ws.close(); b.ws.close();

const id = "smoke" + Date.now().toString(36);
const put = await fetch(base + "/t/" + table + "/games/" + id, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, endedAt: Date.now() }) });
if (!put.ok) fail("saving a game returned " + put.status);
const list = await (await fetch(base + "/t/" + table + "/games")).json();
if (!list.games.some((g) => g.id === id)) fail("saved game missing from the list");
const del = await fetch(base + "/t/" + table + "/games/" + id, { method: "DELETE" });
if (!del.ok) fail("deleting a game returned " + del.status);
const after = await (await fetch(base + "/t/" + table + "/games")).json();
if (after.games.some((g) => g.id === id)) fail("deleted game still listed");
console.log("game history ok");
console.log("PASS");
