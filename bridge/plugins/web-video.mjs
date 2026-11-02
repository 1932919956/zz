/**
 * web-video.mjs — 让成员"看"网页视频
 *
 * 直链（mp4/m3u8）直接 ffmpeg 抽帧；B站/YouTube 这类页面先用 yt-dlp 解析出真实流。
 * 只抽帧看图，不下载整片、不转写声音。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const title = '网页视频';

const run = promisify(execFile);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';
const PAGE = /bilibili\.com|b23\.tv|youtube\.com|youtu\.be|douyin\.com|ixigua\.com|v\.qq\.com|youku\.com|weibo\.com/i;

async function capture(command, args, timeoutMs = 120000) {
  try {
    const result = await run(command, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: timeoutMs });
    return { ok: true, out: (result.stdout || '') + (result.stderr || '') };
  } catch (error) {
    return { ok: false, out: (error.stdout || '') + (error.stderr || '') + (error.message || '') };
  }
}

function jsonLine(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try { return JSON.parse(trimmed); } catch {}
  }
  return null;
}

const YT_CANDIDATES = [
  ['yt-dlp'],
  ['python', '-m', 'yt_dlp'],
  ['py', '-m', 'yt_dlp'],
  ['C:\\Users\\<你的用户名>\\AppData\\Local\\Programs\\Python\\Python311\\python.exe', '-m', 'yt_dlp'],
];

async function ytdlp(args) {
  for (const [command, ...prefix] of YT_CANDIDATES) {
    const result = await capture(command, [...prefix, ...args], 150000);
    if (result.ok && !/No module named|not recognized/i.test(result.out)) return result;
  }
  return { ok: false, out: 'yt-dlp 不可用（没装或不在 PATH）' };
}

async function probeDuration(stream) {
  const args = ['-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=width,height', '-of', 'json'];
  for (const extra of [['-user_agent', UA, '-headers', 'Referer: https://www.bilibili.com/\r\n'], []]) {
    const r = await capture('ffprobe', [...args, ...extra, stream], 60000);
    const j = jsonLine(r.out) || {};
    const v = (j.streams || []).find((s) => s.width);
    if (j.format && j.format.duration) return { duration: Number(j.format.duration) || null, width: v && v.width, height: v && v.height };
  }
  return { duration: null, width: null, height: null };
}

export const tools = [{
  name: 'video_frames',
  description: '看一个网页视频：直链或 B站/YouTube 页面都行。抽 1–4 张关键帧存到 .work，返回路径和时长/分辨率——然后用 read_file 逐张看。只抽帧，不下载整片、不转写声音。',
  kind: 'fetch',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '视频直链（mp4/m3u8）或页面链接（B站 BV 号 / YouTube）' },
      frames: { type: 'number', description: '抽几张，1–4，默认 3' },
      start: { type: 'number', description: '从第几秒开始抽，默认 0' },
    },
    required: ['url'],
  },
  async run(args, ctx) {
    const url = String(args.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return '[错误] 要给 http(s) 链接。';
    const count = Math.max(1, Math.min(4, Number(args.frames) || 3));
    const startAt = Math.max(0, Number(args.start) || 0);
    const cwd = (ctx && ctx.cwd) || process.cwd();
    const outDir = path.resolve(cwd, '.work', 'webvideo', crypto.createHash('md5').update(url).digest('hex').slice(0, 8));
    fs.mkdirSync(outDir, { recursive: true });

    let stream = url, title = null, duration = null, source = 'direct';
    if (PAGE.test(url)) {
      source = 'page';
      const meta = await ytdlp(['--no-warnings', '--no-playlist', '-J', url]);
      const info = meta.ok ? jsonLine(meta.out) : null;
      if (info) { title = info.title; duration = info.duration; }
      const g = await ytdlp(['--no-warnings', '--no-playlist', '-g', '-f', 'bv*[height<=720]/b[height<=720]/b', url]);
      const urls = g.out.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^https?:/.test(s));
      if (!urls.length) return '[错误] 解析失败（可能需要登录或视频受限）：' + String(g.out).slice(0, 300);
      stream = urls[0];
    }

    const probed = await probeDuration(stream);
    duration = duration || probed.duration;
    const total = duration || 60;
    const base = startAt > 0 ? startAt : total * 0.06;
    const span = Math.max(1, (startAt > 0 ? Math.min(total - startAt, 30) : total * 0.88));
    const files = [];
    for (let i = 0; i < count; i++) {
      const t = Math.min(total - 1, base + (span * i) / Math.max(1, count - 1) * (count === 1 ? 0 : 1));
      const file = path.join(outDir, 'f' + (i + 1) + '.jpg');
      const r = await capture('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.max(0, t)),
        '-i', stream, '-frames:v', '1', '-vf', 'scale=960:-2', '-user_agent', UA,
        '-headers', 'Referer: https://www.bilibili.com/\r\n', file], 120000);
      if (r.ok && fs.existsSync(file) && fs.statSync(file).size > 1000) files.push(file);
    }
    if (!files.length) return '[错误] 抽帧失败（视频可能需要登录，或链接不是视频页）。';
    return JSON.stringify({
      source, title, duration: duration ? Math.round(duration) : null,
      resolution: probed.width && probed.height ? probed.width + 'x' + probed.height : null,
      frames: files,
      hint: '用 read_file 逐张看这些 jpg，再回答视频讲了什么/画面什么风格。',
    });
  },
}];
