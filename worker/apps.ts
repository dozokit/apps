import { checkRoutes } from "./check-routes.mjs";
import { gh, reachableRepos, Refused } from "./github";
import type { Env } from "./index";
import { THEMES } from "./themes";

// The owner's apps. Changes go to the app's `draft` branch, which Cloudflare builds as a preview;
// Save merges draft into main, which Cloudflare puts live. Only repos made from dozokit/app-template
// are apps, so the builder never writes to its own repo or to any other.

export type App = { id: number; repo: string; worker: string; preview_url: string | null; live_url: string | null; created_at: number; preview_owner: string | null };

export const listApps = async (env: Env) => (await env.DB.prepare("select * from apps order by id").all<App>()).results;

export async function getApp(env: Env, id: unknown) {
  const row = await env.DB.prepare("select * from apps where id = ?").bind(Number(id)).first<App>();
  if (!row) throw new Refused(`There's no app ${String(id)}. Call list_apps to see them.`);
  return row;
}

const text = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, "")), (c) => c.charCodeAt(0)));
const notFound = (e: unknown) => (e as { status?: number }).status === 404;

async function file(env: Env, repo: string, path: string, ref: string) {
  try {
    return text((await gh<{ content: string }>(env, `/repos/${repo}/contents/${path}?ref=${ref}`)).content);
  } catch (e) {
    if (notFound(e)) return null;
    throw e;
  }
}

// A repo made from dozokit/app-template has the safety check and names its Worker in wrangler.jsonc.
async function appRepo(env: Env, repo: string) {
  const [check, wrangler] = await Promise.all([file(env, repo, "scripts/check-routes.mjs", "main"), file(env, repo, "wrangler.jsonc", "main")]);
  const worker = wrangler?.match(/"name":\s*"([^"]+)"/)?.[1];
  return check && worker ? worker : null;
}

// Repos the GitHub App can reach that are apps not added yet (e.g. just made with the Deploy button).
export async function candidates(env: Env) {
  const added = new Set((await listApps(env)).map((a) => a.repo));
  const repos = (await reachableRepos(env)).filter((r) => !added.has(r.full_name) && r.default_branch === "main").slice(0, 30);
  return (await Promise.all(repos.map(async (r) => ((await appRepo(env, r.full_name)) ? r.full_name : null)))).filter(Boolean) as string[];
}

export async function addApp(env: Env, repo: string, origin: string, theme?: unknown) {
  if (!(await candidates(env)).includes(repo)) throw new Refused(`${repo} isn't an app this builder can reach: it must be made from dozokit/app-template, with main as its default branch.`);
  const worker = (await appRepo(env, repo))!;
  // On workers.dev, the app lives next to the builder: <worker>.<subdomain>.workers.dev, its draft at draft-<worker>.
  const sub = new URL(origin).hostname.match(/^[^.]+\.([^.]+)\.workers\.dev$/)?.[1];
  const local = env.LOCAL_REPOS ? await gh<{ preview_url: string; live_url: string }>(env, `/local/urls/${repo}`) : null;
  const [preview, live] = local ? [local.preview_url, local.live_url] : sub ? [`https://draft-${worker}.${sub}.workers.dev`, `https://${worker}.${sub}.workers.dev`] : [null, null];
  const app = (await env.DB.prepare("insert into apps (repo, worker, preview_url, live_url, created_at) values (?, ?, ?, ?, ?) returning *").bind(repo, worker, preview, live, Date.now()).first<App>())!;
  // The look picked at New app (the template ships Clean): on the draft, live once the owner saves.
  const look = THEMES.find((t) => t.name === theme && t.name !== "Clean") && (await file(env, repo, `src/themes/${String(theme).toLowerCase()}.css`, "main"));
  if (look) await writeFiles(env, app, [{ path: "src/theme.css", content: look }], `Theme: ${theme}`);
  return app;
}

// Local mode: New app makes a git repo from the local template instead of the Deploy button.
export async function newLocalApp(env: Env, name: unknown, ownerEmail: unknown, theme: unknown, origin: string) {
  const look = (THEMES.find((t) => t.name === theme) ?? THEMES[0]).name.toLowerCase();
  const { repo } = await gh<{ repo: string }>(env, "/local/new", { method: "POST", body: JSON.stringify({ name, owner_email: ownerEmail, theme: look }) });
  return addApp(env, repo, origin);
}

