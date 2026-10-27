import puppeteer from "@cloudflare/puppeteer";
import type { Env } from "./index";
import { Refused } from "./github";

// Screenshots of an app's draft preview, for chats that can't open pages themselves.
// Uses Cloudflare's browser (free plan: 10 minutes a day).

const b64 = (buf: Uint8Array) => {
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
};

// Logged in: a throwaway test user signs up on the page's own app first (the template's Better Auth),
// so the shots show what a customer sees. Only ever called on a draft preview, never the live app.
export async function shots(env: Env, urls: string[], login: boolean | { email: string; password: string }) {
  if (!env.BROWSER) throw new Refused("This builder has no browser binding, so it can't take screenshots.");
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    let user: string | null = null;
    if (login) {
      await page.goto(new URL("/", urls[0]).href, { waitUntil: "networkidle0", timeout: 20_000 });
      // A given user (the draft's owner) signs in, or signs up the first time; else a new throwaway user.
      const who = login === true ? { email: `preview-${crypto.randomUUID().slice(0, 8)}@example.test`, password: crypto.randomUUID() } : login;
      const email = who.email;
      const post = (path: string) =>
        `fetch("${path}", { method: "POST", headers: { "content-type": "application/json" }, body: ${JSON.stringify(JSON.stringify({ ...who, name: "Preview" }))} }).then((r) => r.ok)`;
      const ok = (login !== true && (await page.evaluate(post("/api/auth/sign-in/email")))) || (await page.evaluate(post("/api/auth/sign-up/email")));
      // The owner's email is the secret that makes it the owner on the draft: not repeated.
      user = ok ? (login === true ? email : "the draft's throwaway owner") : null;
    }
    const out: { shot: string; image: string }[] = [];
    for (const url of urls) {
      for (const [device, width, height] of [["desktop", 1280, 800], ["phone", 390, 844]] as const) {
        await page.setViewport({ width, height, deviceScaleFactor: 1 });
        const status = (await page.goto(url, { waitUntil: "networkidle0", timeout: 20_000 }))?.status() ?? 0;
        // 304 is the browser's cache answering: as good as 200.
        out.push({ shot: `${new URL(url).pathname} ${device}: ${status < 400 ? "OK" : `HTTP ${status}`}`, image: b64((await page.screenshot({ type: "jpeg", quality: 62 })) as Uint8Array) });
      }
    }
    return { images: out.map((x) => x.image), shots: out.map((x) => x.shot), user: user ?? (login ? "sign-up failed: showing the logged-out view" : "logged out") };
  } finally {
    await browser.close();
  }
}
