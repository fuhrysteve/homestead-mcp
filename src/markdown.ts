/**
 * Pure markdown transforms that encode the homestead repo's conventions:
 *   - log.md: `### YYYY-MM-DD — Title` sections, newest at the TOP of the
 *     current `## <year> season` block.
 *   - notes:  append to / replace a named `##`/`###` section, or whole file.
 * No I/O here — callers fetch/commit the result. Easy to unit test.
 */

export class NoteError extends Error {}

function lf(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

/** Collapse 3+ blank lines to one, guarantee exactly one trailing newline. */
function normalize(s: string): string {
  return s.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
}

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
    // Newest at top: drop the entry directly under the season heading.
    const out = [...lines];
    out.splice(yearIdx + 1, 0, "", entry);
    return normalize(out.join("\n"));
  }

  // No block for this year yet — create one above the newest existing season,
  // or after the intro `---` separator if there are no season blocks.
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

// ---- note editing -------------------------------------------------------

export type NoteMode = "append" | "replace_section" | "replace_file";

function findHeading(lines: string[], section: string): { index: number; level: number } | null {
  const want = section.trim().toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*?)\s*$/.exec(lines[i]);
    if (m && m[2].trim().toLowerCase() === want) {
      return { index: i, level: m[1].length };
    }
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

export interface NoteEditOpts {
  mode: NoteMode;
  text: string;
  section?: string;
}

export function editNote(existing: string | null | undefined, opts: NoteEditOpts): string {
  const { mode, section } = opts;
  const text = lf(opts.text);

  if (mode === "replace_file") {
    return normalize(text);
  }

  const cur = lf(existing ?? "");

  if (mode === "append") {
    if (section) return appendToSection(cur, section, text);
    const base = cur.replace(/\n+$/, "");
    return normalize(base ? `${base}\n\n${text.trim()}` : text.trim());
  }

  if (mode === "replace_section") {
    if (!section) throw new NoteError("replace_section requires a section.");
    return replaceSection(cur, section, text);
  }

  throw new NoteError(`Unknown mode "${mode}".`);
}

function appendToSection(cur: string, section: string, text: string): string {
  const lines = cur.split("\n");
  const h = findHeading(lines, section);
  if (!h) throw new NoteError(`Section "${section}" not found in note.`);
  const end = sectionEnd(lines, h.index, h.level);
  // Back up over trailing blank lines inside the section so we append cleanly.
  let insertAt = end;
  while (insertAt > h.index + 1 && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, "", text.trim());
  return normalize(lines.join("\n"));
}

function replaceSection(cur: string, section: string, text: string): string {
  const lines = cur.split("\n");
  const h = findHeading(lines, section);
  if (!h) throw new NoteError(`Section "${section}" not found in note.`);
  const end = sectionEnd(lines, h.index, h.level);
  lines.splice(h.index + 1, end - (h.index + 1), "", text.trim(), "");
  return normalize(lines.join("\n"));
}
