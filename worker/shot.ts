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
export async function shots(env: Env, urls: string[], login: boolean | { email: string }) {
  if (!env.BROWSER) throw new Refused("This builder has no browser binding, so it can't take screenshots.");
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    let user: string | null = null;
    if (login) {
      await page.goto(new URL("/", urls[0]).href, { waitUntil: "networkidle0", timeout: 20_000 });
      // The template signs in by email code; on a draft, …@preview.test addresses have a code derived from
      // the address (see the template's auth.ts), so no inbox is needed. A given user (the draft's owner),
      // else a new throwaway one; the account is made on first sign-in.
      const email = login === true ? `preview-${crypto.randomUUID().slice(0, 8)}@preview.test` : login.email;
      const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`dozokit-preview:${email}`)))].map((b) => b.toString(16).padStart(2, "0")).join("");
      const otp = String(parseInt(hex.slice(0, 8), 16) % 1e6).padStart(6, "0");
      const post = (path: string, body: object) =>
        `fetch("${path}", { method: "POST", headers: { "content-type": "application/json" }, body: ${JSON.stringify(JSON.stringify(body))} }).then((r) => r.ok)`;
      const ok = (await page.evaluate(post("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" }))) && (await page.evaluate(post("/api/auth/sign-in/email-otp", { email, otp })));
      // The owner's email is the secret that makes it the owner on the draft: not repeated.
      user = ok ? (login === true || email.endsWith("@preview.test") && !email.startsWith("owner-") ? email : "the draft's throwaway owner") : null;
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
