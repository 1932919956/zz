/**
 * self-check.mjs — 让成员在提交前自己核对交付物
 *
 * 为什么：以前"忘了写 / 写错路径 / 写了空文件"要到复核才暴露，
 * 退回一次就是几十分钟。这个工具让成员提交前自己跑一遍，当场发现缺什么。
 */

import fs from 'node:fs';
import path from 'node:path';

export const title = '交付物自检';

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.airoom' || entry.name === '.work' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
}

export const tools = [{
  name: 'check_deliverables',
  description: '提交前自检：核对交付物文件是否存在、是否为空、目录里有多少文件。把想交的文件路径传进来（相对工作目录），返回逐条 PASS/FAIL。提交前跑一次，别等复核退回。',
  kind: 'fetch',
  parameters: {
    type: 'object',
    properties: {
      paths: { type: 'array', items: { type: 'string' }, description: '要核对的相对路径，如 ["03_文案/逐字稿.md"]' },
      minBytes: { type: 'number', description: '每个文件至少多少字节，默认 200' },
    },
    required: ['paths'],
  },
  async run(args, ctx) {
    const cwd = (ctx && ctx.cwd) || process.cwd();
    const minBytes = Number(args.minBytes) || 200;
    const paths = Array.isArray(args.paths) ? args.paths.map(String) : [];
    if (!paths.length) return '[错误] 至少给一个路径。';
    const lines = [];
    let fails = 0;
    for (const raw of paths) {
      const rel = raw.replace(/^[和与及、，,\s]+/, '').trim();
      const full = path.resolve(cwd, rel);
      if (!full.startsWith(path.resolve(cwd))) {
        lines.push('FAIL ' + rel + ' · 路径跑出工作目录了');
        fails++;
        continue;
      }
      if (!fs.existsSync(full)) {
        lines.push('FAIL ' + rel + ' · 不存在');
        fails++;
        continue;
      }
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        const files = [];
        walk(full, files);
        const sizes = files.map((f) => fs.statSync(f).size);
        const biggest = sizes.length ? Math.max(...sizes) : 0;
        lines.push((files.length ? 'PASS ' : 'FAIL ') + rel + ' · 目录，' + files.length + ' 个文件，最大 ' + biggest + ' 字节');
        if (!files.length) fails++;
        continue;
      }
      if (stat.size < minBytes) {
        lines.push('FAIL ' + rel + ' · 只有 ' + stat.size + ' 字节（少于 ' + minBytes + '），基本是空文件');
        fails++;
        continue;
      }
      lines.push('PASS ' + rel + ' · ' + stat.size + ' 字节');
    }
    return (fails ? '[不通过] ' + fails + ' 项有问题，先补齐再提交' : '[全部通过] 可以提交') + String.fromCharCode(10) + lines.join(String.fromCharCode(10));
  },
}];
