/**
 * MCP tool surface — a constrained wiki editor over the homestead repo's docs/ tree.
 * Read/Write/Edit mirror Claude Code; list/search let Claude navigate the knowledge
 * base; log_event keeps the dated-log convention; delete/move are housekeeping.
 * Everything is confined to docs/ (see paths.ts) and committed as the authenticating
 * user (see github.ts). No generic file write, no shell, no read outside docs/.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env, UserProps } from "./env.js";
import { commitIdentity, GitHubError, HomesteadRepo, type CommitResult } from "./github.js";
import { applyEdit, insertLogEntry, NoteError, normalizeContent } from "./markdown.js";
import { domainLogPath, domainSegment, PathError, resolveDocPath, toWikiPath } from "./paths.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SEARCH_FILE_CAP = 80; // max files scanned per search

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function titleCase(d: string): string {
  return d.charAt(0).toUpperCase() + d.slice(1);
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(err: unknown) {
  const known =
    err instanceof PathError || err instanceof NoteError || err instanceof GitHubError;
  const msg = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: known ? `Rejected: ${msg}` : `Error: ${msg}` }],
    isError: true,
  };
}

function shortSummary(s: string, max = 60): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

/** Read → transform → commit, retrying once if a concurrent commit moved the blob sha. */
async function commitTransform(
  repo: HomesteadRepo,
  repoPath: string,
  transform: (current: string | null) => string,
  message: string,
): Promise<CommitResult> {
  for (let attempt = 0; ; attempt++) {
    const current = await repo.getFile(repoPath);
    const next = transform(current?.content ?? null);
    try {
      return await repo.putFile(repoPath, next, message, current?.sha);
    } catch (err) {
      if (err instanceof GitHubError && err.status === 409 && attempt < 1) continue;
      throw err;
    }
  }
}

