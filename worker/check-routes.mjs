// Safety check: fails the build if an API route touches the database without a logged-in user.
// Rules:
//   1. The database (env.DB) is only used inside a route of worker/routes.ts (or by Better Auth in worker/auth.ts).
//   2. A route that uses it calls requireUser() before, unless the route is listed in public-routes.json.
// The Dozokit Apps builder runs this same function on a draft before Save, so it reads plain text, with no dependency.

const ALLOWED_FILES = ["worker/auth.ts", "worker/env.ts"];
const ROUTE_KEY = /^(GET|POST|PUT|PATCH|DELETE) \//;

// Identifiers, strings and punctuation, with their position. Comments are skipped; a template
// literal's ${…} parts are read as code.
function tokens(src) {
  const out = [];
  let i = 0;
  const regexCanStart = () => {
    const t = out[out.length - 1];
    return !t || (t.type === "punct" && !")]}".includes(t.text)) || (t.type === "id" && ["return", "typeof", "case", "in", "of"].includes(t.text));
  };
  const string = (q) => {
    const start = i++;
    let text = "";
    while (i < src.length && src[i] !== q) {
      if (src[i] === "\\") text += src[++i];
      else if (q === "`" && src[i] === "$" && src[i + 1] === "{") {
        i += 2;
        let depth = 1;
        const from = i;
        while (i < src.length && depth) {
          if ("\"'`".includes(src[i])) { string(src[i]); continue; }
          if (src[i] === "{") depth++;
          if (src[i] === "}") depth--;
          i++;
        }
        out.push(...tokens(src.slice(from, i - 1)).map((t) => ({ ...t, pos: t.pos + from })));
        continue;
      } else text += src[i];
      i++;
    }
    i++;
    return { type: "str", text, pos: start };
  };
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) i++;
    else if (c === "/" && src[i + 1] === "/") while (i < src.length && src[i] !== "\n") i++;
    else if (c === "/" && src[i + 1] === "*") i = src.indexOf("*/", i + 2) < 0 ? src.length : src.indexOf("*/", i + 2) + 2;
    else if ("\"'`".includes(c)) out.push(string(c));
    else if (c === "/" && regexCanStart()) {
      let inClass = false;
      for (i++; i < src.length && (src[i] !== "/" || inClass); i++) {
        if (src[i] === "\\") i++;
        else if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
      }
      i++;
      while (/[a-z]/i.test(src[i] ?? "")) i++;
    } else if (/[\w$]/.test(c)) {
      const start = i;
      while (i < src.length && /[\w$]/.test(src[i])) i++;
      out.push({ type: "id", text: src.slice(start, i), pos: start });
    } else out.push({ type: "punct", text: src[i], pos: i++ });
  }
  return out;
}

// files: { "worker/routes.ts": "…source…", … }. Returns { errors, routes }.
export function checkRoutes(files, publicRoutes) {
  const errors = [];
  const routes = new Set();
  for (const [file, src] of Object.entries(files)) {
    if (!/^worker\/.*\.ts$/.test(file) || ALLOWED_FILES.includes(file)) continue;
    const line = (pos) => src.slice(0, pos).split("\n").length;
    const t = tokens(src);
    // Each "METHOD /path": <handler> runs until the comma or closing brace at its own depth.
    const spans = [];
    for (let k = 0; k < t.length - 1; k++) {
      if (t[k].type !== "str" || !ROUTE_KEY.test(t[k].text) || t[k + 1].text !== ":") continue;
      routes.add(t[k].text);
      let depth = 0;
      let end = k + 2;
      for (; end < t.length; end++) {
        const p = t[end].type === "punct" ? t[end].text : "";
        if ("([{".includes(p) && p) depth++;
        else if (")]}".includes(p) && p) { if (depth === 0) break; depth--; }
        else if (p === "," && depth === 0) break;
      }
      spans.push({ route: t[k].text, from: k + 2, to: end });
    }
    t.forEach((tok, k) => {
      const usesDb = (tok.type === "id" && tok.text === "DB") || (tok.type === "str" && tok.text === "DB" && t[k - 1]?.text === "[");
      if (!usesDb) return;
      const span = spans.find((s) => k >= s.from && k < s.to);
      if (!span) {
        errors.push(`${file}:${line(tok.pos)}: the database is used outside an API route. Move this into a route in worker/routes.ts.`);
      } else if (!publicRoutes.includes(span.route)) {
        const before = t.slice(span.from, k);
        const checked = before.some((x, j) => x.type === "id" && x.text === "requireUser" && before[j + 1]?.text === "(");
        if (!checked) {
          errors.push(`${file}:${line(tok.pos)}: "${span.route}" touches the database without a logged-in user. Call requireUser(req, env) first, or add the route to public-routes.json if anyone may call it.`);
        }
      }
    });
  }
  return { errors: [...new Set(errors)], routes: [...routes] };
}

if (import.meta.url === `file://${globalThis.process?.argv?.[1]}`) {
  const { readFileSync, readdirSync } = await import("node:fs");
  const files = Object.fromEntries(
    readdirSync("worker", { recursive: true }).filter((f) => f.endsWith(".ts")).map((f) => [`worker/${f}`, readFileSync(`worker/${f}`, "utf8")]),
  );
  const publicRoutes = JSON.parse(readFileSync("public-routes.json", "utf8"));
  const { errors, routes } = checkRoutes(files, publicRoutes);
  if (errors.length) {
    console.error(`Safety check failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`Safety check passed: ${routes.length} API routes, ${publicRoutes.length} public.`);
}
