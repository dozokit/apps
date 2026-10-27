// Local mode, for development only: apps are git repos in the LOCAL_REPOS folder of .dev.vars
// instead of GitHub repos. This server answers the few GitHub API calls the builder makes, with
// git, on http://localhost:8790, and runs each app like Cloudflare would: main on one port (live),
// the draft branch on the next (preview), rebuilt after every change. It also starts the builder.
// Start: npm run dev:local
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const vars = Object.fromEntries(readFileSync(".dev.vars", "utf8").split("\n").filter((l) => /^\w+=/.test(l)).map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1)]));
const ROOT = vars.LOCAL_REPOS?.replace(/^~/, homedir());
const TEMPLATE = (vars.LOCAL_TEMPLATE ?? "~/dev/dozokit-apps").replace(/^~/, homedir());
if (!ROOT || !existsSync(ROOT)) throw new Error("Set LOCAL_REPOS in .dev.vars to an existing folder.");

const git = (dir, args, input) => execFileSync("git", ["-C", dir, ...args], { input, encoding: input instanceof Buffer ? undefined : "utf8", maxBuffer: 64 << 20, stdio: "pipe" });
const gitOk = (dir, args) => { try { return git(dir, args).trim(); } catch { return null; } };
const names = () => readdirSync(ROOT).filter((n) => !n.endsWith(".draft") && existsSync(join(ROOT, n, ".git"))).sort();
// Each app keeps its ports for good: live on an even port from 8800, its draft on the next one.
const PORTS = join(ROOT, ".ports.json");
const port = (name, draft) => {
  const ports = existsSync(PORTS) ? JSON.parse(readFileSync(PORTS, "utf8")) : {};
  if (!ports[name]) writeFileSync(PORTS, JSON.stringify({ ...ports, [name]: 8800 + Object.keys(ports).length * 2 }));
  return (ports[name] ?? 8800 + Object.keys(ports).length * 2) + (draft ? 1 : 0);
};
const b64 = (buf) => Buffer.from(buf).toString("base64");

