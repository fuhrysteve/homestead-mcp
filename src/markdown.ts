/**
 * Pure markdown transforms (no I/O — easy to unit test):
 *   - insertLogEntry: prepend a dated `### YYYY-MM-DD — Title` section at the top
 *     of the current `## <year> season` block in a log.md.
 *   - applyEdit: Claude-Code-style find/replace within a file, with unique-match
 *     enforcement so an ambiguous edit fails loudly instead of clobbering.
 */

export class NoteError extends Error {}

function lf(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

/** Collapse 3+ blank lines to one, guarantee exactly one trailing newline. */
function normalize(s: string): string {
  return s.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
}

// ---- log entries --------------------------------------------------------

function entryBlock(date: string, title: string, body?: string): string {
  const head = `### ${date} — ${title}`;
  const b = (body ?? "").trim();
  return b ? `${head}\n${b}` : head;
}

function logSkeleton(domainTitle: string, year: string, entry: string): string {
  return normalize(
    [
      `# ${domainTitle} log`,
      "",
      "Newest entries at top. Use ISO dates (`YYYY-MM-DD`).",
      "",
      "---",
      "",
      `## ${year} season`,
      "",
      entry,
    ].join("\n"),
  );
}

export interface LogEntryOpts {
  date: string; // ISO YYYY-MM-DD
  year: string; // YYYY
  title: string;
  body?: string;
  domainTitle: string; // e.g. "Gardening" — only used when creating the file
}

/**
 * Insert a dated log entry as a `### <date> — <title>` section at the top of the
 * current-year season block, creating the file or the season heading if needed.
 */
export function insertLogEntry(existing: string | null | undefined, opts: LogEntryOpts): string {
  const { date, year, title, body, domainTitle } = opts;
  const entry = entryBlock(date, title, body);

  if (!existing || !existing.trim()) {
    return logSkeleton(domainTitle, year, entry);
  }

  const lines = lf(existing).split("\n");
  const yearHeadingRe = new RegExp(`^##\\s+${year}\\b`);
  const anySeasonRe = /^##\s+\d{4}\b/;

  const yearIdx = lines.findIndex((l) => yearHeadingRe.test(l));
  if (yearIdx >= 0) {
    const out = [...lines];
    out.splice(yearIdx + 1, 0, "", entry);
    return normalize(out.join("\n"));
  }

  const firstSeasonIdx = lines.findIndex((l) => anySeasonRe.test(l));
  let insertIdx: number;
  if (firstSeasonIdx >= 0) {
    insertIdx = firstSeasonIdx;
  } else {
    const sepIdx = lines.findIndex((l) => /^---\s*$/.test(l));
    insertIdx = sepIdx >= 0 ? sepIdx + 1 : lines.length;
  }
  const out = [...lines];
  out.splice(insertIdx, 0, `## ${year} season`, "", entry, "");
  return normalize(out.join("\n"));
}

// ---- find/replace edit --------------------------------------------------

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    count++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return count;
}

/**
 * Replace `oldText` with `newText` in `content`. Like Claude Code's Edit:
 * `oldText` must appear exactly once unless `replaceAll` is set, otherwise it
 * throws so an ambiguous edit can't silently clobber the wrong place.
 */
export function applyEdit(
  content: string,
  oldText: string,
  newText: string,
  replaceAll = false,
): string {
  const text = lf(content);
  const oldT = lf(oldText);
  const newT = lf(newText);

  if (oldT.length === 0) {
    throw new NoteError("old_text must not be empty (use write_note to create a file).");
  }
  if (oldT === newT) {
    throw new NoteError("old_text and new_text are identical — nothing to change.");
  }

  const n = countOccurrences(text, oldT);
  if (n === 0) {
    throw new NoteError("old_text was not found in the note. Read it first with get_note and copy the exact text.");
  }
  if (n > 1 && !replaceAll) {
    throw new NoteError(
      `old_text appears ${n} times — add surrounding context to make it unique, or set replace_all: true.`,
    );
  }

  const result = replaceAll ? text.split(oldT).join(newT) : text.replace(oldT, newT);
  return normalize(result);
}

/** Ensure a brand-new file's content is normalized (single trailing newline). */
export function normalizeContent(content: string): string {
  return normalize(lf(content));
}
