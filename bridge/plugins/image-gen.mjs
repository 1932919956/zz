/**
 * image-gen.mjs — 给 API 成员加「文字生图」
 *
 * 调的是 OpenAI 兼容的图片接口（POST {IMAGE_BASE}/images/generations），
 * 生成后把图片存进会话工作目录的 generated\ 下，并把**文件路径**回给模型。
 *
 * 环境变量（写在 AIROOM 连接的环境变量里，每行一个）：
 *   IMAGE_BASE=https://api.avemujica.moe/v1   必填，网关地址
 *   IMAGE_KEY=sk-xxxx                          必填，含 KEY 会被 AIROOM 加密保存
 *   IMAGE_MODEL=gpt-image-2                    必填，图片模型 ID
 *   IMAGE_SIZE=1024x1024                       可选，默认尺寸
 *   IMAGE_DIR=generated                        可选，存到工作目录的哪个子目录
 *   IMAGE_TIMEOUT_MS=180000                    可选
 *
 * 说明：AIROOM 的 ACP 通道只能收文本，图片没法直接显示在聊天里 ——
 * 所以这里存成文件并给出路径，你在「项目文件」里就能打开。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const title = '图片生成';

/** 没配环境变量时，自动读 WorkBuddy 那个生图 MCP 的 config.json —— 省得你再填一遍 key。 */
function readMcpConfig() {
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
const MCP = readMcpConfig();

// base_url 可能带 /v1 也可能不带，统一补成 «…/v1» 结尾
const BASE = (() => {
  const raw = (process.env.IMAGE_BASE || MCP.base_url || '').replace(/\/+$/, '');
  if (!raw) return '';
  return /\/v1$/i.test(raw) ? raw : raw + '/v1';
})();
const KEY = process.env.IMAGE_KEY || MCP.api_key || '';
const MODEL = process.env.IMAGE_MODEL || MCP.default_model || '';
const SIZE = process.env.IMAGE_SIZE || MCP.default_size || '';
const DIR = process.env.IMAGE_DIR || 'generated';
const TIMEOUT = Number(process.env.IMAGE_TIMEOUT_MS || 180000);

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function safeName(text) {
  return String(text || '').replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 40) || 'image';
}

async function saveImage(cwd, bytes, suggested) {
  const dir = path.join(cwd, DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, stamp() + '-' + safeName(suggested) + '.png');
  fs.writeFileSync(file, bytes);
  return file;
}

