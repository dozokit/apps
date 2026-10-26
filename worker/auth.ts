import type { Env } from "./index";

// One password: the PASSWORD secret set when deploying. Changing the secret in Cloudflare is how
// it's changed or reset, and it signs every device out. Without a secret the builder is open on
// this machine (local development) and closed everywhere else.

const COOKIE = "dozokit_apps_session";
const MONTH = 30 * 24 * 3600 * 1000;

export const SETUP_NEEDED = "This builder needs a password of 12 characters or more before it opens.";

const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/[+/=]/g, (c) => (c === "+" ? "-" : c === "/" ? "_" : ""));

async function sign(value: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

// Compares the two values' MACs, so neither their content nor their length leaks through timing.
async function same(a: string, b: string, secret: string) {
  const [x, y] = await Promise.all([sign(a, secret), sign(b, secret)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

const isLocal = (req: Request) => /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(req.url).hostname);

export const setupNeeded = (req: Request, env: Env) => ((env.PASSWORD ? env.PASSWORD.length < 12 : !isLocal(req)) ? SETUP_NEEDED : null);

export async function signedIn(req: Request, env: Env) {
  if (setupNeeded(req, env)) return false;
  if (!env.PASSWORD) return true;
  const raw = (req.headers.get("cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1);
  const [exp, mac] = raw?.split(".") ?? [];
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  return same(mac, await sign(exp, env.PASSWORD), env.PASSWORD);
}

export async function login(req: Request, env: Env) {
  const setup = setupNeeded(req, env);
  if (setup) return Response.json({ error: setup }, { status: 503 });
  if (!env.PASSWORD) return Response.json({ ok: true });
  const ip = req.headers.get("cf-connecting-ip") ?? "local";
  if (env.LOGIN_LIMIT && !(await env.LOGIN_LIMIT.limit({ key: ip })).success) {
    return Response.json({ error: "Too many attempts. Wait a minute, then try again." }, { status: 429 });
  }
  const body = (await req.json().catch(() => ({}))) as { password?: string };
  if (typeof body.password !== "string" || !(await same(body.password, env.PASSWORD, env.PASSWORD))) {
    return Response.json({ error: "That password is not the one set for this builder." }, { status: 401 });
  }
  const exp = String(Date.now() + MONTH);
  return Response.json({ ok: true }, { headers: { "set-cookie": cookie(req, `${exp}.${await sign(exp, env.PASSWORD)}`, MONTH / 1000) } });
}

export const logout = (req: Request) => Response.json({ ok: true }, { headers: { "set-cookie": cookie(req, "", 0) } });

function cookie(req: Request, value: string, maxAge: number) {
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
