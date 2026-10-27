// Safety check: fails the build if an API route touches the database without a logged-in user.
// Rules:
//   1. The database (env.DB) is only used inside a route of worker/routes.ts (or by Better Auth in worker/auth.ts).
//   2. A route that uses it calls requireUser() before, unless the route is listed in public-routes.json.
//   4. Free-plan budgets: every query that filters or sorts hits an index (D1 counts each row it
//      reads: 5 million a day), every list query has a LIMIT, and no package needs native code.
//   3. The look lives in src/theme.css (and the built-in looks in src/themes/): no hard-coded colour (#abc, rgb(…), hsl(…)) and no inline style= anywhere else.
// The Dozokit Apps builder runs this same function on a draft before Save, so it reads plain text, with no dependency.

const ALLOWED_FILES = ["worker/auth.ts", "worker/env.ts", "worker/jobs.ts", "worker/email.ts", "worker/errors.ts", "worker/cron.ts"];
// Packages with native code or a bundled browser: they don't run on Cloudflare Workers.
const NATIVE = ["sharp", "puppeteer", "playwright", "canvas", "bcrypt", "argon2", "better-sqlite3", "sqlite3", "node-gyp", "@napi-rs/canvas"];
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
  if (files["package.json"]) {
    const deps = Object.keys(JSON.parse(files["package.json"]).dependencies ?? {});
    for (const d of deps.filter((d) => NATIVE.includes(d))) errors.push(`package.json: ${d} needs native code and doesn't run on Cloudflare Workers. Remove it (images: Cloudflare Images or the browser; hashing: crypto.subtle).`);
  }
  // Indexed columns, from the migrations: "table.column" that leads an index, a primary key or UNIQUE.
  const migrations = Object.entries(files).filter(([f]) => /^migrations\/.*\.sql$/.test(f)).map(([, s]) => s).join("\n");
  const indexed = new Set([...migrations.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\w+\s+ON\s+(\w+)\s*\(\s*(\w+)/gi)].map((m) => `${m[1]}.${m[2]}`.toLowerCase()));
  for (const [, table, body] of migrations.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([\s\S]*?)\n\);/gi)) {
    for (const [, col] of body.matchAll(/^\s*(\w+)\s+\w+[^,\n]*\b(?:PRIMARY\s+KEY|UNIQUE)\b/gim)) indexed.add(`${table}.${col}`.toLowerCase());
  }
  for (const [file, src] of Object.entries(files)) {
    // Only apps with the design kit (src/theme.css): older apps keep their own styling.
    if ("src/theme.css" in files && /^(src\/.*\.(tsx?|css)|index\.html)$/.test(file) && file !== "src/theme.css" && !file.startsWith("src/themes/")) {
      src.split("\n").forEach((text, i) => {
        const colour = text.match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\([^)]*\)/)?.[0];
        if (colour) errors.push(`${file}:${i + 1} uses ${colour} — use a theme colour from src/theme.css.`);
        if (/\sstyle=/.test(text)) errors.push(`${file}:${i + 1} uses an inline style= — use a block from src/ui (add one there if it's missing).`);
      });
    }
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
    // SQL in strings: a filter or a sort needs an index; a list needs a LIMIT.
    t.forEach((tok, k) => {
      const sql = tok.type === "str" && /^\s*(SELECT|UPDATE|DELETE)\b/i.test(tok.text) ? tok.text.replace(/\s+/g, " ") : null;
      if (!sql || !migrations) return;
      const table = sql.match(/\b(?:FROM|UPDATE)\s+(\w+)/i)?.[1];
      if (table && !/\bJOIN\b/i.test(sql)) {
        const where = sql.match(/\bWHERE\b(.*?)(?:\bORDER\b|\bGROUP\b|\bLIMIT\b|\bRETURNING\b|$)/i)?.[1] ?? "";
        const cols = [...where.matchAll(/(\w+)\s*(?:=|<|>|!=|\bIN\b|\bLIKE\b|\bIS\b|\bBETWEEN\b)/gi)].map((m) => m[1]).filter((c) => !/^(AND|OR|NOT)$/i.test(c));
        const order = sql.match(/\bORDER\s+BY\s+(\w+)/i)?.[1];
        const has = (c) => c.toLowerCase() === "rowid" || indexed.has(`${table}.${c}`.toLowerCase());
        if (cols.length && !cols.some(has)) errors.push(`${file}:${line(tok.pos)}: the query on ${table} filters on ${cols.join(", ")} with no index. Add a migration with CREATE INDEX ${table}_${cols[0]} ON ${table}(${cols[0]}): D1's free plan counts every row a query reads (5 million a day).`);
        else if (!cols.length && order && !has(order)) errors.push(`${file}:${line(tok.pos)}: the query on ${table} sorts on ${order} with no index. Add a migration with CREATE INDEX ${table}_${order} ON ${table}(${order}).`);
      }
      const list = t.slice(k + 1, k + 16).some((x) => x.type === "id" && x.text === "all");
      if (/^\s*SELECT/i.test(sql) && list && !/\bLIMIT\b/i.test(sql)) errors.push(`${file}:${line(tok.pos)}: a list query without LIMIT. Page it: LIMIT 100 at most, with a cursor (?before=<last id>) for the next page.`);
    });
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
    [...["worker", "src", "migrations"].flatMap((dir) => readdirSync(dir, { recursive: true }).map((f) => `${dir}/${f}`)), "index.html", "package.json"]
      .filter((f) => /\.(tsx?|css|html|sql|json)$/.test(f))
      .map((f) => [f, readFileSync(f, "utf8")]),
  );
  const publicRoutes = JSON.parse(readFileSync("public-routes.json", "utf8"));
  const { errors, routes } = checkRoutes(files, publicRoutes);
  if (errors.length) {
    console.error(`Safety check failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`Safety check passed: ${routes.length} API routes, ${publicRoutes.length} public.`);
}
