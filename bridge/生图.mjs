#!/usr/bin/env node
/**
 * 生图.mjs —— 命令行生图 / 图生图（给 DSH / Codex / 任何能跑命令的成员用）
 *
 * 文生图：
 *   node 生图.mjs --prompt "画面描述" --out "04_分镜插画/分镜01.png"
 *   node 生图.mjs --prompt "..." --out "a.png" --size 1536x1024
 *
 * 图生图（基于已有图片改）：
 *   node 生图.mjs --image "04_分镜插画/分镜01.png" --prompt "改成黄昏色调" --out "a.png"
 *   node 生图.mjs --image "原图.png" --prompt "..." --out "新图.png" --size 1536x1024
 *
 * 配置来源（按顺序）：
 *   1. 环境变量 IMAGE_BASE / IMAGE_KEY / IMAGE_MODEL
 *   2. ~/.workbuddy-ai/mcp-servers/avemujica-image/config.json
 *
 * 失败会自动重试 3 次。成功时把绝对路径打印到 stdout，方便调用方直接引用。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    out[name] = value;
  }
  return out;
}

function readConfig() {
  const candidates = [
    process.env.IMAGE_CONFIG,
    path.join(os.homedir(), '.workbuddy-ai', 'mcp-servers', 'avemujica-image', 'config.json'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && raw.api_key) return raw;
    } catch {}
  }
  return {};
}

const args = parseArgs(process.argv.slice(2));
if (!args.prompt) {
  console.error('缺少 --prompt');
  process.exit(2);
}
if (!args.out) {
  console.error('缺少 --out');
  process.exit(2);
}

const config = readConfig();
const rawBase = (process.env.IMAGE_BASE || config.base_url || '').replace(/\/+$/, '');
if (!rawBase) {
  console.error('没有配置生图接口地址（IMAGE_BASE 或 config.json 的 base_url）');
  process.exit(2);
}
const base = /\/v1$/i.test(rawBase) ? rawBase : rawBase + '/v1';
const key = process.env.IMAGE_KEY || config.api_key || '';
const model = args.model || process.env.IMAGE_MODEL || config.default_model || 'gpt-image-2';
const size = args.size || process.env.IMAGE_SIZE || config.default_size || '1024x1024';

const outPath = path.resolve(process.cwd(), args.out);
fs.mkdirSync(path.dirname(outPath), { recursive: true });

// --image 给了就跑图生图，否则文生图
const sourcePath = args.image ? path.resolve(process.cwd(), args.image) : null;

function pickImage(payload) {
  const item = (payload.data || [])[0];
  if (!item) throw new Error('返回里没有 data[0]：' + JSON.stringify(payload).slice(0, 300));
  return item;
}

async function download(item) {
  if (item.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (item.url) {
    const shot = await fetch(item.url, { signal: AbortSignal.timeout(300000), headers: { 'user-agent': 'workbuddy-avemujica-image/1.0' } });
    return Buffer.from(await shot.arrayBuffer());
  }
  throw new Error('返回里既没有 b64_json 也没有 url');
}

async function once() {
  const headers = { authorization: 'Bearer ' + key, 'user-agent': 'workbuddy-avemujica-image/1.0' };
  let response;
  if (sourcePath) {
    if (!fs.existsSync(sourcePath)) throw new Error('找不到要改的图：' + sourcePath);
    const source = fs.readFileSync(sourcePath);
    if (source.length > 24 * 1024 * 1024) throw new Error('原图超过 24 MB，请先缩小');
    const form = new FormData();
    form.append('model', model);
    form.append('image', new Blob([source], { type: 'image/png' }), path.basename(sourcePath));
    form.append('prompt', args.prompt);
    form.append('n', '1');
    if (size) form.append('size', size);
    response = await fetch(base + '/images/edits', {
      method: 'POST',
      signal: AbortSignal.timeout(300000),
      headers,
      body: form,
    });
  } else {
    response = await fetch(base + '/images/generations', {
      method: 'POST',
      signal: AbortSignal.timeout(300000),
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: args.prompt, n: 1, size }),
    });
  }
  if (!response.ok) throw new Error('HTTP ' + response.status + ' ' + (await response.text()).slice(0, 300));
  const blob = await download(pickImage(await response.json()));
  fs.writeFileSync(outPath, blob);
  return blob.length;
}

for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    const bytes = await once();
    console.log(outPath);
    console.error('[生图] 成功 ' + Math.round(bytes / 1024) + ' KB  ' + outPath + (sourcePath ? '（基于 ' + path.basename(sourcePath) + '）' : ''));
    process.exit(0);
  } catch (error) {
    console.error('[生图] 第 ' + attempt + '/3 次失败：' + String((error && error.message) || error).slice(0, 200));
    if (attempt === 3) {
      console.error('[生图] 放弃。');
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000 * attempt));
  }
}