import { useCallback, useEffect, useState, type FormEvent } from "react";
import { lang, setLang, t, tr } from "./lib/i18n";

type AppRow = { id: number; repo: string; worker: string; preview_url: string | null; live_url: string | null };
type Theme = { name: string; paper: string; ink: string; accent: string; "font-head": string };
type Usage = { requests: number; rows_read?: number; rows_written?: number; d1_queries?: number; emails: number; local: boolean; limits: Record<string, number> };
type State = { version: string; local: boolean; cloudflare: boolean; themes: Theme[]; github: { app: string; page?: string; installed: boolean } | null; apps: AppRow[]; mcp: string };
type Mail = { owner: string; log: string; owner_code: string | null; draft_log: string; draft_owner_code: string | null };
type Detail = AppRow & { draft: boolean; changed_files: string[]; local_mail: Mail | null };
type AgentToken = { hash: string; created_at: number; expires_at: number };

const TEMPLATE_DEPLOY = "https://deploy.workers.cloudflare.com/?url=https://github.com/dozokit/app-template";

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(tr(out.error ?? `Error ${res.status}`)), { status: res.status });
  return out as T;
}

const route = () => Number(location.hash.match(/^#app\/(\d+)$/)?.[1]) || null;

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [needLogin, setNeedLogin] = useState<string | null>(null);
  const [appId, setAppId] = useState(route());

  const load = useCallback(() => {
    call<State>("/api/state")
      .then((s) => {
        const next = new URLSearchParams(location.search).get("next");
        if (next?.startsWith("/")) location.href = next;
        else setState(s);
      })
      .catch((e) => setNeedLogin(e.message));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    const on = () => setAppId(route());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);

  if (needLogin !== null && !state) return <Login message={needLogin} onDone={() => (setNeedLogin(null), load())} />;
  if (!state) return <main className="muted">{t("Loading…")}</main>;
  return appId ? <Editor id={appId} /> : <Home state={state} reload={load} />;
}

function Login({ message, onDone }: { message: string; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState(message === tr("Sign in first.") ? "" : message);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await call("/api/login", "POST", { password });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  }
  return (
    <main>
      <h1>Dozokit Apps</h1>
      <form className="row" onSubmit={submit}>
        <input className="grow" type="password" placeholder={t("Password")} value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        <button disabled={busy || !password}>{t("Sign in")}</button>
      </form>
      {error && <p className="error">{error}</p>}
    </main>
  );
}

function Home({ state, reload }: { state: State; reload: () => void }) {
  const q = new URLSearchParams(location.search);
  const [error, setError] = useState(q.get("error") ? tr(q.get("error")!) : "");
  const [found, setFound] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [owner, setOwner] = useState("");
  const [theme, setTheme] = useState("Clean");
  // The look a new app starts with; Claude changes it later in its src/theme.css.
  const picker = (
    <fieldset className="themes">
      <legend>{t("Look")}</legend>
      {state.themes.map((th) => (
        <label key={th.name} className={theme === th.name ? "picked" : ""}>
          <input type="radio" name="theme" value={th.name} checked={theme === th.name} onChange={() => setTheme(th.name)} />
          <span className="swatch" style={{ background: th.paper, color: th.ink, fontFamily: th["font-head"] }}>
            Aa<i style={{ background: th.accent }} />
          </span>
          {t(th.name)}
        </label>
      ))}
    </fieldset>
  );
  const gh = state.github;

  // GitHub only accepts the manifest as a form the owner's browser posts.
  async function connect() {
    setBusy(true);
    try {
      const { action, manifest } = await call<{ action: string; manifest: string }>("/api/github/start", "POST");
      const form = Object.assign(document.createElement("form"), { method: "post", action });
      form.append(Object.assign(document.createElement("input"), { type: "hidden", name: "manifest", value: manifest }));
      document.body.append(form);
      form.submit();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  async function find() {
    setBusy(true);
    setError("");
    try {
      setFound(await call<string[]>("/api/candidates"));
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }
  async function add(repo: string | null) {
    setBusy(true);
    try {
      const app = await (repo ? call<AppRow>("/api/apps", "POST", { repo, theme }) : call<AppRow>("/api/apps/local", "POST", { name, owner_email: owner, theme }));
      location.hash = `#app/${app.id}`;
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <main>
      <div className="row">
        <h1 className="grow">Dozokit Apps</h1>
        <button className="line" onClick={() => setLang(lang === "fr" ? "en" : "fr")}>{lang === "fr" ? "English" : "Français"}</button>
        <button className="line" onClick={() => call("/api/logout", "POST").then(() => location.reload())}>{t("Sign out")}</button>
      </div>
      {q.get("github") === "connected" && <p className="ok">{t("GitHub is connected.")}</p>}
      {error && <p className="error">{error}</p>}

      <section>
        <h2 style={{ marginTop: 0 }}>GitHub</h2>
        {!gh && (
          <>
            <p>{t("Your apps live in your own GitHub. Connect GitHub creates a small GitHub App in your account: click Create, then Install. Its key stays in this builder.")}</p>
            <button disabled={busy} onClick={connect}>{t("Connect GitHub")}</button>
          </>
        )}
        {gh && !gh.installed && (
          <>
            <p>{t("The GitHub App {app} is created. Install it on your account, with access to all repositories, so new apps are reachable.", { app: gh.app })}</p>
            <a className="btn" href={`${gh.page}/installations/new`}>{t("Install it")}</a>
          </>
        )}
        {gh?.installed && (
          <p className="muted">
            {t("Connected through {app}.", { app: gh.app })} {gh.page && <a href={gh.page}>{t("Manage on GitHub")}</a>}
          </p>
        )}
      </section>

      <section>
        <h2 style={{ marginTop: 0 }}>{t("Your apps")}</h2>
        {state.apps.length ? (
          <ul className="apps">
            {state.apps.map((a) => (
              <li key={a.id} className="row">
                <a className="grow" href={`#app/${a.id}`}>
                  <strong>{a.repo}</strong>
                </a>
                {a.live_url && <a href={a.live_url} target="_blank" rel="noreferrer">{t("Live app")}</a>}
                <a className="btn" href={`#app/${a.id}`}>{t("Open")}</a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">{t("No apps yet.")}</p>
        )}
      </section>

      {state.local && (
        <section>
          <h2 style={{ marginTop: 0 }}>{t("New app")}</h2>
          <p className="muted">{t("Local mode: the app is a git repo on this computer, made from the local template, and runs here.")}</p>
          {picker}
          <form className="row" onSubmit={(e) => (e.preventDefault(), add(null))}>
            <input className="grow" placeholder={t("Name (lowercase, e.g. bookings)")} value={name} onChange={(e) => setName(e.target.value)} />
            <input className="grow" type="email" placeholder={t("Your email (the app's owner)")} value={owner} onChange={(e) => setOwner(e.target.value)} />
            <button disabled={busy || !name || !owner}>{busy ? t("Creating…") : t("Create")}</button>
          </form>
          <p className="muted">{t("Sign in to your app with this email (by code or Google) to get the owner views.")}</p>
          <p className="muted">{t("The emails each app sends (sign-in codes) are written to <app name>.log in the local repos folder, and shown on its page here.")}</p>
        </section>
      )}

      {gh?.installed && !state.local && (
        <section>
          <h2 style={{ marginTop: 0 }}>{t("New app")}</h2>
          <p>
            1. {t("Deploy to Cloudflare copies the app template into your GitHub, creates its database and puts it online. Pick a name for it there.")}
          </p>
          <p>
            <a className="btn" href={TEMPLATE_DEPLOY} target="_blank" rel="noreferrer">{t("Deploy a new app")}</a>
          </p>
          <p>2. {t("Once Cloudflare shows it online, add it here.")}</p>
          {picker}
          <button className="line" disabled={busy} onClick={find}>{t("Find my new app")}</button>
          {found && !found.length && <p className="muted">{t("No new app found yet. If the deploy finished, check the GitHub App can reach all your repositories.")}</p>}
          {found?.map((repo) => (
            <p key={repo} className="row">
              <code className="grow">{repo}</code>
              <button disabled={busy} onClick={() => add(repo)}>{t("Add")}</button>
            </p>
          ))}
        </section>
      )}

      {!state.local && <CloudflareToken connected={state.cloudflare} reload={reload} />}

      <section>
        <h2 style={{ marginTop: 0 }}>{t("Build with Claude")}</h2>
        {!state.local && <p>{t("In Claude: Settings → Connectors → Add custom connector, then paste this address. Claude asks you to allow it here once.")}</p>}
        <p>
          <code>{state.mcp}</code>
        </p>
        <p>{state.local ? t("In Claude Code (claude.ai can't reach this computer):") : t("In Claude Code:")}</p>
        <ol>
          <li>
            {t("In a terminal:")} <code>claude mcp add -s user --transport http dozokit-apps {state.mcp}</code> {t("(from any folder: -s user makes it available everywhere)")}
          </li>
          <li>{t("Start claude, type /mcp, pick dozokit-apps → Authenticate, then click Allow on the page that opens.")}</li>
          <li>{t("The tools only appear in a new claude session, started after Authenticate.")}</li>
        </ol>
        <AgentTokens mcp={state.mcp} />
        <p className="muted">{t("Other clients and agents: it's MCP over HTTP with standard OAuth (discovery at /.well-known/oauth-authorization-server, dynamic client registration, PKCE S256), then JSON-RPC POSTs to this address with the bearer token.")}</p>
      </section>
      <p className="muted">
        Dozokit Apps {state.version} · {t("To update: on GitHub, your builder's repo → Actions → Update Dozokit Apps → Run workflow.")}
      </p>
    </main>
  );
}

function Editor({ id }: { id: number }) {
  const [app, setApp] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [frame, setFrame] = useState(0);
  const [addr, setAddr] = useState<{ preview_url: string; live_url: string } | null>(null);
  const unsaved = (app?.changed_files.length ?? 0) > 0;

  // An app that no longer exists (an old tab): back to the list instead of asking again.
  const load = useCallback(() => call<Detail>(`/api/apps/${id}`).then(setApp).catch((e) => (e.status === 400 ? (location.hash = "") : setError(e.message))), [id]);
  useEffect(() => {
    load();
    // Claude writes to the draft from the chat: keep the unsaved count current.
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [load]);

  // Leaving with changes that aren't live: the browser asks first.
  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [unsaved]);

  async function saveIt() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await call(`/api/apps/${id}/save`, "POST");
      setNotice(app?.local_mail ? t("Saved. Live at {url}", { url: app.live_url ?? "" }) : t("Saved. Cloudflare is building it; the live app updates in about a minute."));
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }
  async function saveAddresses(e: FormEvent) {
    e.preventDefault();
    await call(`/api/apps/${id}`, "PUT", addr).catch((err) => setError(err.message));
    setAddr(null);
    load();
  }
  const back = (e: React.MouseEvent) => {
    if (unsaved && !confirm(t("This app has changes that aren't saved. They stay in the draft, but they aren't live. Leave anyway?"))) e.preventDefault();
  };

  if (!app) return <main>{error ? <p className="error">{error}</p> : <p className="muted">{t("Loading…")}</p>}</main>;
  return (
    <main className="wide">
      <div className="row">
        <a href="#" onClick={back}>
          ← {t("Your apps")}
        </a>
        <strong className="grow">{app.repo}</strong>
        {app.live_url && <a href={app.live_url} target="_blank" rel="noreferrer">{t("Live app")}</a>}
        <button className="line" onClick={() => setFrame(frame + 1)}>{t("Reload preview")}</button>
        <button disabled={busy || !unsaved} onClick={saveIt}>{busy ? t("Saving…") : t("Save")}</button>
      </div>
      <p className={unsaved ? "" : "muted"}>
        {unsaved ? t("{n} unsaved changes in the draft:", { n: app.changed_files.length }) : t("Everything in the draft is live.")}{" "}
        {app.changed_files.map((f) => `${t(f.split(" ")[0])} ${f.split(" ").slice(1).join(" ")}`).join(" · ")}
      </p>
      {notice && <p className="ok">{notice}</p>}
      {error && <p className="error">{error}</p>}
      {app.local_mail &&
        ([[t("Live app"), app.local_mail.log, app.local_mail.owner_code], [t("Draft preview"), app.local_mail.draft_log, app.local_mail.draft_owner_code]] as const).map(([which, log, link]) => (
          <p key={log} className="muted">
            {which} : {t("emails (sign-in codes) are written to {log}.", { log })}{" "}
            {link ? (
              <>
                {t("Latest sign-in code for {owner}:", { owner: app.local_mail!.owner })} <strong>{link}</strong> {t("(works for 5 minutes)")}
              </>
            ) : (
              t("No sign-in code for {owner} here yet.", { owner: app.local_mail!.owner })
            )}
          </p>
        ))}
      <UsagePanel id={id} />
      <p className="muted">{t("Live and draft have separate databases: accounts and data made on the draft preview aren't on the live app.")}</p>
      {!app.draft && <p>{t("No draft yet: ask Claude to change something and the draft preview appears here. Meanwhile, this is the live app.")}</p>}
      {(app.draft ? app.preview_url : app.live_url) ? (
        <iframe key={frame} src={(app.draft ? app.preview_url : app.live_url)!} title={app.draft ? t("Draft preview") : t("Live app")} />
      ) : (
        <p className="muted">{t("No draft preview address yet: set it below.")}</p>
      )}
      {addr ? (
        <form className="row" onSubmit={saveAddresses}>
          <input className="grow" placeholder={t("Draft preview address")} value={addr.preview_url} onChange={(e) => setAddr({ ...addr, preview_url: e.target.value })} />
          <input className="grow" placeholder={t("Live address")} value={addr.live_url} onChange={(e) => setAddr({ ...addr, live_url: e.target.value })} />
          <button>{t("Save addresses")}</button>
        </form>
      ) : (
        <p className="muted">
          {t("Draft preview: {url}", { url: app.preview_url ?? "—" })}{" "}
          <button className="line" onClick={() => setAddr({ preview_url: app.preview_url ?? "", live_url: app.live_url ?? "" })}>{t("Change")}</button>
        </p>
      )}
    </main>
  );
}

// An agent already running (a Claude Code session, a script) can't open a browser to sign in:
// it gets a token from here instead, valid 24 hours.
function AgentTokens({ mcp }: { mcp: string }) {
  const [tokens, setTokens] = useState<AgentToken[]>([]);
  const [fresh, setFresh] = useState<string | null>(null);
  const load = () => call<AgentToken[]>("/api/agent-tokens").then(setTokens);
  useEffect(() => void load(), []);
  async function make() {
    setFresh((await call<{ token: string }>("/api/agent-tokens", "POST")).token);
    load();
  }
  const revoke = (hash: string) => call<AgentToken[]>("/api/agent-tokens", "POST", { revoke: hash }).then(setTokens);
  const curl = (rpc: string) => `curl -s ${mcp} -H "Authorization: Bearer ${fresh}" -H "content-type: application/json" -d '${rpc}'`;
  return (
    <>
      <p>
        {t("An agent already running, which can't open /mcp:")} <button className="line" onClick={make}>{t("Connect an agent")}</button>
      </p>
      {fresh && (
        <section>
          <p>{t("Shown once, valid 24 hours. In a terminal (tools in claude sessions started after):")}</p>
          <p>
            {/* --header takes several values, so it goes last. */}
            <code>claude mcp add --transport http -s user dozokit-apps {mcp} --header "Authorization: Bearer {fresh}"</code>
          </p>
          <p>{t("Or right away, from the running session:")}</p>
          <p>
            <code>{curl('{"jsonrpc":"2.0","id":1,"method":"tools/list"}')}</code>
          </p>
          <p>{t("Then a tool, e.g. list_apps:")}</p>
          <p>
            <code>{curl('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_apps","arguments":{}}}')}</code>
          </p>
          <p className="muted">{t("To try an app's own API on its draft: POST <draft>/api/auth/sign-up/email with {email, password, name}, the header Origin: <draft> and a cookie jar, then call its routes with that cookie.")}</p>
        </section>
      )}
      {tokens.length > 0 && (
        <ul className="apps">
          {tokens.map((k) => (
            <li key={k.hash} className="row">
              <span className="grow muted">{t("Agent token made {made}, valid until {until}", { made: new Date(k.created_at).toLocaleString(), until: new Date(k.expires_at).toLocaleString() })}</span>
              <button className="line" onClick={() => revoke(k.hash)}>{t("Revoke")}</button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// Today's use of the live app against the free plan's daily limits (UTC day), amber from 80%.
function UsagePanel({ id }: { id: number }) {
  const [u, setU] = useState<Usage | null>(null);
  useEffect(() => {
    const load = () => call<Usage | null>(`/api/apps/${id}/usage`).then(setU).catch(() => setU(null));
    load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, [id]);
  if (!u) return <p className="muted">{t("Usage today: connect your Cloudflare account on the home page to see it.")}</p>;
  const rows: [string, number, number | null][] = [
    [t("Requests"), u.requests, u.limits.requests],
    ...(u.local
      ? ([[t("Database queries (rows are counted on Cloudflare only)"), u.d1_queries ?? 0, null]] as [string, number, null][])
      : ([[t("Database rows read"), u.rows_read ?? 0, u.limits.rows_read], [t("Database rows written"), u.rows_written ?? 0, u.limits.rows_written]] as [string, number, number][])),
    [t("Emails sent"), u.emails, u.limits.emails],
  ];
  return (
    <section className="usage">
      <strong>{t("Today on the live app (free plan, resets at midnight UTC)")}</strong>
      {rows.map(([label, n, max]) => (
        <p key={label} className={max && n >= max * 0.8 ? "warn" : ""}>
          {label}: {n.toLocaleString()}
          {max ? ` / ${max.toLocaleString()}` : ""}
          {max && n >= max * 0.8 ? ` · ${t("near the free limit")}` : ""}
        </p>
      ))}
    </section>
  );
}

// The owner's Cloudflare API token, for the usage of their apps. Stored here, never shown again.
function CloudflareToken({ connected, reload }: { connected: boolean; reload: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await call("/api/cloudflare", "POST", { token });
      setToken("");
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  }
  return (
    <section>
      <h2 style={{ marginTop: 0 }}>Cloudflare</h2>
      <p>
        {connected ? t("Connected: your apps' usage shows on their page.") : t("To see your apps' usage, create an API token on Cloudflare (My Profile → API Tokens → Create Token → Custom token) with Account Analytics: Read and D1: Read, then paste it here.")}
      </p>
      <form className="row" onSubmit={save}>
        <input className="grow" type="password" placeholder={t("Cloudflare API token")} value={token} onChange={(e) => setToken(e.target.value)} />
        <button disabled={busy || !token}>{connected ? t("Replace") : t("Connect")}</button>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
