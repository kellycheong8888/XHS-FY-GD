// gen-fy-audio.mjs
// 批量生成跟读网页的静态预生成音频（无延迟方案，复用单字 app 模式）
// 抽取 index.html 中的 ALL_WORDS(word+ex_pt) 与 ARTICLES_RAW(pt 句子)
// 统一用 FernandaNeural @ 0.85 生成，输出到 audio/*.mp3 + tts-manifest.json（相对路径）
//
// 用法（金钥仅来自 env，不写死、不入库）：
//   AZURE_TTS_KEY=xxx AZURE_TTS_REGION=southeastasia node gen-fy-audio.mjs
// 增量续跑：已存在且 manifest 已登记的会跳过（ctrl-c 后可重跑补完）

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const KEY = process.env.AZURE_TTS_KEY;
const REGION = process.env.AZURE_TTS_REGION || 'southeastasia';
const VOICE = process.env.TTS_VOICE || 'pt-PT-FernandaNeural';
const RATE = process.env.TTS_RATE || '0.85';
const OUT = 'audio';
const MANIFEST = 'tts-manifest.json';
const DRY = process.env.DRY === '1';

if (!KEY && !DRY) { console.error('ERROR: AZURE_TTS_KEY env missing'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

const html = fs.readFileSync('index.html', 'utf8');

// 抽取 const NAME = [ ... ]; 数组字面量
function extractArray(name) {
  const marker = `const ${name} = [`;
  const start = html.indexOf(marker);
  if (start < 0) throw new Error('marker not found: ' + name);
  const open = html.indexOf('[', start);
  let depth = 0, end = -1;
  for (let i = open; i < html.length; i++) {
    const c = html[i];
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) { end = i; break; } }
  }
  const literal = html.slice(open, end + 1);
  return eval(literal);
}

const ALL_WORDS = extractArray('ALL_WORDS');
const ARTICLES_RAW = extractArray('ARTICLES_RAW');

// 与前端 azureTTS 完全相同的清洗：去掉弯直引号并 trim
function clean(t) { return (t || '').replace(/[""]/g, '').trim(); }

// 去重：key = 清洗后小写；value = 原始清洗文本 + sha1(前12位)做稳定文件名
const map = new Map();
function add(t) {
  const c = clean(t);
  if (!c) return;
  const key = c.toLowerCase();
  if (!map.has(key)) {
    const hash = crypto.createHash('sha1').update(c, 'utf8').digest('hex').slice(0, 12);
    map.set(key, { text: c, hash });
  }
}
for (const w of ALL_WORDS) { add(w.word); add(w.ex_pt); }
for (const a of ARTICLES_RAW) {
  for (const s of a.sentences || []) { if (s.type === 'pt') add(s.text); }
}

const items = [...map.values()];
console.log(`ALL_WORDS=${ALL_WORDS.length} ARTICLES_RAW=${ARTICLES_RAW.length} 唯一文本=${items.length}`);

if (DRY) {
  console.log('[DRY] 前 20 条:');
  items.slice(0, 20).forEach(it => console.log('  ', it.text));
  process.exit(0);
}

// 已有 manifest，用于增量续跑
let manifest = {};
if (fs.existsSync(MANIFEST)) {
  try { manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch (e) { manifest = {}; }
}

let token = null, tokenTs = 0;
async function getToken() {
  const now = Date.now();
  if (token && now - tokenTs < 9 * 60 * 1000) return token;
  const r = await fetch(`https://${REGION}.api.cognitive.microsoft.com/sts/v1.0/issuetoken`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': KEY,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': '0'
    }
  });
  if (!r.ok) throw new Error('token ' + r.status);
  token = await r.text(); tokenTs = Date.now();
  return token;
}

function escXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

async function synth(text) {
  const tk = await getToken();
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="pt-PT">` +
    `<voice name="${VOICE}"><prosody rate="${RATE}">${escXml(text)}</prosody></voice></speak>`;
  const r = await fetch(`https://${REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + tk,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3'
    },
    body: ssml
  });
  if (!r.ok) throw new Error('tts ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return Buffer.from(await r.arrayBuffer());
}

let done = 0, skip = 0, fail = 0;
for (const it of items) {
  const file = path.join(OUT, it.hash + '.mp3');
  const key = it.text.toLowerCase();
  if (fs.existsSync(file) && manifest[key]) { skip++; continue; }
  let ok = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const buf = await synth(it.text);
      fs.writeFileSync(file, buf);
      manifest[key] = OUT + '/' + it.hash + '.mp3';
      ok = true; done++; break;
    } catch (e) {
      console.error('RETRY', it.text, e.message);
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  if (!ok) { fail++; console.error('FAIL', it.text); }
  if ((done + skip + fail) % 25 === 0) console.log('progress', done, skip, fail);
  await new Promise(r => setTimeout(r, 150)); // 轻量限速，避免 429
}

fs.writeFileSync(MANIFEST, JSON.stringify(manifest));
console.log(`DONE done=${done} skip=${skip} fail=${fail} total=${items.length}`);
