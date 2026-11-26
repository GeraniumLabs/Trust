// Sign in with GitHub, for people who create and own spaces. A signed cookie
// (HMAC-SHA256 with TRUST_SESSION_KEY) carries the GitHub id and login; Trust
// keeps no password or GitHub token. Agents never use this: they use the
// bearer tokens a space's admin gives them.

export interface AuthEnv {
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Signs the sign-in cookie. Without it, nobody can sign in. */
  TRUST_SESSION_KEY?: string;
  /** "1" in local development: /auth/dev?login=x signs in without GitHub. */
  TRUST_DEV_LOGIN?: string;
}

export interface User { id: string; login: string }

const COOKIE = "trust_user";
const STATE = "trust_oauth";
const DAYS_30 = 30 * 24 * 3600;

const enc = new TextEncoder();
const b64url = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmac(key: string, data: string) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

async function sign(key: string, payload: object) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  return `${body}.${await hmac(key, body)}`;
}

async function verify<T>(key: string, value: string | undefined): Promise<T | null> {
  if (!value) return null;
  const [body, mac] = value.split(".");
  if (!body || !mac) return null;
  const want = await hmac(key, body);
  if (want.length !== mac.length) return null;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ mac.charCodeAt(i);
  if (diff) return null;
  try {
    const p = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/"))) as T & { exp: number };
    return p.exp > Date.now() ? p : null;
  } catch {
    return null;
  }
}

const cookies = (req: Request) => Object.fromEntries((req.headers.get("cookie") ?? "").split(/;\s*/).filter(Boolean).map((c) => [c.slice(0, c.indexOf("=")), c.slice(c.indexOf("=") + 1)]));

function setCookie(req: Request, name: string, value: string, maxAge: number) {
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

/** Only same-site paths, so a sign-in link can't send someone elsewhere. */
const safeReturn = (r: string | null) => (r && r.startsWith("/") && !r.startsWith("//") ? r : "/new/");

/** The signed-in person, or null. */
export async function currentUser(req: Request, env: AuthEnv): Promise<User | null> {
  if (!env.TRUST_SESSION_KEY) return null;
  const p = await verify<User>(env.TRUST_SESSION_KEY, cookies(req)[COOKIE]);
  return p ? { id: p.id, login: p.login } : null;
}

export const signInReady = (env: AuthEnv) => !!env.TRUST_SESSION_KEY && (!!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) || env.TRUST_DEV_LOGIN === "1");

async function signedIn(req: Request, env: AuthEnv, user: User, to: string) {
  const value = await sign(env.TRUST_SESSION_KEY!, { ...user, exp: Date.now() + DAYS_30 * 1000 });
  const h = new Headers({ location: to });
  h.append("set-cookie", setCookie(req, COOKIE, value, DAYS_30));
  h.append("set-cookie", setCookie(req, STATE, "", 0));
  return new Response(null, { status: 302, headers: h });
}

// GitHub rejects requests without a User-Agent, and Workers' fetch sends none.
const UA = "trust (+https://github.com/GeraniumLabs/Trust)";

interface TokenResult { access_token?: string; error?: string; error_description?: string; status?: number }

/** Trade the callback's code for a token. GitHub answers 200 with { error } for most failures. */
async function exchangeCode(env: AuthEnv, code: string, redirectUri: string): Promise<TokenResult> {
  try {
    const r = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "user-agent": UA },
      body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: redirectUri }),
    });
    const text = await r.text();
    try {
      return { ...(JSON.parse(text) as TokenResult), status: r.status };
    } catch {
      return { error: "non_json_response", error_description: text.slice(0, 200), status: r.status };
    }
  } catch (e) {
    return { error: "fetch_failed", error_description: String(e) };
  }
}

/** A short, secret-free hint for the person, so a config problem is visible without reading logs. */
function tokenHint(error?: string) {
  const hints: Record<string, string> = {
    incorrect_client_credentials: "This Trust server's GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET doesn't match its GitHub OAuth app.",
    redirect_uri_mismatch: "The GitHub OAuth app's callback URL doesn't match this site's /auth/callback.",
    bad_verification_code: "The sign-in code expired or was already used.",
  };
  return error ? ` <small>(${hints[error] ?? `GitHub said: ${error.replace(/[^a-z0-9_]/gi, "")}`})</small>` : "";
}

const page = (status: number, text: string) =>
  new Response(`<!DOCTYPE html><meta name="viewport" content="width=device-width"><title>Trust</title><body style="font:16px/1.5 system-ui;max-width:520px;margin:40px auto;padding:0 20px"><p>${text}</p><p><a href="/new/">Back</a></p>`, { status, headers: { "content-type": "text/html; charset=utf-8" } });

/** /auth/* routes; null when the path isn't one of them. */
export async function authRoutes(req: Request, env: AuthEnv, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/auth/")) return null;
  const route = url.pathname.slice("/auth/".length);

  if (route === "logout" && req.method === "POST") {
    return new Response(null, { status: 204, headers: { "set-cookie": setCookie(req, COOKIE, "", 0) } });
  }
  if (!env.TRUST_SESSION_KEY) return page(503, "Signing in isn't set up on this Trust server yet: it needs TRUST_SESSION_KEY.");

  if (route === "dev" && env.TRUST_DEV_LOGIN === "1") {
    const login = (url.searchParams.get("login") ?? "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 39);
    if (!login) return page(400, "Add ?login=<name>.");
    return signedIn(req, env, { id: `dev-${login}`, login }, safeReturn(url.searchParams.get("return")));
  }

  if (route === "github") {
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return page(503, "Signing in with GitHub isn't set up on this Trust server yet: it needs GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.");
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const state = await sign(env.TRUST_SESSION_KEY, { nonce, to: safeReturn(url.searchParams.get("return")), exp: Date.now() + 600_000 });
    const gh = new URL("https://github.com/login/oauth/authorize");
    gh.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
    gh.searchParams.set("redirect_uri", `${url.origin}/auth/callback`);
    gh.searchParams.set("scope", "");
    gh.searchParams.set("state", nonce);
    gh.searchParams.set("allow_signup", "true");
    return new Response(null, { status: 302, headers: { location: gh.toString(), "set-cookie": setCookie(req, STATE, state, 600) } });
  }

  if (route === "callback") {
    const st = await verify<{ nonce: string; to: string }>(env.TRUST_SESSION_KEY, cookies(req)[STATE]);
    if (!st || st.nonce !== url.searchParams.get("state")) return page(400, "That sign-in link expired or was opened in another browser. Try signing in again.");
    const code = url.searchParams.get("code");
    if (!code) return page(400, "GitHub didn't sign you in. Try again.");
    const tok = await exchangeCode(env, code, `${url.origin}/auth/callback`);
    if (!tok.access_token) {
      console.error("GitHub token exchange failed", { status: tok.status, error: tok.error, description: tok.error_description });
      return page(502, `GitHub didn't confirm the sign-in. Try again.${tokenHint(tok.error)}`);
    }
    const me = await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${tok.access_token}`, "user-agent": UA, accept: "application/vnd.github+json" } })
      .then((r) => (r.ok ? r.json<any>() : null)).catch(() => null);
    if (!me?.id || !me?.login) return page(502, "Couldn't read your GitHub account. Try again.");
    return signedIn(req, env, { id: `gh-${me.id}`, login: me.login }, st.to);
  }
  return page(404, "Not found.");
}
