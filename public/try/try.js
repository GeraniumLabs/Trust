// The simple demo: one memory's life in four steps, against a real throwaway Trust space.
{
  const $ = (id) => document.getElementById(id);
  const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const LETTER = "northwind/engagement-letter.pdf";
  const SCOPE = "northwind";
  const names = { "intake-agent": "the intake agent", "drafting-agent": "the drafting agent" };
  const who = (a) => names[a] ?? a;
  const source = (s) => (s.uri === LETTER ? `Engagement letter, ${s.hash}` : `${s.uri}${s.hash ? ` at ${s.hash}` : ""}`);
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });

  let s = null; // { demo, admin, intake, drafter, oldId, newId }
  let step = 1;

  // Every call goes to the real API; the last one is shown under "What Trust was asked".
  async function api(method, path, body, token) {
    const r = await fetch(`/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Trust answered HTTP ${r.status}`);
    return data;
  }
  const inSpace = (method, path, body, token) => api(method, `/demo/${s.demo}${path}`, body, token);
  function showCall(method, path, body, answer) {
    const shown = { ...body };
    delete shown.session;
    $("callText").textContent = `${method} /api/demo/<space>${path}\nAuthorization: Bearer <${path === "/source-changed" ? "admin" : "agent session"} token>\n\n${JSON.stringify(shown, null, 2)}\n\nTrust answered:\n${JSON.stringify(answer, null, 2).slice(0, 900)}`;
    $("call").hidden = false;
  }

  const STEPS = {
    async 1() {
      const d = await api("POST", "/demo");
      s = { demo: d.demo, admin: d.adminToken };
      const start = (agent) => inSpace("POST", "/sessions", { scope: SCOPE, agent, supervisor: "the supervising lawyer" }, s.admin);
      s.intake = await start("intake-agent");
      s.drafter = await start("drafting-agent");
      const body = {
        scope: SCOPE, kind: "fact", derivation: "observed",
        title: "Notice period is 30 days",
        body: "Either party may end the engagement with 30 days' written notice (section 9).",
        sources: [{ uri: LETTER, hash: "version 3", kind: "doc" }],
      };
      const out = await inSpace("POST", "/remember", { ...body, session: s.intake.id }, s.intake.token);
      s.oldId = out.id;
      showCall("POST", "/remember", body, { id: out.id, status: out.status, trust: out.trust });
      return "The intake agent saved one memory. Trust tagged it with the letter and the version it came from, and signed it with the agent's session.";
    },
    async 2() {
      const body = { query: "how much notice to end the engagement" };
      const out = await inSpace("POST", "/recall", { ...body, session: s.drafter.id }, s.drafter.token);
      const hit = (out.results ?? [])[0];
      showCall("POST", "/recall", body, { results: (out.results ?? []).slice(0, 1).map((r) => ({ id: r.id, title: r.title, status: r.status, sources: r.sources })) });
      return hit
        ? `Trust answered the drafting agent with <b>${esc(hit.title)}</b>, and the letter it came from. It also noted that the drafting agent relied on it.`
        : "Trust found nothing to answer with.";
    },
    async 3() {
      const body = { scope: SCOPE, uri: LETTER, hash: "version 4" };
      const out = await inSpace("POST", "/source-changed", body, s.admin);
      showCall("POST", "/source-changed", body, out);
      const n = (out.flagged ?? []).length;
      return `The letter changed, so <b>${n} ${n === 1 ? "memory" : "memories"}</b> resting on it went stale. The drafting agent relied on it, so its draft needs another look. Agents that recall it now see the warning first.`;
    },
    async 4() {
      const body = {
        scope: SCOPE, kind: "fact", derivation: "observed",
        title: "Notice period is 45 days",
        body: "Version 4 extends notice to 45 days' written notice (section 9).",
        sources: [{ uri: LETTER, hash: "version 4", kind: "doc" }],
      };
      const out = await inSpace("POST", "/remember", { ...body, session: s.intake.id }, s.intake.token);
      s.newId = out.id;
      // The judge may already have marked the old one replaced; if not, the agent says so itself.
      const g = await graph();
      if (g.entries.find((e) => e.id === s.oldId)?.status !== "superseded") {
        await inSpace("POST", "/relate", { session: s.intake.id, scope: SCOPE, entry: s.newId, other: s.oldId, relation: "supersedes", note: "read from version 4" }, s.intake.token);
      }
      showCall("POST", "/remember", body, { id: out.id, status: out.status, trust: out.trust });
      return "The intake agent read version 4 and saved the new term. Trust marked the old memory replaced. Nothing was deleted: its whole history is still there.";
    },
  };

  async function graph() {
    const g = await inSpace("GET", "/graph", undefined, s.admin);
    return g.graphs[SCOPE];
  }

  async function render() {
    const g = await graph();
    const recalls = new Map();
    for (const r of g.receipts) recalls.set(r.entry, (recalls.get(r.entry) ?? []).concat(r));
    const byId = new Map(g.entries.map((e) => [e.id, e]));
    const order = [s.newId, s.oldId].filter(Boolean).map((id) => byId.get(id)).filter(Boolean);
    $("tags").innerHTML = order.map((e) => {
      const r = recalls.get(e.id) ?? [];
      const times = r.reduce((n, x) => n + Number(x.times), 0);
      const fresh = (step === 2 && e.id === s.oldId) || (step === 5 && e.id === s.newId) ? " fresh" : "";
      return `<article class="tag${e.status === "superseded" ? " superseded" : ""}${fresh}">
        <h3>${esc(e.title)}</h3>
        <dl>
          <dt>From</dt><dd>${e.sources.map(source).map(esc).join(", ")}</dd>
          <dt>Saved by</dt><dd>${esc(who(e.origin.agent))}</dd>
          <dt>Relied on</dt><dd>${times ? `${times} ${times === 1 ? "time" : "times"}, by ${esc(who("drafting-agent"))}` : "not yet"}</dd>
        </dl>
        ${e.status === "superseded" ? `<span class="note">Replaced by "${esc(byId.get(e.superseded_by)?.title ?? "a newer memory")}"</span>` : ""}
        ${e.status === "stale" ? `<span class="tape">Stale: letter revised to version 4</span>` : ""}
      </article>`;
    }).join("");

    // The old memory's chain of custody, from the space's activity.
    const act = await inSpace("GET", "/activity", undefined, s.admin);
    const events = act.events.filter((x) => x.entry === s.oldId || (x.other === s.oldId && x.kind !== "unsure")).sort((a, b) => a.at - b.at);
    const items = [];
    for (const x of events) {
      if (x.kind === "write") items.push({ ring: "tagged", text: `<b>Saved</b> by ${esc(who(x.actor))} from the engagement letter, version 3`, at: x.at });
      else if (x.kind === "recall") items.push({ text: `<b>Relied on</b> by ${esc(who(act.sessions.find((y) => y.id === x.session)?.agent ?? "an agent"))}`, at: x.at });
      else if (x.kind === "status" && x.status === "stale") items.push({ ring: "stale", broken: true, text: `<b>Stale.</b> The letter was revised to version 4`, at: x.at });
      else if (x.kind === "status" && x.status === "superseded") items.push({ ring: "tagged", text: `<b>Replaced</b> by "Notice period is 45 days", read from version 4`, at: x.at });
    }
    $("chain").innerHTML = items.map((i) => `<li class="${i.broken ? "broken" : ""}"><span class="ring ${i.ring ?? ""}" aria-hidden="true"></span><span><span class="when">${clock(i.at)}</span>${i.text}</span></li>`).join("");
    $("custody").hidden = !items.length;
  }

  function paintSteps() {
    for (const li of document.querySelectorAll(".step")) {
      const n = Number(li.dataset.step);
      li.classList.toggle("done", n < step);
      li.classList.toggle("todo", n > step);
      li.classList.toggle("stale-step", n === 3);
      const b = li.querySelector("button");
      b.disabled = n !== step;
    }
    $("done").hidden = step <= 4;
  }

  $("steps").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-go]");
    if (!b || Number(b.dataset.go) !== step) return;
    b.setAttribute("aria-busy", "true");
    try {
      const said = await STEPS[step]();
      step++;
      $("say").innerHTML = said;
      await render();
      paintSteps();
      const next = document.querySelector(`[data-go="${step}"]`);
      // On a phone the result sits below the steps: show it, with the next step's button under it.
      $("next").hidden = !next;
      if (next) $("next").textContent = `Next: ${next.textContent}`;
      if (matchMedia("(max-width: 860px)").matches) {
        $("say").scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
        ($("next").hidden ? $("done").querySelector("a, button") : $("next")).focus({ preventScroll: true });
      } else {
        (next ?? $("done").querySelector("a, button"))?.focus({ preventScroll: true });
      }
    } catch (err) {
      $("say").innerHTML = `<span class="err">That step didn't go through: ${esc(err.message)}. Try again, or start over.</span>`;
    } finally {
      b.removeAttribute("aria-busy");
    }
  });

  $("next").addEventListener("click", () => document.querySelector(`[data-go="${step}"]`)?.click());

  $("again").addEventListener("click", () => {
    s = null; step = 1;
    $("tags").innerHTML = ""; $("chain").innerHTML = ""; $("custody").hidden = true; $("call").hidden = true; $("next").hidden = true;
    $("say").innerHTML = "Press <b>Save the memory</b> to start.";
    paintSteps();
    document.querySelector('[data-go="1"]').focus();
  });

  paintSteps();
}
