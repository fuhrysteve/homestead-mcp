import { describe, expect, it } from "vitest";
import { appendToNote, applyEdit, insertLogEntry, NoteError, normalizeContent } from "../src/markdown.js";

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
    expect(out).toContain("## 2025 season (history)");
  });

  it("creates a new season block above older seasons when the year is absent", () => {
    const out = insertLogEntry(EXISTING_LOG, {
      date: "2027-01-02",
      year: "2027",
      title: "New year",
      domainTitle: "Gardening",
    });
    expect(out.indexOf("## 2027 season")).toBeLessThan(out.indexOf("## 2026 season"));
    expect(out).toContain("### 2027-01-02 — New year");
  });

  it("never produces 3+ consecutive newlines", () => {
    const out = insertLogEntry(EXISTING_LOG, { date: "2026-06-06", year: "2026", title: "Spacing", body: "- x", domainTitle: "Gardening" });
    expect(out).not.toMatch(/\n\n\n/);
  });
});

const NOTE = `# Pests

## Aphids
- Spray with insecticidal soap.

## Cabbage looper
- Use Bt and row cover.
`;

describe("applyEdit", () => {
  it("replaces a unique occurrence", () => {
    const out = applyEdit(NOTE, "Use Bt and row cover.", "Use Bt; add row cover after transplant.");
    expect(out).toContain("Use Bt; add row cover after transplant.");
    expect(out).not.toContain("Use Bt and row cover.");
  });

  it("can append under a section by anchoring on the heading", () => {
    const out = applyEdit(NOTE, "## Aphids", "## Aphids\n- Also: ladybugs help.");
    const aphidsIdx = out.indexOf("## Aphids");
    const addedIdx = out.indexOf("- Also: ladybugs help.");
    const loopIdx = out.indexOf("## Cabbage looper");
    expect(addedIdx).toBeGreaterThan(aphidsIdx);
    expect(addedIdx).toBeLessThan(loopIdx);
  });

  it("throws when old_text is not found", () => {
    expect(() => applyEdit(NOTE, "nonexistent text", "x")).toThrow(NoteError);
  });

  it("throws when old_text is ambiguous and replace_all is not set", () => {
    expect(() => applyEdit(NOTE, "- ", "* ")).toThrow(NoteError);
  });

  it("replaces all occurrences with replace_all", () => {
    const out = applyEdit("a x a x a", "x", "y", true);
    expect(out.trim()).toBe("a y a y a");
  });

  it("throws when old_text equals new_text", () => {
    expect(() => applyEdit(NOTE, "## Aphids", "## Aphids")).toThrow(NoteError);
  });

  it("throws on empty old_text", () => {
    expect(() => applyEdit(NOTE, "", "x")).toThrow(NoteError);
  });
});

describe("normalizeContent", () => {
  it("guarantees a single trailing newline", () => {
    expect(normalizeContent("# Title")).toBe("# Title\n");
    expect(normalizeContent("# Title\n\n\n")).toBe("# Title\n");
  });
});

describe("appendToNote", () => {
  it("appends to the end of the file", () => {
    const out = appendToNote(NOTE, "## New\n- fresh");
    expect(out.trimEnd().endsWith("- fresh")).toBe(true);
  });
  it("appends under a named section, before the next heading", () => {
    const out = appendToNote(NOTE, "- ladybugs help", "Aphids");
    const aphids = out.indexOf("## Aphids");
    const added = out.indexOf("- ladybugs help");
    const loop = out.indexOf("## Cabbage looper");
    expect(added).toBeGreaterThan(aphids);
    expect(added).toBeLessThan(loop);
  });
  it("throws when the section is not found", () => {
    expect(() => appendToNote(NOTE, "- x", "Nonexistent")).toThrow(NoteError);
  });
});
