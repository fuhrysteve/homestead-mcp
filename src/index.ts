/**
 * Worker entry. OAuthProvider fronts everything: it serves the OAuth 2.1 + PKCE
 * endpoints the claude.ai connector requires (/authorize, /token, /register),
 * delegates the human login to the GitHub handler, and only then routes
 * authenticated MCP traffic to the agent at /mcp (and /sse for legacy clients).
 */
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env, UserProps } from "./env.js";
import { GitHubHandler } from "./github-handler.js";
import { registerTools } from "./tools.js";

export class HomesteadMCP extends McpAgent<Env, unknown, UserProps> {
  server = new McpServer({ name: "homestead-notes", version: "0.1.0" });

  async init(): Promise<void> {
    registerTools(this.server, this.env, this.props);
  }
}

export default new OAuthProvider({
  apiHandlers: {
    "/sse": HomesteadMCP.serveSSE("/sse") as never,
    "/mcp": HomesteadMCP.serve("/mcp") as never,
  },
  defaultHandler: GitHubHandler as never,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
