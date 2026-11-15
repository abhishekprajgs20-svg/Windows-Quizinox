// QUIZINOX AI engine (v2.5)
// Gemini FREE-tier aware client:
//  • multiple API keys with automatic failover (one key fails → next key is used)
//  • per-key / per-model pacing that stays below Google's free limits (80% safety margin)
//  • automatic model fallback when a model is busy, missing or out of free quota
//  • small local response cache so repeated questions never spend quota again
// Nothing here runs unless the user taps an AI button.

export const MODELS = {
  'gemini-2.5-flash': { rpm: 10, rpd: 250, name: 'Gemini 2.5 Flash', note: 'Best balance (recommended)' },
  'gemini-2.5-flash-lite': { rpm: 15, rpd: 1000, name: 'Gemini 2.5 Flash-Lite', note: 'Highest free daily quota' },
  'gemini-2.0-flash': { rpm: 15, rpd: 200, name: 'Gemini 2.0 Flash', note: 'Older, fast' },
  'gemini-2.0-flash-lite': { rpm: 30, rpd: 200, name: 'Gemini 2.0 Flash-Lite', note: 'Older, very fast' },
  'gemini-2.5-pro': { rpm: 5, rpd: 100, name: 'Gemini 2.5 Pro', note: 'Smartest, very small free quota' },
};
export const FALLBACK_CHAIN = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-2.0-flash-lite'];
export const SAFETY = 0.8;
const DEFAULT_LIMIT = { rpm: 5, rpd: 100, name: '' };
const USAGE_KEY = 'quizinox_ai_usage_v2';
const CACHE_KEY = 'quizinox_ai_cache_v1';
const CACHE_MAX = 160;
const REQUEST_TIMEOUT = 90000;
const MAX_WAIT_FOR_SLOT = 30000;

let ctx = { getSettings: () => ({}), saveSettings: () => {} };
export function initAI(c) { ctx = { ...ctx, ...c }; }

export class AIError extends Error { constructor(message, code = 'error') { super(message); this.code = code; } }

export const limitsFor = m => ({ ...DEFAULT_LIMIT, name: m, ...(MODELS[m] || {}) });
export const safeCap = n => Math.max(1, Math.floor(n * SAFETY));
export function pacificDay(d = new Date()) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }
  catch { return d.toISOString().slice(0, 10); }
}
export function hash(str) {
  let h1 = 2166136261, h2 = 2246822519; const s = String(str);
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 ^ c, 3266489917); }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

/* ---------------- usage bookkeeping (separate small storage key) ---------------- */
function loadUsage() { try { const u = JSON.parse(localStorage.getItem(USAGE_KEY) || '{}'); return u && typeof u === 'object' ? u : {}; } catch { return {}; } }
function saveUsage(u) { try { localStorage.setItem(USAGE_KEY, JSON.stringify(u)); } catch { /* ignore */ } }
function slot(u, keyId, model) {
  const day = pacificDay();
  u[keyId] ||= {};
  const s = (u[keyId][model] ||= { day, count: 0, recent: [], cooldownUntil: 0, dayBlocked: '' });
  if (s.day !== day) { s.day = day; s.count = 0; s.dayBlocked = ''; }
  const cutoff = Date.now() - 60000; s.recent = (s.recent || []).filter(t => t > cutoff);
  return s;
}
function patchSlot(keyId, model, fn) { const u = loadUsage(); fn(slot(u, keyId, model)); saveUsage(u); }
export function resetUsageFlags() { const u = loadUsage(); for (const k of Object.values(u)) for (const s of Object.values(k)) { s.cooldownUntil = 0; s.dayBlocked = ''; } saveUsage(u); }
export function forgetKeyUsage(keyId) { const u = loadUsage(); delete u[keyId]; saveUsage(u); }

export function getKeys() { return (ctx.getSettings().aiKeys || []).filter(k => k && k.key); }
function updateKey(id, patch) { const k = (ctx.getSettings().aiKeys || []).find(x => x.id === id); if (k) { Object.assign(k, patch); ctx.saveSettings(); } }

