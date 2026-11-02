/**
 * tts.mjs — 给成员一个"把文字变成语音"的工具
 *
 * 默认后端：微软 Edge 神经语音（免费、无需显卡、中文 8 个音色）。
 * 也可以切到本地 Mambo/任意 OpenAI 兼容 TTS：
 *   TTS_BACKEND=edge | mambo | http
 *   TTS_MAMBO_URL=http://127.0.0.1:7860/api/tts
 *   TTS_API_BASE=http://127.0.0.1:8000/v1   TTS_API_KEY=...   TTS_API_MODEL=tts-1
 *
 * 为什么要有它：Windows 自带 Huihui 是 2013 年的拼接音，一耳朵就是机器。
 * 换成神经语音后，同一句台词的"人味"差一大截。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const title = '语音合成';

const EDGE_VOICES = {
  xiaoyi: 'zh-CN-XiaoyiNeural',
  xiaoxiao: 'zh-CN-XiaoxiaoNeural',
  yunxi: 'zh-CN-YunxiNeural',
  yunxia: 'zh-CN-YunxiaNeural',
  yunjian: 'zh-CN-YunjianNeural',
  yunyang: 'zh-CN-YunyangNeural',
  xiaobei: 'zh-CN-liaoning-XiaobeiNeural',
  xiaoni: 'zh-CN-shaanxi-XiaoniNeural',
};

const DEFAULT_VOICE = process.env.TTS_VOICE || 'xiaoyi';

function resolveVoice(voice) {
  const raw = String(voice || DEFAULT_VOICE).trim();
  if (!raw) return EDGE_VOICES[DEFAULT_VOICE];
  if (EDGE_VOICES[raw.toLowerCase()]) return EDGE_VOICES[raw.toLowerCase()];
  return raw; // 已经是完整名（zh-CN-...）就原样用
}

function pythonCandidates() {
  const list = [
    process.env.TTS_PYTHON,
    'python',
    'C:\\Users\\<你的用户名>\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe',
    'py',
  ];
  return [...new Set(list.filter(Boolean))];
}

function run(command, args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error && error.message) });
      return;
    }
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(error && error.message) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

async function ffprobeDuration(file) {
  const result = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], 30000);
  const value = Number(String(result.stdout).trim());
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : undefined;
}

async function edgeSpeak({ text, voice, rate, pitch, out }) {
  const args = ['-m', 'edge_tts', '--voice', resolveVoice(voice), '--text', text, '--write-media', out];
  if (rate) args.push('--rate=' + rate);
  if (pitch) args.push('--pitch=' + pitch);
  const errors = [];
  for (const python of pythonCandidates()) {
    const result = await run(python, args, Number(process.env.TTS_TIMEOUT_MS || 120000));
    if (result.code === 0 && fs.existsSync(out) && fs.statSync(out).size > 0) return;
    errors.push(python + ': ' + String(result.stderr || result.stdout).slice(0, 120));
  }
  throw new Error('Edge TTS 调用失败（找不到可用的 Python 或 edge-tts 未安装）：' + errors.join(' | '));
}

async function mamboSpeak({ text, voice, out }) {
  const template = process.env.TTS_MAMBO_CMD;
  if (template) {
    const args = template.split(' ').map((part) => part.replace('{text}', text).replace('{voice}', voice || '').replace('{out}', out));
    const result = await run(args[0], args.slice(1), Number(process.env.TTS_TIMEOUT_MS || 180000));
    if (result.code !== 0) throw new Error('MamboTTS 命令失败：' + String(result.stderr || result.stdout).slice(0, 200));
    return;
  }
  const url = process.env.TTS_MAMBO_URL;
  if (!url) throw new Error('没有配置 TTS_MAMBO_URL / TTS_MAMBO_CMD，不知道 MamboTTS 在哪。');
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, voice: voice || '', speaker: voice || '' }),
  });
  if (!response.ok) throw new Error('MamboTTS HTTP ' + response.status + '：' + (await response.text()).slice(0, 200));
  fs.writeFileSync(out, Buffer.from(await response.arrayBuffer()));
}

async function httpSpeak({ text, voice, out }) {
  const base = (process.env.TTS_API_BASE || '').replace(/\/$/, '');
  if (!base) throw new Error('没有配置 TTS_API_BASE。');
  const response = await fetch(base + '/audio/speech', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (process.env.TTS_API_KEY || '') },
    body: JSON.stringify({ model: process.env.TTS_API_MODEL || 'tts-1', input: text, voice: voice || 'alloy', response_format: 'mp3' }),
  });
  if (!response.ok) throw new Error('TTS 接口 HTTP ' + response.status + '：' + (await response.text()).slice(0, 200));
  fs.writeFileSync(out, Buffer.from(await response.arrayBuffer()));
}

export const tools = [{
  name: 'tts_speak',
  description: '把一句中文合成语音文件（默认微软 Edge 神经语音，音色可选 xiaoyi/xiaoxiao/yunxi/yunxia/yunjian/yunyang）。返回文件路径和时长，便于按真实时长对齐字幕。',
  kind: 'fetch',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '要读的一句话（不要整段，逐句生成）' },
      voice: { type: 'string', description: '音色：xiaoyi(默认)/xiaoxiao/yunxi/yunxia/yunjian/yunyang，也可以填完整名 zh-CN-XXXNeural' },
      out: { type: 'string', description: '输出路径（相对工作目录），默认 .work/tts/tts-<时间>.mp3' },
      rate: { type: 'string', description: '语速，如 +10% / -5%（默认不变）' },
      pitch: { type: 'string', description: '音高，如 +15Hz / -10Hz（用来区分不同角色）' },
    },
    required: ['text'],
  },
  async run(args, ctx) {
    const text = String(args.text || '').trim();
    if (!text) return '[错误] 要给 text。';
    if (text.length > 3000) return '[错误] 一次最多 3000 字；长文请逐句合成。';
    const cwd = (ctx && ctx.cwd) || process.cwd();
    const backend = (process.env.TTS_BACKEND || 'edge').toLowerCase();
    const ext = backend === 'edge' ? '.mp3' : '.wav';
    const out = path.resolve(cwd, String(args.out || path.join('.work', 'tts', 'tts-' + Date.now() + ext)));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const payload = { text, voice: args.voice, rate: args.rate, pitch: args.pitch, out };
    try {
      if (backend === 'mambo') await mamboSpeak(payload);
      else if (backend === 'http') await httpSpeak(payload);
      else await edgeSpeak(payload);
    } catch (error) {
      return '[错误] 合成失败：' + String((error && error.message) || error);
    }
    if (!fs.existsSync(out) || fs.statSync(out).size === 0) return '[错误] 没有生成音频文件。';
    const duration = await ffprobeDuration(out);
    const bytes = fs.statSync(out).size;
    return JSON.stringify({
      path: out,
      bytes,
      duration,
      backend,
      voice: resolveVoice(args.voice),
      hint: duration ? '时长 ' + duration + ' 秒，可直接写进 durations.json' : '时长读取失败，可用 ffprobe 再核',
    });
  },
}, {
  name: 'tts_voices',
  description: '列出可用的语音音色。',
  kind: 'fetch',
  parameters: { type: 'object', properties: {}, required: [] },
  async run() {
    return 'Edge 音色：' + Object.entries(EDGE_VOICES).map(([key, value]) => key + '=' + value).join('、')
      + '\n当前后端：' + (process.env.TTS_BACKEND || 'edge');
  },
}];
