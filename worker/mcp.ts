import { checkDraft, getApp, listApps, previewOwner, readFile, save, status, writeFiles } from "./apps";
import { gh, Refused } from "./github";
import type { Env } from "./index";
import { shots } from "./shot";

// The builder as an MCP server, for the chat apps the owner connected (Claude). The chat's own model
// writes the code on the owner's plan; these tools read and write the app's files on its draft
// branch, show the draft's preview, and save it. Nothing here calls an AI.

type Ctx = { env: Env; origin: string };
type Tool = { name: string; description: string; inputSchema: object; run: (a: Record<string, unknown>, ctx: Ctx) => Promise<unknown> };
class Seen {
  constructor(readonly images: string[], readonly note: unknown) {}
}

const editor = (origin: string, id: number) => `${origin}/#app/${id}`;
const appId = { app_id: { type: "number", description: "From list_apps" } };

const TOOLS: Tool[] = [
  {
    name: "list_apps",
    description: "The owner's apps: id, GitHub repo, live address, draft preview address, unsaved changes and the editor link to show the owner. Each app is a React + Vite app on Cloudflare Workers with a D1 database and Better Auth logins; read its CLAUDE.md first.",
    inputSchema: { type: "object", properties: {} },
    run: async (_a, { env, origin }) =>
      Promise.all(
        (await listApps(env)).map(async (a) => ({ app_id: a.id, repo: a.repo, live: a.live_url, draft_preview: a.preview_url, unsaved_files: (await status(env, a)).changed_files.length, editor: editor(origin, a.id) })),
      ),
  },
  {
    name: "read_file",
    description: "Read one file of an app, from its draft (or main when there's no draft yet). With no path: the list of every file. Start with CLAUDE.md: its rules are enforced at Save.",
    inputSchema: { type: "object", properties: { ...appId, path: { type: "string", description: "e.g. worker/routes.ts; leave out to list files" } }, required: ["app_id"] },
    run: async (a, { env }) => readFile(env, await getApp(env, a.app_id), a.path),
  },
  {
    name: "write_files",
    description: "Write whole files to the app's draft branch as one commit (never to main); the draft preview is then rebuilt from it. The answer gives the safety check's result (and locally the build's). Check the look with preview. Give each file's full new content, or delete: true to remove it.",
    inputSchema: {
      type: "object",
      properties: {
        ...appId,
        files: { type: "array", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, delete: { type: "boolean" } }, required: ["path"] } },
        message: { type: "string", description: "What changed, in a few words (the commit message)" },
      },
      required: ["app_id", "files"],
    },
    run: async (a, { env, origin }) => {
      const app = await getApp(env, a.app_id);
      const written = await writeFiles(env, app, a.files, a.message);
      // The same safety check Save runs, on the draft as it is now; locally also the draft's whole build.
      const errors = await checkDraft(env, app, (await status(env, app)).files);
      const build = env.LOCAL_REPOS
        ? await gh(env, `/local/ready/${app.repo}`).then(() => "passed", (e: Error) => e.message)
        : "Cloudflare builds the draft from this commit; preview shows the result once it's done.";
      return { ...written, safety_check: errors.length ? errors : "passed", build, draft_preview: app.preview_url, editor: editor(origin, app.id) };
    },
  },
  {
    name: "preview",
    description: "Screenshots only, no clicks or typing: pages of the app's draft preview, desktop and phone, up to 4 pages per call. To check what a click does (book, cancel, a rule between two users), call the draft's API yourself: sign up with POST <draft>/api/auth/sign-up/email {\"email\",\"password\" (8+),\"name\"} with the header Origin: <draft> and a cookie jar, then call its routes with that cookie; data made that way shows in later previews of that user only. as_owner: true shows owner-only pages (the first time, it adds preview-owner.json to the draft). By default logged in as a new throwaway test user it signs up on the draft's own database (never live), so logged-in pages show; logged_out: true shows what a visitor sees. Locally it waits for the draft's build; on Cloudflare, if it still shows the old version, the build isn't done: call it again shortly.",
    inputSchema: {
      type: "object",
      properties: { ...appId, path: { type: "string", description: "A page of the app, e.g. /settings (default /)" }, paths: { type: "array", items: { type: "string" }, description: "Several pages at once, e.g. [\"/\", \"/admin\"] (up to 4)" }, logged_out: { type: "boolean", description: "Show the page logged out" }, as_owner: { type: "boolean", description: "Log in as the app's owner instead (a throwaway owner on the draft's own database, never live), for owner-only pages" } },
      required: ["app_id"],
    },
    run: async (a, { env, origin }) => {
      const app = await getApp(env, a.app_id);
      if (!app.preview_url) throw new Refused("This app has no draft preview address yet: the owner sets it in the editor.");
      // The first owner preview adds preview-owner.json to the draft: the draft is rebuilt with it.
      const owner = a.as_owner === true ? await previewOwner(env, app) : null;
      if (owner?.added && !env.LOCAL_REPOS) return { note: "Owner previews are now set up: the draft has a new preview-owner.json and Cloudflare is rebuilding it. Call preview with as_owner again shortly." };
      if (env.LOCAL_REPOS) await gh(env, `/local/ready/${app.repo}`);
      const paths = Array.isArray(a.paths) && a.paths.length ? a.paths.slice(0, 4).map(String) : [String(a.path || "/")];
      const s = await shots(env, paths.map((p) => new URL(p, app.preview_url!).href), owner ?? a.logged_out !== true);
      return new Seen(s.images, { logged_in_as: s.user, shots: s.shots, try_it_yourself: app.preview_url, editor: editor(origin, app.id) });
    },
  },
  {
    name: "save",
    description: "Put the draft live: merge draft into main, after the safety check (every data route checks the logged-in user; migrations only add). Only when the owner asks to save. Cloudflare then builds main and the live app updates in about a minute.",
    inputSchema: { type: "object", properties: appId, required: ["app_id"] },
    run: async (a, { env }) => save(env, await getApp(env, a.app_id)),
  },
];

