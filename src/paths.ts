/**
 * Path validation. The security boundary: every read/write is confined to the
 * repo's docs/ subtree. Because we always prefix "docs/" and reject ".." and
 * absolute paths, callers can never escape docs/ (so the binary reference/ tree —
 * a sibling of docs/ — is unreachable). New domains/subdirs under docs/ are allowed.
 */

export class PathError extends Error {}

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
 * Resolve a wiki path (relative to docs/, e.g. "gardening/pests.md") to its full
 * repo path "docs/gardening/pests.md". Throws if it isn't a .md file or escapes docs/.
 */
export function resolveDocPath(path: string): string {
  const cleaned = cleanRelative(path);
  if (!cleaned.endsWith(".md")) {
    throw new PathError(`Only Markdown (.md) files are allowed (got "${path}").`);
  }
  const full = `docs/${cleaned}`;
  if (!full.startsWith("docs/")) {
    throw new PathError(`Resolved path "${full}" escapes docs/.`);
  }
  return full;
}

/** Validate a domain (single path segment under docs/, e.g. "gardening"). */
export function domainSegment(domain: string): string {
  const d = cleanRelative(String(domain ?? "").trim());
  if (d.includes("/")) {
    throw new PathError(`Domain must be a single path segment (got "${domain}").`);
  }
  return d;
}

/** Full path to a domain's dated-event log, e.g. domain "gardening" -> docs/gardening/log.md. */
export function domainLogPath(domain: string): string {
  return resolveDocPath(`${domainSegment(domain)}/log.md`);
}

/** Strip the leading "docs/" for display, e.g. "docs/gardening/pests.md" -> "gardening/pests.md". */
export function toWikiPath(fullPath: string): string {
  return fullPath.startsWith("docs/") ? fullPath.slice("docs/".length) : fullPath;
}

/** Is this a repo path we expose as a wiki note (a .md file under docs/)? */
export function isWikiNote(fullPath: string): boolean {
  return fullPath.startsWith("docs/") && fullPath.endsWith(".md");
}
