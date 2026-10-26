# Dozokit Apps

A free app builder on your own Cloudflare account. Claude builds real apps (logins, a database) as code in your own GitHub, one repo, Worker and database per app. You try every change on a draft preview, then Save puts it live.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/dozokit/apps)

The button copies this repo into your GitHub, creates the builder's database and puts it online. It asks for `PASSWORD`: the password you'll sign in with, 12 characters or more.

## How it works

1. **Connect GitHub (once).** In the builder, Connect GitHub. GitHub creates a small GitHub App in your own account: click Create, then Install (all repositories). Its key goes to your builder only, and it can only read and write repo contents.
2. **New app.** The builder's Deploy a new app button copies [dozokit/app-template](https://github.com/dozokit/app-template) into your GitHub and puts it online on your Cloudflare. Then Find my new app adds it to the builder.
3. **Build with Claude.** In Claude: Settings → Connectors → Add custom connector, paste `https://<your builder>/mcp`. Claude reads and writes the app's files on its `draft` branch, sees screenshots of the draft preview, and saves when you ask.
4. **Save.** In the builder's editor (or by asking Claude): the draft is merged into `main` and Cloudflare puts it live. Save is refused when the app's safety check fails: a data route without a logged-in user, or a migration that changes or drops something.

## Updates

On GitHub, your builder's repo → Actions → Update Dozokit Apps → Run workflow. It installs the latest release only if it's signed with Dozokit's release key, and it only replaces this builder's own repo, never your apps.

## Run it on your computer

```
cp .dev.vars.example .dev.vars   # set PASSWORD
npm install
npm run dev                      # http://localhost:8788
```

To try it without GitHub or Cloudflare: add `LOCAL_REPOS=<an empty folder>` to `.dev.vars` and run `npm run dev:local` instead. Apps are then git repos in that folder, made from a local copy of dozokit/app-template, each running on this computer.

Part of [Dozokit](https://dozokit.com): free tools you host yourself.
