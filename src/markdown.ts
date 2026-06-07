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

// ---- append -------------------------------------------------------------

function findHeading(lines: string[], section: string): { index: number; level: number } | null {
  const want = section.trim().toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*?)\s*$/.exec(lines[i]);
    if (m && m[2].trim().toLowerCase() === want) return { index: i, level: m[1].length };
  }
  return null;
}

/** Index of the next heading at level <= `level`, else end of file. */
function sectionEnd(lines: string[], startIdx: number, level: number): number {
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s+/.exec(lines[i]);
    if (m && m[1].length <= level) return i;
  }
  return lines.length;
}

/**
 * Append `text` to a note — at the end of the file, or at the end of a named
 * `## section` if `section` is given. Throws if the section isn't found.
 */
export function appendToNote(content: string, text: string, section?: string): string {
  const body = lf(text).trim();
  if (!body) throw new NoteError("Nothing to append.");
  const lines = lf(content).split("\n");

  if (section) {
    const h = findHeading(lines, section);
    if (!h) throw new NoteError(`Section "${section}" not found. Read the page or omit section to append at the end.`);
    let insertAt = sectionEnd(lines, h.index, h.level);
    while (insertAt > h.index + 1 && lines[insertAt - 1].trim() === "") insertAt--;
    lines.splice(insertAt, 0, "", body);
    return normalize(lines.join("\n"));
  }

  const base = lf(content).replace(/\n+$/, "");
  return normalize(base ? `${base}\n\n${body}` : body);
}
