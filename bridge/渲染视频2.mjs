#!/usr/bin/env node
// 渲染视频2.mjs —— 分镜图 -> 有运镜/转场/灯效/配音/配乐/字幕 的成片
// 用法: node 渲染视频2.mjs --images <目录> --out <成片.mp4> [选项]
//   --seconds 10        默认每镜秒数
//   --subs 字幕.ass     烧录字幕
//   --voice 配音.mp3    配音
//   --music 配乐.mp3    配乐(自动循环并压到 -22dB)
//   --config 分镜.json  每镜单独配置(见下), 不给则自动轮换运镜与转场
//   --width 1920 --height 1080 --fps 30 --xfade 0.6 --music-db -22
//
// 分镜.json:
// {"shots":[{"file":"分镜01.png","seconds":14,"move":"zoom-in","transition":"wipeleft","lamp":"on"}]}

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined ? fallback : v;
}

const IMAGES = arg('images', '');
const OUT = arg('out', '');
const SECONDS = Number(arg('seconds', '10'));
const SUBS = arg('subs', '');
const VOICE = arg('voice', '');
const MUSIC = arg('music', '');
const CONFIG = arg('config', '');
const WIDTH = Number(arg('width', '1920'));
const HEIGHT = Number(arg('height', '1080'));
const FPS = Number(arg('fps', '30'));
const XFADE = Number(arg('xfade', '0.6'));
const MUSIC_DB = arg('music-db', '-22');

if (!IMAGES || !OUT) {
  console.error('[错误] 必须给 --images 和 --out');
  process.exit(2);
}

// 运镜: d = 总帧数. on = 当前帧号
const MOVES = {
  'static':       (d) => "zoompan=z='1.0':x='0':y='0':d=" + d + ':s=' + WIDTH + 'x' + HEIGHT,
  'zoom-in':      (d) => "zoompan=z='min(1+0.0012*on,1.12)':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=" + d + ':s=' + WIDTH + 'x' + HEIGHT,
  'zoom-in-slow': (d) => "zoompan=z='min(1+0.0006*on,1.07)':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=" + d + ':s=' + WIDTH + 'x' + HEIGHT,
  'zoom-out':     (d) => "zoompan=z='max(1.12-0.0012*on,1.0)':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=" + d + ':s=' + WIDTH + 'x' + HEIGHT,
  'pan-left':     (d) => "zoompan=z='1.10':x='(iw-iw/zoom)*(1-on/" + d + ")':y='(ih-ih/zoom)/2':d=" + d + ':s=' + WIDTH + 'x' + HEIGHT,
  'pan-right':    (d) => "zoompan=z='1.10':x='(iw-iw/zoom)*(on/" + d + ")':y='(ih-ih/zoom)/2':d=" + d + ':s=' + WIDTH + 'x' + HEIGHT,
  'pan-up':       (d) => "zoompan=z='1.10':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)*(1-on/" + d + ")':d=" + d + ':s=' + WIDTH + 'x' + HEIGHT,
  'pan-down':     (d) => "zoompan=z='1.10':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)*(on/" + d + ")':d=" + d + ':s=' + WIDTH + 'x' + HEIGHT,
  'diag-tl':      (d) => "zoompan=z='1.10':x='(iw-iw/zoom)*(1-on/" + d + ")':y='(ih-ih/zoom)*(1-on/" + d + ")':d=" + d + ':s=' + WIDTH + 'x' + HEIGHT,
  'diag-br':      (d) => "zoompan=z='1.10':x='(iw-iw/zoom)*(on/" + d + ")':y='(ih-ih/zoom)*(on/" + d + ")':d=" + d + ':s=' + WIDTH + 'x' + HEIGHT,
  'kenburns':     (d) => "zoompan=z='min(1+0.0010*on,1.10)':x='(iw-iw/zoom)*(on/" + d + ")':y='(ih-ih/zoom)*0.5':d=" + d + ':s=' + WIDTH + 'x' + HEIGHT,
  'shake':        (d) => "zoompan=z='1.06':x='(iw-iw/zoom)/2+8*sin(on/4)':y='(ih-ih/zoom)/2+6*cos(on/5)':d=" + d + ':s=' + WIDTH + 'x' + HEIGHT,
};

