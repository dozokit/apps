import type { App } from "./apps";
import { gh, Refused } from "./github";
import type { Env } from "./index";

// The owner's own Cloudflare, through an API token they create once from a pre-filled link (exactly
// the permissions below). Kept in this builder's database like the GitHub App's key; never shown again.

const PERMISSIONS = [
  { key: "account_analytics", type: "read" }, // usage panel
  { key: "d1", type: "edit" }, // usage and errors read the app's database; Restore (Time Travel) needs edit
  { key: "workers_scripts", type: "edit" }, // the secrets form
  { key: "workers_r2", type: "read" }, // the weekly backups
];
export const TOKEN_LINK = `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent(JSON.stringify(PERMISSIONS))}&accountId=*&zoneId=all&name=Dozokit%20Apps`;
const AGAIN = "Create a new one with the link in the builder's Cloudflare section, then paste it there.";

const API = "https://api.cloudflare.com/client/v4";

async function cf<T>(token: string, path: string, init: RequestInit = {}) {
  const res = await fetch(API + path, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
  const body = (await res.json()) as { success: boolean; result: T; errors?: { message: string }[] };
  const why = body.errors?.map((e) => e.message).join("; ") || "no reason given";
  if (res.status === 401 || res.status === 403) throw new Refused(`Your Cloudflare token was refused (${why}): it may have expired or miss a permission. ${AGAIN}`);
  if (!body.success) throw new Refused(`Cloudflare said ${res.status}: ${why}`);
  return body.result;
}

const setting = async (env: Env, key: string) => (await env.DB.prepare("select value from settings where key = ?").bind(key).first<{ value: string }>())?.value ?? null;

// Checked on the spot: the token is active, reaches the account, and can do each thing it's for.
export async function setCloudflareToken(env: Env, token: unknown) {
  const t = String(token ?? "").trim();
  const v = await cf<{ status: string; expires_on?: string }>(t, "/user/tokens/verify").catch(() => null);
  if (!v || v.status !== "active") throw new Refused(`That isn't an active Cloudflare token${v?.expires_on ? ` (it expired on ${v.expires_on})` : ""}. ${AGAIN}`);
  const [account] = await cf<{ id: string }[]>(t, "/accounts");
  if (!account) throw new Refused(`This token reaches no Cloudflare account. ${AGAIN}`);
  const a = `/accounts/${account.id}`;
  const tries: [string, Promise<unknown>][] = [
    ["read analytics", cf(t, "/graphql", { method: "POST", body: JSON.stringify({ query: `{ viewer { accounts(filter: { accountTag: "${account.id}" }) { workersInvocationsAdaptive(limit: 1, filter: { datetime_geq: "${new Date(Date.now() - 3600_000).toISOString()}" }) { sum { requests } } } } }` }) })],
    ["reach your D1 databases", cf(t, `${a}/d1/database?per_page=1`)],
    ["reach your Workers", cf(t, `${a}/workers/scripts`)],
    ["reach your R2 storage", cf(t, `${a}/r2/buckets`)],
  ];
  const missing = (await Promise.all(tries.map(([what, p]) => p.then(() => null, () => what)))).filter(Boolean);
  if (missing.length) throw new Refused(`This token can't ${missing.join(", ")}. ${AGAIN}`);
  await env.DB.batch([
    env.DB.prepare("insert or replace into settings (key, value) values ('cloudflare_token', ?)").bind(t),
    env.DB.prepare("insert or replace into settings (key, value) values ('cloudflare_account', ?)").bind(account.id),
  ]);
}

export const cloudflareConnected = async (env: Env) => Boolean(await setting(env, "cloudflare_token"));

// Free plan limits a day (PLAN.md, "Free plan limits"); emails: Resend's free plan.
export const LIMITS = { requests: 100_000, rows_read: 5_000_000, rows_written: 100_000, emails: 100 };

async function account(env: Env) {
  const [token, id] = [await setting(env, "cloudflare_token"), await setting(env, "cloudflare_account")];
  if (!token || !id) throw new Refused("Connect your Cloudflare account first: the Cloudflare section of the builder's home page.");
  return { token, id };
}

// The app's live database (or its draft preview's): its name is in the app's wrangler.jsonc.
async function database(env: Env, app: App, draft: boolean) {
  const { token, id } = await account(env);
  const wrangler = atob((await gh<{ content: string }>(env, `/repos/${app.repo}/contents/wrangler.jsonc`)).content.replace(/\n/g, ""));
  const name = draft ? `${app.worker}-preview-db` : wrangler.match(/"d1_databases"[\s\S]*?"database_name":\s*"([^"]+)"/)?.[1];
  const [db] = name ? await cf<{ uuid: string }[]>(token, `/accounts/${id}/d1/database?name=${encodeURIComponent(name)}`) : [];
  if (!db) throw new Refused(`No ${draft ? "draft preview" : "live"} database found for ${app.repo} on your Cloudflare account.`);
  return { token, id, uuid: db.uuid };
}

// A read query on an app's database, live or draft. Locally, through the app's local database.
export async function query<T>(env: Env, app: App, sql: string, params: unknown[] = [], draft = false): Promise<T[]> {
  if (env.LOCAL_REPOS) return gh<T[]>(env, `/local/d1/${app.repo}${draft ? "?draft=1" : ""}`, { method: "POST", body: JSON.stringify({ sql, params }) });
  const { token, id, uuid } = await database(env, app, draft);
  return (await cf<{ results: T[] }[]>(token, `/accounts/${id}/d1/database/${uuid}/query`, { method: "POST", body: JSON.stringify({ sql, params }) }))[0]?.results ?? [];
}