export function registerTools(server: McpServer, env: Env, props: UserProps): void {
  const repo = new HomesteadRepo(env, commitIdentity(props, env));

  // ---- browse -----------------------------------------------------------
  server.tool(
    "list_notes",
    "List the Markdown pages in the homestead knowledge base (the docs/ wiki tree). " +
      "Use this to see what already exists before creating or editing a page. " +
      "Optionally pass a subdir (e.g. 'gardening') to list just that area.",
    {
      subdir: z.string().optional().describe("Optional area to limit the listing to, e.g. 'gardening'."),
    },
    async ({ subdir }) => {
      try {
        const files = await repo.listDocsFiles();
        let wiki = files.map((f) => toWikiPath(f.path));
        if (subdir) {
          const prefix = subdir.replace(/^\/+|\/+$/g, "") + "/";
          wiki = wiki.filter((p) => p.startsWith(prefix) || p === subdir);
        }
        if (wiki.length === 0) return textResult(subdir ? `No pages under ${subdir}.` : "The wiki is empty.");
        // Group by top-level domain for readability.
        const byDomain = new Map<string, string[]>();
        for (const p of wiki) {
          const top = p.includes("/") ? p.slice(0, p.indexOf("/")) : "(root)";
          (byDomain.get(top) ?? byDomain.set(top, []).get(top)!).push(p);
        }
        const out: string[] = [`${wiki.length} page(s):`];
        for (const [top, paths] of [...byDomain.entries()].sort()) {
          out.push(`\n${top}/`);
          for (const p of paths) out.push(`  ${p}`);
        }
        return textResult(out.join("\n"));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ---- search -----------------------------------------------------------
  server.tool(
    "search_notes",
    "Search the homestead knowledge base for text (case-insensitive; all words must match). " +
      "Use this to find where something is already documented before answering or writing, " +
      "so you extend the right page instead of duplicating. Returns matching pages with snippets.",
    {
      query: z.string().min(1).describe("Words to search for, e.g. 'aphids broccoli'."),
      subdir: z.string().optional().describe("Optional area to limit the search to, e.g. 'gardening'."),
    },
    async ({ query, subdir }) => {
      try {
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
        let files = await repo.listDocsFiles();
        if (subdir) {
          const prefix = `docs/${subdir.replace(/^\/+|\/+$/g, "")}/`;
          files = files.filter((f) => f.path.startsWith(prefix));
        }
        const truncated = files.length > SEARCH_FILE_CAP;
        files = files.slice(0, SEARCH_FILE_CAP);

        const scanned = await Promise.all(
          files.map(async (f) => {
            const state = await repo.getFile(f.path);
            return state ? { path: toWikiPath(f.path), content: state.content } : null;
          }),
        );

        const hits: string[] = [];
        for (const file of scanned) {
          if (!file) continue;
          const lower = file.content.toLowerCase();
          if (!terms.every((t) => lower.includes(t))) continue;
          const snippetLines = file.content
            .split("\n")
            .filter((line) => terms.some((t) => line.toLowerCase().includes(t)))
            .slice(0, 3)
            .map((l) => `    ${l.trim()}`);
          hits.push(`• ${file.path}\n${snippetLines.join("\n")}`);
        }

        if (hits.length === 0) return textResult(`No matches for "${query}".`);
        const header = `${hits.length} page(s) matched "${query}"${truncated ? ` (scan capped at ${SEARCH_FILE_CAP} files)` : ""}:`;
        return textResult([header, ...hits].join("\n"));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ---- read -------------------------------------------------------------
  server.tool(
    "get_note",
    "Read the current contents of a knowledge-base page so you can edit it accurately. " +
      "Path is relative to docs/, e.g. 'gardening/pests.md'. Read before you edit_note.",
    {
      path: z.string().describe("Page path under docs/, e.g. 'gardening/README.md'."),
    },
    async ({ path }) => {
      try {
        const full = resolveDocPath(path);
        const state = await repo.getFile(full);
        if (!state) return textResult(`${toWikiPath(full)} does not exist yet. Use write_note to create it.`);
        return textResult(state.content);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ---- edit (find/replace) ----------------------------------------------
  server.tool(
    "edit_note",
    "Make a surgical edit to an existing page by replacing exact text (like a code editor). " +
      "old_text must match the file exactly and be unique (read it with get_note first); set " +
      "replace_all to change every occurrence. Use this for small in-place changes; use " +
      "write_note to create a page or rewrite it wholesale.",
    {
      path: z.string().describe("Page path under docs/, e.g. 'gardening/pests.md'."),
      old_text: z.string().min(1).describe("Exact existing text to replace (copy it from get_note)."),
      new_text: z.string().describe("Replacement text."),
      replace_all: z.boolean().optional().describe("Replace every occurrence (default false → must be unique)."),
    },
    async ({ path, old_text, new_text, replace_all }) => {
      try {
        const full = resolveDocPath(path);
        const commit = await commitTransform(
          repo,
          full,
          (cur) => {
            if (cur === null) throw new NoteError(`${toWikiPath(full)} does not exist. Use write_note to create it.`);
            return applyEdit(cur, old_text, new_text, replace_all ?? false);
          },
          `notes(${toWikiPath(full)}): edit`,
        );
        return textResult(`Edited ${toWikiPath(full)}. Commit ${commit.sha.slice(0, 7)}: ${commit.url}`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ---- write (create / overwrite) ---------------------------------------
  server.tool(
    "write_note",
    "Create a new knowledge-base page, or overwrite an existing one with full new contents. " +
      "Path is relative to docs/, e.g. 'gardening/pests.md' or a new area like 'orchard/overview.md' " +
      "(new domains are allowed). For small changes to an existing page prefer edit_note so you " +
      "don't clobber other content.",
    {
      path: z.string().describe("Page path under docs/, e.g. 'orchard/pawpaws.md'."),
      content: z.string().min(1).describe("Full Markdown content of the page."),
    },
    async ({ path, content }) => {
      try {
        const full = resolveDocPath(path);
        const existed = (await repo.getFile(full)) !== null;
        const commit = await commitTransform(
          repo,
          full,
          () => normalizeContent(content),
          `notes(${toWikiPath(full)}): ${existed ? "update" : "create"}`,
        );
        return textResult(`${existed ? "Updated" : "Created"} ${toWikiPath(full)}. Commit ${commit.sha.slice(0, 7)}: ${commit.url}`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ---- dated log entry --------------------------------------------------
  server.tool(
    "log_event",
    "Append a dated event to a domain's log (docs/<domain>/log.md) — for things that happened on " +
      "a date (inspections, plantings, repairs, a pest sighting). Creates a '### <date> — <title>' " +
      "section at the top of the current season. For lasting knowledge (how-tos, plans, findings) " +
      "use write_note/edit_note on a topic page instead.",
    {
      domain: z.string().describe("Domain whose log to append to, e.g. 'gardening', 'chickens', 'beekeeping'."),
      title: z.string().min(1).describe('Short headline, e.g. "Cabbage looper on broccoli".'),
      body: z.string().optional().describe("Optional Markdown details, typically `- ` bullet lines."),
      date: z.string().optional().describe("ISO date YYYY-MM-DD. Defaults to today (UTC)."),
    },
    async ({ domain, title, body, date }) => {
      try {
        if (date && !ISO_DATE.test(date)) throw new PathError(`date must be YYYY-MM-DD, got "${date}".`);
        const dom = domainSegment(domain);
        const path = domainLogPath(dom);
        const d = date ?? todayIso();
        const commit = await commitTransform(
          repo,
          path,
          (cur) => insertLogEntry(cur, { date: d, year: d.slice(0, 4), title, body, domainTitle: titleCase(dom) }),
          `log(${dom}): ${shortSummary(title)}`,
        );
        return textResult(`Logged to ${toWikiPath(path)} (${d}). Commit ${commit.sha.slice(0, 7)}: ${commit.url}`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ---- delete -----------------------------------------------------------
  server.tool(
    "delete_note",
    "Delete a knowledge-base page (docs/...). Every deletion is a revertible commit. " +
      "Use sparingly — prefer editing a page to fix it rather than removing knowledge.",
    {
      path: z.string().describe("Page path under docs/ to delete, e.g. 'gardening/old-notes.md'."),
    },
    async ({ path }) => {
      try {
        const full = resolveDocPath(path);
        const state = await repo.getFile(full);
        if (!state) return textResult(`${toWikiPath(full)} does not exist; nothing to delete.`);
        const commit = await repo.deleteFile(full, `notes(${toWikiPath(full)}): delete`, state.sha);
        return textResult(`Deleted ${toWikiPath(full)}. Commit ${commit.sha.slice(0, 7)}: ${commit.url}`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ---- move / rename ----------------------------------------------------
  server.tool(
    "move_note",
    "Rename or move a knowledge-base page to a new path under docs/ (copies content to the new " +
      "path, then removes the old one).",
    {
      path: z.string().describe("Current page path under docs/, e.g. 'gardening/pests.md'."),
      new_path: z.string().describe("New page path under docs/, e.g. 'gardening/pests-and-disease.md'."),
    },
    async ({ path, new_path }) => {
      try {
        const from = resolveDocPath(path);
        const to = resolveDocPath(new_path);
        if (from === to) throw new NoteError("path and new_path are the same.");
        const src = await repo.getFile(from);
        if (!src) throw new NoteError(`${toWikiPath(from)} does not exist.`);
        if ((await repo.getFile(to)) !== null) {
          throw new NoteError(`${toWikiPath(to)} already exists — choose a different new_path or delete it first.`);
        }
        await repo.putFile(to, src.content, `notes: move ${toWikiPath(from)} -> ${toWikiPath(to)}`);
        const commit = await repo.deleteFile(from, `notes: move ${toWikiPath(from)} -> ${toWikiPath(to)} (remove old)`, src.sha);
        return textResult(`Moved ${toWikiPath(from)} -> ${toWikiPath(to)}. Commit ${commit.sha.slice(0, 7)}: ${commit.url}`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