// The draft's throwaway owner: a random email only the builder knows; the draft gets its hash in
// preview-owner.json, which the template's isOwner reads on previews only (never live).
export async function previewOwner(env: Env, app: App) {
  if (app.preview_owner) return { ...(JSON.parse(app.preview_owner) as { email: string }), added: false };
  const owner = { email: `owner-${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}@preview.test` };
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(owner.email)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await writeFiles(env, app, [{ path: "preview-owner.json", content: `{ "sha256": "${hash}" }\n` }], "Owner previews on the draft");
  await env.DB.prepare("update apps set preview_owner = ? where id = ?").bind(JSON.stringify(owner), app.id).run();
  return { ...owner, added: true };
}

// The app's one cron (alerts + Sunday backup), off by default: Cloudflare's free plan allows 5 crons
// per account, and the backup needs R2 turned on. Turning it on is a draft change the owner saves.
const CRON = '  "triggers": { "crons": ["0 * * * *"] },\n';
export async function cronSlots(env: Env) {
  const apps = await listApps(env);
  const on = await Promise.all(apps.map(async (a) => Boolean((await file(env, a.repo, "wrangler.jsonc", "main").catch(() => null))?.includes('"crons"'))));
  return { used: on.filter(Boolean).length, of: 5, on: Object.fromEntries(apps.map((a, i) => [a.id, on[i]])) };
}

export async function turnOnCron(env: Env, app: App) {
  const slots = await cronSlots(env);
  if (slots.on[app.id]) throw new Refused("Backups and alerts are already on for this app.");
  if (slots.used >= slots.of) throw new Refused(`Your apps already use the ${slots.of} crons Cloudflare's free plan allows per account. Turn one off first (remove its "triggers" from its wrangler.jsonc).`);
  const ref = (await draftSha(env, app.repo, false)) ? "draft" : "main";
  const wrangler = await file(env, app.repo, "wrangler.jsonc", ref);
  if (wrangler?.includes('"crons"')) throw new Refused("Backups and alerts are already in this app's draft: Save to turn them on.");
  if (!wrangler?.includes("  // Workers Logs")) throw new Refused("This app's wrangler.jsonc isn't the template's: add the cron by hand (see its CLAUDE.md).");
  const next = wrangler.replace("  // Workers Logs", `${CRON}  "r2_buckets": [{ "binding": "BACKUPS", "bucket_name": "${app.worker}-backups" }],\n  // Workers Logs`);
  return writeFiles(env, app, [{ path: "wrangler.jsonc", content: next }], "Backups and alerts on");
}

// A custom domain, as in Dozokit Sites: the owner adds it to the app's Worker in Cloudflare, the
// builder checks it really reaches this app, then it becomes the app's live address.
export async function setDomain(env: Env, app: App, raw: unknown) {
  const domain = String(raw ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const local = env.LOCAL_REPOS && /^[a-z0-9.-]+\.localhost:\d+$/.test(domain);
  if (!local && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) throw new Refused("Type only the domain, like app.mondomaine.fr.");
  const n = crypto.randomUUID().slice(0, 8);
  const url = `${local ? "http" : "https"}://${domain}`;
  const res = await fetch(`${url}/api/dozokit-check?n=${n}`, { redirect: "manual", signal: AbortSignal.timeout(8000) }).catch(() => null);
  const where = `In Cloudflare: Workers & Pages → ${app.worker} → Settings → Domains & Routes → Add → Custom domain → ${domain}. It can take a few minutes.`;
  if (!res) throw new Refused(`No answer from ${domain} yet. ${where}`);
  if (res.headers.get("x-dozokit-app") !== n) throw new Refused(`${domain} doesn't lead to ${app.worker} yet. ${where}`);
  await env.DB.prepare("update apps set live_url = ? where id = ?").bind(url, app.id).run();
  return { live_url: url };
}

// Dozokit Analytics: the owner pastes the snippet their Analytics gives for this app's site; it goes
// into the app's index.html on the draft (one line, replaced if it's there already).
export async function addAnalytics(env: Env, app: App, snippet: unknown) {
  const s = String(snippet ?? "");
  const site = s.match(/data-site="([\w-]+)"/)?.[1];
  const src = s.match(/src="(https:\/\/[^"\s]+\/t\.js)"/)?.[1];
  if (!site || !src) throw new Refused('Paste the snippet from your Dozokit Analytics (Sites → this site), like <script defer data-site="…" src="https://…/t.js"></script>.');
  const ref = (await draftSha(env, app.repo, false)) ? "draft" : "main";
  const html = (await file(env, app.repo, "index.html", ref)) ?? "";
  const tag = `    <script defer data-site="${site}" src="${src}"></script>`;
  const next = /\n\s*<script defer data-site="[^"]*" src="[^"]*\/t\.js"><\/script>/.test(html)
    ? html.replace(/\n\s*<script defer data-site="[^"]*" src="[^"]*\/t\.js"><\/script>/, `\n${tag}`)
    : html.replace("  </head>", `${tag}\n  </head>`);
  if (next === html) throw new Refused("This app's index.html has no </head> to put the script before.");
  return writeFiles(env, app, [{ path: "index.html", content: next }], "Dozokit Analytics");
}

