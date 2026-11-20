// Vercel serverless function: POST /api/chat
// Forwards the chat to the Google Gemini API (OpenAI-compatible endpoint) and streams the answer back.
// The API key lives only in the Vercel environment variable GEMINI_API_KEY.

const UPSTREAM = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

// Must match MODELS in app.js
const ALLOWED_MODELS = new Set([
  'gemini-3.6-flash',
  'gemini-3-flash-preview',
  'gemini-4-hydrogen',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
]);

const MAX_BODY = 2_000_000;
const RATE_LIMIT = parseInt(process.env.IDEORA_RATE_LIMIT || '20', 10); // per IP per hour, 0 = off

// Best-effort, per-instance rate limit. Serverless instances are short-lived,
// so for a hard limit also enable Vercel Firewall rate limiting.
const hits = new Map();
function rateLimited(ip) {
  if (RATE_LIMIT <= 0) return 0;
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 3600_000);
  if (recent.length >= RATE_LIMIT) {
    hits.set(ip, recent);
    return Math.ceil((3600_000 - (now - recent[0])) / 1000);
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 3600_000) hits.delete(k);
  return 0;
}

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function POST(request) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return json(500, { error: { message: 'GEMINI_API_KEY is not set in Vercel environment variables.', type: 'ideora_config' } });

  const len = parseInt(request.headers.get('content-length') || '0', 10);
  if (len > MAX_BODY) return json(413, { error: { message: 'Request too large. Start a new chat.', type: 'ideora_limit' } });

  let body;
  try {
    body = await request.json();
    if (!Array.isArray(body.messages) || !body.messages.length) throw new Error();
  } catch {
    return json(400, { error: { message: 'Bad request' } });
  }
  if (!ALLOWED_MODELS.has(body.model)) return json(400, { error: { message: 'Model not allowed: ' + body.model } });

  const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || request.headers.get('x-real-ip') || 'anon';
  const wait = rateLimited(ip);
  if (wait) {
    const mins = Math.max(1, Math.floor(wait / 60));
    return json(429, {
      error: {
        message: `Hourly limit reached (${RATE_LIMIT} requests per hour). Try again in about ${mins} minute${mins === 1 ? '' : 's'}.`,
        type: 'ideora_limit',
      },
    });
  }

  let upstream;
  try {
    upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: body.model, messages: body.messages, stream: true }),
      signal: request.signal,
    });
  } catch (e) {
    return json(502, { error: { message: 'Cannot reach the Gemini API (' + e.message + ').' } });
  }

  if (!upstream.ok) {
    const raw = await upstream.text();
    let msg = raw.slice(0, 300);
    try {
      let j = JSON.parse(raw);
      if (Array.isArray(j)) j = j[0];
      msg = j?.error?.message || msg;
    } catch {}
    return json(upstream.status, { error: { message: `Gemini API ${upstream.status}: ${msg}` } });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}

export function GET() {
  return json(405, { error: { message: 'Use POST' } });
}
