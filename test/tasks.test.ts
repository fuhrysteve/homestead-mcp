import { describe, expect, it } from "vitest";
import { addTask, completeTask, listTasks } from "../src/tasks.js";
import { NoteError } from "../src/markdown.js";

describe("addTask", () => {
  it("creates a task page when none exists", () => {
    const out = addTask(null, "put up row cover", "Gardening");
    expect(out).toContain("# Gardening tasks");
    expect(out).toContain("## Open");
    expect(out).toContain("- [ ] put up row cover");
    expect(out).toContain("## Done");
  });

  it("appends to the Open section of an existing page", () => {
    const start = addTask(null, "first", "Homestead");
    const out = addTask(start, "second", "Homestead");
    const open = out.indexOf("## Open");
    const done = out.indexOf("## Done");
    expect(out.indexOf("- [ ] first")).toBeGreaterThan(open);
    expect(out.indexOf("- [ ] second")).toBeGreaterThan(open);
    // both tasks land inside the Open section (before Done)
    expect(out.indexOf("- [ ] second")).toBeLessThan(done);
  });
});

describe("listTasks", () => {
  const page = `# Homestead tasks

## Open
- [ ] water the starts
- [ ] order seeds

## Done
- [x] build beds (done 2026-05-01)
`;
  it("separates open and done", () => {
    const { open, done } = listTasks(page);
    expect(open).toEqual(["water the starts", "order seeds"]);
    expect(done).toEqual(["build beds"]);
  });
  it("handles empty/missing content", () => {
    expect(listTasks(null)).toEqual({ open: [], done: [] });
  });
});

describe("completeTask", () => {
  const page = `# Homestead tasks

## Open
- [ ] water the starts
- [ ] order seeds

## Done
`;
  it("marks a unique match done with a date", () => {
    const out = completeTask(page, "seeds", "2026-06-07");
    expect(out).toContain("- [x] order seeds (done 2026-06-07)");
    expect(out).toContain("- [ ] water the starts");
  });
  it("throws when nothing matches", () => {
    expect(() => completeTask(page, "fertilize", "2026-06-07")).toThrow(NoteError);
  });
  it("throws on ambiguous match", () => {
    const p = `## Open\n- [ ] order seeds\n- [ ] order seed trays\n`;
    expect(() => completeTask(p, "order seed", "2026-06-07")).toThrow(NoteError);
  });
});
