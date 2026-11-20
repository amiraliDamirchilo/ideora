// Vercel serverless function: GET /api/health
export function GET() {
  return new Response(JSON.stringify({ ok: true, key_configured: Boolean(process.env.GEMINI_API_KEY) }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
