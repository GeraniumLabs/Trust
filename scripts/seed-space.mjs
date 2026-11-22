// Fill a space with a believable multi-agent session, for working on the space pages.
//   node scripts/seed-space.mjs [base] [login]
// Needs a local Worker with TRUST_DEV_LOGIN=1 and TRUST_SESSION_KEY set. Prints the space page URL.
const BASE = process.argv[2] ?? "http://127.0.0.1:8797";
const LOGIN = process.argv[3] ?? "jonathanherr";

const signIn = async () => (await fetch(`${BASE}/auth/dev?login=${LOGIN}`, { redirect: "manual" })).headers.get("set-cookie").split(";")[0];
const cookie = await signIn();
const call = async (method, path, body, token) => {
  const r = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.20", ...(token ? { authorization: `Bearer ${token}` } : { cookie }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(data)}`);
  return data;
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const made = await call("POST", "/spaces", { name: "todo-service", scopes: [{ id: "project", label: "todo-service", kind: "project" }] });
const S = `/spaces/${made.space}`;
const admin = made.adminToken;
const session = async (agent) => {
  const s = await call("POST", `${S}/sessions`, { scope: "project", agent, supervisor: "mergery" }, admin);
  return { ...s, agent };
};
const remember = (s, m) => call("POST", `${S}/remember`, { session: s.id, scope: "project", derivation: "observed", kind: "fact", ...m }, s.token);
const recall = (s, query) => call("POST", `${S}/recall`, { session: s.id, query }, s.token);
const head1 = "4be81f2", head2 = "a90c3d7", head3 = "e17b605";

const ada = await session("ada");
const kai = await session("kai");
const lin = await session("lin");

const m1 = await remember(ada, { title: "All reads go through db.js", body: "Every read of the todo table goes through the functions in src/db.js; routes never query SQLite directly.", sources: [{ uri: "src/db.js", hash: head1, kind: "file" }, { uri: "src/routes.js", hash: head1, kind: "file" }] });
await pause(40);
const m2 = await remember(ada, { title: "Titles are trimmed in db.js", body: "Todo titles are trimmed in save() in src/db.js, not in the route handlers.", sources: [{ uri: "src/db.js", hash: head1, kind: "file" }] });
await pause(40);
const m3 = await remember(kai, { title: "Date tests need TZ=UTC", body: "The date tests in test/dates.test.js fail unless TZ=UTC is set; CI sets it in the workflow.", sources: [{ uri: "test/dates.test.js", hash: head1, kind: "file" }, { uri: ".github/workflows/ci.yml", hash: head1, kind: "file" }] });
await pause(40);
const m4 = await remember(kai, { kind: "decision", derivation: "stated", title: "Max title length is 200", body: "Max title length?\n\n200 characters, enforced in save().", sources: [{ uri: "src/db.js", hash: head1, kind: "file" }] });
await pause(40);
await recall(lin, "where are titles validated");
await pause(40);
await recall(lin, "how do routes read todos");
await pause(40);
// lin says the same thing ada did: the judge folds it in as corroboration.
await remember(lin, { title: "All reads go through db.js", body: "Every read of the todo table goes through the functions in src/db.js; routes never query SQLite directly.", sources: [{ uri: "src/db.js", hash: head1, kind: "file" }] });
await pause(40);
const m6 = await remember(lin, { title: "Pagination uses cursors", body: "GET /todos pages with an opaque cursor (the last id), 50 per page, not offsets.", sources: [{ uri: "src/routes.js", hash: head1, kind: "file" }] });
await pause(40);
await recall(kai, "date tests failing timezone");
await pause(40);
// A contradiction from another session.
await remember(kai, { title: "Pagination uses offsets", body: "GET /todos does not page with cursors; it uses ?offset= and ?limit=, 50 per page.", sources: [{ uri: "src/routes.js", hash: head2, kind: "file" }] });
await pause(40);
// A merge that changes db.js: memories citing it go stale.
await call("POST", `${S}/changes`, { session: ada.id, ref: head2, title: "#4 Trim titles to 200" }, admin);
await call("POST", `${S}/source-changed`, { scope: "project", uri: "src/db.js", hash: head2 }, admin);
await pause(40);
// A newer figure supersedes the old one.
await remember(ada, { kind: "decision", derivation: "stated", title: "Max title length is 280", body: "Max title length?\n\n280 characters, enforced in save().", sources: [{ uri: "src/db.js", hash: head2, kind: "file" }] });
await pause(40);
const m8 = await remember(lin, { title: "Errors return problem+json", body: "API errors are returned as application/problem+json with a type and detail.", sources: [{ uri: "src/errors.js", hash: head2, kind: "file" }, { uri: "src/routes.js", hash: head2, kind: "file" }] });
await pause(40);
await recall(ada, "error response format");
await recall(kai, "error response format");
await pause(40);
// A secret is refused.
await remember(kai, { title: "Staging key", body: "The staging api_key = sk-live-9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c is in the README." }).catch(() => {});
await pause(40);
// kai retracts a note that turned out wrong.
const m9 = await remember(kai, { title: "Seed data loads on boot", body: "The server loads seed todos from seed.json on every boot.", sources: [{ uri: "src/server.js", hash: head2, kind: "file" }] });
await pause(40);
await call("POST", `${S}/retract`, { session: kai.id, scope: "project", entry: m9.id, reason: "seed only loads with --seed" }, kai.token);
await pause(40);
await call("POST", `${S}/changes`, { session: lin.id, ref: head3, title: "#5 problem+json for 404s" }, admin);
await call("POST", `${S}/source-changed`, { scope: "project", uri: "src/errors.js", hash: head3 }, admin);
await recall(lin, "titles");
await call("POST", `${S}/sessions/${kai.id}/end`, {}, admin);

console.log(`${BASE}/space/?id=${made.space}`);
console.log(`admin key: ${admin}`);
void [m1, m2, m3, m4, m6, m8];