export function keyAvailability(k, model) {
  const u = loadUsage(); const s = slot(u, k.id, model); const L = limitsFor(model); const now = Date.now();
  if (k.enabled === false) return { ok: false, reason: 'disabled', used: s.count };
  if (k.status === 'invalid') return { ok: false, reason: 'invalid', used: s.count };
  if (s.dayBlocked === pacificDay() || s.count >= safeCap(L.rpd)) return { ok: false, reason: 'daily', used: s.count };
  if (s.cooldownUntil > now) return { ok: false, reason: 'cooldown', wait: s.cooldownUntil - now, used: s.count };
  if (s.recent.length >= safeCap(L.rpm)) return { ok: false, reason: 'minute', wait: s.recent[0] + 60000 - now + 300, used: s.count };
  return { ok: true, used: s.count };
}
/** Per key: today's request count per model, for the Settings screen. */
export function usageSummary() {
  const u = loadUsage(); const day = pacificDay();
  return getKeys().map(k => {
    const models = {}; let total = 0;
    for (const [m, s] of Object.entries(u[k.id] || {})) { if (s.day !== day) continue; models[m] = s.count; total += s.count; }
    return { id: k.id, total, models };
  });
}
export function todayTotal() { return usageSummary().reduce((n, k) => n + k.total, 0); }
/** How many more requests today are possible on `model` across all healthy keys (safety-capped). */
export function remainingToday(model) {
  const L = limitsFor(model); const u = loadUsage(); const day = pacificDay(); let n = 0;
  for (const k of getKeys()) { if (k.enabled === false || k.status === 'invalid') continue; const s = u[k.id]?.[model]; if (s && s.day === day && s.dayBlocked === day) continue; n += Math.max(0, safeCap(L.rpd) - (s && s.day === day ? s.count : 0)); }
  return n;
}

/* ---------------- response cache ---------------- */
function loadCache() { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {}; } catch { return {}; } }
export function cacheGet(key) { const c = loadCache(); return c[key]?.v ?? null; }
export function cacheSet(key, v) {
  const c = loadCache(); c[key] = { v, t: Date.now() };
  const keys = Object.keys(c); if (keys.length > CACHE_MAX) keys.sort((a, b) => c[a].t - c[b].t).slice(0, keys.length - CACHE_MAX).forEach(k => delete c[k]);
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch { try { localStorage.removeItem(CACHE_KEY); } catch { /* */ } }
}
export function clearCache() { try { localStorage.removeItem(CACHE_KEY); } catch { /* */ } }

/* ---------------- helpers ---------------- */
const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new AIError('Cancelled', 'abort')); }, { once: true });
});
function parseQuotaError(body) {
  const det = body?.error?.details || []; let delay = 0, daily = false;
  for (const x of det) {
    if (x.retryDelay) delay = parseFloat(x.retryDelay) * 1000 || 0;
    for (const v of x.violations || []) if (/PerDay/i.test(v.quotaId || '') || /per_?day/i.test(v.quotaMetric || '')) daily = true;
  }
  const msg = body?.error?.message || '';
  if (/per day|daily/i.test(msg)) daily = true;
  const m = msg.match(/retry in ([\d.]+)\s*s/i); if (!delay && m) delay = parseFloat(m[1]) * 1000;
  return { delay, daily };
}
/** Robust JSON extraction: strips code fences and repairs a truncated {"questions":[...]} array. */
export function parseJsonLoose(raw) {
  const t = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  try { return JSON.parse(t); } catch { /* continue */ }
  const i = t.search(/[[{]/); if (i < 0) throw new AIError('AI did not return JSON', 'parse');
  const j = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch { /* continue */ } }
  let end = t.lastIndexOf('}'), tries = 0;
  while (end > i && tries++ < 40) {
    for (const tail of [']}', ']', '}']) { try { return JSON.parse(t.slice(i, end + 1) + tail); } catch { /* next */ } }
    end = t.lastIndexOf('}', end - 1);
  }
  throw new AIError('AI response was cut off or not valid JSON. Try fewer questions.', 'parse');
}

async function request(key, model, prompt, { json, maxTokens, temperature, signal, system }) {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort('timeout'), REQUEST_TIMEOUT);
  const onAbort = () => ctrl.abort('user'); signal?.addEventListener('abort', onAbort, { once: true });
  const generationConfig = { temperature, maxOutputTokens: maxTokens };
  if (json) generationConfig.responseMimeType = 'application/json';
  // Gemini 2.5 Flash "thinking" spends free output tokens; switch it off for quick tasks.
  if (/^gemini-2\.5-flash/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  const payload = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig };
  if (system) payload.systemInstruction = { parts: [{ text: system }] };
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(payload),
    });
    let body = null; try { body = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, ok: res.ok, body };
  } catch (e) {
    if (signal?.aborted) throw new AIError('Cancelled', 'abort');
    if (ctrl.signal.aborted) throw new AIError('AI request timed out', 'timeout');
    throw new AIError('Network error while contacting Gemini', 'network');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}

