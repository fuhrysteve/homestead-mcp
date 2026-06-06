/** Worker bindings + config. Secrets are injected by Wrangler (see .dev.vars.example). */
export interface Env {
  // Platform bindings.
  OAUTH_KV: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;

  // Access control (who may call the MCP).
  ALLOWED_GITHUB_LOGINS: string; // comma-separated GitHub logins
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string; // secret
  COOKIE_ENCRYPTION_KEY: string; // secret

  // Target repo + write surface.
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_BRANCH: string;
  ALLOWED_DOMAINS: string; // comma-separated

  // Bot commit identity.
  COMMIT_AUTHOR_NAME: string;
  COMMIT_AUTHOR_EMAIL: string;

  // GitHub App (what writes the commits).
  GITHUB_APP_ID: string;
  GITHUB_APP_INSTALLATION_ID: string;
  GITHUB_APP_PRIVATE_KEY: string; // secret, PKCS#8 PEM
}

/** The authenticated caller's identity, propagated from the OAuth layer into the MCP agent. */
export interface UserProps extends Record<string, unknown> {
  login: string;
  name: string;
  email: string;
}
