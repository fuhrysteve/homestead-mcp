import { describe, expect, it } from "vitest";
import { commitIdentity } from "../src/github.js";
import type { Env, UserProps } from "../src/env.js";

const env = { COMMIT_AUTHOR_NAME: "homestead-bot", COMMIT_AUTHOR_EMAIL: "homestead-bot@fuhry.app" } as Env;

function props(p: Partial<UserProps>): UserProps {
  return { login: "", name: "", email: "", ...p };
}

describe("commitIdentity", () => {
  it("uses the user's public email + display name when present", () => {
    expect(commitIdentity(props({ login: "marybethfuhry", name: "Mary Beth", email: "mb@example.com", id: 42 }), env))
      .toEqual({ name: "Mary Beth", email: "mb@example.com" });
  });

  it("falls back to the GitHub noreply address when email is private", () => {
    expect(commitIdentity(props({ login: "marybethfuhry", name: "Mary Beth", email: "", id: 42 }), env))
      .toEqual({ name: "Mary Beth", email: "42+marybethfuhry@users.noreply.github.com" });
  });

  it("uses login as the name when no display name is set", () => {
    expect(commitIdentity(props({ login: "fuhrysteve", name: "", email: "", id: 7 }), env))
      .toEqual({ name: "fuhrysteve", email: "7+fuhrysteve@users.noreply.github.com" });
  });

  it("falls back to the bot identity when there is no login at all", () => {
    expect(commitIdentity(props({}), env)).toEqual({ name: "homestead-bot", email: "homestead-bot@fuhry.app" });
  });

  it("falls back to the bot email when neither email nor id is available", () => {
    expect(commitIdentity(props({ login: "ghost" }), env))
      .toEqual({ name: "ghost", email: "homestead-bot@fuhry.app" });
  });
});
