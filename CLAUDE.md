# Dozokit Apps (the builder)

The owner's app builder: password login, a GitHub App made in the owner's account (manifest flow), the apps list, an editor with the draft preview and Save, and an MCP server at `/mcp` (OAuth) for Claude.

- `worker/github.ts`: GitHub App flow (`start`, `callback`, `installed`), its JWT and installation token.
- `worker/apps.ts`: everything done to an app repo: read, write to `draft`, status, safety check, Save.
- `worker/check-routes.mjs`: a copy of dozokit/app-template's `scripts/check-routes.mjs`. Keep them identical.
- `worker/mcp.ts`, `worker/oauth.ts`: the Claude connector.
- `src/`: the admin page; French in `src/lib/fr.ts`, keyed by the English text.

Rules: free Cloudflare plans only. The builder writes only to repos made from the template (checked at every write), never to `.github`, never outside the app's repo, never to `main` except through Save. Bump `worker/version.ts` for a release; releases are signed tags.

Local GitHub testing without the GitHub App: `wrangler dev --var DEV_GITHUB_TOKEN:$(gh auth token)`. Never set it online.
