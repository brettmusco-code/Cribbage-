// Checks a deployed sync server end to end: health, live updates between two
// connections on one table, the table list (listed and hidden), and saving,
// listing and deleting a finished game, and deleting the table. The test table ends up deleted.
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

// Table list: a game shows up while listed, and disappears once hidden
const game = (listed) => ({ v: 2, mode: "solo", names: ["Smoke", "Test"], sides: [{ score: 3 }, { score: 5 }], game: 1, winner: null, listed });
async function setAndWait(state) {
  a.ws.send(JSON.stringify({ type: "set", doc: { state, by } }));
  let m;
  do { m = await withTimeout(b.next(), 10000, "live update"); } while (!(m.type === "state" && m.doc && m.doc.by === by && m.doc.state.listed === state.listed));
}
const listedTables = async () => (await (await fetch(base + "/tables")).json()).tables;
await setAndWait(game(true));
const shown = (await listedTables()).find((t) => t.name === table);
if (!shown) fail("listed table missing from /tables");
if (shown.players.join(",") !== "Smoke,Test" || shown.scores.join(",") !== "3,5") fail("table summary wrong: " + JSON.stringify(shown));
if (shown.devices < 2) fail("expected 2 connected phones, got " + shown.devices);
await setAndWait(game(false));
if ((await listedTables()).some((t) => t.name === table)) fail("hidden table still listed");
console.log("table list ok");
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

// Deleting: a connected phone is told, the game and list entry are gone, and a phone reconnecting learns of it
const c = await withTimeout(connect(), 10000, "connection before delete");
await withTimeout(c.next(), 10000, "state before delete");
const delRes = await fetch(base + "/t/" + table, { method: "DELETE" });
if (!delRes.ok) fail("deleting the table returned " + delRes.status);
let note;
do { note = await withTimeout(c.next(), 10000, "deleted notice"); } while (note.type !== "deleted");
const afterDel = await (await fetch(base + "/t/" + table + "/state")).json();
if (afterDel.doc) fail("deleted table still has a game");
if ((await listedTables()).some((t) => t.name === table)) fail("deleted table still listed");
const d = await withTimeout(connect(), 10000, "connection after delete");
const onReconnect = await withTimeout(d.next(), 10000, "state after delete");
if (!(onReconnect.type === "state" && onReconnect.doc === null && onReconnect.deleted === true)) fail("reconnecting phone not told the table was deleted: " + JSON.stringify(onReconnect));
d.ws.close();
console.log("delete ok");
console.log("PASS");
