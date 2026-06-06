# homestead-mcp

Remote **MCP server** (Cloudflare Worker) that lets Claude write notes and dated
events back to the [`fuhrysteve/homestead`](https://github.com/fuhrysteve/homestead)
repo — the gardening / chickens / beekeeping knowledge base — through a **narrow,
convention-enforcing tool surface**.

Built for MaryBeth's phone-only claude.ai (Pro) account via a **custom connector**:
mid-conversation, decisions and dated events get committed to the homestead repo
without her touching git. Full spec, threat model, and rationale live in the homelab
repo: `docs/homestead-notes-mcp.md`.

## What it does

Three tools, and nothing else — no generic file write, no shell, no read-arbitrary-path:

| Tool | Purpose |
|------|---------|
| `log_event(domain, title, body?, date?)` | Prepend a `### <date> — <title>` section at the top of the current season in `docs/<domain>/log.md`. |
| `update_note(domain, file, text, mode?, section?)` | Edit a persistent-context note under `docs/<domain>/` (append / replace a section / replace file). |
| `get_note(domain, file)` | Read a note under `docs/<domain>/` so Claude can edit it accurately first. |

`domain ∈ {gardening, chickens, beekeeping}` (set via `ALLOWED_DOMAINS`).

### Security model (two separate credentials)

- **Who may call it** — GitHub **OAuth** via [`workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider).
  The connector does OAuth 2.1 + PKCE against this Worker (the only auth claude.ai
  connectors support); the Worker bounces the human through GitHub login and only
  completes authorization for a login in `ALLOWED_GITHUB_LOGINS`.
- **What writes the commits** — a GitHub **App** scoped to *only* `fuhrysteve/homestead`,
  **Contents: read/write**. Its installation token is minted on demand from the App
  private key (WebCrypto RS256). Commits are authored as `homestead-bot`.
- **Path allowlist** — every write is forced under `docs/<domain>/`; `..`, absolute
  paths, backslashes, control chars, non-`.md`, and anything under `reference/` are
  rejected server-side regardless of caller input (see `src/paths.ts` + tests).
- **Blast radius** — worst case is "the one homestead repo," every change a revertible
  git commit. The Worker runs on Cloudflare's edge — **zero inbound exposure to the homelab.**

## Layout

```
src/
  index.ts           OAuthProvider wiring + the McpAgent (HomesteadMCP)
  github-handler.ts  GitHub OAuth upstream (login gate + allowlist)
  tools.ts           log_event / update_note / get_note (the whole write surface)
  markdown.ts        log-insertion + note-edit transforms (pure, tested)
  paths.ts           docs/<domain>/ path allowlist (pure, tested)
  github.ts          GitHub App token + Contents API client
  env.ts             binding types
test/                vitest unit tests (paths, markdown)
wrangler.jsonc       bindings + non-secret vars
```

## Develop

```bash
npm install
npm test          # vitest — path allowlist + markdown transforms
npm run typecheck # tsc --noEmit
npm run dev       # wrangler dev (needs .dev.vars — copy .dev.vars.example)
```

## Deploy (one-time setup)

### 1. GitHub App (the commit credential)

1. Create a GitHub App (your account → Settings → Developer settings → GitHub Apps → New).
   - **Permissions → Repository → Contents: Read and write.** Nothing else.
   - No webhook needed.
2. Generate a **private key** — GitHub gives you a PKCS#1 PEM (`BEGIN RSA PRIVATE KEY`).
   WebCrypto needs **PKCS#8**, so convert:
   ```bash
   openssl pkcs8 -topk8 -nocrypt -in downloaded.pem -out homestead-app.pkcs8.pem
   ```
3. **Install** the App on *only* the `fuhrysteve/homestead` repo.
4. Note the **App ID** and the **Installation ID** (the latter is in the URL of the
   installation settings page, or `GET /app/installations`). Put both in `wrangler.jsonc`
   `vars` (`GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`).

### 2. GitHub OAuth app (the access gate)

1. Create an **OAuth App** (Settings → Developer settings → OAuth Apps → New).
   - **Authorization callback URL:** `https://homestead-mcp.fuhry.app/callback`
2. Put the **Client ID** in `wrangler.jsonc` `vars.GITHUB_CLIENT_ID`; the secret is a
   Worker secret (below).
3. Set `ALLOWED_GITHUB_LOGINS` in `vars` to the GitHub login(s) permitted to authorize.

### 3. KV + secrets + deploy

```bash
# KV namespace backing the OAuth provider; paste the id into wrangler.jsonc
npx wrangler kv namespace create OAUTH_KV

# Secrets (never committed)
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY      # openssl rand -hex 32
npx wrangler secret put GITHUB_APP_PRIVATE_KEY     # paste the PKCS#8 PEM

npx wrangler deploy
```

### 4. Route + WAF

- Bind the Worker to **`homestead-mcp.fuhry.app`** (its own public DNS record — the
  `*.fuhry.app` wildcard otherwise resolves to a private IP).
- Add a Cloudflare **WAF rate-limit rule** on the route.

### 5. The connector (in MB's claude.ai account)

1. Settings → Connectors → add custom connector, URL `https://homestead-mcp.fuhry.app/mcp`.
2. Authorize once (Steve does this — GitHub login, allowlisted).
3. Set `log_event` and `update_note` to **Always allow**.
4. Create the "Homestead" Project with the project-instructions block from
   `docs/homestead-notes-mcp.md` §4.

## License

Private homelab project.
