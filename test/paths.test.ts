import { describe, expect, it } from "vitest";
import { assertDomain, buildDocPath, DomainError, logPath, parseDomains, PathError } from "../src/paths.js";

const DOMAINS = ["gardening", "chickens", "beekeeping"];

describe("parseDomains", () => {
  it("splits, trims, lowercases", () => {
    expect(parseDomains(" Gardening, Chickens ,beekeeping ")).toEqual(DOMAINS);
  });
  it("handles empty", () => {
    expect(parseDomains(undefined)).toEqual([]);
  });
});

describe("assertDomain", () => {
  it("accepts allowed (case-insensitive)", () => {
    expect(assertDomain("Gardening", DOMAINS)).toBe("gardening");
  });
  it("rejects unknown", () => {
    expect(() => assertDomain("finances", DOMAINS)).toThrow(DomainError);
  });
});

describe("buildDocPath — valid", () => {
  it("builds a domain file path", () => {
    expect(buildDocPath("gardening", "irrigation.md", DOMAINS)).toBe("docs/gardening/irrigation.md");
  });
  it("allows nested subdirs", () => {
    expect(buildDocPath("gardening", "topics/beds.md", DOMAINS)).toBe("docs/gardening/topics/beds.md");
  });
  it("logPath resolves to log.md", () => {
    expect(logPath("chickens", DOMAINS)).toBe("docs/chickens/log.md");
  });
});

describe("buildDocPath — rejected", () => {
  const bad: [string, string][] = [
    ["gardening", "../chickens/log.md"],
    ["gardening", "../../etc/passwd"],
    ["gardening", "/etc/passwd"],
    ["gardening", "a/../../escape.md"],
    ["gardening", "sub/../../../escape.md"],
    ["gardening", "./hidden.md"],
    ["gardening", "weird\\path.md"],
    ["gardening", ""],
    ["gardening", "notmarkdown.txt"],
    ["gardening", "README"],
  ];
  for (const [domain, file] of bad) {
    it(`rejects ${domain}/${JSON.stringify(file)}`, () => {
      expect(() => buildDocPath(domain, file, DOMAINS)).toThrow(PathError);
    });
  }

  it("rejects writes into reference/", () => {
    expect(() => buildDocPath("gardening", "reference/manual.md", DOMAINS)).toThrow(PathError);
  });

  it("rejects unknown domain before path checks", () => {
    expect(() => buildDocPath("secrets", "x.md", DOMAINS)).toThrow(DomainError);
  });

  it("rejects control characters", () => {
    expect(() => buildDocPath("gardening", "a\tb.md", DOMAINS)).toThrow(PathError);
  });
});
