import { useCallback, useEffect, useState, type FormEvent } from "react";
import { lang, setLang, t, tr } from "./lib/i18n";

type AppRow = { id: number; repo: string; worker: string; preview_url: string | null; live_url: string | null };
type State = { version: string; github: { app: string; page?: string; installed: boolean } | null; apps: AppRow[]; mcp: string };
type Detail = AppRow & { unsaved_commits: number; changed_files: string[] };

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
  async function add(repo: string) {
    setBusy(true);
    try {
      const app = await call<AppRow>("/api/apps", "POST", { repo });
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

      {gh?.installed && (
        <section>
          <h2 style={{ marginTop: 0 }}>{t("New app")}</h2>
          <p>
            1. {t("Deploy to Cloudflare copies the app template into your GitHub, creates its database and puts it online. Pick a name for it there.")}
          </p>
          <p>
            <a className="btn" href={TEMPLATE_DEPLOY} target="_blank" rel="noreferrer">{t("Deploy a new app")}</a>
          </p>
          <p>2. {t("Once Cloudflare shows it online, add it here.")}</p>
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

      <section>
        <h2 style={{ marginTop: 0 }}>{t("Build with Claude")}</h2>
        <p>{t("In Claude: Settings → Connectors → Add custom connector, then paste this address. Claude asks you to allow it here once.")}</p>
        <p>
          <code>{state.mcp}</code>
        </p>
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
  const unsaved = (app?.unsaved_commits ?? 0) > 0;

  const load = useCallback(() => call<Detail>(`/api/apps/${id}`).then(setApp).catch((e) => setError(e.message)), [id]);
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
      setNotice(t("Saved. Cloudflare is building it; the live app updates in about a minute."));
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
        {unsaved ? t("{n} unsaved changes in the draft:", { n: app.unsaved_commits }) : t("Everything in the draft is live.")} {app.changed_files.join(" · ")}
      </p>
      {notice && <p className="ok">{notice}</p>}
      {error && <p className="error">{error}</p>}
      {app.preview_url ? <iframe key={frame} src={app.preview_url} title={t("Draft preview")} /> : <p className="muted">{t("No draft preview address yet: set it below.")}</p>}
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
