import { addAnalytics, addApp, candidates, cronSlots, getApp, listApps, newLocalApp, save, setAddresses, setDomain, status, turnOnCron } from "./apps";
import { login, logout, setupNeeded, signedIn } from "./auth";
import { callback, gh, githubApp, installed, Refused, start } from "./github";
import { mcp } from "./mcp";
import { agentTokens, authorize, bearer, metadata, register, token, unauthorized } from "./oauth";
import { backupFile, backups, cloudflareConnected, restore, secretNames, setCloudflareToken, setSecret, TOKEN_LINK, usage } from "./cloudflare";
import { THEMES } from "./themes";
import { VERSION } from "./version";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  BROWSER?: Fetcher;
  PASSWORD?: string;
  LOGIN_LIMIT?: RateLimit;
  DEV_GITHUB_TOKEN?: string;
  LOCAL_REPOS?: string;
}

// The owner's admin API, behind the password.
async function api(req: Request, env: Env, url: URL, path: string) {
  const body = req.method === "POST" || req.method === "PUT" ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};
  const app = path.match(/^\/api\/apps\/(\d+)(\/\w+)?$/);
  if (path === "/api/state") {
    // Each look's swatch: its paper, ink and accent colours and its heading font.
    const themes = THEMES;
    const gh = await githubApp(env);
    const dev = env.LOCAL_REPOS ? "local repos" : env.DEV_GITHUB_TOKEN ? "local token" : null;
    return { version: VERSION, github: gh ? { app: gh.slug, page: gh.html_url, installed: Boolean(gh.installation_id) } : dev ? { app: dev, installed: true } : null, local: Boolean(env.LOCAL_REPOS), cloudflare: await cloudflareConnected(env), cloudflare_link: TOKEN_LINK, apps: (await listApps(env)).map(({ preview_owner: _, ...a }) => a), mcp: `${url.origin}/mcp`, themes };
  }
  if (path === "/api/github/start" && req.method === "POST") return start(env, url.origin);
  if (path === "/api/cloudflare" && req.method === "POST") return setCloudflareToken(env, body.token).then(() => ({ ok: true }));
  if (app?.[2] === "/usage") return usage(env, await getApp(env, app[1]));
  if (app?.[2] === "/backups") {
    const a = await getApp(env, app[1]);
    const key = url.searchParams.get("key");
    if (key) return backupFile(env, a, key);
    const slots = await cronSlots(env);
    return { on: slots.on[a.id], used: slots.used, of: slots.of, backups: await backups(env, a) };
  }
  if (app?.[2] === "/secrets") {
    const a = await getApp(env, app[1]);
    if (req.method === "POST") await setSecret(env, a, body.name, body.value);
    return { names: await secretNames(env, a) };
  }
  if (app?.[2] === "/domain" && req.method === "POST") return setDomain(env, await getApp(env, app[1]), body.domain);
  if (app?.[2] === "/analytics" && req.method === "POST") return addAnalytics(env, await getApp(env, app[1]), body.snippet);
  if (app?.[2] === "/cron" && req.method === "POST") return turnOnCron(env, await getApp(env, app[1]));
  if (app?.[2] === "/restore" && req.method === "POST") {
    const a = await getApp(env, app[1]);
    if (String(body.confirm ?? "").trim() !== a.worker) throw new Refused(`Type ${a.worker} to confirm.`);
    return restore(env, a, body.when);
  }
  if (path === "/api/agent-tokens") return agentTokens(env, req.method === "POST" ? (body.revoke ? "revoke" : "new") : "list", String(body.revoke ?? ""));
  if (path === "/api/candidates") return candidates(env);
  if (path === "/api/apps/local" && req.method === "POST" && env.LOCAL_REPOS) return newLocalApp(env, body.name, body.owner_email, body.theme, url.origin);
  if (path === "/api/apps" && req.method === "POST") return addApp(env, String(body.repo ?? ""), url.origin, body.theme);
  if (app && !app[2] && req.method === "GET") {
    const a = await getApp(env, app[1]);
    const s = await status(env, a);
    const mail = env.LOCAL_REPOS ? await gh(env, `/local/mail/${a.repo}`) : null;
    const { preview_owner: _, ...row } = a;
    return { ...row, draft: s.draft, changed_files: s.changed_files, local_mail: mail };
  }
  if (app && !app[2] && req.method === "PUT") return setAddresses(env, await getApp(env, app[1]), body).then(() => ({ ok: true }));
  if (app?.[2] === "/save" && req.method === "POST") return save(env, await getApp(env, app[1]));
  return null;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (env.LOCAL_REPOS && !/^(localhost|127\.0\.0\.1)$/.test(url.hostname)) return new Response("LOCAL_REPOS is for local development only: remove it.", { status: 500 });

    // Chat apps (Claude): OAuth discovery, registration, approval, tokens, then MCP.
    if (path.startsWith("/.well-known/oauth-")) return metadata(url);
    if (req.method === "OPTIONS" && (path === "/mcp" || path.startsWith("/oauth/"))) {
      return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id", "access-control-allow-methods": "GET, POST, OPTIONS" } });
    }
    if (path === "/oauth/register" && req.method === "POST") return register(req, env);
    if (path === "/oauth/token" && req.method === "POST") return token(req, env);
    if (path === "/oauth/authorize") return authorize(req, env, url);
    if (path === "/mcp") {
      if (!(await bearer(req, env))) return unauthorized(url);
      return mcp(req, { env, origin: url.origin });
    }

    // GitHub sends the owner back here after Create and after Install.
    if (path === "/github/callback" || path === "/github/installed") {
      if (!(await signedIn(req, env))) return Response.redirect(`${url.origin}/?next=${encodeURIComponent(path + url.search)}`, 302);
      try {
        if (path === "/github/callback") return Response.redirect(await callback(env, url), 302);
        await installed(env, url);
        return Response.redirect(`${url.origin}/?github=connected`, 302);
      } catch (e) {
        return Response.redirect(`${url.origin}/?error=${encodeURIComponent(e instanceof Refused ? e.message : String(e))}`, 302);
      }
    }

    if (path.startsWith("/api/")) {
      // Writes only from the admin page itself, on top of the SameSite cookie.
      const origin = req.headers.get("origin");
      if (req.method !== "GET" && origin && origin !== url.origin) return Response.json({ error: "Wrong origin" }, { status: 403 });
      if (path === "/api/login" && req.method === "POST") return login(req, env);
      if (path === "/api/logout" && req.method === "POST") return logout(req);
      if (!(await signedIn(req, env))) return Response.json({ error: setupNeeded(req, env) ?? "Sign in first." }, { status: 401 });
      try {
        const out = await api(req, env, url, path);
        return out === null ? Response.json({ error: "Not found" }, { status: 404 }) : Response.json(out);
      } catch (e) {
        if (!(e instanceof Refused)) console.error(e);
        return Response.json({ error: e instanceof Refused ? e.message : "Something went wrong." }, { status: e instanceof Refused ? 400 : 500 });
      }
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
