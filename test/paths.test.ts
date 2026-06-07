import { describe, expect, it } from "vitest";
import { domainLogPath, domainSegment, isWikiNote, PathError, resolveDocPath, toWikiPath } from "../src/paths.js";

describe("resolveDocPath — valid", () => {
  it("resolves a page path under docs/", () => {
    expect(resolveDocPath("gardening/pests.md")).toBe("docs/gardening/pests.md");
  });
  it("allows new domains (any safe top segment)", () => {
    expect(resolveDocPath("orchard/pawpaws.md")).toBe("docs/orchard/pawpaws.md");
  });
  it("allows nested subdirs", () => {
    expect(resolveDocPath("gardening/topics/beds.md")).toBe("docs/gardening/topics/beds.md");
  });
});

describe("resolveDocPath — rejected", () => {
  const bad = [
    "../chickens/log.md",
    "../../etc/passwd",
    "/etc/passwd",
    "a/../../escape.md",
    "./hidden.md",
    "weird\\path.md",
    "",
    "notmarkdown.txt",
    "README",
    "a\tb.md",
  ];
  for (const p of bad) {
    it(`rejects ${JSON.stringify(p)}`, () => {
      expect(() => resolveDocPath(p)).toThrow(PathError);
    });
  }
  it("cannot escape docs/ into the sibling reference/ tree", () => {
    // ".." is rejected, so there's no way to reach top-level reference/.
    expect(() => resolveDocPath("../reference/manual.md")).toThrow(PathError);
  });
});

describe("domainSegment", () => {
  it("accepts a single segment", () => {
    expect(domainSegment("gardening")).toBe("gardening");
    expect(domainSegment(" beekeeping ")).toBe("beekeeping");
  });
  it("rejects a path with slashes", () => {
    expect(() => domainSegment("gardening/pests")).toThrow(PathError);
  });
  it("rejects traversal", () => {
    expect(() => domainSegment("..")).toThrow(PathError);
  });
});

describe("domainLogPath", () => {
  it("maps a domain to its log.md", () => {
    expect(domainLogPath("chickens")).toBe("docs/chickens/log.md");
  });
  it("works for a brand-new domain", () => {
    expect(domainLogPath("orchard")).toBe("docs/orchard/log.md");
  });
});

describe("toWikiPath / isWikiNote", () => {
  it("strips the docs/ prefix", () => {
    expect(toWikiPath("docs/gardening/pests.md")).toBe("gardening/pests.md");
  });
  it("identifies wiki notes", () => {
    expect(isWikiNote("docs/gardening/pests.md")).toBe(true);
    expect(isWikiNote("reference/images/x.png")).toBe(false);
    expect(isWikiNote("docs/gardening/diagram.png")).toBe(false);
  });
});
