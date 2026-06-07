/**
 * Pure helpers for a simple Markdown task list (GitHub-style checkboxes) so Claude
 * can turn "we should do X" into a tracked, checkable next-action. No I/O — tested.
 * A task page looks like:
 *
 *   # <Title> tasks
 *
 *   ## Open
 *   - [ ] put row cover over the broccoli
 *
 *   ## Done
 *   - [x] order Freedom Rangers (done 2026-06-01)
 */
import { NoteError } from "./markdown.js";

const OPEN_RE = /^(\s*[-*]\s+)\[ \]\s+(.*)$/;
const DONE_RE = /^(\s*[-*]\s+)\[[xX]\]\s+(.*)$/;

function lf(s: string): string {
  return s.replace(/\r\n/g, "\n");
}
function normalize(s: string): string {
  return s.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
}

function skeleton(title: string, firstTask: string): string {
  return normalize([`# ${title} tasks`, "", "## Open", `- [ ] ${firstTask}`, "", "## Done"].join("\n"));
}

/** Append a new open task. Creates the page (with title) if it doesn't exist. */
export function addTask(existing: string | null | undefined, text: string, title: string): string {
  const task = text.trim();
  if (!task) throw new NoteError("Task text is empty.");
  if (!existing || !existing.trim()) return skeleton(title, task);

  const lines = lf(existing).split("\n");
  const openIdx = lines.findIndex((l) => /^##\s+open\s*$/i.test(l));
  const line = `- [ ] ${task}`;
  if (openIdx === -1) {
    // No Open section — add one at the end.
    return normalize([lf(existing).replace(/\n+$/, ""), "", "## Open", line].join("\n"));
  }
  // Insert at the end of the Open section.
  let end = openIdx + 1;
  while (end < lines.length && !/^##\s+/.test(lines[end])) end++;
  let insertAt = end;
  while (insertAt > openIdx + 1 && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, line);
  return normalize(lines.join("\n"));
}

export interface TaskListing {
  open: string[];
  done: string[];
}

/** Parse the open and done tasks from a task page. */
export function listTasks(content: string | null | undefined): TaskListing {
  const open: string[] = [];
  const done: string[] = [];
  for (const line of lf(content ?? "").split("\n")) {
    const o = OPEN_RE.exec(line);
    if (o) {
      open.push(o[2].trim());
      continue;
    }
    const d = DONE_RE.exec(line);
    if (d) done.push(d[2].replace(/\s*\(done [^)]*\)\s*$/i, "").trim());
  }
  return { open, done };
}

/**
 * Mark the open task matching `match` (case-insensitive substring) as done,
 * stamping the date. Throws if no open task matches or the match is ambiguous.
 */
export function completeTask(content: string, match: string, date: string): string {
  const needle = match.trim().toLowerCase();
  if (!needle) throw new NoteError("Provide text identifying which task to complete.");
  const lines = lf(content).split("\n");

  const matches: number[] = [];
  lines.forEach((line, i) => {
    const m = OPEN_RE.exec(line);
    if (m && m[2].toLowerCase().includes(needle)) matches.push(i);
  });

  if (matches.length === 0) throw new NoteError(`No open task matches "${match}".`);
  if (matches.length > 1) throw new NoteError(`"${match}" matches ${matches.length} open tasks — be more specific.`);

  const i = matches[0];
  const m = OPEN_RE.exec(lines[i])!;
  lines[i] = `${m[1]}[x] ${m[2].trim()} (done ${date})`;
  return normalize(lines.join("\n"));
}
