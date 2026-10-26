import type { Env } from "./index";

// GitHub, through a GitHub App the owner creates in their own account (the "manifest flow"):
// the builder sends GitHub the app's description, GitHub asks the owner to create it, then hands
// the builder the app's key, which stays in this builder's database. The app may only read and
// write repo contents (Contents, Metadata), on the repos the owner picks when installing it.

const API = "https://api.github.com";
// Local mode (LOCAL_REPOS in .dev.vars): scripts/local-repos.mjs answers instead of GitHub.
const LOCAL = "http://localhost:8790";

// A refusal or failure meant for the owner or the chat: its message is shown as it is.
export class Refused extends Error {}

type GitHubApp = { app_id: number; slug: string; client_id: string; pem: string; html_url: string; installation_id: number | null };

export const githubApp = (env: Env) => env.DB.prepare("select app_id, slug, client_id, pem, html_url, installation_id from github_app where id = 1").first<GitHubApp>();

async function call(token: string, path: string, init: RequestInit = {}) {
  const res = await fetch(/^https?:\/\//.test(path) ? path : API + path, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "dozokit-apps", ...(init.body ? { "content-type": "application/json" } : {}) },
  });
  if (res.status === 204) return null;
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) throw Object.assign(new Refused(`${path.startsWith(LOCAL) ? "Local repos" : "GitHub"} said ${res.status}: ${body.message ?? "no reason given"} (${path.split("?")[0]})`), { status: res.status });
  return body;
}

// --- The app's own identity: a JWT signed with its key (RS256) ---

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const text64 = (s: string) => b64url(new TextEncoder().encode(s));

// GitHub hands out PKCS#1 keys ("BEGIN RSA PRIVATE KEY"); WebCrypto only reads PKCS#8, which wraps it.
function pkcs8(pem: string) {
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, "")), (c) => c.charCodeAt(0));
  if (!pem.includes("RSA PRIVATE KEY")) return der;
  const len = (n: number) => (n < 128 ? [n] : n < 256 ? [0x81, n] : n < 65536 ? [0x82, n >> 8, n & 255] : [0x83, n >> 16, (n >> 8) & 255, n & 255]);
  const octets = [0x04, ...len(der.length), ...der];
  const body = [0x02, 0x01, 0x00, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00, ...octets];
  return new Uint8Array([0x30, ...len(body.length), ...body]);
}

export async function appJwt(pem: string, issuer: string) {
  const key = await crypto.subtle.importKey("pkcs8", pkcs8(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${text64(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${text64(JSON.stringify({ iat: now - 60, exp: now + 540, iss: issuer }))}`;
  return `${unsigned}.${b64url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned))))}`;
}

// --- Acting on the owner's repos: an installation token (an hour long), kept while it lasts ---

let cached: { token: string; until: number } | null = null;

async function token(env: Env) {
  if (env.LOCAL_REPOS) return "local";
  // Local development only: a token of your own instead of the GitHub App (never set it online).
  if (env.DEV_GITHUB_TOKEN) return env.DEV_GITHUB_TOKEN;
  if (cached && cached.until > Date.now()) return cached.token;
  const app = await githubApp(env);
  if (!app?.installation_id) throw new Refused("GitHub isn't connected yet: the owner clicks Connect GitHub in the builder first.");
  const out = (await call(await appJwt(app.pem, app.client_id), `/app/installations/${app.installation_id}/access_tokens`, { method: "POST" })) as { token: string; expires_at: string };
  cached = { token: out.token, until: Date.parse(out.expires_at) - 5 * 60_000 };
  return out.token;
}

export const gh = async <T = Record<string, unknown>>(env: Env, path: string, init?: RequestInit) => (await call(await token(env), env.LOCAL_REPOS ? LOCAL + path : path, init)) as T;

// Every repo the builder may reach: the ones the owner gave the GitHub App when installing it.
export async function reachableRepos(env: Env) {
  type Repo = { full_name: string; default_branch: string };
  if (env.DEV_GITHUB_TOKEN || env.LOCAL_REPOS) return gh<Repo[]>(env, "/user/repos?affiliation=owner&per_page=100&sort=updated");
  return (await gh<{ repositories: Repo[] }>(env, "/installation/repositories?per_page=100")).repositories;
}

// --- Connect GitHub ---

// The form the owner's browser posts to GitHub: GitHub shows "Create GitHub App" for this manifest.
export async function start(env: Env, origin: string) {
  const state = crypto.randomUUID();
  await env.DB.prepare("insert into github_states (state, expires_at) values (?, ?)").bind(state, Date.now() + 3600_000).run();
  const manifest = {
    // GitHub App names are unique on all of GitHub: the owner may rename it on GitHub's page.
    name: `Dozokit Apps ${crypto.randomUUID().slice(0, 6)}`,
    url: origin,
    redirect_url: `${origin}/github/callback`,
    setup_url: `${origin}/github/installed`,
    setup_on_update: true,
    public: false,
    hook_attributes: { url: `${origin}/github/hook`, active: false },
    default_permissions: { contents: "write", metadata: "read" },
    default_events: [],
  };
  return { action: `https://github.com/settings/apps/new?state=${state}`, manifest: JSON.stringify(manifest) };
}

// GitHub sends the owner back with a code, swapped once (within the hour) for the app's key.
export async function callback(env: Env, url: URL) {
  const state = url.searchParams.get("state") ?? "";
  const ok = await env.DB.prepare("delete from github_states where state = ? and expires_at > ? returning state").bind(state, Date.now()).first();
  if (!ok) throw new Refused("This GitHub answer doesn't match a Connect GitHub started here, or it's over an hour old. Click Connect GitHub again.");
  const res = await fetch(`${API}/app-manifests/${encodeURIComponent(url.searchParams.get("code") ?? "")}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", "user-agent": "dozokit-apps" },
  });
  const app = (await res.json()) as { id: number; slug: string; client_id: string; client_secret: string; pem: string; webhook_secret: string | null; html_url: string; message?: string };
  if (!res.ok) throw new Refused(`GitHub didn't hand over the app (${res.status}: ${app.message ?? "no reason given"}). Click Connect GitHub again.`);
  await env.DB.prepare(
    "insert or replace into github_app (id, app_id, slug, client_id, client_secret, pem, webhook_secret, html_url, installation_id, created_at) values (1, ?, ?, ?, ?, ?, ?, ?, null, ?)",
  )
    .bind(app.id, app.slug, app.client_id, app.client_secret, app.pem, app.webhook_secret, app.html_url, Date.now())
    .run();
  cached = null;
  return `${app.html_url}/installations/new`;
}

// After Install, GitHub sends the owner here with the installation's id, checked with the app's key.
export async function installed(env: Env, url: URL) {
  const app = await githubApp(env);
  const id = Number(url.searchParams.get("installation_id"));
  if (!app || !id) throw new Refused("Connect GitHub first, then install the app it creates.");
  await call(await appJwt(app.pem, app.client_id), `/app/installations/${id}`);
  await env.DB.prepare("update github_app set installation_id = ? where id = 1").bind(id).run();
  cached = null;
}
