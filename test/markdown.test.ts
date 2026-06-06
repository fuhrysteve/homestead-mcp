import { describe, expect, it } from "vitest";
import { editNote, insertLogEntry, NoteError } from "../src/markdown.js";

const EXISTING_LOG = `# Gardening log

Newest entries at top. Use ISO dates (\`YYYY-MM-DD\`).

---

## 2026 season

### 2026-05-31 — Berry status walk
- Raspberries doing fine.

---

## 2025 season (history)
- Built the beds.
`;

describe("insertLogEntry", () => {
  it("creates a new file with skeleton when none exists", () => {
    const out = insertLogEntry(null, {
      date: "2026-06-06",
      year: "2026",
      title: "First entry",
      body: "- hello",
      domainTitle: "Gardening",
    });
    expect(out).toContain("# Gardening log");
    expect(out).toContain("## 2026 season");
    expect(out).toContain("### 2026-06-06 — First entry");
    expect(out).toContain("- hello");
    expect(out.endsWith("\n")).toBe(true);
  });

  it("inserts newest entry at the TOP of the current season", () => {
    const out = insertLogEntry(EXISTING_LOG, {
      date: "2026-06-06",
      year: "2026",
      title: "New thing",
      body: "- detail",
      domainTitle: "Gardening",
    });
    const newIdx = out.indexOf("### 2026-06-06 — New thing");
    const oldIdx = out.indexOf("### 2026-05-31 — Berry status walk");
    expect(newIdx).toBeGreaterThan(-1);
    expect(newIdx).toBeLessThan(oldIdx);
    // didn't clobber history
    expect(out).toContain("## 2025 season (history)");
  });

  it("creates a new season block above older seasons when the year is absent", () => {
    const out = insertLogEntry(EXISTING_LOG, {
      date: "2027-01-02",
      year: "2027",
      title: "New year",
      domainTitle: "Gardening",
    });
    const seasonIdx = out.indexOf("## 2027 season");
    const oldSeasonIdx = out.indexOf("## 2026 season");
    expect(seasonIdx).toBeGreaterThan(-1);
    expect(seasonIdx).toBeLessThan(oldSeasonIdx);
    expect(out).toContain("### 2027-01-02 — New year");
  });

  it("supports a title-only entry (no body)", () => {
    const out = insertLogEntry(EXISTING_LOG, {
      date: "2026-06-07",
      year: "2026",
      title: "Quick note",
      domainTitle: "Gardening",
    });
    expect(out).toContain("### 2026-06-07 — Quick note");
  });

  it("never produces 3+ consecutive newlines", () => {
    const out = insertLogEntry(EXISTING_LOG, {
      date: "2026-06-06",
      year: "2026",
      title: "Spacing",
      body: "- x",
      domainTitle: "Gardening",
    });
    expect(out).not.toMatch(/\n\n\n/);
  });
});

const NOTE = `# Irrigation

Some intro.

## How to tee off
- Use two gear clamps.

## Pressure
- Well pressure is unregulated.
`;

describe("editNote", () => {
  it("appends to end of file by default", () => {
    const out = editNote(NOTE, { mode: "append", text: "## New section\n- added" });
    expect(out).toContain("## New section");
    expect(out.trimEnd().endsWith("- added")).toBe(true);
  });

  it("appends under a named section, before the next heading", () => {
    const out = editNote(NOTE, { mode: "append", text: "- soften poly first", section: "How to tee off" });
    const teeIdx = out.indexOf("## How to tee off");
    const addedIdx = out.indexOf("- soften poly first");
    const pressureIdx = out.indexOf("## Pressure");
    expect(addedIdx).toBeGreaterThan(teeIdx);
    expect(addedIdx).toBeLessThan(pressureIdx);
  });

  it("replaces a section body, keeping the heading", () => {
    const out = editNote(NOTE, { mode: "replace_section", text: "- rewritten", section: "Pressure" });
    expect(out).toContain("## Pressure");
    expect(out).toContain("- rewritten");
    expect(out).not.toContain("Well pressure is unregulated");
  });

  it("matches section headings case-insensitively", () => {
    const out = editNote(NOTE, { mode: "append", text: "- x", section: "PRESSURE" });
    expect(out).toContain("- x");
  });

  it("throws on a missing section", () => {
    expect(() => editNote(NOTE, { mode: "append", text: "x", section: "Nonexistent" })).toThrow(NoteError);
  });

  it("replace_section requires a section", () => {
    expect(() => editNote(NOTE, { mode: "replace_section", text: "x" })).toThrow(NoteError);
  });

  it("replace_file overwrites everything", () => {
    const out = editNote(NOTE, { mode: "replace_file", text: "# Brand new" });
    expect(out).toBe("# Brand new\n");
  });
});
