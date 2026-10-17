/**
 * memory.mjs — 给 API 成员加"跨会话长期记忆"
 *
 * 内置工具的会话历史在内存里，AIROOM 一重启就没了。这个插件把要点落到文件里，
 * 并且每次对话开始时会自动把已有记忆注入系统提示词。
 *
 * 记忆文件：本插件旁边 memory.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const title = '长期记忆';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'memory.json');
const MAX_ITEMS = Number(process.env.MEMORY_MAX_ITEMS || 200);

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}
function save(items) {
  try { fs.writeFileSync(FILE, JSON.stringify(items.slice(-MAX_ITEMS), null, 2), 'utf8'); } catch {}
}

/** 每次对话自动注入：让模型知道自己记过什么。 */
export function systemExtra() {
  const items = load();
  if (!items.length) return '';
  return '【长期记忆】你在以前的会话里记下了这些，可以按需使用或更新：\n'
    + items.slice(-30).map((it) => '- {' + it.tag + '} ' + it.text).join('\n');
}

export const tools = [
  {
    name: 'remember',
    description: '把一条值得长期记住的信息写进记忆（跨会话保留）。例如项目约定、用户偏好、关键结论。',
    kind: 'edit',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记住的内容，一句话' },
        tag: { type: 'string', description: '分类标签，例如 项目 / 偏好 / 结论' },
      },
      required: ['text'],
    },
    async run(args, ctx) {
      const text = String(args.text || '').trim();
      if (!text) return '[错误] 要给 text。';
      const items = load();
      items.push({ tag: String(args.tag || '通用').slice(0, 20), text: text.slice(0, 500), at: new Date().toISOString().slice(0, 19) });
      save(items);
      ctx.log('记住了一条（共 ' + items.length + ' 条）');
      return '[成功] 已记住。当前共 ' + items.length + ' 条。';
    },
  },
  {
    name: 'recall',
    description: '读回长期记忆。可以给 keyword 过滤。',
    kind: 'read',
    parameters: {
      type: 'object',
      properties: { keyword: { type: 'string', description: '可选，按关键词过滤' } },
    },
    async run(args) {
      const items = load();
      const keyword = String(args.keyword || '').trim();
      const hit = keyword ? items.filter((it) => (it.text + it.tag).includes(keyword)) : items;
      if (!hit.length) return '(没有匹配的记忆)';
      return hit.slice(-50).map((it, i) => (i + 1) + '. [' + it.tag + '] ' + it.text + '  (' + it.at + ')').join('\n');
    },
  },
  {
    name: 'forget',
    description: '删掉匹配 keyword 的记忆。',
    kind: 'edit',
    parameters: {
      type: 'object',
      properties: { keyword: { type: 'string', description: '要删掉哪些' } },
      required: ['keyword'],
    },
    async run(args) {
      const keyword = String(args.keyword || '').trim();
      if (!keyword) return '[错误] 要给 keyword。';
      const items = load();
      const kept = items.filter((it) => !(it.text + it.tag).includes(keyword));
      save(kept);
      return '[成功] 删掉 ' + (items.length - kept.length) + ' 条，剩 ' + kept.length + ' 条。';
    },
  },
];