/**
 * Main entry. Returns { text, model, keyLabel }.
 * opts: json, maxTokens, temperature, model (preferred), signal, onStatus(msg), system
 */
export async function aiCall(prompt, opts = {}) {
  const { json = true, maxTokens = 2048, temperature = json ? 0.6 : 0.4, model, signal, onStatus = () => {}, system } = opts;
  if (typeof navigator !== 'undefined' && !navigator.onLine) throw new AIError('No internet connection. AI needs internet — all offline features still work.', 'offline');
  const keys = getKeys().filter(k => k.enabled !== false);
  if (!keys.length) throw new AIError('Add at least one Gemini API key in Settings → AI keys.', 'nokey');
  if (!keys.some(k => k.status !== 'invalid')) throw new AIError('All saved Gemini keys are marked invalid. Re-check them in Settings.', 'nokey');
  const st = ctx.getSettings();
  const primary = model || st.aiModel || FALLBACK_CHAIN[0];
  const chain = [...new Set([primary, ...(st.aiAutoFallback === false ? [] : FALLBACK_CHAIN)])];
  let lastErr = null; let sawLimit = false;
  for (const m of chain) {
    let overload = 0, guard = 0, modelMissing = false;
    while (guard++ < keys.length * 3 + 6) {
      if (signal?.aborted) throw new AIError('Cancelled', 'abort');
      const avail = keys.map(k => ({ k, a: keyAvailability(k, m) }));
      const ready = avail.filter(x => x.a.ok).sort((x, y) => x.a.used - y.a.used);
      if (!ready.length) {
        if (avail.some(x => x.a.reason === 'daily' || x.a.reason === 'minute' || x.a.reason === 'cooldown')) sawLimit = true;
        const waits = avail.filter(x => x.a.reason === 'minute' || x.a.reason === 'cooldown').map(x => x.a.wait);
        const w = waits.length ? Math.min(...waits) : Infinity;
        if (w <= MAX_WAIT_FOR_SLOT) { onStatus(`Staying inside the free limit — waiting ${Math.ceil(w / 1000)}s…`); await sleep(w, signal); continue; }
        break; // nothing usable on this model now → next model
      }
      const { k } = ready[0];
      patchSlot(k.id, m, s => { s.recent.push(Date.now()); s.count++; });
      onStatus(`Asking ${limitsFor(m).name}${keys.length > 1 ? ` · key "${k.label || 'key'}"` : ''}…`);
      let r;
      try { r = await request(k.key, m, prompt, { json, maxTokens, temperature, signal, system }); }
      catch (e) {
        if (e.code === 'abort') throw e;
        lastErr = e;
        if (typeof navigator !== 'undefined' && !navigator.onLine) throw new AIError('Internet connection lost.', 'offline');
        patchSlot(k.id, m, s => { s.cooldownUntil = Date.now() + 8000; });
        continue;
      }
      const msg = r.body?.error?.message || `Gemini error ${r.status}`;
      if (r.ok) {
        const cand = r.body?.candidates?.[0];
        const text = (cand?.content?.parts || []).map(p => p.text || '').join('');
        if (!text) {
          const reason = cand?.finishReason || r.body?.promptFeedback?.blockReason;
          if (/SAFETY|PROHIBITED|BLOCK|RECITATION/i.test(reason || '')) throw new AIError('Gemini declined to answer this request (safety filter). Try rephrasing.', 'blocked');
          lastErr = new AIError('Empty AI response', 'empty'); patchSlot(k.id, m, s => { s.cooldownUntil = Date.now() + 4000; }); continue;
        }
        if (k.status !== 'ok' || k.lastError) updateKey(k.id, { status: 'ok', lastError: '', checkedAt: Date.now() });
        return { text, model: m, keyLabel: k.label, truncated: cand?.finishReason === 'MAX_TOKENS' };
      }
      if (r.status === 429) {
        const q = parseQuotaError(r.body); sawLimit = true;
        patchSlot(k.id, m, s => { if (q.daily) s.dayBlocked = pacificDay(); else s.cooldownUntil = Date.now() + Math.max(q.delay || 0, 20000); });
        updateKey(k.id, { status: 'limited', lastError: q.daily ? `Daily free limit reached on ${m}` : `Rate-limited on ${m}` });
        lastErr = new AIError('Gemini free limit reached.', 'limit');
        continue;
      }
      if (r.status === 400 && /api key|API_KEY/i.test(msg + JSON.stringify(r.body?.error?.details || ''))) {
        updateKey(k.id, { status: 'invalid', lastError: 'API key not valid' }); lastErr = new AIError('An API key is invalid.', 'invalid'); continue;
      }
      if (r.status === 401 || r.status === 403) {
        updateKey(k.id, { status: 'invalid', lastError: msg.slice(0, 160) }); lastErr = new AIError(`Key rejected: ${msg}`, 'invalid'); continue;
      }
      if (r.status === 404) { lastErr = new AIError(`Model "${m}" is not available for this key.`, 'model'); modelMissing = true; break; }
      if (r.status >= 500) {
        overload++; patchSlot(k.id, m, s => { s.cooldownUntil = Date.now() + 15000; });
        lastErr = new AIError('Gemini is overloaded right now.', 'overload');
        if (overload >= 2) break; continue;
      }
      lastErr = new AIError(msg, 'bad'); break; // other 4xx: try next model
    }
    if (modelMissing) onStatus(`Model ${m} unavailable — trying another…`);
  }
  if (sawLimit) throw new AIError('All your Gemini keys have reached the free limit for now. Wait a minute (or until tomorrow for daily limits), or add another key in Settings.', 'limit');
  throw lastErr || new AIError('AI request failed', 'error');
}

