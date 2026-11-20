# Ideora

Paste in a raw business idea and get a full market analysis: market size, competitors, similar companies that succeeded or failed, revenue models, unit economics, risks, opportunities nobody is serving yet, ideas for improving the business, and a 30-day validation plan.

- No sign-up and no login. All chats and settings are saved in **browser cookies**.
- The AI is the official **Google Gemini API**, using a free key from [AI Studio](https://aistudio.google.com/api-keys).
- The UI is English. The AI answers in whatever language you write in, including Persian, and Persian text is shown right-to-left.
- Each analysis shows a score card, follow-up buttons (financial model, landing page copy, pitch deck…), and export to Markdown or PDF.

## Run locally

Double-click `start.bat`, or run:

```bash
python server.py
```

Then open http://localhost:3000. Only Python 3 is needed; there is nothing to install with pip.

## Files

| File | Purpose |
|------|---------|
| `index.html`, `styles.css` | Chat interface in the ChatGPT style |
| `app.js` | Chat logic, streaming, cookie storage, model fallback, score card, export |
| `prompt.js` | The 1,200+ line system prompt that drives the analysis |
| `server.py` | Static server plus Gemini proxy that keeps the API key secret, with a rate limit |
| `ideora.env` | Settings and **API key**. Keep this file private and never upload it publicly. |

## Deploy to Vercel (recommended)

The site is static. `/api/chat` and `/api/health` run as Vercel serverless functions (`api/`). The API key lives only in Vercel's environment variables.

**Option A, from GitHub:**
1. Push this folder to a **private** GitHub repo. `ideora.env` is already in `.gitignore`.
2. On vercel.com, choose **Add New → Project**, import the repo, and keep the defaults (Framework: *Other*, no build command).
3. Under **Environment Variables**, add `GEMINI_API_KEY` = your key, plus `IDEORA_RATE_LIMIT` = `20` if you want a limit.
4. Click **Deploy**.

**Option B, with the CLI:**
```bash
npx vercel login
npx vercel env add GEMINI_API_KEY production   # paste the key when asked
npx vercel --prod
```

`.vercelignore` keeps `ideora.env`, `server.py` and `start.bat` from being uploaded.
For a hard rate limit across all serverless instances, also add a rule in **Vercel → Firewall → Rate Limiting** for `/api/chat`.

## Deploy to your own server

You need a **VPS** with Python 3 (shared cPanel hosting won't work). Pick one **outside Iran**, because Google blocks Iranian IPs.

1. Upload the files.
2. In `ideora.env`, set `IDEORA_HOST=0.0.0.0` and `IDEORA_RATE_LIMIT=20`.
3. Run `python3 server.py` (keep it running with `systemd`, `pm2` or `screen`).
4. Optionally put nginx or Cloudflare in front for HTTPS and a domain. If you do, set `IDEORA_TRUST_PROXY=1`.

## Notes

- **Models:** you choose the model from the top menu. If a model is busy (503), out of quota (429), or doesn't respond for 90 seconds, Ideora automatically tries the next one: 3.6 Flash, then 3 Flash, then 3.5 Flash-Lite, then 3.1 Flash-Lite.
- **Free tier limits:** the free AI Studio key has a daily and per-minute quota. The Gemini 4 Pro models (Neon and Carbon) don't work on the free tier.
- **Cookie limits:** at most about 53 KB of compressed chats is stored. When that fills up, the oldest chats are deleted automatically.
- The AI can't browse the web. Check recent facts yourself.