// --- Running an app: build, local migrations, wrangler dev. A failed build is kept as the answer. ---
const servers = {}; // "<name>" or "<name>.draft" → { proc, ready: Promise }
function run(name, draft) {
  const key = draft ? `${name}.draft` : name;
  const dir = join(ROOT, key);
  const previous = servers[key];
  const entry = { proc: null };
  // One build at a time per server: a change during a build waits for it. Like Cloudflare, the
  // last good version keeps running until a new one builds.
  entry.ready = (async () => {
    await previous?.ready.catch(() => {});
    try {
      await promisify(execFile)("sh", ["-c", "npm install --prefer-offline --no-audit --no-fund && npm run build && npx wrangler d1 migrations apply DB --local"], { cwd: dir, maxBuffer: 16 << 20 });
    } catch (e) {
      // The last good version keeps running: the next good build has to be able to stop it.
      entry.proc = previous?.proc ?? null;
      throw new Error(`The build failed, as Cloudflare's would:\n${`${e.stdout ?? ""}${e.stderr ?? ""}`.slice(-3000)}`);
    }
    const p = port(name, draft);
    stop(previous);
    while (await fetch(`http://localhost:${p}/`).then(() => true, () => false)) await new Promise((r) => setTimeout(r, 300));
    // The app's log, where its emails land locally (sign-up confirmation, password reset).
    const log = openSync(join(ROOT, `${key}.log`), "a");
    // The draft runs as a preview (PREVIEW=1), as on Cloudflare: owner previews only work there.
    entry.proc = spawn("npx", ["wrangler", "dev", "--port", String(p), "--inspector-port", String(p + 1000), ...(draft ? ["--var", "PREVIEW:1"] : [])], { cwd: dir, stdio: ["ignore", log, log], detached: true });
    for (let i = 0; i < 60; i++) {
      if (await fetch(`http://localhost:${p}/`).then(() => true, () => false)) return `http://localhost:${p}`;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("wrangler dev didn't start within a minute.");
  })();
  entry.ready.catch(() => {});
  servers[key] = entry;
}

// wrangler dev runs workerd under it: stop the whole process group.
function stop(server) {
  try {
    if (server?.proc) process.kill(-server.proc.pid);
  } catch {}
}

// --- The GitHub API calls the builder makes, answered with git ---
async function answer(method, path, body) {
  if (path.split("?")[0] === "/user/repos") return names().map((n) => ({ full_name: `local/${n}`, default_branch: "main" }));
  if (method === "POST" && path === "/local/new") {
    const name = String(body.name ?? "").toLowerCase();
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(name) || existsSync(join(ROOT, name))) return [400, { message: "Pick a new name: lowercase letters, digits and dashes." }];
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.owner_email ?? "")) return [400, { message: "Give the owner's email: that account becomes the app's owner once the email is confirmed." }];
    execFileSync("git", ["clone", "-q", "--branch", "main", TEMPLATE, join(ROOT, name)]);
    git(join(ROOT, name), ["remote", "remove", "origin"]);
    const wrangler = join(ROOT, name, "wrangler.jsonc");
    writeFileSync(wrangler, readFileSync(wrangler, "utf8").replace(/"name":\s*"[^"]+"/, `"name": "${name}"`));
    const look = join(ROOT, name, "src", "themes", `${body.theme}.css`);
    if (/^[a-z]+$/.test(body.theme ?? "") && existsSync(look)) writeFileSync(join(ROOT, name, "src", "theme.css"), readFileSync(look));
    git(join(ROOT, name), ["commit", "-qam", `New app ${name}`]);
    writeFileSync(join(ROOT, name, ".dev.vars"), `BETTER_AUTH_SECRET=${b64(crypto.getRandomValues(new Uint8Array(32)))}\nOWNER_EMAIL=${body.owner_email}\n`);
    run(name, false);
    return { repo: `local/${name}` };
  }
  const m = path.match(/^\/(?:repos|local\/(urls|ready|mail))\/local\/([a-z0-9-]+)(\/.*)?$/);
  if (!m || !names().includes(m[2])) return [404, { message: "Not Found" }];
  const [, local, name, rest = ""] = m;
  const dir = join(ROOT, name);
  // The draft on its own hostname: browsers keep cookies per host, not per port, so logging in on
  // one doesn't log you out of the other (on Cloudflare they're different hosts anyway).
  // Where this app's emails land, and the latest link that confirms the owner's email.
  if (local === "mail") {
    const owner = readFileSync(join(dir, ".dev.vars"), "utf8").match(/^OWNER_EMAIL=(.*)$/m)?.[1];
    const latest = (log) => {
      const text = existsSync(log) ? readFileSync(log, "utf8") : "";
      return [...text.matchAll(/\[email stub\] to=(\S+) subject="Confirm your email"\n.*?(http\S+)/g)].filter((m) => m[1] === owner).pop()?.[2] ?? null;
    };
    const [log, draftLog] = [join(ROOT, `${name}.log`), join(ROOT, `${name}.draft.log`)];
    return { owner, log, owner_link: latest(log), draft_log: draftLog, draft_owner_link: latest(draftLog) };
  }
  if (local === "urls") return { preview_url: `http://draft.localhost:${port(name, true)}`, live_url: `http://localhost:${port(name, false)}` };
  if (local === "ready") {
    if (!servers[`${name}.draft`]) return [409, { message: "No draft preview yet: write_files first." }];
    return { url: await servers[`${name}.draft`].ready.catch((e) => { throw Object.assign(e, { status: 422 }); }) };
  }
  const q = new URL(rest, "http://x");
  const r = q.pathname;
  let x;
  if (method === "GET" && (x = r.match(/^\/contents\/(.+)$/))) {
    try {
      return { content: b64(git(dir, ["show", `${q.searchParams.get("ref") ?? "main"}:${x[1]}`], Buffer.alloc(0))) };
    } catch {
      return [404, { message: "Not Found" }];
    }
  }
  if (method === "GET" && (x = r.match(/^\/git\/ref\/heads\/(\w+)$/))) {
    const sha = gitOk(dir, ["rev-parse", "--verify", `refs/heads/${x[1]}`]);
    return sha ? { object: { sha } } : [404, { message: "Not Found" }];
  }
  if (method === "POST" && r === "/git/refs") {
    git(dir, ["branch", body.ref.replace("refs/heads/", ""), body.sha]);
    git(dir, ["worktree", "add", "-q", join(ROOT, `${name}.draft`), "draft"]);
    writeFileSync(join(ROOT, `${name}.draft`, ".dev.vars"), readFileSync(join(dir, ".dev.vars")));
    return {};
  }
  if (method === "PATCH" && r === "/git/refs/heads/draft") {
    git(dir, ["update-ref", "refs/heads/draft", body.sha]);
    git(join(ROOT, `${name}.draft`), ["reset", "-q", "--hard", "draft"]);
    run(name, true);
    return {};
  }
  if (method === "GET" && (x = r.match(/^\/git\/trees\/(\w+)$/))) {
    const tree = git(dir, ["ls-tree", "-r", x[1]]).trim().split("\n").map((l) => { const [meta, path] = l.split("\t"); const [, type, sha] = meta.split(" "); return { path, type, sha }; });
    return { tree };
  }
  if (method === "GET" && (x = r.match(/^\/git\/commits\/(\w+)$/))) return { tree: { sha: git(dir, ["rev-parse", `${x[1]}^{tree}`]).trim() } };
  if (method === "GET" && (x = r.match(/^\/git\/blobs\/(\w+)$/))) return { content: b64(git(dir, ["cat-file", "blob", x[1]], Buffer.alloc(0))) };
  if (method === "POST" && r === "/git/trees") {
    const index = join(ROOT, `.index-${name}`);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    const g = (args, input) => execFileSync("git", ["-C", dir, ...args], { env, input, encoding: "utf8" }).trim();
    g(["read-tree", body.base_tree]);
    for (const t of body.tree) {
      if (t.sha === null) g(["update-index", "--force-remove", t.path]);
      else g(["update-index", "--add", "--cacheinfo", `100644,${g(["hash-object", "-w", "--stdin"], t.content)},${t.path}`]);
    }
    return { sha: g(["write-tree"]) };
  }
  if (method === "POST" && r === "/git/commits") return { sha: git(dir, ["commit-tree", body.tree, ...body.parents.flatMap((p) => ["-p", p]), "-m", body.message]).trim() };
  if (method === "GET" && r === "/compare/main...draft") {
    const status = { A: "added", M: "modified", D: "removed", R: "renamed" };
    const files = git(dir, ["diff", "--name-status", "--no-renames", "main...draft"]).trim().split("\n").filter(Boolean).map((l) => {
      const [s, filename] = l.split("\t");
      return { filename, status: status[s[0]] ?? s, sha: gitOk(dir, ["rev-parse", `draft:${filename}`]) };
    });
    return { ahead_by: Number(git(dir, ["rev-list", "--count", "main..draft"])), files };
  }
  if (method === "POST" && r === "/merges") {
    const tree = gitOk(dir, ["merge-tree", "--write-tree", "main", "draft"]);
    if (!tree) return [409, { message: "Merge conflict" }];
    const commit = git(dir, ["commit-tree", tree.split("\n")[0], "-p", "main", "-p", "draft", "-m", body.commit_message]).trim();
    git(dir, ["update-ref", "refs/heads/main", commit]);
    git(dir, ["reset", "-q", "--hard", "main"]);
    run(name, false);
    return { sha: commit };
  }
  return [404, { message: `Not answered in local mode: ${method} ${path}` }];
}

createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  try {
    const out = await answer(req.method, req.url, body ? JSON.parse(body) : {});
    const [status, data] = Array.isArray(out) && typeof out[0] === "number" ? out : [200, out];
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
  } catch (e) {
    res.writeHead(e.status ?? 500, { "content-type": "application/json" }).end(JSON.stringify({ message: String(e.message ?? e) }));
  }
}).listen(8790, "127.0.0.1", () => console.log(`Local repos in ${ROOT}, from ${TEMPLATE}. Builder: http://localhost:8788`));

// Apps already there run again, and the builder itself starts.
for (const n of names()) {
  run(n, false);
  if (existsSync(join(ROOT, `${n}.draft`))) run(n, true);
}
const builder = { proc: spawn("npm", ["run", "dev"], { stdio: "inherit", detached: true }) };
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { [builder, ...Object.values(servers)].forEach(stop); process.exit(); });
