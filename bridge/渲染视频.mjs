#!/usr/bin/env node
/**
 * 渲染视频.mjs —— 把分镜图 + 字幕合成 mp4（给 AIROOM 成员用，确定性、不依赖浏览器）
 *
 * 用法：
 *   node 渲染视频.mjs --images "04_分镜插画" --out "07_成片/分镜动画.mp4"
 *   node 渲染视频.mjs --images "04_分镜插画" --out out.mp4 --seconds 10 --width 1920 --height 1080
 *   node 渲染视频.mjs --images "04_分镜插画" --out out.mp4 --subs "07_成片/字幕.ass"
 *
 * 为什么不用 player.html 截图：headless 截图时图片常常还没加载完，
 * 结果录出来是黑屏配字幕（本项目已经踩过一次）。ffmpeg 直接合成最可靠。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const name = argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    out[name] = value;
  }
  return out;
}

function findFfmpeg() {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, exe);
    if (fs.existsSync(candidate)) return candidate;
  }
  const guesses = [
    path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', exe),
    path.join(os.homedir(), '.workbuddy-ai', 'binaries', 'ffmpeg', exe),
    'C:\\ffmpeg\\bin\\' + exe,
  ];
  for (const guess of guesses) if (fs.existsSync(guess)) return guess;
  return '';
}

const args = parseArgs(process.argv.slice(2));
const imageDir = path.resolve(process.cwd(), args.images || '04_分镜插画');
const outFile = path.resolve(process.cwd(), args.out || '07_成片/分镜动画.mp4');
const seconds = Number(args.seconds || 10);
const width = Number(args.width || 1920);
const height = Number(args.height || 1080);
const fps = Number(args.fps || 30);
const crf = Number(args.crf || 20);

if (!fs.existsSync(imageDir)) { console.error('图片目录不存在：' + imageDir); process.exit(2); }
const images = fs.readdirSync(imageDir)
  .filter((n) => /\.(png|jpe?g|webp)$/i.test(n))
  .filter((n) => /分镜\d+/.test(n))
  .sort((a, b) => {
    const na = Number((a.match(/分镜(\d+)/) || [])[1] || 0);
    const nb = Number((b.match(/分镜(\d+)/) || [])[1] || 0);
    return na - nb;
  });
if (!images.length) { console.error('没找到「分镜NN_*.png」这样的图片'); process.exit(2); }
console.log('找到 ' + images.length + ' 张分镜图');

const ffmpeg = findFfmpeg();
if (!ffmpeg) { console.error('没找到 ffmpeg'); process.exit(2); }

const frames = Math.max(1, Math.round(seconds * fps));
// 每张图只喂「一帧」，时长完全交给 zoompan 的 d 参数控制。
// 如果这里用 -loop 1 -t N，会得到 N*fps 帧，再被 zoompan 展开一次，时长就爆炸了。
const inputs = [];
for (const name of images) inputs.push('-i', path.join(imageDir, name));

const filters = [];
images.forEach((_, i) => {
  // 缓慢推近（1.00 → 1.06），给静态插画一点"活着"的感觉
  filters.push('[' + i + ':v]scale=' + width + ':' + height + ':force_original_aspect_ratio=increase,'
    + 'crop=' + width + ':' + height + ',setsar=1,'
    + "zoompan=z='min(zoom+0.0006,1.06)':d=" + frames + ':s=' + width + 'x' + height + ':fps=' + fps
    + '[v' + i + ']');
});
filters.push(images.map((_, i) => '[v' + i + ']').join('') + 'concat=n=' + images.length + ':v=1:a=0[vout]');

// 这个 ffmpeg 版本没有 -filter_complex_script，直接内联（21 个输入的滤镜串约 5KB，命令行放得下）
const filterGraph = filters.join(';');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const outArgs = [
  '-y', ...inputs,
  '-filter_complex', filterGraph,
  '-map', '[vout]',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p',
  '-r', String(fps), '-movflags', '+faststart',
  outFile,
];

console.log('开始渲染：' + images.length + ' 张 x ' + seconds + ' 秒 = ' + (images.length * seconds) + ' 秒');
const started = Date.now();
try {
  execFileSync(ffmpeg, outArgs, { stdio: 'inherit', timeout: 60 * 60 * 1000 });
} catch (error) {
  console.error('渲染失败：' + String((error && error.message) || error).slice(0, 400));
  process.exit(1);
}
const size = fs.statSync(outFile).size;
console.error('[渲染] 完成 ' + Math.round(size / 1024 / 1024) + ' MB  ' + Math.round((Date.now() - started) / 1000) + ' 秒  ' + outFile);
console.log(outFile);