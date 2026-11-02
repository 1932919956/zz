"use strict";

// src/backend/adapters/claude-permission-mcp.ts
var import_node_net = require("node:net");
var import_node_readline = require("node:readline");
var permissionTool = {
  name: "permission_prompt",
  description: "Ask the AIROOM owner to approve a pending Claude Code operation.",
  inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object", additionalProperties: true }, tool_use_id: { type: "string" } }, required: ["tool_name", "input"] }
};
var questionTool = {
  name: "ask_user",
  description: "Ask the AIROOM owner a question and wait for their answer. Use when native AskUserQuestion is unavailable.",
  inputSchema: { type: "object", properties: { question: { type: "string" }, questions: { type: "array", items: { type: "object", additionalProperties: true } } }, additionalProperties: false }
};
function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function error(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}
function hostRequest(kind, payload) {
  return new Promise((resolve, reject) => {
    const pipe = process.env.AIROOM_PERMISSION_PIPE, secret = process.env.AIROOM_PERMISSION_SECRET;
    if (!pipe || !secret) {
      reject(new Error("AIROOM \u5BA1\u6279\u8FDE\u63A5\u672A\u914D\u7F6E\u3002"));
      return;
    }
    const socket = (0, import_node_net.connect)(pipe);
    let buffer = "", answered = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("\u5BA1\u6279\u7B49\u5F85\u8D85\u65F6\uFF0C\u8BF7\u91CD\u65B0\u63D0\u51FA\u8BF7\u6C42\u3002"));
    }, 30 * 60 * 1e3);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(JSON.stringify({ secret, kind, payload }) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) {
        socket.destroy(new Error("\u5BA1\u6279\u54CD\u5E94\u8FC7\u5927\u3002"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        answered = true;
        clearTimeout(timer);
        if (response.error) reject(new Error(response.error));
        else resolve(response.result);
      } catch (cause) {
        reject(cause);
      }
      socket.end();
    });
    socket.once("error", (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
    socket.once("close", () => {
      clearTimeout(timer);
      if (!answered) reject(new Error("AIROOM \u5BA1\u6279\u8FDE\u63A5\u5DF2\u5173\u95ED\u3002"));
    });
  });
}
var lines = (0, import_node_readline.createInterface)({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === void 0) return;
  if (message.method === "initialize") respond(message.id, { protocolVersion: message.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "airoom-permissions", version: "0.1.0" } });
  else if (message.method === "ping") respond(message.id, {});
  else if (message.method === "tools/list") respond(message.id, { tools: [permissionTool, questionTool] });
  else if (message.method === "tools/call" && ["permission_prompt", "ask_user"].includes(message.params?.name)) {
    const kind = message.params.name === "permission_prompt" ? "permission" : "question";
    hostRequest(kind, message.params.arguments ?? {}).then((result) => respond(message.id, { content: [{ type: "text", text: JSON.stringify(result) }] }), (cause) => {
      if (kind === "permission") respond(message.id, { content: [{ type: "text", text: JSON.stringify({ behavior: "deny", message: cause instanceof Error ? cause.message : String(cause) }) }] });
      else respond(message.id, { content: [{ type: "text", text: cause instanceof Error ? cause.message : String(cause) }], isError: true });
    });
  } else error(message.id, -32601, "Unsupported MCP method or tool.");
});
lines.once("close", () => process.exit(0));
//# sourceMappingURL=claude-permission-mcp.cjs.map
