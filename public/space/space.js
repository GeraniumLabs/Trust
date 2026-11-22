// Trust space pages: Memory (files threaded to the memories that cite them) and Activity
// (a log with one lane per agent session). Read-only: the signed-in owner's cookie, or an
// admin key pasted into this tab.
{
  const $ = (id) => document.getElementById(id);
  const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const svgNS = "http://www.w3.org/2000/svg";
  const glyph = (g, cls, label) => `<svg class="g ${cls}" ${label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"'}><use href="#g-${g}"/></svg>`;
  const id = new URLSearchParams(location.search).get("id");
  let key = null; // an admin key pasted into this tab; never stored
  let data = null; // { info, entries, byId, relations, conflicts, receipts, events, sessions }
  let selected = null;

  const STATUS = {
    active: { label: "Active", g: "write", cls: "k-ink" },
    stale: { label: "Stale", g: "stale", cls: "k-stale" },
    contested: { label: "Contested", g: "contested", cls: "k-contested" },
    superseded: { label: "Superseded", g: "superseded", cls: "k-superseded" },
    retracted: { label: "Retracted", g: "cross", cls: "k-critical" },
    quarantined: { label: "Quarantined", g: "cross", cls: "k-critical" },
  };
  const statusChip = (s) => (s === "active" ? "" : `<span class="st ${s}">${glyph(STATUS[s]?.g ?? "write", "")}<span>${STATUS[s]?.label ?? s}</span></span>`);
  const TRUST_WORDS = { unverified: "Not yet checked against a source", sourced: "Cites the files it came from", reviewed: "Reviewed by a person" };
  const DERIVATION = { observed: "seen in the code", inferred: "worked out by the agent", stated: "stated by a person", imported: "imported", promoted: "promoted from a matter" };
  const when = (t) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const clock = (t) => new Date(t).toLocaleTimeString([], matchMedia("(max-width: 860px)").matches ? { hour: "numeric", minute: "2-digit" } : { hour: "numeric", minute: "2-digit", second: "2-digit" });

  // ---------- loading ----------
  async function get(path) {
    const r = await fetch(`/api/spaces/${id}${path}`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
    if (r.status === 401 || r.status === 403) throw Object.assign(new Error("denied"), { denied: true });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    return r.json();
  }

  async function load() {
    if (!id) { $("name").textContent = "No space chosen"; $("summary").innerHTML = `Open one from <a href="/new/">your spaces</a>.`; return; }
    try {
      const [info, graph, act] = await Promise.all([get(""), get("/graph"), get("/activity")]);
      const entries = [], relations = [], conflicts = [], receipts = [];
      for (const g of Object.values(graph.graphs)) {
        entries.push(...g.entries); relations.push(...g.relations); conflicts.push(...g.conflicts); receipts.push(...g.receipts);
      }
      data = { info, entries, byId: new Map(entries.map((e) => [e.id, e])), relations, conflicts, receipts, events: act.events, sessions: act.sessions };
      $("keyform").hidden = true;
      render();
    } catch (e) {
      if (e.denied) {
        $("name").textContent = "Open a space";
        $("summary").textContent = "";
        $("keyform").hidden = false;
        if (key) { $("keyerr").textContent = "That key wasn't accepted for this space."; $("keyerr").hidden = false; }
        return;
      }
      $("name").textContent = "Couldn't load this space";
      $("summary").textContent = e.message;
    }
  }

  $("keyform").addEventListener("submit", (e) => { e.preventDefault(); key = $("key").value.trim() || null; $("key").value = ""; load(); });

  fetch("/api/me").then((r) => (r.ok ? r.json() : null)).then((me) => {
    $("who").innerHTML = me ? `Signed in as <b>${esc(me.login)}</b>` : `<a href="/auth/github?return=${encodeURIComponent(location.pathname + location.search)}">Sign in</a>`;
  });

  // ---------- shared ----------
  function render() {
    const { info, entries } = data;
    $("name").textContent = info.name || `Space ${id}`;
    document.title = `${info.name || id}: Trust`;
    const agents = new Set(entries.map((e) => e.origin.agent));
    const by = (s) => entries.filter((e) => e.status === s).length;
    const parts = [["stale", "stale"], ["contested", "contested"], ["superseded", "superseded"], ["retracted", "retracted"]].map(([s, w]) => (by(s) ? `${by(s)} ${w}` : null)).filter(Boolean);
    $("summary").textContent = entries.length
      ? `${entries.length} ${entries.length === 1 ? "memory" : "memories"} from ${agents.size} ${agents.size === 1 ? "agent" : "agents"}${parts.length ? `. ${parts.join(", ")}.` : ", all active."}`
      : "No memories yet. They appear here as agents write them.";
    buildMemoryControls();
    buildActivityControls();
    route();
  }

  function route() {
    const view = location.hash === "#activity" ? "activity" : "memory";
    for (const a of document.querySelectorAll(".views a")) {
      if (a.dataset.view === view) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    }
    $("memory").hidden = view !== "memory";
    $("activity").hidden = view !== "activity";
    if (!data) return;
    if (view === "memory") renderMemory(); else renderActivity();
  }
  addEventListener("hashchange", route);

  // ---------- Memory ----------
  const memFilter = { q: "", statuses: new Set(["active", "stale", "contested", "superseded", "retracted", "quarantined"]), agent: "" };

  function buildMemoryControls() {
    const counts = {};
    for (const e of data.entries) counts[e.status] = (counts[e.status] ?? 0) + 1;
    $("statusChips").innerHTML = Object.entries(STATUS).filter(([s]) => counts[s] || s === "active")
      .map(([s, v]) => `<button type="button" class="chip" data-status="${s}" aria-pressed="${memFilter.statuses.has(s)}">${glyph(v.g, v.cls)}${v.label} <span class="n">${counts[s] ?? 0}</span></button>`).join("");
    const agents = [...new Set(data.entries.map((e) => e.origin.agent))].sort();
    $("agent").innerHTML = `<option value="">Every agent</option>` + agents.map((a) => `<option ${a === memFilter.agent ? "selected" : ""}>${esc(a)}</option>`).join("");
  }
  $("statusChips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-status]"); if (!b) return;
    const s = b.dataset.status;
    memFilter.statuses.has(s) ? memFilter.statuses.delete(s) : memFilter.statuses.add(s);
    b.setAttribute("aria-pressed", memFilter.statuses.has(s));
    renderMemory();
  });
  $("q").addEventListener("input", (e) => { memFilter.q = e.target.value.trim().toLowerCase(); renderMemory(); });
  $("agent").addEventListener("change", (e) => { memFilter.agent = e.target.value; renderMemory(); });

  function visibleEntries() {
    return data.entries.filter((e) => memFilter.statuses.has(e.status)
      && (!memFilter.agent || e.origin.agent === memFilter.agent)
      && (!memFilter.q || `${e.title} ${e.body} ${e.sources.map((s) => s.uri).join(" ")}`.toLowerCase().includes(memFilter.q)));
  }

  function renderMemory() {
    const list = visibleEntries();
    $("memEmpty").hidden = list.length > 0 || data.entries.length === 0;
    // Order memories by the file they cite first, files by how many memories cite them, so threads mostly run level.
    const cites = new Map();
    for (const e of list) for (const s of e.sources) cites.set(s.uri, (cites.get(s.uri) ?? 0) + 1);
    const fileRank = (uri) => [...cites.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).findIndex(([u]) => u === uri);
    const primary = (e) => (e.sources.length ? [...e.sources].sort((a, b) => fileRank(a.uri) - fileRank(b.uri))[0].uri : null);
    list.sort((a, b) => {
      const pa = primary(a), pb = primary(b);
      if (pa !== pb) return pa === null ? 1 : pb === null ? -1 : fileRank(pa) - fileRank(pb);
      return b.created_at - a.created_at;
    });
    const recalls = new Map();
    for (const r of data.receipts) recalls.set(r.entry, (recalls.get(r.entry) ?? 0) + Number(r.times));
    $("mems").innerHTML = list.map((e) => {
      const n = recalls.get(e.id) ?? 0, agree = e.corroborations?.length ?? 0;
      return `<li class="mem ${e.status}${selected === e.id ? " sel" : ""}" data-id="${esc(e.id)}" tabindex="0" role="button" aria-label="${esc(e.title)}">
        <p class="t"><span>${esc(e.title)}</span>${statusChip(e.status)}</p>
        <p class="b">${esc(e.body)}</p>
        <p class="src">${e.sources.map((s) => esc(s.uri)).join(", ")}</p>
        <p class="m"><span>${esc(e.origin.agent)}, ${when(e.created_at)}</span>${agree ? `<span>${agree} more ${agree === 1 ? "agent agrees" : "agents agree"}</span>` : ""}${n ? `<span>recalled ${n} ${n === 1 ? "time" : "times"}</span>` : ""}${e.kind === "decision" ? "<span>decision</span>" : ""}</p>
      </li>`;
    }).join("");
    $("files").innerHTML = [...cites.keys()].map((u) => `<button type="button" class="file" data-uri="${esc(u)}" title="${esc(u)}"><span class="path">&lrm;${esc(u)}</span><span class="n">${cites.get(u)}</span></button>`).join("");
    requestAnimationFrame(() => layoutLoom(list));
  }

  // Files sit beside the first memory that cites them; threads join each memory to its files.
  function layoutLoom(list) {
    const loom = $("loom"), files = $("files"), threads = $("threads"), arcs = $("arcs");
    const top = loom.getBoundingClientRect().top;
    const memY = new Map();
    for (const el of $("mems").children) { const r = el.getBoundingClientRect(); memY.set(el.dataset.id, { top: r.top - top, mid: r.top - top + 22, bottom: r.bottom - top }); }
    const height = Math.max(...[...memY.values()].map((m) => m.bottom), 0);
    const narrow = getComputedStyle(files).display === "none";
    arcs.setAttribute("height", height); arcs.style.height = `${height}px`;
    if (!narrow) {
      files.style.position = "relative"; files.style.height = `${height}px`;
      const firstFor = (uri) => Math.min(...list.filter((e) => e.sources.some((s) => s.uri === uri)).map((e) => memY.get(e.id)?.mid ?? Infinity));
      const fileEls = [...files.children].sort((a, b) => firstFor(a.dataset.uri) - firstFor(b.dataset.uri));
      let next = 0;
      for (const el of fileEls) {
        const want = firstFor(el.dataset.uri) - 16;
        const y = Math.max(next, want);
        Object.assign(el.style, { position: "absolute", top: `${y}px`, left: "0", right: "0" });
        next = y + 34;
      }
      files.style.height = `${Math.max(height, next)}px`;
      const fileY = new Map(fileEls.map((el) => [el.dataset.uri, parseFloat(el.style.top) + 16]));
      const w = threads.getBoundingClientRect().width, h = Math.max(height, next);
      threads.setAttribute("viewBox", `0 0 ${w} ${h}`);
      threads.style.height = `${h}px`;
      let paths = "";
      for (const e of list) {
        const m = memY.get(e.id); if (!m) continue;
        for (const s of e.sources) {
          const y1 = fileY.get(s.uri); if (y1 === undefined) continue;
          const c = w * 0.55;
          paths += `<path data-id="${esc(e.id)}" data-uri="${esc(s.uri)}" class="${e.status}" d="M0 ${y1} C ${c} ${y1}, ${w - c} ${m.mid}, ${w} ${m.mid}"/>`;
        }
      }
      for (const [, y] of fileY) paths += `<circle cx="0" cy="${y}" r="3"/>`;
      threads.innerHTML = paths;
    }
    // Arcs on the right: contradictions, supersessions, and pairs the judge wasn't sure about.
    const pairs = [];
    for (const c of data.conflicts) pairs.push({ a: c.a, b: c.b, cls: "conflict", label: c.status === "open" ? "conflict" : c.resolution ?? "resolved" });
    for (const e of data.entries) if (e.superseded_by) pairs.push({ a: e.superseded_by, b: e.id, cls: "supersedes", label: "replaces" });
    const seen = new Set();
    for (const e of data.entries) for (const u of e.unsure ?? []) {
      const pair = [u.entry, u.with].sort().join("|");
      if (u.status !== "open" || seen.has(pair)) continue;
      seen.add(pair);
      pairs.push({ a: u.entry, b: u.with, cls: "unsure", label: "unsure" });
    }
    let out = "", level = 0;
    for (const p of pairs) {
      const a = memY.get(p.a), b = memY.get(p.b); if (!a || !b) continue;
      const x = 14 + (level++ % 3) * 12;
      out += `<path class="${p.cls}" d="M0 ${a.mid} C ${x} ${a.mid}, ${x} ${b.mid}, 0 ${b.mid}"/>`;
    }
    arcs.innerHTML = out;
  }

  // Hover a file to see what depends on it; hover a memory to see what it rests on.
  function highlight({ uri, mem }) {
    const paths = $("threads").querySelectorAll("path");
    const on = new Set();
    for (const p of paths) {
      const hit = (uri && p.dataset.uri === uri) || (mem && p.dataset.id === mem);
      p.classList.toggle("hot", !!hit); p.classList.toggle("dim", !!(uri || mem) && !hit);
      if (hit) on.add(p.dataset.id), on.add(p.dataset.uri);
    }
    for (const el of $("mems").children) el.classList.toggle("dim", !!uri && !on.has(el.dataset.id));
    for (const el of $("files").children) el.classList.toggle("on", on.has(el.dataset.uri));
  }
  $("files").addEventListener("pointerover", (e) => { const f = e.target.closest(".file"); if (f) highlight({ uri: f.dataset.uri }); });
  $("files").addEventListener("pointerleave", () => highlight({}));
  $("files").addEventListener("click", (e) => { const f = e.target.closest(".file"); if (f) { $("q").value = f.dataset.uri; memFilter.q = f.dataset.uri.toLowerCase(); renderMemory(); } });
  $("mems").addEventListener("pointerover", (e) => { const m = e.target.closest(".mem"); if (m) highlight({ mem: m.dataset.id }); });
  $("mems").addEventListener("pointerleave", () => highlight({}));
  $("mems").addEventListener("click", (e) => { const m = e.target.closest(".mem"); if (m) openMemory(m.dataset.id); });
  $("mems").addEventListener("keydown", (e) => { const m = e.target.closest(".mem"); if (m && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openMemory(m.dataset.id); } });
  new ResizeObserver(() => { if (data && !$("memory").hidden) layoutLoom(visibleEntries()); }).observe($("loom"));

  // ---------- one memory ----------
  function openMemory(entryId) {
    const e = data.byId.get(entryId);
    if (!e) return;
    selected = entryId;
    for (const el of $("mems").children) el.classList.toggle("sel", el.dataset.id === entryId);
    const recalls = data.receipts.filter((r) => r.entry === entryId);
    const sessionAgent = (sid) => data.sessions.find((s) => s.id === sid)?.agent ?? sid;
    const history = data.events.filter((x) => x.entry === entryId || x.other === entryId).sort((a, b) => a.at - b.at);
    const link = (oid) => `<button class="rel" data-open="${esc(oid)}">${esc(data.byId.get(oid)?.title ?? oid)}</button>`;
    const related = [
      ...data.conflicts.filter((c) => c.a === entryId || c.b === entryId).map((c) => `<li>${glyph("contested", "k-contested")} Contradicts ${link(c.a === entryId ? c.b : c.a)}${c.status === "open" ? ", waiting for a person to decide" : `, ${esc(c.resolution ?? "resolved")}`}</li>`),
      ...(e.superseded_by ? [`<li>${glyph("superseded", "k-superseded")} Replaced by ${link(e.superseded_by)}</li>`] : []),
      ...data.entries.filter((x) => x.superseded_by === entryId).map((x) => `<li>${glyph("superseded", "k-superseded")} Replaces ${link(x.id)}</li>`),
      ...(e.unsure ?? []).map((u) => `<li>${glyph("unsure", "k-judge")} The judge wasn't sure how this relates to ${link(u.entry === entryId ? u.with : u.entry)} (${esc(u.first?.relation ?? "?")}, ${Math.round((u.first?.confidence ?? 0) * 100)}% sure)${u.status === "open" ? "; the agent was told and decides" : `; ${esc(u.decision ?? "decided")}`}</li>`),
    ];
    $("dBody").innerHTML = `
      <h2 id="dTitle">${esc(e.title)}</h2>
      <p>${statusChip(e.status) || `<span class="st" style="color:var(--k-write)">${glyph("write", "")}<span>Active</span></span>`}</p>
      <p class="body">${esc(e.body)}</p>
      <h3>Where it came from</h3>
      <p>${esc(e.origin.agent)} wrote it in session ${esc(e.origin.session)}${e.origin.supervisor ? `, supervised by ${esc(e.origin.supervisor)}` : ""}, ${when(e.created_at)}. ${esc(DERIVATION[e.derivation] ? `It was ${DERIVATION[e.derivation]}.` : "")}</p>
      <p>${esc(TRUST_WORDS[e.trust] ?? e.trust)}.</p>
      ${e.sources.length ? `<ul>${e.sources.map((s) => `<li><code>${esc(s.uri)}</code>${s.hash ? ` at <code>${esc(String(s.hash).slice(0, 7))}</code>` : ""}</li>`).join("")}</ul>` : `<p>It cites no files.</p>`}
      ${e.corroborations?.length ? `<h3>Others who said the same</h3><ul>${e.corroborations.map((c) => `<li>${esc(c.agent)}, ${when(c.at)}${c.judge ? ` (merged by the ${esc(c.judge)} judge)` : ""}</li>`).join("")}</ul>` : ""}
      ${related.length ? `<h3>Related memories</h3><ul>${related.join("")}</ul>` : ""}
      <h3>Recalled</h3>
      ${recalls.length ? `<ul>${recalls.map((r) => `<li>${esc(sessionAgent(r.session))} recalled it ${r.times} ${Number(r.times) === 1 ? "time" : "times"}, first ${when(r.first_at)}</li>`).join("")}</ul>` : `<p>No agent has recalled it yet.</p>`}
      <h3>History</h3>
      <ul class="hist">${history.map((x) => `<li>${eventGlyph(x)}<span>${clock(x.at)}: ${eventText(x, entryId)}</span></li>`).join("")}</ul>`;
    $("drawer").hidden = false;
    $("dClose").focus();
  }
  $("dClose").addEventListener("click", () => { $("drawer").hidden = true; selected = null; for (const el of $("mems").children) el.classList.remove("sel"); });
  addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("drawer").hidden) $("dClose").click(); });
  document.addEventListener("click", (e) => { const b = e.target.closest("[data-open]"); if (b) openMemory(b.dataset.open); });

  // ---------- Activity ----------
  const KINDS = {
    write: { label: "Writes", g: "write", cls: "k-write", has: (k) => k === "write" },
    recall: { label: "Recalls", g: "recall", cls: "k-recall", has: (k) => k === "recall" },
    judge: { label: "Judge", g: "judge", cls: "k-judge", has: (k) => ["judged", "corroborated", "unsure", "conflict"].includes(k) },
    status: { label: "Status changes", g: "stale", cls: "k-stale", has: (k) => k === "status" },
    system: { label: "Sessions and merges", g: "merge", cls: "k-ink", has: (k) => ["session", "session_end", "change", "source_changed", "admin"].includes(k) },
    refused: { label: "Refused", g: "cross", cls: "k-critical", has: (k) => k === "refused" },
  };
  const actFilter = { kinds: new Set(Object.keys(KINDS)), agent: "" };
  const kindOf = (k) => Object.keys(KINDS).find((x) => KINDS[x].has(k));

  function buildActivityControls() {
    const counts = {};
    for (const e of data.events) { const k = kindOf(e.kind); if (k) counts[k] = (counts[k] ?? 0) + 1; }
    $("kindChips").innerHTML = Object.entries(KINDS).map(([k, v]) => `<button type="button" class="chip" data-kind="${k}" aria-pressed="${actFilter.kinds.has(k)}">${glyph(v.g, v.cls)}${v.label} <span class="n">${counts[k] ?? 0}</span></button>`).join("");
    const agents = [...new Set(data.sessions.map((s) => s.agent))].sort();
    $("lagent").innerHTML = `<option value="">Every agent</option>` + agents.map((a) => `<option>${esc(a)}</option>`).join("");
  }
  $("kindChips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-kind]"); if (!b) return;
    const k = b.dataset.kind;
    actFilter.kinds.has(k) ? actFilter.kinds.delete(k) : actFilter.kinds.add(k);
    b.setAttribute("aria-pressed", actFilter.kinds.has(k));
    renderActivity();
  });
  $("lagent").addEventListener("change", (e) => { actFilter.agent = e.target.value; renderActivity(); });

  function eventGlyph(x) {
    switch (x.kind) {
      case "write": return glyph("write", "k-write", "Write");
      case "recall": return glyph("recall", "k-recall ring", "Recall");
      case "judged": case "corroborated": return glyph("judge", "k-judge", "Judge");
      case "conflict": return glyph("contested", "k-contested", "Conflict");
      case "unsure": return glyph("unsure", "k-judge", "Unsure");
      case "status": {
        const s = STATUS[x.status] ?? STATUS.active;
        return x.status === "active" ? glyph("judge", "k-judge", "Updated") : glyph(s.g, s.cls, s.label);
      }
      case "refused": return glyph("cross", "k-critical", "Refused");
      case "change": return glyph("merge", "k-ink", "Merge");
      case "source_changed": return glyph("merge", "k-stale", "Files changed");
      default: return glyph("session", "k-muted", "Session");
    }
  }

  function eventText(x, here) {
    const t = (eid, title) => (eid && eid !== here && data.byId.has(eid) ? `<button class="link" data-open="${esc(eid)}">${esc(title ?? data.byId.get(eid).title)}</button>` : `<b>${esc(title ?? data.byId.get(eid)?.title ?? eid ?? "")}</b>`);
    const pct = (c) => (c == null ? "" : ` <span class="q">(${Math.round(c * 100)}% sure)</span>`);
    const who = x.actor ?? agentOfSession(x.session) ?? "An agent";
    switch (x.kind) {
      case "write": return `${esc(who)} wrote ${t(x.entry, x.title)}`;
      case "recall": return `${esc(agentOfSession(x.session) ?? "An agent")} recalled ${t(x.entry, x.title)}${x.rank ? ` <span class="q">(result ${Number(x.rank)})</span>` : ""}`;
      case "corroborated": return `${esc(who)} said the same as ${t(x.entry, x.title)}, so the judge kept one memory and added ${esc(who)} as agreeing`;
      case "judged": {
        const what = { merged: "merged them", conflict: "opened a conflict", superseded: "marked the older one replaced" }[x.action] ?? esc(x.action);
        const other = String(x.entry).startsWith("merged:") ? t(x.other, x.otherTitle) : `${t(x.entry, x.title)} and ${t(x.other, x.otherTitle)}`;
        return `The judge found ${x.relation === "duplicate" ? "a duplicate of" : x.relation === "contradicts" ? "a contradiction between" : `${esc(x.relation)}:`} ${other} and ${what}${pct(x.confidence)}`;
      }
      case "unsure": return `The judge wasn't sure how ${t(x.entry, x.title)} relates to ${t(x.other, x.otherTitle)}${pct(x.confidence)}, so it told the agent${x.second ? ` and asked a second judge, who said ${esc(x.second.relation)}${pct(x.second.confidence)}` : ""}`;
      case "conflict": return `${t(x.entry, x.title)} and ${t(x.other, x.otherTitle)} contradict each other${x.status === "open" ? "; a person decides" : `; ${esc(x.resolution ?? "resolved")}`}`;
      case "status": {
        if (x.status === "active") return `${t(x.entry, x.title)} was updated${x.detail ? `: ${esc(x.detail)}` : ""}`;
        const sc = /^source changed: (.*) is now (\w+)/.exec(x.detail ?? "");
        const why = sc ? `: <code>${esc(sc[1])}</code> changed at <code>${esc(sc[2].slice(0, 7))}</code>` : x.status === "contested" ? "" : x.detail ? `: ${esc(x.detail)}` : "";
        const verb = { stale: "went stale", contested: "is contested", retracted: `was retracted by ${esc(x.actor)}`, superseded: "was replaced", quarantined: "was quarantined" }[x.status] ?? `is now ${esc(x.status)}`;
        return `${t(x.entry, x.title)} ${verb}${x.status === "retracted" ? (x.detail ? `: ${esc(x.detail)}` : "") : why}`;
      }
      case "refused": return `Refused ${esc(x.actor)}'s ${esc(x.action === "remember" ? "write" : x.action)}: ${esc(x.detail)}`;
      case "change": return `Merged ${esc(x.detail)} at <code>${esc(String(x.ref).slice(0, 7))}</code>${agentOfSession(x.session) ? `, ${esc(agentOfSession(x.session))}'s work` : ""}`;
      case "source_changed": {
        const m = /^(.*) -> (\w+): flagged (.*)$/.exec(x.detail ?? "");
        return m ? `<code>${esc(m[1])}</code> changed at <code>${esc(m[2].slice(0, 7))}</code>; ${m[3] === "nothing" ? "no memories cite it" : `${m[3].split(", ").length} ${m[3].split(", ").length === 1 ? "memory" : "memories"} went stale`}` : esc(x.detail);
      }
      case "session": return `${esc(x.actor)} started a session`;
      case "session_end": { const sid = /^(s-\d+)/.exec(x.detail ?? "")?.[1]; return `${esc(agentOfSession(sid) ?? "An agent")}'s session ended`; }
      default: return x.action === "setup" ? "The space was created" : esc(x.detail ?? x.action ?? x.kind);
    }
  }

  const agentOfSession = (sid) => (sid ? data.sessions.find((s) => s.id === sid)?.agent : null);
  // Which lane an event sits in: its session's, or Trust's own lane (0) for system events.
  function laneOf(x, lanes) {
    let sid = x.session;
    if (!sid && x.kind === "session") sid = /^(s-\d+)/.exec(x.detail ?? "")?.[1];
    if (!sid && x.kind === "session_end") sid = /^(s-\d+)/.exec(x.detail ?? "")?.[1];
    if (!sid && (x.kind === "judged" || x.kind === "unsure" || x.kind === "conflict")) sid = data.byId.get(x.entry)?.origin.session ?? data.byId.get(x.other)?.origin.session;
    if (!sid && x.actor) sid = [...data.sessions].filter((s) => s.agent === x.actor && s.started_at <= x.at).pop()?.id;
    const i = lanes.findIndex((l) => l.id === sid);
    return i < 0 ? 0 : i + 1;
  }

  function renderActivity() {
    const lanes = [...data.sessions].sort((a, b) => a.started_at - b.started_at);
    const endAt = new Map();
    for (const e of data.events) if (e.kind === "session_end") { const sid = /^(s-\d+)/.exec(e.detail ?? "")?.[1]; if (sid) endAt.set(sid, e.at); }
    const events = data.events.filter((x) => {
      if (x.kind === "admin" && x.action === "remember") return false; // the corroborated row says it
      if (x.kind === "status" && x.status === "active" && /^corroborated/.test(x.detail ?? "")) return false;
      const k = kindOf(x.kind);
      if (!k || !actFilter.kinds.has(k)) return false;
      if (actFilter.agent) { const l = laneOf(x, lanes); return l > 0 && lanes[l - 1].agent === actFilter.agent; }
      return true;
    });
    $("logEmpty").hidden = events.length > 0;
    const gutter = 20 + 18 * lanes.length;
    $("log").style.setProperty("--gutter", `${gutter}px`);
    const laneX = (i) => 10 + 18 * i;
    let html = "", lastDay = "";
    for (const x of events) {
      const day = new Date(x.at).toDateString();
      if (day !== lastDay) { html += `<li class="day">${new Date(x.at).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</li>`; lastDay = day; }
      const lane = laneOf(x, lanes);
      const lines = lanes.map((l, i) => (l.started_at <= x.at && (!endAt.has(l.id) || endAt.get(l.id) >= x.at) ? `<i style="left:${laneX(i + 1)}px"></i>` : "")).join("");
      const sys = x.kind === "change" || x.kind === "source_changed";
      const mark = eventGlyph(x).replace('<svg class="g ', `<svg style="left:${laneX(lane)}px" class="g `);
      html += `<li class="ev${sys ? " system" : ""}" data-at="${x.at}"><span class="time">${clock(x.at)}</span><span class="lanes">${lines}${mark}</span><span class="txt">${eventText(x)}</span></li>`;
    }
    $("log").innerHTML = html;
    drawOverview(events);
  }

  // A strip of event counts over time; click a bar to jump there in the log.
  function drawOverview(events) {
    const svg = $("ovSvg"), W = svg.clientWidth, H = svg.clientHeight;
    const ts = events.map((e) => e.at), min = Math.min(...ts), max = Math.max(...ts);
    // Under a minute of activity has no shape worth charting.
    $("ov").hidden = !events.length || max - min < 60e3;
    if ($("ov").hidden) { $("ovCap").textContent = events.length ? `${events.length} events within a minute` : ""; return; }
    if (!W) return;
    const steps = [1e3, 5e3, 15e3, 6e4, 3e5, 9e5, 36e5, 108e5, 216e5, 864e5, 6048e5];
    const step = steps.find((s) => (max - min) / s <= 60) ?? steps.at(-1);
    const start = Math.floor(min / step) * step, n = Math.max(1, Math.ceil((max - start + 1) / step));
    const counts = new Array(n).fill(0);
    for (const t of ts) counts[Math.min(n - 1, Math.floor((t - start) / step))]++;
    const peak = Math.max(...counts), bw = W / n, base = H - 16;
    const label = (t) => (step >= 864e5 ? new Date(t).toLocaleDateString([], { month: "short", day: "numeric" }) : step >= 6e4 ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : clock(t));
    let out = `<line class="base" x1="0" x2="${W}" y1="${base}" y2="${base}"/>`;
    counts.forEach((c, i) => {
      const h = c ? Math.max(3, (c / peak) * (base - 6)) : 0;
      if (c) out += `<rect class="bar" data-i="${i}" x="${i * bw + 1}" y="${base - h}" width="${Math.max(1, bw - 2)}" height="${h}" rx="${Math.min(4, bw / 3)}"/>`;
      out += `<rect class="hit" data-i="${i}" x="${i * bw}" y="0" width="${bw}" height="${H}"/>`;
    });
    out += `<text x="0" y="${H - 2}">${label(start)}</text><text x="${W}" y="${H - 2}" text-anchor="end">${label(start + n * step)}</text>`;
    svg.innerHTML = out;
    $("ovCap").textContent = `Events over time, ${step >= 36e5 ? `${step / 36e5}-hour` : step >= 6e4 ? `${step / 6e4}-minute` : `${step / 1e3}-second`} buckets`;
    const tip = $("ovTip");
    svg.onpointermove = (e) => {
      const r = e.target.closest?.("[data-i]"); if (!r) { tip.hidden = true; return; }
      const i = Number(r.dataset.i);
      for (const b of svg.querySelectorAll("rect.bar")) b.classList.toggle("hot", b.dataset.i === String(i));
      tip.textContent = `${counts[i]} ${counts[i] === 1 ? "event" : "events"}, ${label(start + i * step)}`;
      tip.style.left = `${(i + 0.5) * bw}px`; tip.hidden = false;
    };
    svg.onpointerleave = () => { tip.hidden = true; for (const b of svg.querySelectorAll("rect.bar")) b.classList.remove("hot"); };
    svg.onclick = (e) => {
      const r = e.target.closest?.("[data-i]"); if (!r) return;
      const from = start + Number(r.dataset.i) * step, to = from + step;
      const row = [...$("log").querySelectorAll(".ev")].find((li) => Number(li.dataset.at) >= from && Number(li.dataset.at) < to);
      row?.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    };
  }
  new ResizeObserver(() => { if (data && !$("activity").hidden) renderActivity(); }).observe($("ov"));

  load();
}