// The app's latest unhandled errors (the template keeps them in error_log).
export const appErrors = (env: Env, app: App, draft: boolean) =>
  query<{ at: string; route: string; message: string }>(env, app, "SELECT at, route, message FROM error_log ORDER BY id DESC LIMIT 20", [], draft);

// Today's use (UTC day) of one app. Locally from the app's own local logs and database: there,
// D1 counts queries, not rows.
export async function usage(env: Env, app: App) {
  if (env.LOCAL_REPOS) return { ...(await gh<Record<string, number>>(env, `/local/usage/${app.repo}`)), local: true, limits: LIMITS };
  if (!(await cloudflareConnected(env))) return null;
  const { token, id, uuid } = await database(env, app, false);
  const day = new Date().toISOString().slice(0, 10);
  const q = await cf<{ viewer: { accounts: { w: { sum: { requests: number } }[]; d: { sum: { rowsRead: number; rowsWritten: number } }[] }[] } }>(token, "/graphql", {
    method: "POST",
    body: JSON.stringify({
      query: `query($a: string!, $s: string!, $d: string!, $from: Time!, $day: Date!) { viewer { accounts(filter: { accountTag: $a }) {
        w: workersInvocationsAdaptive(limit: 1, filter: { scriptName: $s, datetime_geq: $from }) { sum { requests } }
        d: d1AnalyticsAdaptiveGroups(limit: 1, filter: { databaseId: $d, date_geq: $day }) { sum { rowsRead rowsWritten } } } } }`,
      variables: { a: id, s: app.worker, d: uuid, from: `${day}T00:00:00Z`, day },
    }),
  });
  const acc = q.viewer.accounts[0];
  const [emails] = await query<{ n: number }>(env, app, "SELECT n FROM email_count WHERE day = ?", [day]);
  return { requests: acc?.w[0]?.sum.requests ?? 0, rows_read: acc?.d[0]?.sum.rowsRead ?? 0, rows_written: acc?.d[0]?.sum.rowsWritten ?? 0, emails: emails?.n ?? 0, local: false, limits: LIMITS };
}

// --- Backups: the app's weekly copies in its R2 bucket, and D1 Time Travel (7 days on the free plan) ---

const bucket = (app: App) => `${app.worker}-backups`;

export async function backups(env: Env, app: App) {
  if (env.LOCAL_REPOS) return gh<{ key: string; size: number }[]>(env, `/local/backups/${app.repo}`);
  if (!(await cloudflareConnected(env))) return [];
  const { token, id } = await account(env);
  const list = await cf<{ key: string; size: number }[]>(token, `/accounts/${id}/r2/buckets/${bucket(app)}/objects?prefix=backups/`).catch(() => []);
  return list.map(({ key, size }) => ({ key, size }));
}

export async function backupFile(env: Env, app: App, key: string) {
  if (!/^backups\/\d{4}-\d{2}-\d{2}\.json$/.test(key)) throw new Refused("That isn't one of this app's backups.");
  if (env.LOCAL_REPOS) return gh<unknown>(env, `/local/backups/${app.repo}?key=${encodeURIComponent(key)}`);
  const { token, id } = await account(env);
  const res = await fetch(`${API}/accounts/${id}/r2/buckets/${bucket(app)}/objects/${encodeURIComponent(key)}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Refused(`Cloudflare said ${res.status} for ${key}.`);
  return res.json();
}

// Puts the live database back as it was at that moment (up to 7 days ago on the free plan).
export async function restore(env: Env, app: App, when: unknown) {
  if (env.LOCAL_REPOS) throw new Refused("Restore uses D1 Time Travel, which only exists on Cloudflare, not on this computer.");
  const at = new Date(String(when));
  if (Number.isNaN(at.getTime()) || at.getTime() > Date.now() || at.getTime() < Date.now() - 7 * 24 * 3600_000) throw new Refused("Pick a moment in the last 7 days.");
  const { token, id, uuid } = await database(env, app, false);
  return cf<{ bookmark: string }>(token, `/accounts/${id}/d1/database/${uuid}/time_travel/restore?timestamp=${encodeURIComponent(at.toISOString())}`, { method: "POST" });
}

// --- Secrets: set as Worker secrets, never shown again; only their names come back ---

export async function secretNames(env: Env, app: App) {
  if (env.LOCAL_REPOS) return gh<string[]>(env, `/local/secrets/${app.repo}`);
  if (!(await cloudflareConnected(env))) return null;
  const { token, id } = await account(env);
  return (await cf<{ name: string }[]>(token, `/accounts/${id}/workers/scripts/${app.worker}/secrets`)).map((s) => s.name);
}

export async function setSecret(env: Env, app: App, name: unknown, value: unknown) {
  const n = String(name ?? "").trim();
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(n)) throw new Refused("A secret's name is capitals, digits and _, like STRIPE_SECRET_KEY.");
  if (typeof value !== "string" || !value) throw new Refused("Paste the secret's value.");
  if (env.LOCAL_REPOS) return gh(env, `/local/secrets/${app.repo}`, { method: "POST", body: JSON.stringify({ name: n, value }) });
  const { token, id } = await account(env);
  return cf(token, `/accounts/${id}/workers/scripts/${app.worker}/secrets`, { method: "PUT", body: JSON.stringify({ name: n, text: value, type: "secret_text" }) });
}
