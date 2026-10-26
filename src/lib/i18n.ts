import { FR } from "./fr";

// The page's language: the owner's choice, else their browser's. Texts are written in English in
// the code; FR holds their French, keyed by the English. Templates name their parts in braces
// ("{n} unsaved changes"), so messages from the server translate too.

export type Lang = "en" | "fr";
const KEY = "dozokit_lang";

function initial(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "en" || saved === "fr") return saved;
  } catch {}
  return navigator.language?.toLowerCase().startsWith("fr") ? "fr" : "en";
}

export const lang: Lang = initial();
document.documentElement.lang = lang;
// The server draws a few pages itself (connecting Claude): it reads the same choice from a cookie.
document.cookie = `${KEY}=${lang}; Path=/; Max-Age=31536000; SameSite=Lax`;

export function setLang(l: Lang) {
  try {
    localStorage.setItem(KEY, l);
  } catch {}
  location.reload();
}

const fill = (s: string, vars?: Record<string, string | number>) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s);

export const t = (en: string, vars?: Record<string, string | number>) => fill(lang === "fr" ? (FR[en] ?? en) : en, vars);

// Messages written elsewhere (the server's errors): exact text first, then the templates.
const TEMPLATES = Object.keys(FR)
  .filter((k) => k.includes("{"))
  .map((k) => ({ k, names: [...k.matchAll(/\{(\w+)\}/g)].map((m) => m[1]), re: new RegExp(`^${k.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{(\w+)\}/g, "([\\s\\S]+?)")}$`) }));

export function tr(message: string) {
  if (lang === "en") return message;
  if (FR[message]) return FR[message];
  for (const { k, names, re } of TEMPLATES) {
    const m = message.match(re);
    if (m) return fill(FR[k], Object.fromEntries(names.map((n, i) => [n, m[i + 1]])));
  }
  return message;
}
