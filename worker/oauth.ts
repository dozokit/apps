import { signedIn } from "./auth";
import type { Env } from "./index";

// Dozokit Apps is its own OAuth server for chat apps that use it through MCP (Claude's custom
// connectors, ChatGPT apps): discovery documents, dynamic client registration, an approval page
// the owner confirms while signed in to the builder, and PKCE-checked tokens.

const HOUR = 3600_000;
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = () => b64(crypto.getRandomValues(new Uint8Array(32)));
const sha = async (s: string) => b64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(data, { status, headers: { "cache-control": "no-store", "access-control-allow-origin": "*", ...headers } });
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

export function metadata(url: URL) {
  if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
    return json({ resource: `${url.origin}/mcp`, authorization_servers: [url.origin], bearer_methods_supported: ["header"] });
  }
  return json({
    issuer: url.origin,
    authorization_endpoint: `${url.origin}/oauth/authorize`,
    token_endpoint: `${url.origin}/oauth/token`,
    registration_endpoint: `${url.origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["apps"],
  });
}

export async function register(req: Request, env: Env) {
  const b = (await req.json().catch(() => ({}))) as { client_name?: string; redirect_uris?: unknown };
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String).filter((u) => /^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u)).slice(0, 5) : [];
  if (!uris.length) return json({ error: "invalid_redirect_uri" }, 400);
  const id = crypto.randomUUID();
  const name = String(b.client_name ?? "A chat app").slice(0, 80);
  await env.DB.prepare("insert into oauth_clients (id, name, redirect_uris, created_at) values (?, ?, ?, ?)").bind(id, name, JSON.stringify(uris), Date.now()).run();
  return json({ client_id: id, client_name: name, redirect_uris: uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }, 201);
}

// These pages are drawn here, not by the admin app: French when the browser asks for it.
// The builder's own language choice (a cookie the admin page sets) first, then the browser's.
const fr = (req: Request) => {
  const chosen = (req.headers.get("cookie") ?? "").match(/(?:^|;\s*)dozokit_lang=(en|fr)/)?.[1];
  return chosen ? chosen === "fr" : /^fr\b/i.test(req.headers.get("accept-language") ?? "");
};
const page = (title: string, body: string, l: "en" | "fr" = "en") =>
  new Response(
    `<!doctype html><html lang="${l}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>` +
      `<body style="font:16px/1.5 system-ui,sans-serif;max-width:30rem;margin:12vh auto;padding:0 1rem;color:#2a2421;background:#f6f1ec"><h1 style="font-size:1.4rem">${title}</h1>${body}</body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" } },
  );

// The page the chat app sends the owner to. Signed in to the builder: one button to allow.
// Not signed in: the builder's sign-in first, then back here.
export async function authorize(req: Request, env: Env, url: URL) {
  const q = url.searchParams;
  const client = await env.DB.prepare("select * from oauth_clients where id = ?").bind(q.get("client_id") ?? "").first<{ id: string; name: string; redirect_uris: string }>();
  const redirect = q.get("redirect_uri") ?? "";
  const F = fr(req);
  const l = F ? "fr" : "en";
  const invalid = F ? "Cette connexion n’est pas valable" : "This connection isn't valid";
  if (!client || !JSON.parse(client.redirect_uris).includes(redirect)) return page(invalid, F ? "<p>Recommencez depuis l’application de chat.</p>" : "<p>Start again from the chat app.</p>", l);
  if (q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) return page(invalid, F ? "<p>L’application de chat doit utiliser PKCE (S256).</p>" : "<p>The chat app has to use PKCE (S256).</p>", l);
  if (!(await signedIn(req, env))) {
    const back = encodeURIComponent(url.pathname + url.search);
    return F
      ? page("Connectez-vous d’abord", `<p>Pour relier ${esc(client.name)} à Dozokit Apps, connectez-vous, puis revenez sur cette page.</p><p><a href="/?next=${back}">Se connecter à Dozokit Apps</a></p>`, l)
      : page("Sign in first", `<p>To connect ${esc(client.name)} to Dozokit Apps, sign in to it, then come back to this page.</p><p><a href="/?next=${back}">Sign in to Dozokit Apps</a></p>`);
  }
  if (req.method === "POST") {
    const form = await req.formData();
    const to = new URL(redirect);
    const state = q.get("state");
    if (form.get("answer") !== "allow") {
      to.searchParams.set("error", "access_denied");
    } else {
      const code = random();
      await env.DB.prepare("insert into oauth_codes (hash, client_id, redirect_uri, challenge, expires_at) values (?, ?, ?, ?, ?)")
        .bind(await sha(code), client.id, redirect, q.get("code_challenge"), Date.now() + 10 * 60_000)
        .run();
      to.searchParams.set("code", code);
    }
    if (state) to.searchParams.set("state", state);
    return Response.redirect(to.href, 302);
  }
  const name = esc(client.name);
  const [ask, can, allow, cancel, later] = F
    ? [`Relier ${name} ?`, `<strong>${name}</strong> pourra lire et modifier vos apps dans Dozokit Apps, et enregistrer ses changements quand vous le lui demandez dans une conversation. Il utilise votre propre abonnement ; rien n’est facturé ici.`, "Autoriser", "Annuler", "Pour le déconnecter, retirez-le dans les réglages de votre application de chat."]
    : [`Connect ${name}?`, `<strong>${name}</strong> will be able to read and change your apps in Dozokit Apps, and save its changes when you ask it to in a chat. It uses your own chat plan; nothing is charged here.`, "Allow", "Cancel", "To disconnect it, remove it in your chat app’s settings."];
  return page(
    ask,
    `<p>${can}</p>
<form method="post" style="display:flex;gap:12px;margin-top:24px"><button name="answer" value="allow" style="font:600 16px system-ui;padding:12px 20px;border:0;border-radius:8px;background:#2a2421;color:#fff;cursor:pointer">${allow}</button><button name="answer" value="deny" style="font:16px system-ui;padding:12px 20px;border:1px solid #2a2421;border-radius:8px;background:none;cursor:pointer">${cancel}</button></form>
<p style="font-size:14px;color:#6b625c">${later}</p>`,
    l,
  );
}

async function issue(env: Env, clientId: string) {
  const access = random();
  const refresh = random();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("insert into oauth_tokens (hash, kind, client_id, expires_at, created_at) values (?, 'access', ?, ?, ?)").bind(await sha(access), clientId, now + HOUR, now),
    env.DB.prepare("insert into oauth_tokens (hash, kind, client_id, expires_at, created_at) values (?, 'refresh', ?, ?, ?)").bind(await sha(refresh), clientId, now + 90 * 24 * HOUR, now),
  ]);
  return json({ access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: "apps" });
}

export async function token(req: Request, env: Env) {
  const f = new URLSearchParams(await req.text());
  const clientId = f.get("client_id") ?? "";
  if (f.get("grant_type") === "authorization_code") {
    const row = await env.DB.prepare("delete from oauth_codes where hash = ? returning *").bind(await sha(f.get("code") ?? "")).first<{ client_id: string; redirect_uri: string; challenge: string; expires_at: number }>();
    const ok = row && row.client_id === clientId && row.redirect_uri === f.get("redirect_uri") && row.expires_at > Date.now() && (await sha(f.get("code_verifier") ?? "")) === row.challenge;
    return ok ? issue(env, clientId) : json({ error: "invalid_grant" }, 400);
  }
  if (f.get("grant_type") === "refresh_token") {
    const row = await env.DB.prepare("delete from oauth_tokens where hash = ? and kind = 'refresh' returning *").bind(await sha(f.get("refresh_token") ?? "")).first<{ client_id: string; expires_at: number }>();
    return row && row.client_id === clientId && row.expires_at > Date.now() ? issue(env, clientId) : json({ error: "invalid_grant" }, 400);
  }
  return json({ error: "unsupported_grant_type" }, 400);
}

// For an agent already running, which can't open a browser to sign in: a token the owner copies
// from the builder. 24 hours, shown once, kept hashed, revocable on the same page.
export async function agentTokens(env: Env, action: "new" | "list" | "revoke", hash?: string) {
  const now = Date.now();
  if (action === "revoke") await env.DB.prepare("delete from oauth_tokens where client_id = 'agent' and hash = ?").bind(hash ?? "").run();
  if (action !== "new") return (await env.DB.prepare("select hash, created_at, expires_at from oauth_tokens where client_id = 'agent' and expires_at > ? order by created_at desc").bind(now).all()).results;
  const token = random();
  await env.DB.batch([
    env.DB.prepare("insert or ignore into oauth_clients (id, name, redirect_uris, created_at) values ('agent', 'Agent token', '[]', ?)").bind(now),
    env.DB.prepare("insert into oauth_tokens (hash, kind, client_id, expires_at, created_at) values (?, 'access', 'agent', ?, ?)").bind(await sha(token), now + 24 * HOUR, now),
  ]);
  return { token, expires_at: now + 24 * HOUR };
}

// The chat app calling /mcp: its access token, or null.
export async function bearer(req: Request, env: Env) {
  const t = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1];
  if (!t) return null;
  const row = await env.DB.prepare("select t.client_id, c.name from oauth_tokens t join oauth_clients c on c.id = t.client_id where t.hash = ? and t.kind = 'access' and t.expires_at > ?")
    .bind(await sha(t), Date.now())
    .first<{ client_id: string; name: string }>();
  // Noted at most once an hour: enough to tell an app still in use from one removed long ago.
  if (row) await env.DB.prepare("update oauth_clients set last_used = ? where id = ? and coalesce(last_used, 0) < ?").bind(Date.now(), row.client_id, Date.now() - HOUR).run();
  return row;
}

export const unauthorized = (url: URL) =>
  new Response(JSON.stringify({ error: "invalid_token" }), {
    status: 401,
    headers: { "content-type": "application/json", "www-authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`, "access-control-allow-origin": "*" },
  });