export const tools = [{
  name: 'generate_image',
  description: '按文字描述生成一张图片（会真的调用生图接口，保存成 png 并返回路径）。'
    + '需要画图、出插画、做角色三视图时用它，不要自己写脚本调接口。',
  // 归为联网类：AIROOM 的只读会话（会议室/聊天室）只放行 read/search/think/fetch。
  // 生图只是"联网取回一张图存到自己目录"，不改项目文件，所以按 fetch 归类，
  // 这样成员在任何场景都能画图，不必先切到工位。
  kind: 'fetch',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '图片描述，越具体越好' },
      size: { type: 'string', description: '尺寸，例如 1024x1024；不填用默认' },
      name: { type: 'string', description: '可选，文件名里用的短标题' },
    },
    required: ['prompt'],
  },
  async run(args, ctx) {
    if (!BASE || !KEY || !MODEL) {
      return '[未配置] 请在这个连接的环境变量里填 IMAGE_BASE、IMAGE_KEY、IMAGE_MODEL。';
    }
    const prompt = String(args.prompt || '').trim();
    if (!prompt) return '[错误] 要给 prompt。';

    const body = { model: MODEL, prompt, n: 1 };
    const size = String(args.size || SIZE || '').trim();
    if (size) body.size = size;

    let res;
    try {
      res = await fetch(BASE + '/images/generations', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + KEY,
          // Cloudflare 会拦掉默认 UA（403 / error code 1010），必须带上这个
          'user-agent': 'workbuddy-avemujica-image/1.0',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT),
      });
    } catch (error) {
      return '[生成失败] 连不上接口：' + String((error && error.message) || error);
    }

    const raw = await res.text().catch(() => '');
    let payload = null;
    try { payload = JSON.parse(raw); } catch {}
    if (/^\s*</.test(raw)) {
      return '[生成失败] 接口返回的是网页而不是 JSON（多半是地址少写或多了 /v1，或者被网关拦了）。\n'
        + '当前请求地址：' + BASE + '/images/generations\n'
        + '前 200 字：' + raw.slice(0, 200);
    }
    if (!res.ok) {
      return '[生成失败] HTTP ' + res.status + '  ' + raw.slice(0, 400)
        + '\n（如果是 Invalid token，检查 IMAGE_KEY；如果是 model not found，核对 IMAGE_MODEL 的精确 ID。）';
    }

    const item = payload && Array.isArray(payload.data) ? payload.data[0] : null;
    if (!item) {
      return '[生成失败] 返回里没有 data[0]：' + raw.slice(0, 400);
    }

    let bytes = null;
    if (typeof item.b64_json === 'string' && item.b64_json) {
      bytes = Buffer.from(item.b64_json, 'base64');
    } else if (typeof item.url === 'string' && item.url) {
      try {
        const shot = await fetch(item.url, {
          signal: AbortSignal.timeout(TIMEOUT),
          headers: { 'user-agent': 'workbuddy-avemujica-image/1.0' },
        });
        if (!shot.ok) return '[生成失败] 图片下载失败 HTTP ' + shot.status;
        bytes = Buffer.from(await shot.arrayBuffer());
      } catch (error) {
        return '[生成失败] 图片下载出错：' + String((error && error.message) || error);
      }
    }
    if (!bytes || !bytes.length) return '[生成失败] 既没有 b64_json 也没有可用的 url：' + raw.slice(0, 300);

    const file = await saveImage(ctx.cwd || process.cwd(), bytes, args.name || prompt.slice(0, 20));
    ctx.log('生图完成 ' + bytes.length + ' 字节 -> ' + file);
    return '[成功] 图片已保存：' + file + '（' + Math.round(bytes.length / 1024) + ' KB）\n'
      + '你可以直接用图片查看器打开这个路径。';
  },
}, {
  name: 'edit_image',
  description: '在已有图片上改（图生图）：给一张图的路径 + 改法描述，返回新图路径。'
    + '适合"把色调改成黄昏""给这个角色加顶帽子""把这张的分辨率放大后重绘局部"这类。'
    + '和 generate_image 的区别：那个是从零画，这个是基于你给的图改。',
  kind: 'fetch',
  parameters: {
    type: 'object',
    properties: {
      image: { type: 'string', description: '要改的图片路径（绝对路径，或相对工作目录的路径）' },
      prompt: { type: 'string', description: '怎么改，越具体越好' },
      size: { type: 'string', description: '输出尺寸，例如 1536x1024；不填由接口决定' },
      name: { type: 'string', description: '可选，文件名里用的短标题' },
    },
    required: ['image', 'prompt'],
  },
  async run(args, ctx) {
    if (!BASE || !KEY || !MODEL) {
      return '[未配置] 请在这个连接的环境变量里填 IMAGE_BASE、IMAGE_KEY、IMAGE_MODEL。';
    }
    const prompt = String(args.prompt || '').trim();
    if (!prompt) return '[错误] 要给 prompt（怎么改）。';
    const rawPath = String(args.image || '').trim();
    if (!rawPath) return '[错误] 要给 image（要改的那张图的路径）。';
    const cwd = ctx.cwd || process.cwd();
    const resolved = path.isAbsolute(rawPath) ? rawPath : path.join(cwd, rawPath);

    let source;
    try { source = await fs.promises.readFile(resolved); } catch {
      return '[错误] 读不到这张图：' + resolved;
    }
    if (source.length > 24 * 1024 * 1024) {
      return '[错误] 原图超过 24 MB，请先缩小再传。';
    }

    const form = new FormData();
    form.append('model', MODEL);
    form.append('image', new Blob([source], { type: 'image/png' }), path.basename(resolved));
    form.append('prompt', prompt);
    form.append('n', '1');
    const size = String(args.size || '').trim();
    if (size) form.append('size', size);

    let res;
    try {
      res = await fetch(BASE + '/images/edits', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + KEY,
          'user-agent': 'workbuddy-avemujica-image/1.0',
        },
        body: form,
        signal: AbortSignal.timeout(TIMEOUT),
      });
    } catch (error) {
      return '[改图失败] 连不上接口：' + String((error && error.message) || error);
    }

    const raw = await res.text();
    if (!res.ok) return '[改图失败] HTTP ' + res.status + ' ' + raw.slice(0, 400);

    let payload = null;
    try { payload = JSON.parse(raw); } catch { return '[改图失败] 返回不是 JSON：' + raw.slice(0, 300); }
    const item = payload && Array.isArray(payload.data) ? payload.data[0] : null;
    if (!item) return '[改图失败] 返回里没有 data[0]：' + raw.slice(0, 400);

    let bytes = null;
    if (typeof item.b64_json === 'string' && item.b64_json) {
      bytes = Buffer.from(item.b64_json, 'base64');
    } else if (typeof item.url === 'string' && item.url) {
      try {
        const shot = await fetch(item.url, {
          signal: AbortSignal.timeout(TIMEOUT),
          headers: { 'user-agent': 'workbuddy-avemujica-image/1.0' },
        });
        if (!shot.ok) return '[改图失败] 图片下载失败 HTTP ' + shot.status;
        bytes = Buffer.from(await shot.arrayBuffer());
      } catch (error) {
        return '[改图失败] 图片下载出错：' + String((error && error.message) || error);
      }
    }
    if (!bytes || !bytes.length) return '[改图失败] 既没有 b64_json 也没有可用的 url。';

    const file = await saveImage(ctx.cwd || process.cwd(), bytes, args.name || ('改图-' + prompt.slice(0, 16)));
    ctx.log('改图完成 ' + bytes.length + ' 字节 -> ' + file);
    return '[成功] 已按你的描述改好，新图保存在：' + file
      + '（' + Math.round(bytes.length / 1024) + ' KB，原图 ' + Math.round(source.length / 1024) + ' KB）';
  },
}];
