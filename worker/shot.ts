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

export async function shots(env: Env, url: string) {
  if (!env.BROWSER) throw new Refused("This builder has no browser binding, so it can't take screenshots.");
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    const out: { device: string; image: string; status: number | null }[] = [];
    for (const [device, width, height] of [["desktop", 1280, 800], ["phone", 390, 844]] as const) {
      await page.setViewport({ width, height, deviceScaleFactor: 1 });
      const res = await page.goto(url, { waitUntil: "networkidle0", timeout: 20_000 });
      out.push({ device, image: b64((await page.screenshot({ type: "jpeg", quality: 62 })) as Uint8Array), status: res?.status() ?? null });
    }
    return out;
  } finally {
    await browser.close();
  }
}
