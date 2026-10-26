import { checkRoutes } from "./check-routes.mjs";
import { gh, reachableRepos, Refused } from "./github";
import type { Env } from "./index";

// The owner's apps. Changes go to the app's `draft` branch, which Cloudflare builds as a preview;
// Save merges draft into main, which Cloudflare puts live. Only repos made from dozokit/app-template
// are apps, so the builder never writes to its own repo or to any other.

export type App = { id: number; repo: string; worker: string; preview_url: string | null; live_url: string | null; created_at: number };

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

export async function addApp(env: Env, repo: string, origin: string) {
  if (!(await candidates(env)).includes(repo)) throw new Refused(`${repo} isn't an app this builder can reach: it must be made from dozokit/app-template, with main as its default branch.`);
  const worker = (await appRepo(env, repo))!;
  // On workers.dev, the app lives next to the builder: <worker>.<subdomain>.workers.dev, its draft at draft-<worker>.
  const sub = new URL(origin).hostname.match(/^[^.]+\.([^.]+)\.workers\.dev$/)?.[1];
  const local = env.LOCAL_REPOS ? await gh<{ preview_url: string; live_url: string }>(env, `/local/urls/${repo}`) : null;
  const [preview, live] = local ? [local.preview_url, local.live_url] : sub ? [`https://draft-${worker}.${sub}.workers.dev`, `https://${worker}.${sub}.workers.dev`] : [null, null];
  return env.DB.prepare("insert into apps (repo, worker, preview_url, live_url, created_at) values (?, ?, ?, ?, ?) returning *").bind(repo, worker, preview, live, Date.now()).first<App>();
}

// Local mode: New app makes a git repo from the local template instead of the Deploy button.
export async function newLocalApp(env: Env, name: unknown, ownerEmail: unknown, origin: string) {
  const { repo } = await gh<{ repo: string }>(env, "/local/new", { method: "POST", body: JSON.stringify({ name, owner_email: ownerEmail }) });
  return addApp(env, repo, origin);
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
  const wanted = tree.filter((t) => t.type === "blob" && (/^worker\/.*\.ts$/.test(t.path) || t.path === "public-routes.json"));
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
