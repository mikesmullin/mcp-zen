import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import Ajv from "ajv";
import { enabledTools } from "@mcp-zen/common";

const ajv = new Ajv({ allErrors: true, useDefaults: true, strict: false });
const validators = new Map(enabledTools.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]));

export function createMcpServer(adapter) {
  const server = new Server({ name: "mcp-zen", version: "0.1.0" }, {
    capabilities: { tools: {} },
    instructions: "Agent-browser signatures on an attached Firefox/Zen browser, not a managed Chromium process. Default session binds a personal tab; named sessions use Firefox containers (permission required). Namespaces are logical container/session groups, not daemon filesystem sandboxes. Snapshots are DOM-derived accessibility approximations; input events are synthetic. Frames, find/hover, dialogs, tap/swipe are included. Unsupported launch/security/restore options fail explicitly. close only closes mcp-zen-owned tabs/containers, never the personal browser. Screenshot paths are on the MCP server host. See docs/parity.md.",
  });
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    if (request.params?.cursor !== undefined) throw new McpError(ErrorCode.InvalidParams, "No additional tool pages");
    return { tools: enabledTools };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const validate = validators.get(request.params.name);
    if (!validate) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
    const args = structuredClone(request.params.arguments || {});
    if (!validate(args)) throw new McpError(ErrorCode.InvalidParams, ajv.errorsText(validate.errors, { separator: "; " }));
    return adapter.call(request.params.name, args, { signal: extra.signal });
  });
  return server;
}
