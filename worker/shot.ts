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
export async function shots(env: Env, url: string, login: boolean) {
  if (!env.BROWSER) throw new Refused("This builder has no browser binding, so it can't take screenshots.");
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    let user: string | null = null;
    if (login) {
      await page.goto(new URL("/", url).href, { waitUntil: "networkidle0", timeout: 20_000 });
      const email = `preview-${crypto.randomUUID().slice(0, 8)}@example.test`;
      const ok = await page.evaluate(
        `fetch("/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "${email}", password: "${crypto.randomUUID()}", name: "Preview" }) }).then((r) => r.ok)`,
      );
      user = ok ? email : null;
    }
    const out: { device: string; image: string; status: number | null }[] = [];
    for (const [device, width, height] of [["desktop", 1280, 800], ["phone", 390, 844]] as const) {
      await page.setViewport({ width, height, deviceScaleFactor: 1 });
      const res = await page.goto(url, { waitUntil: "networkidle0", timeout: 20_000 });
      out.push({ device, image: b64((await page.screenshot({ type: "jpeg", quality: 62 })) as Uint8Array), status: res?.status() ?? null });
    }
    return { images: out.map((x) => x.image), devices: out.map((x) => `${x.device}: HTTP ${x.status}`), user: user ?? (login ? "sign-up failed: showing the logged-out view" : "logged out") };
  } finally {
    await browser.close();
  }
}