export async function setAddresses(env: Env, app: App, body: { preview_url?: unknown; live_url?: unknown }) {
  const url = (v: unknown) => (typeof v === "string" && /^https:\/\/[\w.-]+(\/.*)?$/.test(v) ? v : null);
  await env.DB.prepare("update apps set preview_url = ?, live_url = ? where id = ?").bind(url(body.preview_url), url(body.live_url), app.id).run();
}

async function draftSha(env: Env, repo: string, create: boolean) {
  try {
    return (await gh<{ object: { sha: string } }>(env, `/repos/${repo}/git/ref/heads/draft`)).object.sha;
  } catch (e) {
    if (!notFound(e)) throw e;
    if (!create) return null;
  }
  const main = (await gh<{ object: { sha: string } }>(env, `/repos/${repo}/git/ref/heads/main`)).object.sha;
  await gh(env, `/repos/${repo}/git/refs`, { method: "POST", body: JSON.stringify({ ref: "refs/heads/draft", sha: main }) });
  return main;
}

function safePath(p: unknown) {
  const path = String(p ?? "").replace(/^\.?\//, "");
  if (!/^[\w.@+-]+(\/[\w.@+-]+)*$/.test(path) || path.length > 200 || path.split("/").some((s) => s === ".." || s === ".")) {
    throw new Refused(`"${String(p)}" isn't a path inside the app's repo (letters, digits, . _ - and / only, no ..).`);
  }
  if (/^\.git(\/|$)|^\.github(\/|$)/.test(path)) throw new Refused(`${path}: the builder doesn't write to .git or .github.`);
  return path;
}

// A file's text, or with no path every file of the app, from the draft when there is one.
export async function readFile(env: Env, app: App, path: unknown) {
  const ref = (await draftSha(env, app.repo, false)) ? "draft" : "main";
  if (!path) {
    const tree = await gh<{ tree: { path: string; type: string }[] }>(env, `/repos/${app.repo}/git/trees/${ref}?recursive=1`);
    return { branch: ref, files: tree.tree.filter((t) => t.type === "blob").map((t) => t.path) };
  }
  const p = safePath(path);
  const content = await file(env, app.repo, p, ref);
  if (content === null) throw new Refused(`There's no file ${p} on ${ref}. Call read_file with no path to list the files.`);
  return { branch: ref, path: p, content };
}

export async function writeFiles(env: Env, app: App, files: unknown, message: unknown) {
  if (!Array.isArray(files) || !files.length || files.length > 50) throw new Refused("Send files as a list of 1 to 50 { path, content } (or { path, delete: true }).");
  const tree = files.map((f: { path?: unknown; content?: unknown; delete?: unknown }) => {
    const path = safePath(f.path);
    if (f.delete === true) return { path, mode: "100644", type: "blob", sha: null };
    if (typeof f.content !== "string" || f.content.length > 500_000) throw new Refused(`${path}: content must be the whole file as text, under 500,000 characters.`);
    return { path, mode: "100644", type: "blob", content: f.content };
  });
  // Checked again at every write: only a repo made from the template is written to.
  if (!(await appRepo(env, app.repo))) throw new Refused(`${app.repo} isn't an app repo (no scripts/check-routes.mjs on main), so the builder won't write to it.`);
  const base = (await draftSha(env, app.repo, true))!;
  const baseTree = (await gh<{ tree: { sha: string } }>(env, `/repos/${app.repo}/git/commits/${base}`)).tree.sha;
  const newTree = await gh<{ sha: string }>(env, `/repos/${app.repo}/git/trees`, { method: "POST", body: JSON.stringify({ base_tree: baseTree, tree }) });
  const commit = await gh<{ sha: string }>(env, `/repos/${app.repo}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message: String(message || `Change ${tree.map((t) => t.path).join(", ")}`).slice(0, 500), tree: newTree.sha, parents: [base] }),
  });
  await gh(env, `/repos/${app.repo}/git/refs/heads/draft`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha }) });
  return { commit: commit.sha.slice(0, 7), files: tree.map((t) => t.path), branch: "draft" };
}

// What the draft holds that main doesn't, file by file: Save's "unsaved changes".
export async function status(env: Env, app: App) {
  if (!(await draftSha(env, app.repo, false))) return { draft: false, changed_files: [] as string[], files: [] };
  const c = await gh<{ ahead_by: number; files?: { filename: string; status: string; sha: string }[] }>(env, `/repos/${app.repo}/compare/main...draft`);
  const files = c.ahead_by ? (c.files ?? []) : [];
  return { draft: true, changed_files: files.map((f) => `${f.status} ${f.filename}`), files };
}

const blob = async (env: Env, repo: string, sha: string) => text((await gh<{ content: string }>(env, `/repos/${repo}/git/blobs/${sha}`)).content);

// The template's own safety check, run here on the draft (never the draft's copy of it), plus
// "migrations only add": an applied migration is never changed, and a new one never drops.
export async function checkDraft(env: Env, app: App, changed: { filename: string; status: string; sha: string }[]) {
  const tree = (await gh<{ tree: { path: string; type: string; sha: string }[] }>(env, `/repos/${app.repo}/git/trees/draft?recursive=1`)).tree;
  const wanted = tree.filter((t) => t.type === "blob" && (/^(worker\/.*\.ts|src\/.*\.(tsx?|css)|index\.html|public-routes\.json|package\.json|migrations\/.*\.sql)$/.test(t.path)));
  const files = Object.fromEntries(await Promise.all(wanted.map(async (t) => [t.path, await blob(env, app.repo, t.sha)])));
  const { errors } = checkRoutes(files, JSON.parse(files["public-routes.json"] ?? "[]"));
  for (const f of changed.filter((f) => f.filename.startsWith("migrations/"))) {
    if (f.status !== "added") errors.push(`${f.filename} is ${f.status}: an applied migration is never changed. Add a new migration instead.`);
    else if (/\b(DROP|RENAME|DELETE\s+FROM)\b/i.test(await blob(env, app.repo, f.sha))) errors.push(`${f.filename} drops, renames or deletes: migrations only add.`);
  }
  return errors;
}

export async function save(env: Env, app: App) {
  const s = await status(env, app);
  if (!s.files.length) throw new Refused("Nothing to save: the draft has no changes that aren't live already.");
  const errors = await checkDraft(env, app, s.files);
  if (errors.length) throw new Refused(`Not saved. The safety check failed:\n${errors.map((e) => `- ${e}`).join("\n")}`);
  try {
    await gh(env, `/repos/${app.repo}/merges`, { method: "POST", body: JSON.stringify({ base: "main", head: "draft", commit_message: "Save from Dozokit Apps" }) });
  } catch (e) {
    if ((e as { status?: number }).status === 409) throw new Refused("Not saved: the draft and main changed the same lines. Update the draft from main first.");
    throw e;
  }
  return { saved: s.changed_files, live_url: app.live_url, note: "Live and draft have separate databases: accounts and data made on the draft preview aren't on the live app." };
}
