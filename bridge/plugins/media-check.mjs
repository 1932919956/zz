/**
 * media-check.mjs — 让成员在交付前自己体检视频/音频
 *
 * 为什么要有它：AIROOM 的验收标准过去只看「文件存在、分辨率对、不是黑屏」，
 * 于是「17 张图各 14 秒、字幕压着画面里的字、响度只有 -23.7 LUFS」的片子也能过。
 * 这个插件把「节奏、响度、静音、音画时长」变成成员交付前能自己看到的数字。
 *
 * 只读，不修改任何文件（除非你让它出接触表）。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

export const title = '视频体检';

const run = promisify(execFile);
const LF = String.fromCharCode(10);

async function capture(command, args) {
  try {
    const result = await run(command, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    return { text: (result.stdout || '') + (result.stderr || ''), code: 0 };
  } catch (error) {
    return { text: (error.stdout || '') + (error.stderr || '') + (error.message || ''), code: error.code || 1 };
  }
}

function round(value, digits = 1) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function stdev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

async function probe(file) {
  const result = await capture('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  try {
    return JSON.parse(result.text.slice(result.text.indexOf('{')));
  } catch {
    return undefined;
  }
}

async function cuts(file) {
  const result = await capture('ffmpeg', ['-hide_banner', '-i', file, '-vf', "select='gt(scene,0.2)',showinfo", '-an', '-f', 'null', '-']);
  const times = [...result.text.matchAll(/pts_time:([0-9.]+)/g)].map((match) => Number(match[1]));
  return [...new Set(times)].sort((a, b) => a - b);
}

async function loudness(file) {
  const result = await capture('ffmpeg', ['-hide_banner', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-']);
  const points = [...result.text.matchAll(/I:\s*(-?[0-9.]+)\s*LUFS/g)];
  return points.length ? Number(points[points.length - 1][1]) : null;
}

async function silences(file) {
  const result = await capture('ffmpeg', ['-hide_banner', '-i', file, '-af', 'silencedetect=noise=-40dB:d=3', '-f', 'null', '-']);
  const starts = [...result.text.matchAll(/silence_start:\s*(-?[0-9.]+)/g)].length;
  return starts;
}

async function contactSheet(file, seconds) {
  const target = file.replace(/\.[^.]+$/, '') + '.contact.jpg';
  const step = Math.max(1, Math.round(seconds / 12));
  const result = await capture('ffmpeg', ['-hide_banner', '-y', '-i', file, '-vf', 'fps=1/' + step + ',scale=480:-1,tile=4x3', '-frames:v', '1', target]);
  return result.code === 0 ? target : undefined;
}

function verdicts(report) {
  const notes = [];
  if (!report.video) notes.push({ level: 'fail', text: '没有视频轨。' });
  if (!report.audio) notes.push({ level: 'fail', text: '没有音频轨；成片至少要有台词或音乐。' });
  if (report.video && report.audio && report.shotCount > 2) {
    if (report.shotSpread < 1) notes.push({ level: 'fail', text: '所有镜头时长几乎一样（标准差 ' + report.shotSpread + ' 秒），看起来会像幻灯片。镜头时长要跟内容走。' });
    else if (report.shotSpread < 2) notes.push({ level: 'warn', text: '镜头时长变化偏小（标准差 ' + report.shotSpread + ' 秒），节奏可能偏平。' });
  }
  if (report.loudness !== null) {
    if (report.loudness > -12) notes.push({ level: 'warn', text: '响度 ' + report.loudness + ' LUFS 偏大，可能削波。' });
    else if (report.loudness < -20) notes.push({ level: 'fail', text: '响度 ' + report.loudness + ' LUFS 偏轻（网络视频通常 -16 LUFS），观众要开大音量。' });
  }
  if (report.silences > 0) notes.push({ level: 'warn', text: '有 ' + report.silences + ' 段超过 3 秒的静音。' });
  if (report.video && report.width >= 1920 && report.videoBitrate && report.videoBitrate < 1500000) notes.push({ level: 'warn', text: '视频码率 ' + Math.round(report.videoBitrate / 1000) + ' kbps 偏低（1080p 建议 3 Mbps 以上）。' });
  return notes;
}

export const tools = [{
  name: 'check_media',
  description: '体检一个视频/音频文件：时长、分辨率、镜头切点与节奏、响度、静音段，并给出可执行的修改建议。交付成片前先跑一遍，把结果一起提交。',
  kind: 'fetch',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要检查的文件路径（绝对路径，或相对工作目录）' },
      sheet: { type: 'boolean', description: '是否顺便输出一张 12 帧接触表（.contact.jpg），方便自己和评审一次看全片节奏' },
    },
    required: ['path'],
  },
  async run(args, ctx) {
    const raw = String(args.path || '').trim();
    if (!raw) return '[错误] 要给 path。';
    const file = path.isAbsolute(raw) ? raw : path.join(ctx.cwd || process.cwd(), raw);
    if (!fs.existsSync(file)) return '[错误] 文件不存在：' + file;

    const info = await probe(file);
    if (!info) return '[错误] ffprobe 读不出这个文件，确认路径和格式。';
    const streams = info.streams || [];
    const videoStream = streams.find((stream) => stream.codec_type === 'video');
    const audioStream = streams.find((stream) => stream.codec_type === 'audio');
    const duration = Number(info.format && info.format.duration) || 0;

    const shotTimes = videoStream ? await cuts(file) : [];
    const boundaries = [0, ...shotTimes.filter((time) => time > 0.05 && time < duration - 0.05), duration];
    const lengths = boundaries.slice(1).map((time, index) => time - boundaries[index]).filter((value) => value > 0.05);
    const spread = round(stdev(lengths), 2);

    const report = {
      file,
      duration: round(duration, 1),
      width: videoStream ? videoStream.width : null,
      height: videoStream ? videoStream.height : null,
      fps: videoStream ? round(Number(String(videoStream.r_frame_rate || '0/1').split('/')[0]) / Number(String(videoStream.r_frame_rate || '0/1').split('/')[1] || 1), 2) : null,
      videoBitrate: Number(videoStream && videoStream.bit_rate) || Number(info.format && info.format.bit_rate) || null,
      audio: Boolean(audioStream),
      video: Boolean(videoStream),
      shotCount: lengths.length,
      shotSpread: spread,
      shortest: round(Math.min(...lengths), 2),
      longest: round(Math.max(...lengths), 2),
      loudness: audioStream ? await loudness(file) : null,
      silences: audioStream ? await silences(file) : 0,
    };

    const notes = verdicts(report);
    let sheetPath;
    if (args.sheet && videoStream) sheetPath = await contactSheet(file, duration);

    const lines = [
      '【' + path.basename(file) + '】',
      '时长 ' + report.duration + ' 秒 · ' + (report.video ? report.width + 'x' + report.height + ' @' + report.fps + 'fps' : '无视频') + ' · 音频 ' + (report.audio ? '有' : '无'),
      report.video ? '镜头 ' + report.shotCount + ' 个：最短 ' + report.shortest + ' 秒 / 最长 ' + report.longest + ' 秒 / 标准差 ' + report.shotSpread + (spread < 1 ? '（几乎等长，像幻灯片）' : '') : '',
      '响度 ' + (report.loudness === null ? '读不出' : report.loudness + ' LUFS（网络视频常用 -16）'),
      '超过 3 秒的静音：' + report.silences + ' 段',
    ].filter(Boolean);
    if (sheetPath) lines.push('接触表：' + sheetPath);
    lines.push('');
    if (!notes.length) lines.push('体检通过：没有发现节奏、响度或音轨问题。');
    else {
      lines.push('需要处理：');
      for (const note of notes) lines.push((note.level === 'fail' ? '✗ ' : '! ') + note.text);
    }
    return lines.join(LF);
  },
}];