/** Test one key with a tiny request (uses 1 request of quota). */
export async function testKey(id, model) {
  const k = getKeys().find(x => x.id === id); if (!k) throw new AIError('Key not found', 'nokey');
  const m = model || ctx.getSettings().aiModel || FALLBACK_CHAIN[0];
  patchSlot(k.id, m, s => { s.recent.push(Date.now()); s.count++; });
  const r = await request(k.key, m, 'Reply with the single word OK', { json: false, maxTokens: 10, temperature: 0 });
  if (r.ok) { updateKey(k.id, { status: 'ok', lastError: '', checkedAt: Date.now() }); return { ok: true, model: m }; }
  const msg = r.body?.error?.message || `HTTP ${r.status}`;
  if (r.status === 429) { const q = parseQuotaError(r.body); patchSlot(k.id, m, s => { if (q.daily) s.dayBlocked = pacificDay(); else s.cooldownUntil = Date.now() + Math.max(q.delay || 0, 20000); }); updateKey(k.id, { status: 'limited', lastError: q.daily ? 'Daily free limit reached' : 'Rate-limited' }); return { ok: false, limited: true, message: 'Key works but its free limit is reached right now.' }; }
  if (r.status === 404) return { ok: false, message: `Model ${m} not available for this key — choose another model.` };
  if (r.status === 400 || r.status === 401 || r.status === 403) { updateKey(k.id, { status: 'invalid', lastError: msg.slice(0, 160) }); return { ok: false, message: msg }; }
  return { ok: false, message: msg };
}
