// api/tts.mjs — Vercel serverless: Azure TTS (European Portuguese voice)
// 🛡️ Security: origin whitelist + proxy secret + rate limit + text size limit

const RATE_LIMIT = 60;          // max requests per IP per minute
const MAX_TEXT_LENGTH = 800;    // max chars per TTS request
const ALLOWED_ORIGINS = [
  'https://xhs-fy-gd.vercel.app',
  'https://xhs-fy-gd-kellycheong.vercel.app',
  'http://localhost:4173',
  'http://localhost:3000',
  'http://127.0.0.1:4173',
];

// In-memory rate limiter
const rateMap = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now - entry.reset > 60000) {
    rateMap.set(ip, { count: 1, reset: now });
    return { allowed: true };
  }
  if (entry.count >= RATE_LIMIT) {
    return { allowed: false, retryAfter: Math.ceil((entry.reset + 60000 - now) / 1000) };
  }
  entry.count++;
  return { allowed: true };
}

// Periodic cleanup
if (Math.random() < 0.01) {
  const cutoff = Date.now() - 120000;
  for (const [k, v] of rateMap) {
    if (v.reset < cutoff) rateMap.delete(k);
  }
}

// XML escaping
function escXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export default async function handler(req, res) {
  // CORS
  const origin = req.headers['origin'] || '';
  res.setHeader('Access-Control-Allow-Origin', origin || 'https://xhs-fy-gd.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-proxy-secret');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST allowed' });

  // Origin check: REQUIRED and must be in whitelist.
  // Reject empty origin to block direct curl/script abuse (proxy secret is public in frontend JS).
  if (!origin || !ALLOWED_ORIGINS.some(o => origin === o)) {
    return res.status(403).json({ error: 'Unauthorized origin' });
  }

  // Rate limit
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const rateCheck = checkRateLimit(ip);
  if (!rateCheck.allowed) {
    res.setHeader('Retry-After', String(rateCheck.retryAfter));
    return res.status(429).json({ error: 'Too many requests', retryAfter: rateCheck.retryAfter });
  }

  // Proxy secret validation
  const secret = req.headers['x-proxy-secret'];
  const expected = process.env.PROXY_SECRET;
  if (!expected) {
    console.error('PROXY_SECRET not set');
    return res.status(500).json({ error: 'Server config error' });
  }
  if (secret !== expected) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const { text, voice, rate } = req.body;
  if (!text) return res.status(400).json({ error: 'Missing text' });

  const key = process.env.AZURE_KEY;
  const region = process.env.AZURE_REGION || 'southeastasia';
  if (!key) return res.status(500).json({ error: 'AZURE_KEY not configured' });

  const trimmed = text.trim().substring(0, MAX_TEXT_LENGTH);
  const voiceName = voice || 'pt-PT-FernandaNeural';
  const speakRate = rate || '0.85';

  try {
    // Step 1: Get access token
    const tokenRes = await fetch(
      `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issuetoken`,
      {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': key,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': '0'
        }
      }
    );
    const token = await tokenRes.text();

    // Step 2: Synthesize speech
    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="pt-PT">
      <voice name="${voiceName}"><prosody rate="${speakRate}">${escXml(trimmed)}</prosody></voice></speak>`;

    const ttsRes = await fetch(
      `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3'
        },
        body: ssml
      }
    );

    if (!ttsRes.ok) {
      const errText = await ttsRes.text();
      return res.status(ttsRes.status).json({ error: 'TTS failed: ' + errText });
    }

    const audioBuffer = await ttsRes.arrayBuffer();
    const b64 = Buffer.from(audioBuffer).toString('base64');

    return res.status(200).json({ success: true, audio: b64, voice: voiceName });
  } catch (e) {
    console.error('TTS error:', e);
    return res.status(500).json({ error: String(e) });
  }
}