const INSTRUCTIONS =
  "This is the owner's own app builder (Dozokit Apps). Each app is its own GitHub repo, Worker and database on the owner's free Cloudflare. Call list_apps, then read the app's CLAUDE.md with read_file and follow it. write_files changes only the draft; check it with preview; save only when the owner asks. If save is refused, fix what it names and try again.";

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

async function one(m: Rpc, ctx: Ctx) {
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: m.id ?? null, result });
  switch (m.method) {
    case "initialize":
      return ok({ protocolVersion: String(m.params?.protocolVersion ?? "2025-06-18"), capabilities: { tools: {} }, serverInfo: { name: "dozokit-apps", title: "Dozokit Apps", version: "0.1.0" }, instructions: INSTRUCTIONS });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === m.params?.name);
      if (!tool) return { jsonrpc: "2.0", id: m.id ?? null, error: { code: -32602, message: `Unknown tool ${String(m.params?.name)}` } };
      try {
        const out = await tool.run((m.params?.arguments ?? {}) as Record<string, unknown>, ctx);
        console.log(`[mcp] ${tool.name} ok`);
        if (out instanceof Seen) return ok({ content: [...out.images.map((data) => ({ type: "image", data, mimeType: "image/jpeg" })), { type: "text", text: JSON.stringify(out.note, null, 1) }] });
        return ok({ content: [{ type: "text", text: JSON.stringify(out, null, 1) }] });
      } catch (err) {
        console.log(`[mcp] ${tool.name} refused: ${String((err as Error)?.message ?? err)}`.slice(0, 300));
        const text = err instanceof Refused ? err.message : `That failed (${String((err as Error)?.message ?? err).slice(0, 200)}).`;
        return ok({ content: [{ type: "text", text }], isError: true });
      }
    }
    default:
      return m.id === undefined ? null : { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Unknown method ${m.method}` } };
  }
}

// Streamable HTTP, answered as plain JSON: every tool answers at once.
export async function mcp(req: Request, ctx: Ctx) {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  const body = (await req.json().catch(() => null)) as Rpc | Rpc[] | null;
  if (!body) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  const out = Array.isArray(body) ? (await Promise.all(body.map((m) => one(m, ctx)))).filter(Boolean) : await one(body, ctx);
  if (!out || (Array.isArray(out) && !out.length)) return new Response(null, { status: 202 });
  return Response.json(out, { headers: { "access-control-allow-origin": "*" } });
}
