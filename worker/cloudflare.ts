import type { App } from "./apps";
import { gh, Refused } from "./github";
import type { Env } from "./index";

// The owner's own Cloudflare, through an API token they create once (Account Analytics: Read, D1: Read).
// Kept in this builder's database like the GitHub App's key; never shown again.

const API = "https://api.cloudflare.com/client/v4";

async function cf<T>(token: string, path: string, init: RequestInit = {}) {
  const res = await fetch(API + path, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
  const body = (await res.json()) as { success: boolean; result: T; errors?: { message: string }[] };
  if (!body.success) throw new Refused(`Cloudflare said ${res.status}: ${body.errors?.map((e) => e.message).join("; ") || "no reason given"}`);
  return body.result;
}

const setting = async (env: Env, key: string) => (await env.DB.prepare("select value from settings where key = ?").bind(key).first<{ value: string }>())?.value ?? null;

export async function setCloudflareToken(env: Env, token: unknown) {
  const t = String(token ?? "").trim();
  await cf(t, "/user/tokens/verify");
  const [account] = await cf<{ id: string }[]>(t, "/accounts");
  if (!account) throw new Refused("This token reaches no Cloudflare account. Give it access to your account.");
  await env.DB.batch([
    env.DB.prepare("insert or replace into settings (key, value) values ('cloudflare_token', ?)").bind(t),
    env.DB.prepare("insert or replace into settings (key, value) values ('cloudflare_account', ?)").bind(account.id),
  ]);
}

export const cloudflareConnected = async (env: Env) => Boolean(await setting(env, "cloudflare_token"));

// Free plan limits a day (PLAN.md, "Free plan limits"); emails: Resend's free plan.
export const LIMITS = { requests: 100_000, rows_read: 5_000_000, rows_written: 100_000, emails: 100 };

// Today's use (UTC day) of one app. Locally from the app's own local logs and database: there,
// D1 counts queries, not rows.
export async function usage(env: Env, app: App) {
  if (env.LOCAL_REPOS) return { ...(await gh<Record<string, number>>(env, `/local/usage/${app.repo}`)), local: true, limits: LIMITS };
  const [token, account] = [await setting(env, "cloudflare_token"), await setting(env, "cloudflare_account")];
  if (!token || !account) return null;
  const wrangler = (await gh<{ content: string }>(env, `/repos/${app.repo}/contents/wrangler.jsonc`)).content;
  const dbName = atob(wrangler.replace(/\n/g, "")).match(/"d1_databases"[\s\S]*?"database_name":\s*"([^"]+)"/)?.[1];
  const [db] = dbName ? await cf<{ uuid: string }[]>(token, `/accounts/${account}/d1/database?name=${encodeURIComponent(dbName)}`) : [];
  const day = new Date().toISOString().slice(0, 10);
  const q = await cf<{ viewer: { accounts: { w: { sum: { requests: number } }[]; d: { sum: { rowsRead: number; rowsWritten: number } }[] }[] } }>(token, "/graphql", {
    method: "POST",
    body: JSON.stringify({
      query: `query($a: string!, $s: string!, $d: string!, $from: Time!, $day: Date!) { viewer { accounts(filter: { accountTag: $a }) {
        w: workersInvocationsAdaptive(limit: 1, filter: { scriptName: $s, datetime_geq: $from }) { sum { requests } }
        d: d1AnalyticsAdaptiveGroups(limit: 1, filter: { databaseId: $d, date_geq: $day }) { sum { rowsRead rowsWritten } } } } }`,
      variables: { a: account, s: app.worker, d: db?.uuid ?? "", from: `${day}T00:00:00Z`, day },
    }),
  });
  const acc = q.viewer.accounts[0];
  const emails = db ? (await cf<{ results: { n: number }[] }[]>(token, `/accounts/${account}/d1/database/${db.uuid}/query`, { method: "POST", body: JSON.stringify({ sql: "SELECT n FROM email_count WHERE day = ?", params: [day] }) }))[0]?.results[0]?.n ?? 0 : 0;
  return { requests: acc?.w[0]?.sum.requests ?? 0, rows_read: acc?.d[0]?.sum.rowsRead ?? 0, rows_written: acc?.d[0]?.sum.rowsWritten ?? 0, emails, local: false, limits: LIMITS };
}
