/* Ideora — AI market analysis for raw business ideas.
 * No sign-up. All state is stored in browser cookies (compressed + chunked).
 * AI calls go through Puter.js (free Gemini access, no API key).
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------- config
  // Must match ALLOWED_MODELS in server.py
  const MODELS = [
    { id: 'gemini-3.6-flash',      name: '3.6 Flash',      desc: 'Smart and fast. Recommended for analysis.' },
    { id: 'gemini-3-flash-preview', name: '3 Flash',       desc: 'Reliable all-rounder.' },
    { id: 'gemini-4-hydrogen',     name: '4 Hydrogen',     desc: 'Newest generation. May be busy at peak times.' },
    { id: 'gemini-3.5-flash-lite', name: '3.5 Flash-Lite', desc: 'Very fast, lighter analysis.' },
    { id: 'gemini-3.1-flash-lite', name: '3.1 Flash-Lite', desc: 'Fastest. Good for quick scans.' },
  ];
  // If the chosen model fails or hangs before producing any text, try these in order.
  const FALLBACKS = ['gemini-3.6-flash', 'gemini-3-flash-preview', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
  const IDLE_TIMEOUT_MS = 90000; // no data for this long -> treat the model as stuck
  const API_URL = '/api/chat';   // served by server.py, which forwards to the Gemini API

  const DEPTH_HINTS = {
    quick: 'Depth mode: Quick scan (Part 21). Keep it to roughly 300-600 words.',
    standard: 'Depth mode: Standard (Part 21).',
    deep: 'Depth mode: Deep dive (Part 21). Expand every section, include three scenarios for unit economics and a 90-day plan.',
  };

  const SUGGESTIONS = [
    { icon: '🐶', label: 'Same-day dog walking app', text: 'A mobile app that connects busy dog owners in big cities with vetted walkers who live within a few blocks, for same-day walks booked in under a minute.' },
    { icon: '🦷', label: 'AI receptionist for clinics', text: 'An AI phone receptionist for small dental and beauty clinics that answers calls 24/7, books appointments into their calendar and sends reminders. Subscription per clinic.' },
    { icon: '🌱', label: 'Office plant subscription', text: 'A B2B subscription that delivers, maintains and replaces plants for small offices and cafes, with a monthly fee per plant.' },
    { icon: '🎓', label: 'Freelancer course in Persian', text: 'یک پلتفرم آموزشی فارسی که به جوانان ایرانی کمک می‌کند به عنوان فریلنسر برای مشتری‌های خارجی کار کنند و درآمد ارزی داشته باشند.' },
  ];

  // Cookie storage
  const COOKIE_PREFIX = 'ideora_d';     // data chunks: ideora_d0, ideora_d1, ...
  const COOKIE_COUNT = 'ideora_n';      // number of chunks
  const COOKIE_PREFS = 'ideora_prefs';  // small prefs cookie
  const CHUNK_SIZE = 3800;              // stay below the ~4096 byte per-cookie limit
  const MAX_CHUNKS = 14;                // ~53 KB of compressed data; keeps request headers sane
  const MAX_AGE = 60 * 60 * 24 * 365;   // one year

  // ---------------------------------------------------------------- dom
  const $ = (id) => document.getElementById(id);
  const app = $('app');
  const historyEl = $('history');
  const messagesEl = $('messages');
  const threadEl = $('thread');
  const input = $('input');
  const sendBtn = $('sendBtn');
  const composer = $('composer');
  const modelBtn = $('modelBtn');
  const modelMenu = $('modelMenu');
  const modelLabel = $('modelLabel');
  const itemMenu = $('itemMenu');
  const toastEl = $('toast');

  // ---------------------------------------------------------------- cookies
  function setCookie(name, value, maxAge = MAX_AGE) {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = name + '=' + value + '; Max-Age=' + maxAge + '; Path=/; SameSite=Lax' + secure;
  }
  function getCookie(name) {
    const parts = document.cookie ? document.cookie.split('; ') : [];
    for (const p of parts) {
      const i = p.indexOf('=');
      if (p.slice(0, i) === name) return p.slice(i + 1);
    }
    return null;
  }
  function deleteCookie(name) { setCookie(name, '', 0); }

  function cookiesWork() {
    try {
      setCookie('ideora_test', '1', 60);
      const ok = getCookie('ideora_test') === '1';
      deleteCookie('ideora_test');
      return ok;
    } catch { return false; }
  }

  const Store = {
    usedChunks: 0,

    load() {
      try {
        const n = parseInt(getCookie(COOKIE_COUNT) || '0', 10);
        if (!n) return null;
        let s = '';
        for (let i = 0; i < n; i++) {
          const part = getCookie(COOKIE_PREFIX + i);
          if (part == null) return null;
          s += part;
        }
        this.usedChunks = n;
        const json = LZString.decompressFromEncodedURIComponent(s);
        return json ? JSON.parse(json) : null;
      } catch (e) {
        console.warn('Ideora: could not read saved chats', e);
        return null;
      }
    },

    encode(data) {
      return LZString.compressToEncodedURIComponent(JSON.stringify(data));
    },

    /** Saves chats. If the cookie budget is exceeded, the oldest chats are dropped. */
    save(chats, activeId) {
      let list = chats.slice();
      let encoded = this.encode({ v: 1, chats: list });
      let dropped = 0;
      while (encoded.length > CHUNK_SIZE * MAX_CHUNKS && list.length > 1) {
        // drop the least recently updated chat that is not active
        let idx = -1, oldest = Infinity;
        list.forEach((c, i) => { if (c.id !== activeId && c.updated < oldest) { oldest = c.updated; idx = i; } });
        if (idx < 0) break;
        list.splice(idx, 1);
        dropped++;
        encoded = this.encode({ v: 1, chats: list });
      }
      if (encoded.length > CHUNK_SIZE * MAX_CHUNKS) {
        // a single huge chat: trim its oldest message pairs
        const c = list[0];
        while (encoded.length > CHUNK_SIZE * MAX_CHUNKS && c.messages.length > 2) {
          c.messages.splice(0, 2);
          encoded = this.encode({ v: 1, chats: list });
        }
      }

      const n = Math.ceil(encoded.length / CHUNK_SIZE);
      for (let i = 0; i < n; i++) setCookie(COOKIE_PREFIX + i, encoded.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE));
      for (let i = n; i < Math.max(this.usedChunks, MAX_CHUNKS); i++) if (getCookie(COOKIE_PREFIX + i) != null) deleteCookie(COOKIE_PREFIX + i);
      setCookie(COOKIE_COUNT, String(n));
      this.usedChunks = n;

      return { kept: list, dropped, ratio: encoded.length / (CHUNK_SIZE * MAX_CHUNKS) };
    },

    clear() {
      for (let i = 0; i < Math.max(this.usedChunks, MAX_CHUNKS) + 2; i++) deleteCookie(COOKIE_PREFIX + i);
      deleteCookie(COOKIE_COUNT);
      this.usedChunks = 0;
    },

    loadPrefs() {
      try { return JSON.parse(decodeURIComponent(getCookie(COOKIE_PREFS) || '')) || {}; } catch { return {}; }
    },
    savePrefs(p) { setCookie(COOKIE_PREFS, encodeURIComponent(JSON.stringify(p))); },
  };

  // ---------------------------------------------------------------- state
  const saved = Store.load();
  const prefs = Object.assign({ model: MODELS[0].id, depth: 'standard', sidebar: true, activeId: null }, Store.loadPrefs());
  if (!MODELS.some((m) => m.id === prefs.model)) prefs.model = MODELS[0].id;

  const state = {
    chats: saved && Array.isArray(saved.chats) ? saved.chats : [],
    activeId: null,
    streaming: false,
    stopRequested: false,
    search: '',
  };
  if (prefs.activeId && state.chats.some((c) => c.id === prefs.activeId)) state.activeId = prefs.activeId;

  const activeChat = () => state.chats.find((c) => c.id === state.activeId) || null;
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function persist() {
    const res = Store.save(state.chats, state.activeId);
    if (res.dropped) {
      state.chats = res.kept;
      toast(res.dropped + ' old chat' + (res.dropped > 1 ? 's' : '') + ' removed to fit cookie storage');
      renderHistory();
    }
    updateMeter(res.ratio);
  }
  function persistPrefs() {
    prefs.activeId = state.activeId;
    Store.savePrefs(prefs);
  }

  function updateMeter(ratio) {
    const pct = Math.min(100, Math.round(ratio * 100));
    $('storageText').textContent = pct + '%';
    const fill = $('storageFill');
    fill.style.width = pct + '%';
    fill.classList.toggle('warn', pct > 80);
  }

  // ---------------------------------------------------------------- utils
  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), 2600);
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  marked.setOptions({ gfm: true, breaks: false });
  function cleanModelText(text) {
    // Gemini web sometimes injects placeholder image tags like <Image ... src="image_agent_tag_..."/>
    return (text || '').replace(/<image\b[^>]*\/?>(\s*<\/image>)?/gi, '').replace(/\n{3,}/g, '\n\n');
  }
  function renderMarkdown(text) {
    const html = DOMPurify.sanitize(marked.parse(cleanModelText(text)), { ADD_ATTR: ['target'], FORBID_TAGS: ['img', 'style'] });
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    tpl.content.querySelectorAll('table').forEach((t) => {
      const wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      t.replaceWith(wrap);
      wrap.appendChild(t);
    });
    tpl.content.querySelectorAll('a').forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
    return tpl.innerHTML;
  }

  function detectDir(text) {
    const m = (text || '').match(/[A-Za-z֐-ࣿ]/);
    return m && /[֐-ࣿ]/.test(m[0]) ? 'rtl' : 'ltr';
  }

  function titleFrom(text) {
    const t = text.replace(/\s+/g, ' ').trim();
    return t.length > 42 ? t.slice(0, 42).trim() + '…' : t || 'New idea';
  }

  function modelName(id) {
    const m = MODELS.find((x) => x.id === id);
    return m ? m.name : id;
  }

  function isNearBottom() {
    return threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight < 120;
  }
  function scrollToBottom() { threadEl.scrollTop = threadEl.scrollHeight; }

  // ---------------------------------------------------------------- icons
  const ICON = {
    copy: '<svg viewBox="0 0 24 24" width="17" height="17"><rect x="8" y="8" width="12" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="17" height="17"><path d="M5 12l5 5 9-10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    regen: '<svg viewBox="0 0 24 24" width="17" height="17"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    edit: '<svg viewBox="0 0 24 24" width="17" height="17"><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    dots: '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="5" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="19" cy="12" r="1.7" fill="currentColor"/></svg>',
    download: '<svg viewBox="0 0 24 24" width="17" height="17"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    print: '<svg viewBox="0 0 24 24" width="17" height="17"><path d="M7 9V4h10v5M7 17H5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2M7 14h10v6H7z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
    tick: '<svg class="check" viewBox="0 0 24 24" width="18" height="18"><path d="M5 12l5 5 9-10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  // ---------------------------------------------------------------- render: sidebar
  function groupLabel(ts) {
    const d = new Date(ts), now = new Date();
    const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = (startOf(now) - startOf(d)) / 86400000;
    if (diff < 1) return 'Today';
    if (diff < 2) return 'Yesterday';
    if (diff < 7) return 'Previous 7 days';
    if (diff < 30) return 'Previous 30 days';
    return 'Older';
  }

  function renderHistory() {
    const q = state.search.toLowerCase();
    const list = state.chats
      .filter((c) => !q || c.title.toLowerCase().includes(q) || c.messages.some((m) => m.content.toLowerCase().includes(q)))
      .sort((a, b) => b.updated - a.updated);

    historyEl.innerHTML = '';
    if (!list.length) {
      historyEl.innerHTML = '<div class="history-empty">' + (q ? 'No chats found.' : 'Your idea analyses will appear here.') + '</div>';
      return;
    }
    let currentGroup = null, groupEl = null;
    for (const c of list) {
      const g = groupLabel(c.updated);
      if (g !== currentGroup) {
        currentGroup = g;
        groupEl = document.createElement('div');
        groupEl.className = 'history-group';
        groupEl.innerHTML = '<div class="history-label">' + g + '</div>';
        historyEl.appendChild(groupEl);
      }
      const item = document.createElement('div');
      item.className = 'history-item' + (c.id === state.activeId ? ' active' : '');
      item.dataset.id = c.id;
      item.innerHTML =
        '<button class="title" dir="auto">' + escapeHtml(c.title) + '</button>' +
        '<button class="more" aria-label="Chat options" aria-expanded="false">' + ICON.dots + '</button>';
      groupEl.appendChild(item);
    }
  }

  // ---------------------------------------------------------------- render: thread
  function renderThread() {
    const chat = activeChat();
    messagesEl.innerHTML = '';
    app.classList.toggle('empty', !chat || !chat.messages.length);
    if (!chat) return;
    chat.messages.forEach((m, i) => messagesEl.appendChild(buildMessage(m, i, chat)));
    requestAnimationFrame(scrollToBottom);
  }

  function buildMessage(m, index, chat) {
    const el = document.createElement('div');
    el.className = 'msg ' + m.role;
    el.dataset.index = index;
    if (m.role === 'user') {
      el.innerHTML =
        '<div class="bubble" dir="' + detectDir(m.content) + '">' + escapeHtml(m.content) + '</div>' +
        '<div class="msg-actions">' +
          '<button data-act="copy" title="Copy">' + ICON.copy + '</button>' +
          '<button data-act="edit" title="Edit">' + ICON.edit + '</button>' +
        '</div>';
    } else {
      const isLast = index === chat.messages.length - 1;
      const sc = extractScore(m.content);
      el.innerHTML =
        (sc ? scoreCardHtml(sc) : '') +
        '<div class="content" dir="' + detectDir(m.content) + '">' + renderMarkdown(m.content) + '</div>' +
        '<div class="msg-actions">' +
          '<button data-act="copy" title="Copy">' + ICON.copy + '</button>' +
          (isLast ? '<button data-act="regen" title="Regenerate">' + ICON.regen + '</button>' : '') +
          '<button data-act="download" title="Download as Markdown">' + ICON.download + '</button>' +
          '<button data-act="print" title="Print / Save as PDF">' + ICON.print + '</button>' +
          (m.model ? '<span class="model-tag">' + escapeHtml(modelName(m.model)) + '</span>' : '') +
        '</div>' +
        (isLast && !state.streaming ? followupsHtml(chat) : '');
    }
    return el;
  }

  // ---------------------------------------------------------------- score card
  function toLatinDigits(s) {
    return s.replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
  }
  function extractScore(text) {
    const head = toLatinDigits(cleanModelText(text).slice(0, 3000));
    const m = head.match(/(\d{1,3})\s*(?:\/|از)\s*100/);
    if (!m || +m[1] > 100) return null;
    const v = head.match(/(?:Verdict|حکم|نتیجه|ارزیابی)[^:\n：]{0,20}[:：]\s*\**\s*([^\n]+)/i);
    return { score: +m[1], verdict: v ? v[1].replace(/[*_#|]/g, '').trim().slice(0, 90) : '' };
  }
  function scoreCardHtml({ score, verdict }) {
    const color = score >= 70 ? '#10a37f' : score >= 55 ? '#84cc16' : score >= 40 ? '#f59e0b' : '#ef4444';
    const tier = score >= 85 ? 'Exceptional' : score >= 70 ? 'Strong' : score >= 55 ? 'Promising' : score >= 40 ? 'Risky' : 'Weak';
    return '<div class="scorecard" style="--p:' + score + ';--c:' + color + '">' +
      '<div class="ring"><span>' + score + '</span></div>' +
      '<div class="sc-text"><div class="sc-label">Ideora Score · <b style="color:' + color + '">' + tier + '</b></div>' +
      (verdict ? '<div class="sc-verdict" dir="auto">' + escapeHtml(verdict) + '</div>' : '') +
      '</div></div>';
  }

  // ---------------------------------------------------------------- follow-ups
  const FOLLOWUPS = [
    { icon: '🔍', label: 'Competitor deep-dive',
      en: 'Do a deep-dive on the main competitors: features, pricing, positioning, and what their customers complain about. Where exactly is the gap?',
      fa: 'یک بررسی عمیق از رقبای اصلی انجام بده: ویژگی‌ها، قیمت‌گذاری، جایگاه‌یابی و چیزهایی که مشتری‌هایشان از آن شکایت دارند. دقیقاً شکاف بازار کجاست؟' },
    { icon: '💰', label: 'Financial model',
      en: 'Build a 12-month financial projection with pessimistic, base and optimistic scenarios. List the assumptions first.',
      fa: 'یک پیش‌بینی مالی ۱۲ ماهه با سه سناریوی بدبینانه، پایه و خوش‌بینانه بساز. اول فرضیات را فهرست کن.' },
    { icon: '🚀', label: 'Landing page copy',
      en: 'Write complete landing page copy for this idea: headline, sub-headline, benefits, CTA and FAQ.',
      fa: 'متن کامل صفحه فرود (لندینگ پیج) برای این ایده بنویس: تیتر، زیرتیتر، مزایا، دکمه اقدام و سؤالات متداول.' },
    { icon: '🎤', label: 'Pitch deck',
      en: 'Create a 10-12 slide pitch deck outline for this idea, with what goes on each slide.',
      fa: 'یک ساختار پیچ‌دک ۱۰ تا ۱۲ اسلایدی برای این ایده بساز و بگو در هر اسلاید چه چیزی بیاید.' },
    { icon: '🧪', label: 'Interview script',
      en: 'Write a customer interview script based on Mom Test principles to validate this idea.',
      fa: 'یک اسکریپت مصاحبه با مشتری بر اساس اصول Mom Test برای اعتبارسنجی این ایده بنویس.' },
    { icon: '🔄', label: 'Pivot ideas',
      en: 'Suggest 5 strong pivots or niche versions of this idea, scored and compared in a table.',
      fa: '۵ پیوت یا نسخه نیچ قوی از این ایده پیشنهاد بده و آن‌ها را در یک جدول امتیازدهی و مقایسه کن.' },
  ];
  function chatLang(chat) {
    const firstUser = chat.messages.find((m) => m.role === 'user');
    return firstUser && detectDir(firstUser.content) === 'rtl' ? 'fa' : 'en';
  }
  function followupsHtml(chat) {
    const asked = new Set(chat.messages.filter((m) => m.role === 'user').map((m) => m.content));
    const lang = chatLang(chat);
    const items = FOLLOWUPS.map((f, i) => ({ f, i })).filter(({ f }) => !asked.has(f[lang]));
    if (!items.length) return '';
    return '<div class="followups">' + items.map(({ f, i }) =>
      '<button class="followup" data-act="followup" data-i="' + i + '"><span>' + f.icon + '</span>' + f.label + '</button>').join('') + '</div>';
  }

  // ---------------------------------------------------------------- export
  function safeFileName(s) { return (s || 'ideora').replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 60) || 'ideora'; }
  function downloadMarkdown(chat, idx) {
    const blob = new Blob([cleanModelText(chat.messages[idx].content)], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = safeFileName(chat.title) + ' - Ideora.md';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function printMessage(chat, idx) {
    const m = chat.messages[idx];
    const w = window.open('', '_blank');
    if (!w) return toast('Allow pop-ups to print');
    const dir = detectDir(m.content);
    w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>' + escapeHtml(chat.title) + ' – Ideora</title>' +
      '<style>body{font-family:system-ui,"Segoe UI",Tahoma,sans-serif;max-width:800px;margin:32px auto;padding:0 24px;color:#111;line-height:1.6}' +
      'h1,h2,h3{line-height:1.3}h2{border-bottom:1px solid #ddd;padding-bottom:4px;margin-top:28px}' +
      'table{border-collapse:collapse;width:100%;margin:12px 0;font-size:13px}th,td{border:1px solid #ccc;padding:6px 8px;text-align:start;vertical-align:top}th{background:#f3f3f3}' +
      '.brand{color:#10a37f;font-weight:700;font-size:13px;letter-spacing:.04em}@media print{a{color:#111}}</style></head>' +
      '<body dir="' + dir + '"><div class="brand">IDEORA · MARKET ANALYSIS</div><h1>' + escapeHtml(chat.title) + '</h1>' +
      renderMarkdown(m.content) + '</body></html>');
    w.document.close();
    setTimeout(() => { try { w.focus(); w.print(); } catch {} }, 500);
  }

  // ---------------------------------------------------------------- model menu
  function renderModelMenu() {
    modelLabel.textContent = modelName(prefs.model);
    modelMenu.innerHTML = '<div class="menu-head">Gemini model</div>' + MODELS.map((m) =>
      '<button class="model-option' + (m.id === prefs.model ? ' selected' : '') + '" data-model="' + m.id + '">' +
        '<div class="mo-text"><div class="mo-name">' + m.name + '</div><div class="mo-desc">' + m.desc + '</div></div>' + ICON.tick +
      '</button>').join('');
  }
  function toggleModelMenu(open) {
    const willOpen = open ?? modelMenu.hidden;
    modelMenu.hidden = !willOpen;
    modelBtn.setAttribute('aria-expanded', String(willOpen));
  }

  // ---------------------------------------------------------------- depth chips
  function renderDepth() {
    document.querySelectorAll('#depthGroup .chip').forEach((b) => {
      const on = b.dataset.depth === prefs.depth;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }

  // ---------------------------------------------------------------- composer
  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 220) + 'px';
    input.dir = detectDir(input.value) === 'rtl' ? 'rtl' : 'auto';
  }
  function updateSendBtn() {
    if (state.streaming) {
      sendBtn.disabled = false;
      sendBtn.classList.add('stop');
      sendBtn.setAttribute('aria-label', 'Stop generating');
    } else {
      sendBtn.classList.remove('stop');
      sendBtn.disabled = !input.value.trim();
      sendBtn.setAttribute('aria-label', 'Send');
    }
  }

  // ---------------------------------------------------------------- AI
  function buildApiMessages(chat) {
    const msgs = [{ role: 'system', content: window.IDEORA_SYSTEM_PROMPT }];
    chat.messages.forEach((m, i) => {
      let content = m.content;
      if (m.role === 'user' && i === chat.messages.length - 1) {
        content += '\n\n[' + DEPTH_HINTS[m.depth || prefs.depth] + ']';
      }
      msgs.push({ role: m.role, content });
    });
    return msgs;
  }

  function errorText(err) {
    if (!err) return 'Unknown error';
    if (typeof err === 'string') return err;
    if (err.error) return typeof err.error === 'string' ? err.error : (err.error.message || JSON.stringify(err.error));
    if (err.message) return err.message;
    try { return JSON.stringify(err); } catch { return String(err); }
  }

  let abortCtrl = null;

  /** Streams an OpenAI-format SSE response from the Gemini API (via server.py). */
  async function streamFrom(model, apiMessages, onText, onThinking) {
    const ctrl = new AbortController();
    abortCtrl = ctrl;
    let timedOut = false, idleTimer;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { timedOut = true; ctrl.abort(); }, IDLE_TIMEOUT_MS);
    };
    const timeoutError = () => new Error(modelName(model) + ' did not respond in time.');
    armIdle();

    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: apiMessages, stream: true }),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(idleTimer);
      if (e.name === 'AbortError') { if (timedOut) throw timeoutError(); return false; }
      const err = new Error('Cannot reach the Ideora server. Is server.py running?');
      err.local = true;
      throw err;
    }
    if (!res.ok) {
      clearTimeout(idleTimer);
      let detail = res.status + ' ' + res.statusText, type = '';
      try { const j = await res.json(); detail = j.error?.message || detail; type = j.error?.type || ''; } catch {}
      const err = new Error(detail);
      err.status = res.status;
      err.local = type.startsWith('ideora_'); // our own limit/config error: other models won't help
      throw err;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', got = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        armIdle();
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') return got;
          let j;
          try { j = JSON.parse(data); } catch { continue; }
          if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
          const delta = j.choices?.[0]?.delta || {};
          if (delta.reasoning_content) onThinking();
          if (delta.content) { got = true; onText(delta.content); }
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') { if (timedOut && !got) throw timeoutError(); return got; }
      throw e;
    } finally {
      clearTimeout(idleTimer);
      if (abortCtrl === ctrl) abortCtrl = null;
    }
    return got;
  }

  async function generate() {
    const chat = activeChat();
    if (!chat || state.streaming) return;

    state.streaming = true;
    state.stopRequested = false;
    updateSendBtn();

    const apiMessages = buildApiMessages(chat);
    const msg = { role: 'assistant', content: '', model: prefs.model };

    const el = document.createElement('div');
    el.className = 'msg assistant streaming';
    el.innerHTML = '<div class="thinking"><span class="pulse"></span><span class="shimmer">Analyzing the market…</span></div><div class="content" dir="auto"></div>';
    messagesEl.appendChild(el);
    scrollToBottom();
    const contentEl = el.querySelector('.content');

    let pending = false;
    const flush = () => {
      pending = false;
      const stick = isNearBottom();
      contentEl.dir = detectDir(msg.content);
      contentEl.innerHTML = renderMarkdown(msg.content);
      if (stick) scrollToBottom();
    };
    const onText = (t) => {
      if (!msg.content) el.querySelector('.thinking')?.remove();
      msg.content += t;
      if (!pending) { pending = true; requestAnimationFrame(flush); }
    };
    const onThinking = () => {
      const s = el.querySelector('.shimmer');
      if (s && !msg.content) s.textContent = 'Thinking deeply about your market…';
    };

    const chain = [prefs.model, ...FALLBACKS.filter((m) => m !== prefs.model)];
    let lastErr = null, success = false;
    for (const model of chain) {
      if (state.stopRequested) break;
      try {
        msg.model = model;
        const got = await streamFrom(model, apiMessages, onText, onThinking);
        if (got || state.stopRequested) { success = true; break; }
        lastErr = 'The model returned an empty response.';
      } catch (err) {
        console.warn('Ideora: model ' + model + ' failed', err);
        lastErr = err;
        if (msg.content) { success = true; break; } // partial answer: keep it
        if (err.local) break; // our own server limit/config problem: other models won't help
      }
      if (!msg.content && model !== chain[chain.length - 1]) {
        const s = el.querySelector('.shimmer');
        if (s) s.textContent = modelName(model) + ' unavailable, trying another model…';
      }
    }

    const stopped = state.stopRequested;
    state.streaming = false;
    state.stopRequested = false;
    updateSendBtn();

    if (stopped && !msg.content) {
      el.remove();
    } else if (success && msg.content) {
      chat.messages.push(msg);
      chat.updated = Date.now();
      persist();
      renderHistory();
      el.replaceWith(buildMessage(msg, chat.messages.length - 1, chat));
      refreshRegenButtons();
      if (msg.model !== prefs.model) toast('Answered with ' + modelName(msg.model));
    } else if (!msg.content) {
      el.classList.remove('streaming');
      el.innerHTML = '<div class="error-box"><strong>Could not get an answer.</strong><br>' +
        escapeHtml(errorText(lastErr) || 'Stopped.') +
        '<br><button data-act="retry">Try again</button></div>';
    }
  }

  function refreshRegenButtons() {
    // only the final assistant message gets a regenerate button
    const chat = activeChat();
    if (!chat) return;
    messagesEl.querySelectorAll('.msg.assistant').forEach((node) => {
      const i = +node.dataset.index;
      if (chat.messages[i]) node.replaceWith(buildMessage(chat.messages[i], i, chat));
    });
  }

  // ---------------------------------------------------------------- actions
  function newChat() {
    if (state.streaming) stop();
    state.activeId = null;
    persistPrefs();
    renderHistory();
    renderThread();
    input.value = '';
    autosize();
    updateSendBtn();
    input.focus();
    closeSidebarOnMobile();
  }

  function openChat(id) {
    if (state.streaming) stop();
    state.activeId = id;
    persistPrefs();
    renderHistory();
    renderThread();
    closeSidebarOnMobile();
  }

  function send(text) {
    text = (text ?? input.value).trim();
    if (!text || state.streaming) return;
    let chat = activeChat();
    if (!chat) {
      chat = { id: uid(), title: titleFrom(text), created: Date.now(), updated: Date.now(), messages: [] };
      state.chats.push(chat);
      state.activeId = chat.id;
      persistPrefs();
    }
    chat.messages.push({ role: 'user', content: text, depth: prefs.depth });
    chat.updated = Date.now();
    input.value = '';
    autosize();
    persist();
    renderHistory();
    renderThread();
    generate();
  }

  function stop() {
    if (!state.streaming) return;
    state.stopRequested = true;
    if (abortCtrl) abortCtrl.abort();
  }

  function regenerate() {
    const chat = activeChat();
    if (!chat || state.streaming) return;
    if (chat.messages[chat.messages.length - 1]?.role === 'assistant') chat.messages.pop();
    persist();
    renderThread();
    generate();
  }

  function editMessage(index) {
    const chat = activeChat();
    if (!chat || state.streaming) return;
    const text = chat.messages[index].content;
    chat.messages.splice(index);
    persist();
    renderThread();
    input.value = text;
    autosize();
    updateSendBtn();
    input.focus();
  }

  function deleteChat(id) {
    state.chats = state.chats.filter((c) => c.id !== id);
    if (state.activeId === id) state.activeId = null;
    persist();
    persistPrefs();
    renderHistory();
    renderThread();
  }

  function startRename(id) {
    const item = historyEl.querySelector('.history-item[data-id="' + id + '"]');
    const chat = state.chats.find((c) => c.id === id);
    if (!item || !chat) return;
    const inp = document.createElement('input');
    inp.value = chat.title;
    inp.dir = 'auto';
    item.innerHTML = '';
    item.appendChild(inp);
    inp.focus();
    inp.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      if (save && inp.value.trim()) { chat.title = inp.value.trim().slice(0, 80); persist(); }
      renderHistory();
    };
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    inp.addEventListener('blur', () => finish(true));
  }

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
    }
    if (btn) {
      btn.innerHTML = ICON.check;
      setTimeout(() => (btn.innerHTML = ICON.copy), 1400);
    }
  }

  // ---------------------------------------------------------------- sidebar
  const isMobile = () => window.matchMedia('(max-width: 800px)').matches;
  function setSidebar(open, remember = true) {
    app.classList.toggle('sidebar-closed', !open);
    if (remember && !isMobile()) { prefs.sidebar = open; persistPrefs(); }
  }
  function closeSidebarOnMobile() { if (isMobile()) setSidebar(false, false); }

  // ---------------------------------------------------------------- events
  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    state.streaming ? stop() : send();
  });
  input.addEventListener('input', () => { autosize(); updateSendBtn(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isMobile()) {
      e.preventDefault();
      if (!state.streaming) send();
    }
  });

  $('newChatTop').addEventListener('click', newChat);
  $('newChatBrand').addEventListener('click', newChat);
  $('newChatMobile').addEventListener('click', newChat);
  $('openSidebar').addEventListener('click', () => setSidebar(true));
  $('closeSidebar').addEventListener('click', () => setSidebar(false));
  $('scrim').addEventListener('click', () => setSidebar(false, false));
  $('searchChats').addEventListener('input', (e) => { state.search = e.target.value; renderHistory(); });

  $('clearAll').addEventListener('click', () => {
    if (!state.chats.length) return toast('Nothing to clear');
    if (!confirm('Delete all chats saved in this browser? This cannot be undone.')) return;
    stop();
    state.chats = [];
    state.activeId = null;
    Store.clear();
    persistPrefs();
    updateMeter(0);
    renderHistory();
    renderThread();
    toast('All chats deleted');
  });

  modelBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleModelMenu(); });
  modelMenu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-model]');
    if (!b) return;
    prefs.model = b.dataset.model;
    persistPrefs();
    renderModelMenu();
    toggleModelMenu(false);
  });

  $('depthGroup').addEventListener('click', (e) => {
    const b = e.target.closest('[data-depth]');
    if (!b) return;
    prefs.depth = b.dataset.depth;
    persistPrefs();
    renderDepth();
  });

  // history clicks
  let menuTarget = null;
  historyEl.addEventListener('click', (e) => {
    const item = e.target.closest('.history-item');
    if (!item) return;
    const more = e.target.closest('.more');
    if (more) {
      e.stopPropagation();
      menuTarget = item.dataset.id;
      const r = more.getBoundingClientRect();
      itemMenu.hidden = false;
      itemMenu.style.top = Math.min(r.bottom + 4, window.innerHeight - 110) + 'px';
      itemMenu.style.left = Math.min(r.left, window.innerWidth - 160) + 'px';
      itemMenu.style.position = 'fixed';
      return;
    }
    if (e.target.closest('.title')) openChat(item.dataset.id);
  });
  historyEl.addEventListener('dblclick', (e) => {
    const item = e.target.closest('.history-item');
    if (item && e.target.closest('.title')) startRename(item.dataset.id);
  });
  itemMenu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || !menuTarget) return;
    itemMenu.hidden = true;
    if (b.dataset.act === 'rename') startRename(menuTarget);
    if (b.dataset.act === 'delete') {
      const c = state.chats.find((x) => x.id === menuTarget);
      if (c && confirm('Delete "' + c.title + '"?')) deleteChat(menuTarget);
    }
    menuTarget = null;
  });

  document.addEventListener('click', (e) => {
    if (!modelMenu.hidden && !e.target.closest('.model-picker')) toggleModelMenu(false);
    if (!itemMenu.hidden && !e.target.closest('#itemMenu')) { itemMenu.hidden = true; menuTarget = null; }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { toggleModelMenu(false); itemMenu.hidden = true; }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); newChat(); }
  });

  // message actions
  messagesEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const chat = activeChat();
    const msgEl = b.closest('.msg');
    const idx = msgEl ? +msgEl.dataset.index : -1;
    switch (b.dataset.act) {
      case 'copy': if (chat && chat.messages[idx]) copyText(chat.messages[idx].content, b); break;
      case 'regen': regenerate(); break;
      case 'edit': editMessage(idx); break;
      case 'retry': msgEl.remove(); generate(); break;
      case 'download': if (chat) downloadMarkdown(chat, idx); break;
      case 'print': if (chat) printMessage(chat, idx); break;
      case 'followup': {
        if (!chat) break;
        const f = FOLLOWUPS[+b.dataset.i];
        b.closest('.followups')?.remove();
        send(f[chatLang(chat)]);
        break;
      }
    }
  });

  // suggestions
  $('suggestions').innerHTML = SUGGESTIONS.map((s, i) =>
    '<button class="suggestion" data-i="' + i + '"><span>' + s.icon + '</span>' + escapeHtml(s.label) + '</button>').join('');
  $('suggestions').addEventListener('click', (e) => {
    const b = e.target.closest('.suggestion');
    if (!b) return;
    input.value = SUGGESTIONS[+b.dataset.i].text;
    autosize();
    updateSendBtn();
    input.focus();
  });

  // ---------------------------------------------------------------- boot
  if (!cookiesWork()) {
    const banner = $('cookieBanner');
    banner.hidden = false;
    banner.innerHTML = location.protocol === 'file:'
      ? '<strong>Cookies are disabled for local files.</strong> Run the site from a local web server (see README) so your chats can be saved.'
      : '<strong>Cookies are blocked in this browser.</strong> Ideora will still work, but chats will not be saved.';
  }
  fetch('/api/health').then((r) => r.json()).then((h) => {
    if (!h.key_configured) throw new Error('key');
  }).catch(() => {
    const banner = $('cookieBanner');
    banner.hidden = false;
    banner.innerHTML += (banner.innerHTML ? '<br>' : '') +
      '<strong>AI backend not configured.</strong> Start Ideora with <code>python server.py</code> and set GEMINI_API_KEY in ideora.env.';
  });

  setSidebar(isMobile() ? false : prefs.sidebar !== false, false);
  renderModelMenu();
  renderDepth();
  renderHistory();
  renderThread();
  updateSendBtn();
  updateMeter(Store.usedChunks / MAX_CHUNKS);
  input.focus();
})();
