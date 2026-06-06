/**
 * MCP tool surface: log_event, update_note, get_note. This is the ENTIRE write
 * surface — no generic file write, no shell, no read-arbitrary-path. Every path
 * is validated through paths.ts; every write is one git commit by the bot identity.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env, UserProps } from "./env.js";
import { GitHubError, HomesteadRepo, type CommitResult } from "./github.js";
import { editNote, insertLogEntry, NoteError, type NoteMode } from "./markdown.js";
import { buildDocPath, DomainError, logPath, parseDomains, PathError } from "./paths.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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
    err instanceof PathError ||
    err instanceof DomainError ||
    err instanceof NoteError ||
    err instanceof GitHubError;
  const msg = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: known ? `Rejected: ${msg}` : `Error: ${msg}` }],
    isError: true,
  };
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

function shortSummary(s: string, max = 60): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

export function registerTools(server: McpServer, env: Env, props: UserProps): void {
  const domains = parseDomains(env.ALLOWED_DOMAINS);
  const repo = new HomesteadRepo(env);
  const domainList = domains.join(", ");

  server.tool(
    "log_event",
    `Append a dated event to a homestead domain's log (docs/<domain>/log.md). Use for things ` +
      `that happened on a date — inspections, plantings, repairs, flock/hive changes. Creates a ` +
      `"### <date> — <title>" section at the top of the current season. Domains: ${domainList}.`,
    {
      domain: z.string().describe(`Homestead domain. One of: ${domainList}.`),
      title: z.string().min(1).describe('Short headline for the entry (the "— Title" part), e.g. "Berry status walk".'),
      body: z
        .string()
        .optional()
        .describe("Optional Markdown details, typically `- ` bullet lines. Omit for a one-line event."),
      date: z.string().optional().describe("ISO date YYYY-MM-DD. Defaults to today (UTC)."),
    },
    async ({ domain, title, body, date }) => {
      try {
        if (date && !ISO_DATE.test(date)) throw new PathError(`date must be YYYY-MM-DD, got "${date}".`);
        const path = logPath(domain, domains);
        const d = date ?? todayIso();
        const year = d.slice(0, 4);
        const domainTitle = titleCase(parseDomains(env.ALLOWED_DOMAINS).find((x) => x === domain.trim().toLowerCase()) ?? domain);
        const commit = await commitTransform(
          repo,
          path,
          (cur) => insertLogEntry(cur, { date: d, year, title, body, domainTitle }),
          `log(${domain.trim().toLowerCase()}): ${shortSummary(title)}`,
        );
        return textResult(`Logged to ${path} (${d}). Commit ${commit.sha.slice(0, 7)}: ${commit.url}`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "update_note",
    `Edit a persistent-context note under docs/<domain>/ (e.g. README.md or a topic file like ` +
      `irrigation.md). Use for lasting facts, not dated events. By default appends; can target a ` +
      `"## Section" heading. Never writes outside docs/<domain>/ or into reference/. Domains: ${domainList}.`,
    {
      domain: z.string().describe(`Homestead domain. One of: ${domainList}.`),
      file: z.string().describe('Markdown file under the domain, e.g. "README.md" or "irrigation.md".'),
      text: z.string().min(1).describe("Markdown content to write."),
      mode: z
        .enum(["append", "replace_section", "replace_file"])
        .optional()
        .describe(
          "append (default): add text to end of file, or under `section` if given. " +
            "replace_section: replace the body under `section`. " +
            "replace_file: overwrite the whole file (call get_note first).",
        ),
      section: z
        .string()
        .optional()
        .describe('Heading text to target (without leading #), e.g. "How to tee off". Required for replace_section.'),
    },
    async ({ domain, file, text, mode, section }) => {
      try {
        const path = buildDocPath(domain, file, domains);
        const m: NoteMode = mode ?? "append";
        const where = section ? `${file} › "${section}"` : file;
        const commit = await commitTransform(
          repo,
          path,
          (cur) => {
            if (cur === null && m !== "replace_file") {
              throw new NoteError(`${path} does not exist yet; use mode "replace_file" to create it.`);
            }
            return editNote(cur, { mode: m, text, section });
          },
          `notes(${domain.trim().toLowerCase()}/${file}): ${shortSummary(section ?? text)}`,
        );
        return textResult(`Updated ${where} (mode=${m}). Commit ${commit.sha.slice(0, 7)}: ${commit.url}`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "get_note",
    `Read the current contents of a note under docs/<domain>/ so you can edit it accurately ` +
      `before calling update_note. Read-only and path-constrained to docs/. Domains: ${domainList}.`,
    {
      domain: z.string().describe(`Homestead domain. One of: ${domainList}.`),
      file: z.string().describe('Markdown file under the domain, e.g. "README.md" or "log.md".'),
    },
    async ({ domain, file }) => {
      try {
        const path = buildDocPath(domain, file, domains);
        const state = await repo.getFile(path);
        if (!state) return textResult(`${path} does not exist yet.`);
        return textResult(state.content);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // props.login is available for per-call audit logging if desired.
  void props;
}
