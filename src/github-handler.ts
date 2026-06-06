/**
 * OAuth gate: who may call this MCP. We use GitHub as the upstream IdP via
 * workers-oauth-provider. The connector (Anthropic) does OAuth 2.1+PKCE against
 * THIS worker; this worker in turn bounces the human through GitHub login, then
 * only completes authorization for an allowlisted GitHub login. This is access
 * control only — it is NOT the credential that writes commits (that's the App).
 */
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import type { Env } from "./env.js";

const GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN = "https://github.com/login/oauth/access_token";

type Bindings = Env & { OAUTH_PROVIDER: OAuthHelpers };

const app = new Hono<{ Bindings: Bindings }>();

function allowedLogins(env: Env): string[] {
  return env.ALLOWED_GITHUB_LOGINS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

app.get("/", (c) => c.text("homestead-mcp: remote MCP server. Connect via /mcp (or /sse)."));

app.get("/authorize", async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  if (!oauthReqInfo.clientId) return c.text("Invalid request", 400);

  const url = new URL(GITHUB_AUTHORIZE);
  url.searchParams.set("client_id", c.env.GITHUB_CLIENT_ID);
  url.searchParams.set("redirect_uri", new URL("/callback", c.req.url).href);
  url.searchParams.set("scope", "read:user");
  url.searchParams.set("state", btoa(JSON.stringify(oauthReqInfo)));
  return Response.redirect(url.href);
});

app.get("/callback", async (c) => {
  const stateParam = c.req.query("state");
  if (!stateParam) return c.text("Missing state", 400);
  let oauthReqInfo: AuthRequest;
  try {
    oauthReqInfo = JSON.parse(atob(stateParam)) as AuthRequest;
  } catch {
    return c.text("Invalid state", 400);
  }
  if (!oauthReqInfo.clientId) return c.text("Invalid state", 400);

  const code = c.req.query("code");
  if (!code) return c.text("Missing code", 400);

  // Exchange the GitHub code for an access token.
  const tokenRes = await fetch(GITHUB_TOKEN, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "homestead-mcp" },
    body: JSON.stringify({
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: new URL("/callback", c.req.url).href,
    }),
  });
  if (!tokenRes.ok) return c.text("GitHub token exchange failed", 502);
  const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string };
  const accessToken = tokenJson.access_token;
  if (!accessToken) return c.text(`GitHub OAuth error: ${tokenJson.error ?? "no token"}`, 502);

  // Identify the user.
  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "homestead-mcp",
    },
  });
  if (!userRes.ok) return c.text("Failed to fetch GitHub user", 502);
  const user = (await userRes.json()) as { login: string; name: string | null; email: string | null };

  // Allowlist enforcement — the actual access-control decision.
  if (!allowedLogins(c.env).includes(user.login.toLowerCase())) {
    return c.text(`GitHub user "${user.login}" is not authorized to use this connector.`, 403);
  }

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId: user.login,
    metadata: { label: user.name ?? user.login },
    scope: oauthReqInfo.scope,
    props: { login: user.login, name: user.name ?? user.login, email: user.email ?? "" },
  });
  return Response.redirect(redirectTo);
});

export { app as GitHubHandler };
