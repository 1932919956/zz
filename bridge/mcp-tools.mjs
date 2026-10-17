#!/usr/bin/env node
/**
 * mcp-tools.mjs —— 把 bridge/plugins 里的工具通过 MCP 暴露给别的运行时（OpenCode 等）
 *
 * 为什么需要它：generate_image / web_search / remember 这些工具装在
 * api-acp.mjs 的插件里，只有"API 接口"那类成员能用。OpenCode 是另一套运行时，
 * 读不到这些插件；但 MCP 是通用协议，OpenCode 支持它。
 *
 * 用法（由 OpenCode 配置自动拉起，stdio）：
 *   node mcp-tools.mjs
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function log(message) {
  try { process.stderr.write('[mcp-tools] ' + message + String.fromCharCode(10)); } catch {}
}

const MODULES = [
  './plugins/image-gen.mjs',
  './plugins/web-search.mjs',
  './plugins/memory.mjs',
  './plugins/workbuddy.mjs',
];

const registry = new Map();

export async function loadAll() {
  for (const rel of MODULES) {
    try {
      const mod = await import(new URL(rel, import.meta.url).href);
      for (const tool of (mod.tools || [])) {
        if (!tool || !tool.name || typeof tool.run !== 'function') continue;
        registry.set(tool.name, tool);
      }
    } catch (error) {
      log('插件加载失败 ' + rel + '：' + String((error && error.message) || error));
    }
  }
  log('已注册 ' + registry.size + ' 个工具：' + [...registry.keys()].join(', '));
}

const CTX = {
  cwd: process.cwd(),
  session: { id: "mcp" },
  inside: () => true,
  cap: () => undefined,
  log,
  cfg: {},
  fs,
  path,
};

function toMcpTool(tool) {
  return {
    name: tool.name,
    description: tool.description || tool.name,
    inputSchema: tool.parameters || { type: "object", properties: {} },
  };
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + String.fromCharCode(10));
}

function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + String.fromCharCode(10));
}

async function handle(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    reply(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "airoom-tools", version: "1.0.0" },
    });
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "ping") { reply(id, {}); return; }
  if (method === "tools/list") {
    reply(id, { tools: [...registry.values()].map(toMcpTool) });
    return;
  }
  if (method === "tools/call") {
    const name = String(params?.name || "");
    const tool = registry.get(name);
    if (!tool) {
      reply(id, { content: [{ type: "text", text: "[错误] 不认识这个工具：" + name }], isError: true });
      return;
    }
    try {
      const result = await tool.run(params?.arguments || {}, CTX);
      const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      reply(id, { content: [{ type: "text", text }] });
    } catch (error) {
      reply(id, { content: [{ type: "text", text: "[执行失败] " + String((error && error.message) || error) }], isError: true });
    }
    return;
  }
  if (id !== undefined) replyError(id, -32601, "不支持的方法：" + method);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf(String.fromCharCode(10))) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { log("收到无法解析的一行：" + line.slice(0, 120)); continue; }
    void handle(message).catch((error) => {
      if (message && message.id !== undefined) replyError(message.id, -32603, String((error && error.message) || error));
    });
  }
});

process.stdin.on("end", () => process.exit(0));

await loadAll();