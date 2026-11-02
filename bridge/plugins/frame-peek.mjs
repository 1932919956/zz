/**
 * frame-peek.mjs — 让成员"看"片子和图片
 *
 * 为什么：以前验收只看 exit code 和参数，17 段里 16 段只有一个角色、
 * 人物被裁头，脚本全过。脚本量不出"好不好看"，只有看图才知道。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

export const title = '抽帧看图';

const run = promisify(execFile);

async function capture(cmd, args) {
  try {
    const r = await run(cmd, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    return { ok: true, out: (r.stdout || '') + (r.stderr || '') };
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || '') + e.message };
  }
}

export const tools = [{
  name: 'sample_frames',
  description: '抽帧：从视频里按时间点抽出 N 张关键帧（默认 6 张），返回绝对路径。拿到路径后必须用 read_file 逐张看，再描述你看到了什么——不要只看脚本输出。',
  kind: 'fetch',
  parameters: {
    type: 'object',
    properties: {
      video: { type: 'string', description: '视频相对/绝对路径' },
      count: { type: 'number', description: '抽几张，1–8，默认 6' },
    },
    required: ['video'],
  },
  async run(args, ctx) {
    const cwd = (ctx && ctx.cwd) || process.cwd();
    const video = path.resolve(cwd, String(args.video || ''));
    if (!fs.existsSync(video)) return '[错误] 找不到视频：' + video;
    const count = Math.max(1, Math.min(8, Number(args.count) || 6));
    const probe = await capture('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video]);
    const dur = Number(String(probe.out).trim()) || 0;
    if (!dur) return '[错误] 读不出时长：' + String(probe.out).slice(0, 150);
    const outDir = path.join(path.dirname(video), '.work', 'frames');
    fs.mkdirSync(outDir, { recursive: true });
    const files = [];
    for (let i = 0; i < count; i++) {
      const t = dur * (i + 0.5) / count;
      const f = path.join(outDir, 'f' + (i + 1) + '.jpg');
      const r = await capture('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(t.toFixed(2)), '-i', video, '-frames:v', '1', '-vf', 'scale=960:-2', f]);
      if (r.ok && fs.existsSync(f) && fs.statSync(f).size > 1000) files.push({ at: Number(t.toFixed(1)), path: f });
    }
    if (!files.length) return '[错误] 抽帧失败。';
    return JSON.stringify({
      duration: dur,
      frames: files,
      hint: '用 read_file 逐张打开这些图，然后逐帧写清：画面里有什么、几个角色、人物占画面多大、有没有被裁切、道具是否挡住人脸。只报脚本结果不算看过。',
    });
  },
}];
