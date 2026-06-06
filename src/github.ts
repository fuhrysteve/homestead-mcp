/**
 * GitHub App auth + Contents API client. The App (not the OAuth caller) is the
 * commit identity; its installation token is minted on demand from the App JWT
 * and cached until just before expiry. Plain fetch + WebCrypto — no SDK weight.
 */
import type { Env } from "./env.js";

const API = "https://api.github.com";
const UA = "homestead-mcp";

export class GitHubError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// ---- base64 / PEM helpers ----------------------------------------------

function b64urlFromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlFromString(s: string): string {
  return b64urlFromBytes(new TextEncoder().encode(s));
}

function encodeBase64Utf8(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Accept both real-newline and \n-escaped PEM strings (the latter from .dev.vars one-liners). */
function normalizePem(pem: string): string {
  const s = pem.includes("\\n") && !pem.includes("\n") ? pem.replace(/\\n/g, "\n") : pem;
  if (/BEGIN RSA PRIVATE KEY/.test(s)) {
    throw new GitHubError(
      "GITHUB_APP_PRIVATE_KEY is in PKCS#1 (BEGIN RSA PRIVATE KEY) format; WebCrypto needs PKCS#8. " +
        "Convert with: openssl pkcs8 -topk8 -nocrypt -in key.pem -out key.pkcs8.pem",
      500,
    );
  }
  return s;
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

async function createAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 540, iss: appId };
  const data = `${b64urlFromString(JSON.stringify(header))}.${b64urlFromString(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(normalizePem(privateKeyPem)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(data));
  return `${data}.${b64urlFromBytes(new Uint8Array(sig))}`;
}

// Installation token cache (per isolate). Tokens last ~1h; refresh early.
let cachedToken: { token: string; exp: number } | null = null;

async function getInstallationToken(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 120 > now) return cachedToken.token;

  const jwt = await createAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const res = await fetch(`${API}/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "User-Agent": UA,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new GitHubError(`Installation token exchange failed: ${res.status} ${await res.text()}`, res.status);
  }
  const json = (await res.json()) as { token: string; expires_at: string };
  cachedToken = { token: json.token, exp: Math.floor(new Date(json.expires_at).getTime() / 1000) };
  return cachedToken.token;
}

// ---- Contents API -------------------------------------------------------

function encodePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}

export interface FileState {
  content: string;
  sha: string;
}

export interface CommitResult {
  sha: string;
  url: string;
}

export class HomesteadRepo {
  constructor(private env: Env) {}

  private get base(): string {
    return `${API}/repos/${this.env.GITHUB_OWNER}/${this.env.GITHUB_REPO}/contents`;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await getInstallationToken(this.env);
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": UA,
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  /** Fetch a file's decoded contents + blob sha, or null if it doesn't exist. */
  async getFile(repoPath: string): Promise<FileState | null> {
    const url = `${this.base}/${encodePath(repoPath)}?ref=${encodeURIComponent(this.env.GITHUB_BRANCH)}`;
    const res = await fetch(url, { headers: await this.authHeaders() });
    if (res.status === 404) return null;
    if (!res.ok) throw new GitHubError(`getFile ${repoPath} failed: ${res.status} ${await res.text()}`, res.status);
    const json = (await res.json()) as { content?: string; sha: string; type: string };
    if (json.type !== "file" || json.content === undefined) {
      throw new GitHubError(`Path ${repoPath} is not a file.`, 422);
    }
    return { content: decodeBase64Utf8(json.content), sha: json.sha };
  }

  /** Create or update a file; returns the commit sha + html url. */
  async putFile(repoPath: string, content: string, message: string, sha?: string): Promise<CommitResult> {
    const identity = { name: this.env.COMMIT_AUTHOR_NAME, email: this.env.COMMIT_AUTHOR_EMAIL };
    const body: Record<string, unknown> = {
      message,
      content: encodeBase64Utf8(content),
      branch: this.env.GITHUB_BRANCH,
      author: identity,
      committer: identity,
    };
    if (sha) body.sha = sha;

    const res = await fetch(`${this.base}/${encodePath(repoPath)}`, {
      method: "PUT",
      headers: { ...(await this.authHeaders()), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new GitHubError(`putFile ${repoPath} failed: ${res.status} ${await res.text()}`, res.status);
    const json = (await res.json()) as { commit: { sha: string; html_url: string } };
    return { sha: json.commit.sha, url: json.commit.html_url };
  }
}
