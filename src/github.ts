/**
 * GitHub App auth + Contents API client. The App (not the OAuth caller) is the
 * commit identity; its installation token is minted on demand from the App JWT
 * and cached until just before expiry. Plain fetch + WebCrypto — no SDK weight.
 */
import type { Env, UserProps } from "./env.js";

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

function appJwtHeaders(jwt: string): Record<string, string> {
  return {
    Authorization: `Bearer ${jwt}`,
    Accept: "application/vnd.github+json",
    "User-Agent": UA,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

// Caches (per isolate). Installation tokens last ~1h; refresh early.
let cachedToken: { token: string; exp: number } | null = null;
let cachedInstallationId: string | null = null;

/**
 * Resolve the App's installation id. Prefer the configured value; otherwise look
 * it up from the target repo (authoritative, survives reinstalls) so it never has
 * to be hand-copied into config.
 */
async function resolveInstallationId(env: Env, jwt: string): Promise<string> {
  const configured = (env.GITHUB_APP_INSTALLATION_ID ?? "").trim();
  if (configured && !configured.startsWith("REPLACE")) return configured;
  if (cachedInstallationId) return cachedInstallationId;

  const res = await fetch(`${API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/installation`, {
    headers: appJwtHeaders(jwt),
  });
  if (!res.ok) {
    throw new GitHubError(
      `Could not resolve installation for ${env.GITHUB_OWNER}/${env.GITHUB_REPO} (${res.status}). ` +
        `Is the GitHub App installed on that repo with Contents: read/write?`,
      res.status,
    );
  }
  const json = (await res.json()) as { id: number };
  cachedInstallationId = String(json.id);
  return cachedInstallationId;
}

async function getInstallationToken(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 120 > now) return cachedToken.token;

  const jwt = await createAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const installationId = await resolveInstallationId(env, jwt);
  const res = await fetch(`${API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: appJwtHeaders(jwt),
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

export interface CommitIdentity {
  name: string;
  email: string;
}

/**
 * The git identity to attribute a commit to. Prefer the authenticated GitHub user
 * (so MB's saves show as MB, Steve's as Steve); fall back to their privacy-preserving
 * noreply address when their email is private, and finally to the configured bot.
 */
export function commitIdentity(props: UserProps, env: Env): CommitIdentity {
  const login = props.login?.trim();
  if (!login) {
    return { name: env.COMMIT_AUTHOR_NAME, email: env.COMMIT_AUTHOR_EMAIL };
  }
  const name = (props.name && props.name.trim()) || login;
  const email =
    (props.email && props.email.trim()) ||
    (props.id ? `${props.id}+${login}@users.noreply.github.com` : env.COMMIT_AUTHOR_EMAIL);
  return { name, email };
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
  constructor(private env: Env, private identity: CommitIdentity) {}

  private get base(): string {
    return `${API}/repos/${this.env.GITHUB_OWNER}/${this.env.GITHUB_REPO}/contents`;
  }

  private get repoBase(): string {
    return `${API}/repos/${this.env.GITHUB_OWNER}/${this.env.GITHUB_REPO}`;
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
    const body: Record<string, unknown> = {
      message,
      content: encodeBase64Utf8(content),
      branch: this.env.GITHUB_BRANCH,
      author: this.identity,
      committer: this.identity,
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

  /** Delete a file; returns the commit sha + html url. */
  async deleteFile(repoPath: string, message: string, sha: string): Promise<CommitResult> {
    const res = await fetch(`${this.base}/${encodePath(repoPath)}`, {
      method: "DELETE",
      headers: { ...(await this.authHeaders()), "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        sha,
        branch: this.env.GITHUB_BRANCH,
        author: this.identity,
        committer: this.identity,
      }),
    });
    if (!res.ok) throw new GitHubError(`deleteFile ${repoPath} failed: ${res.status} ${await res.text()}`, res.status);
    const json = (await res.json()) as { commit: { sha: string; html_url: string } };
    return { sha: json.commit.sha, url: json.commit.html_url };
  }

  /**
   * List every Markdown file under docs/ (one recursive tree call). Returns full
   * repo paths + sizes. Used for browsing (list_notes) and scanning (search_notes).
   */
  async listDocsFiles(): Promise<{ path: string; size: number }[]> {
    const url = `${this.repoBase}/git/trees/${encodeURIComponent(this.env.GITHUB_BRANCH)}?recursive=1`;
    const res = await fetch(url, { headers: await this.authHeaders() });
    if (!res.ok) throw new GitHubError(`listDocsFiles failed: ${res.status} ${await res.text()}`, res.status);
    const json = (await res.json()) as { tree: { path: string; type: string; size?: number }[]; truncated?: boolean };
    return json.tree
      .filter((t) => t.type === "blob" && t.path.startsWith("docs/") && t.path.endsWith(".md"))
      .map((t) => ({ path: t.path, size: t.size ?? 0 }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Read a file at a specific ref (commit sha / branch), or null if absent there. */
  async getFileAtRef(repoPath: string, ref: string): Promise<FileState | null> {
    const url = `${this.base}/${encodePath(repoPath)}?ref=${encodeURIComponent(ref)}`;
    const res = await fetch(url, { headers: await this.authHeaders() });
    if (res.status === 404) return null;
    if (!res.ok) throw new GitHubError(`getFileAtRef ${repoPath}@${ref} failed: ${res.status}`, res.status);
    const json = (await res.json()) as { content?: string; sha: string; type: string };
    if (json.type !== "file" || json.content === undefined) throw new GitHubError(`${repoPath}@${ref} is not a file.`, 422);
    return { content: decodeBase64Utf8(json.content), sha: json.sha };
  }

  /** Most recent commits (optionally limited to a path), newest first. */
  async listCommits(limit: number, path?: string): Promise<CommitInfo[]> {
    const params = new URLSearchParams({ per_page: String(Math.min(Math.max(limit, 1), 50)), sha: this.env.GITHUB_BRANCH });
    if (path) params.set("path", path);
    const res = await fetch(`${this.repoBase}/commits?${params}`, { headers: await this.authHeaders() });
    if (!res.ok) throw new GitHubError(`listCommits failed: ${res.status} ${await res.text()}`, res.status);
    const json = (await res.json()) as {
      sha: string;
      commit: { message: string; author: { name: string; date: string } };
      author: { login: string } | null;
    }[];
    return json.map((c) => ({
      sha: c.sha,
      message: c.commit.message.split("\n")[0],
      author: c.author?.login ?? c.commit.author.name,
      date: c.commit.author.date,
    }));
  }

  /** Full detail for a single commit: its parent and the files it changed. */
  async getCommitDetail(sha: string): Promise<CommitDetail> {
    const res = await fetch(`${this.repoBase}/commits/${encodeURIComponent(sha)}`, { headers: await this.authHeaders() });
    if (!res.ok) throw new GitHubError(`getCommitDetail ${sha} failed: ${res.status}`, res.status);
    const json = (await res.json()) as {
      sha: string;
      commit: { message: string };
      parents: { sha: string }[];
      files: { filename: string; status: string; previous_filename?: string }[];
    };
    return {
      sha: json.sha,
      message: json.commit.message.split("\n")[0],
      parent: json.parents[0]?.sha,
      files: json.files.map((f) => ({ filename: f.filename, status: f.status, previousFilename: f.previous_filename })),
    };
  }
}

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface CommitDetail {
  sha: string;
  message: string;
  parent?: string;
  files: { filename: string; status: string; previousFilename?: string }[];
}
