/**
 * Path allowlist + validation. The entire security boundary for "where can this
 * server write" lives here: writes are only ever permitted under docs/<domain>/,
 * and reference/ (binaries) is hard off-limits. Enforced server-side regardless
 * of what the caller asks for.
 */

export class PathError extends Error {}
export class DomainError extends Error {}

/** Parse a comma-separated allowlist env string into a normalized list. */
export function parseDomains(csv: string | undefined): string[] {
  return (csv ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

export function assertDomain(domain: string, allowed: string[]): string {
  const d = String(domain ?? "").trim().toLowerCase();
  if (!allowed.includes(d)) {
    throw new DomainError(
      `Unknown domain "${domain}". Allowed: ${allowed.join(", ")}.`,
    );
  }
  return d;
}

/** True if the string contains a NUL/control char (< 0x20) or a backslash (0x5C). */
function hasIllegalChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x5c) return true;
  }
  return false;
}

/**
 * Normalize a POSIX-style relative path, rejecting anything that tries to escape
 * its base: no absolute paths, no backslashes, no NUL/control chars, no `..` or
 * `.` segments, no empty segments. Returns the cleaned relative path.
 */
function cleanRelative(rel: string): string {
  if (typeof rel !== "string" || rel.length === 0) {
    throw new PathError("Empty path.");
  }
  if (hasIllegalChars(rel)) {
    throw new PathError("Path contains illegal characters (control chars or backslash).");
  }
  if (rel.startsWith("/")) {
    throw new PathError("Absolute paths are not allowed.");
  }
  const segments = rel.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") {
      throw new PathError(`Illegal path segment "${seg}" in "${rel}".`);
    }
  }
  return segments.join("/");
}

/**
 * Build the full repo-relative path for a note file, e.g.
 * buildDocPath("gardening", "irrigation.md") -> "docs/gardening/irrigation.md".
 * Throws if the file escapes docs/<domain>/ or targets reference/.
 */
export function buildDocPath(domain: string, file: string, allowed: string[]): string {
  const d = assertDomain(domain, allowed);
  const cleaned = cleanRelative(file);
  const full = `docs/${d}/${cleaned}`;

  // Defense in depth: re-verify the resolved path can't have escaped the subtree.
  const base = `docs/${d}/`;
  if (!full.startsWith(base)) {
    throw new PathError(`Resolved path "${full}" escapes ${base}.`);
  }
  if (/(^|\/)reference(\/|$)/.test(full)) {
    throw new PathError("Writing under reference/ is not allowed.");
  }
  if (!full.endsWith(".md")) {
    throw new PathError("Only Markdown (.md) note files are allowed.");
  }
  return full;
}

/** Fixed path for a domain's dated-event log. */
export function logPath(domain: string, allowed: string[]): string {
  return buildDocPath(domain, "log.md", allowed);
}