const MOVE_KEYS = Object.keys(MOVES);

const TRANSITIONS = [
  'fade', 'fadeblack', 'fadewhite', 'fadegrays',
  'wipeleft', 'wiperight', 'wipeup', 'wipedown',
  'slideleft', 'slideright', 'slideup', 'slidedown',
  'circleopen', 'circleclose', 'dissolve', 'pixelize',
  'radial', 'hblur', 'smoothleft', 'smoothup',
];

function lampEffect(kind, seconds) {
  if (kind === 'on')
    return "eq=brightness='if(between(t,0,0.4),-0.5*(t/0.4),if(between(t,0.4,0.8),-0.5+0.5*((t-0.4)/0.4),0))'";
  if (kind === 'fade-in')
    return "eq=brightness='if(lt(t,0.6),-0.6+0.6*(t/0.6),0)'";
  if (kind === 'fade-out') {
    const s = Math.max(0, seconds - 0.8);
    return "eq=brightness='if(gt(t," + s + "),-0.7*((t-" + s + ")/0.8),0)'";
  }
  return null;
}

function listImages(dir) {
  return fs.readdirSync(dir)
    .filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

function loadShots(dir) {
  let shots;
  if (CONFIG && fs.existsSync(CONFIG)) {
    const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    shots = (cfg.shots || []).map((s) => ({
      file: path.isAbsolute(s.file) ? s.file : path.join(dir, s.file),
      seconds: Number(s.seconds || SECONDS),
      move: s.move || null,
      transition: s.transition || null,
      lamp: s.lamp || null,
    }));
    console.log('  用配置文件 ' + CONFIG + ' (' + shots.length + ' 镜)');
  } else {
    shots = listImages(dir).map((f) => ({ file: f, seconds: SECONDS, move: null, transition: null, lamp: null }));
  }
  shots.forEach((s, i) => {
    if (!s.move) s.move = MOVE_KEYS[i % MOVE_KEYS.length];
    if (!s.transition) s.transition = TRANSITIONS[i % TRANSITIONS.length];
  });
  return shots;
}

async function main() {
  const shots = loadShots(IMAGES);
  if (!shots.length) { console.error('[错误] 目录里没有图片: ' + IMAGES); process.exit(2); }
  for (const s of shots) if (!fs.existsSync(s.file)) { console.error('[错误] 图片不存在: ' + s.file); process.exit(2); }

  console.log('  共 ' + shots.length + ' 镜, 目标 ' + WIDTH + 'x' + HEIGHT + ' @' + FPS + 'fps');
  shots.forEach((s) => console.log('    ' + path.basename(s.file) + '  ' + s.seconds + 's  ' + s.move + '  -> ' + s.transition + (s.lamp ? '  [' + s.lamp + ']' : '')));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'render2-'));
  const parts = [];

  for (let i = 0; i < shots.length; i++) {
    const s = shots[i];
    const d = Math.max(1, Math.round(s.seconds * FPS));
    const out = path.join(tmp, 'p' + String(i).padStart(3, '0') + '.mp4');
    const filters = [
      'scale=' + WIDTH + ':' + HEIGHT + ':force_original_aspect_ratio=increase',
      'crop=' + WIDTH + ':' + HEIGHT,
      MOVES[s.move] ? MOVES[s.move](d) : MOVES['zoom-in-slow'](d),
      'format=yuv420p',
    ];
    const lamp = s.lamp ? lampEffect(s.lamp, s.seconds) : null;
    if (lamp) filters.push(lamp);
    await run('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-loop', '1', '-t', String(s.seconds), '-i', s.file,
      '-vf', filters.join(','),
      '-r', String(FPS), '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
      '-pix_fmt', 'yuv420p', out,
    ], { maxBuffer: 64 * 1024 * 1024 });
    parts.push(out);
    console.log('  [' + (i + 1) + '/' + shots.length + '] ' + path.basename(s.file));
  }

  const merged = path.join(tmp, 'merged.mp4');
  const dur = Math.min(XFADE, Math.max(0.2, shots[0].seconds * 0.4));

  if (parts.length === 1) {
    fs.copyFileSync(parts[0], merged);
  } else {
    const args = [];
    for (const p of parts) args.push('-i', p);
    let filter = '';
    let offset = shots[0].seconds;
    filter += '[0:v][1:v]xfade=transition=' + shots[0].transition + ':duration=' + dur + ':offset=' + (offset - dur) + '[v1]';
    let last = 'v1';
    for (let i = 2; i < parts.length; i++) {
      offset = offset - dur + shots[i - 1].seconds;
      const label = 'v' + i;
      filter += ';[' + last + '][' + i + ':v]xfade=transition=' + shots[i - 1].transition + ':duration=' + dur + ':offset=' + (offset - dur) + '[' + label + ']';
      last = label;
    }
    await run('ffmpeg', [
      '-y', '-loglevel', 'error', ...args,
      '-filter_complex', filter, '-map', '[' + last + ']',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-r', String(FPS), merged,
    ], { maxBuffer: 128 * 1024 * 1024 });
  }

  const total = shots.reduce((a, s) => a + s.seconds, 0) - dur * Math.max(0, parts.length - 1);
  console.log('  合并完成, 时长约 ' + total.toFixed(1) + ' 秒');

  const audioInputs = [];
  if (VOICE && fs.existsSync(VOICE)) audioInputs.push(['-i', VOICE]);
  if (MUSIC && fs.existsSync(MUSIC)) audioInputs.push(['-stream_loop', '-1', '-i', MUSIC]);

  const vfilter = [];
  if (SUBS && fs.existsSync(SUBS)) {
    const p = SUBS.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    vfilter.push("ass='" + p + "'");
  }

  if (!audioInputs.length && !vfilter.length) {
    fs.copyFileSync(merged, OUT);
    console.log('  OK 成片(无声无字幕): ' + OUT);
    return;
  }

  const fc = [];
  if (audioInputs.length === 2) {
    fc.push('[1:a]volume=1.0[voice]');
    fc.push('[2:a]volume=' + MUSIC_DB + 'dB[music]');
    fc.push('[voice][music]amix=inputs=2:duration=first:dropout_transition=0[aout]');
  } else if (audioInputs.length === 1) {
    fc.push('[1:a]volume=1.0[aout]');
  }
  if (vfilter.length) fc.push('[0:v]' + vfilter.join(',') + '[vout]');

  const cmd = [
    '-y', '-loglevel', 'error',
    '-i', merged,
    ...audioInputs.flat(),
    '-filter_complex', fc.join(';'),
    ...(vfilter.length ? ['-map', '[vout]'] : ['-map', '0:v']),
    ...(audioInputs.length ? ['-map', '[aout]'] : []),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    ...(audioInputs.length ? ['-c:a', 'aac', '-b:a', '192k'] : []),
    '-r', String(FPS),
    '-t', total.toFixed(2),
    OUT,
  ];
  await run('ffmpeg', cmd, { maxBuffer: 128 * 1024 * 1024 });
  console.log('  OK 成片: ' + OUT + '  ' + (fs.statSync(OUT).size / 1024 / 1024).toFixed(1) + ' MB');
  console.log('     配音 ' + (VOICE ? '有' : '无') + ' | 配乐 ' + (MUSIC ? '有' : '无') + ' | 字幕 ' + (SUBS ? '有' : '无'));
}

main().catch((e) => {
  console.error('[失败] ' + (e && e.message ? e.message : String(e)));
  if (e && e.stderr) console.error(String(e.stderr).slice(0, 2000));
  process.exit(1);
});
