import './style.css';
import { fixQuestionsFile, convertFormat, parseText as parseMcqText } from './text-tools.js';
import { saveFile, shareFile, onBackButton, isNative } from './native.js';
import * as AI from './ai.js';
const iconUrl = './quizinox-icon.png';
// Keep the quiz/player startup bundle light. PDF engines and jsPDF are loaded
// only when a user actually opens a PDF/export feature (important on low-RAM PCs).
let pdfEnginesPromise = null, jsPdfPromise = null;
const getPdfEngines = () => pdfEnginesPromise ||= import('./pdf-engines.js');
const getJsPDF = () => jsPdfPromise ||= import('jspdf').then(m => ({ jsPDF: m.jsPDF }));
if (isNative()) document.documentElement.classList.add('native-app');

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const escMl = s => esc(s).replace(/\n/g, '<br>');
function explanationLines(value) {
  let text = String(value ?? '').replace(/\r\n?/g, '\n').trim();
  if (!text) return '';
  // Keep existing numbered/bulleted points on their own lines.
  text = text.replace(/\s+(?=(?:\d{1,2}[.)]|\(\d{1,2}\)|[a-z][.)]|\([ivxlcdm]+\)|[•●▪◦*\-])\s+)/gi, '\n');

  // Split prose at sentence endings so each full-stop-delimited point is
  // readable on its own line. Protect decimals, common abbreviations and
  // numbered-list markers (for example, "1. First point") from false splits.
  const dot = '\uE000';
  text = text
    .replace(/\b(?:e\.g|i\.e|etc|mr|mrs|ms|dr|prof|vs|no|fig|approx|u\.s|u\.k)\./gi, m => m.replace(/\./g, dot))
    .replace(/(\d)\.(?=\d)/g, `$1${dot}`)
    .replace(/(^|\s)(\d{1,2})\.(?=\s)/gm, `$1$2${dot}`);
  text = text.split(/(?<=[.!?])[\t ]+|\n+/).map(line => line.trim()).filter(Boolean).join('\n');
  return text.replaceAll(dot, '.');
}
const L = i => String.fromCharCode(65 + i);
const STORE = 'quizinox_local_v1', PLAY_STORE = 'quizinox_play_v1';
const APP_VERSION = '2.5.0';
const defaultState = () => ({ quizzes: [], attempts: [], shuffleHistory: {}, bookmarks: {}, revision: {}, revStats: { mastered: 0 }, aiAnalysis: null, aiLog: {}, settings: { name: 'Learner', geminiKey: '', aiKeys: [], aiModel: AI.FALLBACK_CHAIN[0], aiAutoFallback: true, analystDaily: 5, tutorLang: 'English', langMode: 'single', langs: ['original'] }, activeTab: 'home' });
let db = load();
let currentQuiz = null, play = null, toastTimer = null, lastResult = null;
AI.initAI({ getSettings: () => db.settings, saveSettings: () => save() });

function normalizeState(d) {
  const base = defaultState(); d = d && typeof d === 'object' ? d : {};
  const obj = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const s = { ...base, ...d, settings: { ...base.settings, ...obj(d.settings) }, quizzes: Array.isArray(d.quizzes) ? d.quizzes : [], attempts: Array.isArray(d.attempts) ? d.attempts : [], shuffleHistory: obj(d.shuffleHistory), bookmarks: obj(d.bookmarks), revision: obj(d.revision), revStats: { mastered: 0, ...obj(d.revStats) }, aiLog: obj(d.aiLog) };
  if (!Array.isArray(s.settings.aiKeys)) s.settings.aiKeys = [];
  // v2.4 → v2.5: single Gemini key becomes the first entry of the multi-key list
  if (s.settings.geminiKey && !s.settings.aiKeys.some(k => k.key === s.settings.geminiKey)) s.settings.aiKeys.push({ id: uid(), label: 'Key 1', key: s.settings.geminiKey, enabled: true, status: 'unknown' });
  s.settings.geminiKey = '';
  if (!Array.isArray(s.settings.langs) || !s.settings.langs.length) s.settings.langs = ['original'];
  return s;
}
function load() {
  try { return normalizeState(JSON.parse(localStorage.getItem(STORE) || '{}')); }
  catch { return defaultState(); }
}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify(db)); }
  catch (e) {
    // Storage full: drop the oldest attempt details and try again
    if (db.attempts.length > 20) { db.attempts = db.attempts.slice(0, 20); try { localStorage.setItem(STORE, JSON.stringify(db)); toast('Storage was full — older attempts trimmed'); } catch { toast('Storage full. Export a backup and delete old quizzes.'); } }
    else toast('Storage full. Export a backup and delete old quizzes.');
  }
  updateCounts();
}
// Per-question time tracking (time while the app is in the background is not counted)
function tickTime(p = play) { if (!p || p.finished) return; const now = Date.now(); if (p.qEnter && !p.away) { p.qTime ||= {}; p.qTime[p.index] = (p.qTime[p.index] || 0) + Math.min(now - p.qEnter, 30 * 60000); } p.qEnter = now; }
function savePlay() { try { if (play && !play.finished) { tickTime(play); localStorage.setItem(PLAY_STORE, JSON.stringify({ ...play, interval: null })); } else localStorage.removeItem(PLAY_STORE); } catch { /* ignore */ } }
function updateCounts() { const q = $('#quizCount'); if (q) q.textContent = db.quizzes.length; const r = $('#revCount'); if (r) { const n = dueItems().length; r.textContent = n; r.hidden = !n; } }
function toast(msg, ms = 2800) { const el = $('#toast'); if (!el) return; el.textContent = msg; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), ms); }
function question(text = '', options = ['', '', '', ''], correct = 0, explanation = '', topic = '') { return { id: uid(), text, options, correct: Number(correct) || 0, explanation, topic }; }
function quizTemplate(title = 'Untitled Quiz') { const now = new Date().toISOString(); return { id: uid(), title, description: '', subject: 'General', createdAt: now, updatedAt: now, settings: { timer: 0, negative: 0, shuffleQ: false, shuffleO: false, pass: 40 }, questions: [] }; }
const parseText = t => parseMcqText(t, question);

/* ------------------------------ MODALS ------------------------------ */
function modal(html, { wide = false } = {}) {
  const m = document.createElement('div'); m.className = 'mode-overlay';
  m.innerHTML = `<div class="mode-dialog ${wide ? 'wide' : ''}"><button class="mode-close" aria-label="Close">×</button>${html}</div>`;
  document.body.appendChild(m);
  const close = () => m.remove();
  $('.mode-close', m).onclick = close; m.addEventListener('click', e => { if (e.target === m) close(); });
  return { el: m, close };
}
function actionSheet(title, subtitle, actions) {
  const { el, close } = modal(`<div class="eyebrow">QUICK ACTIONS</div><h2>${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}${actions.map((a, i) => `<button class="mode-choice ${a.danger ? 'danger-choice' : ''}" data-act="${i}"><span class="mode-icon ${a.cls || 'exam-icon'}">${a.icon}</span><span><b>${esc(a.label)}</b>${a.hint ? `<small>${esc(a.hint)}</small>` : ''}</span><span class="mode-arrow">→</span></button>`).join('')}`);
  $$('[data-act]', el).forEach(b => b.onclick = () => { close(); actions[Number(b.dataset.act)].run(); });
}
function confirmBox(title, text, okLabel = 'Yes', danger = false) {
  return new Promise(res => {
    const { el, close } = modal(`<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="dialog-actions"><button class="secondary" data-no>Cancel</button><button class="${danger ? 'primary danger-btn' : 'primary'}" data-yes>${esc(okLabel)}</button></div>`);
    const done = v => { close(); res(v); };
    $('[data-yes]', el).onclick = () => done(true); $('[data-no]', el).onclick = () => done(false); $('.mode-close', el).onclick = () => done(false);
  });
}

/* ------------------------------ SHELL ------------------------------ */
document.querySelector('#app').innerHTML = `
<div class="shell">
  <aside class="sidebar">
    <div class="brand"><img class="brandlogo" src="${iconUrl}" alt="QUIZINOX"/><div><b>QUIZINOX</b><small>LEARN · PRACTISE · WIN</small></div></div>
    <div class="profile"><div class="avatar">✦</div><div><b id="profileName">Learner</b><small>Personal workspace</small></div></div>
    <nav class="nav">
      <button class="navitem active" data-tab="home"><span>⌂</span> Overview</button>
      <button class="navitem" data-tab="quizzes"><span>▤</span> My Quizzes <em id="quizCount">0</em></button>
      <button class="navitem" data-tab="create"><span>＋</span> Create Quiz</button>
      <button class="navitem" data-tab="revision"><span>↻</span> Revision <em id="revCount" class="hot" hidden>0</em></button>
      <button class="navitem" data-tab="search"><span>⌕</span> Question Search</button>
      <button class="navitem" data-tab="reports"><span>▥</span> Analytics</button>
      <button class="navitem" data-tab="ai"><span>✦</span> AI Studio</button>
      <button class="navitem" data-tab="tools"><span>⌘</span> File Studio</button>
      <button class="navitem" data-tab="settings"><span>⚙</span> Settings</button>
    </nav>
    <div class="sidebottom"><div class="offline-pill"><i></i> Works offline</div><small>All quiz data stays on this device. AI tools use the internet only when you start them.</small><div class="version">QUIZINOX · v${APP_VERSION}</div></div>
  </aside>
  <main class="main">
    <header class="topbar"><button class="mobile-brand" data-tab="home"><img src="${iconUrl}" alt=""/> <b>QUIZINOX</b></button><div class="crumb" id="crumb">Your learning space</div><div class="top-actions"><span class="online-state" id="netState"><i></i> OFFLINE</span><button class="iconbtn" id="quickImport" title="Import">⇧</button><button class="avatar small" data-tab="settings">⚙</button></div></header>
    <section class="content" id="view"></section>
  </main>
</div>
<div class="mobile-nav">
 <button data-tab="home" class="active"><span>⌂</span>Home</button><button data-tab="quizzes"><span>▤</span>Quizzes</button><button data-tab="revision"><span>↻</span>Revise</button><button data-tab="search"><span>⌕</span>Search</button><button data-tab="reports"><span>▥</span>Reports</button><button data-more><span>☰</span>More</button>
</div>
<div id="toast" class="toast"></div>
<input type="file" id="fileInput" accept=".txt,.json,.pdf,text/plain,application/json,application/pdf" hidden/>
<input type="file" id="restoreInput" accept=".json,application/json" hidden/>
`;

const view = $('#view');
const labels = { home: 'Your learning space', quizzes: 'Your quiz library', create: 'Quiz studio', revision: 'Automatic revision', search: 'Question bank search', reports: 'Performance analytics', ai: 'AI study studio', tools: 'File studio', settings: 'Preferences' };
const MORE_TABS = ['create', 'ai', 'tools', 'settings'];
function markNav(tab) { $$('.navitem,.mobile-nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab || (b.hasAttribute('data-more') && MORE_TABS.includes(tab)))); }
function scrollTop() { window.scrollTo(0, 0); $('.main')?.scrollTo?.(0, 0); }
function setTab(tab) { if (play) return; db.activeTab = tab; save(); markNav(tab); $('#crumb').textContent = labels[tab] || 'QUIZINOX'; lastResult = null; render(); scrollTop(); }
$('[data-more]').addEventListener('click', () => { if (play) return toast('Finish or exit the quiz first'); actionSheet('More', '', [
  { icon: '＋', label: 'Create quiz', hint: 'Build or paste questions', run: () => setTab('create') },
  { icon: '✦', label: 'AI Studio', hint: 'Analyst · tutor · question generator', cls: 'practice-icon', run: () => setTab('ai') },
  { icon: '⌘', label: 'File Studio', hint: 'PDF → TXT, import, export, backup', run: () => setTab('tools') },
  { icon: '⚙', label: 'Settings', hint: 'Profile, AI keys, languages, data', cls: 'practice-icon', run: () => setTab('settings') },
]); });
$$('[data-tab]').forEach(b => b.addEventListener('click', () => { if (play) return toast('Finish or exit the quiz first'); setTab(b.dataset.tab); }));
$('#quickImport').onclick = () => $('#fileInput').click();
$('#fileInput').addEventListener('change', async e => { if (e.target.files[0]) await importFile(e.target.files[0]); e.target.value = ''; });
$('#restoreInput').addEventListener('change', async e => { if (e.target.files[0]) await restoreBackup(e.target.files[0]); e.target.value = ''; });
$('#profileName').textContent = db.settings.name || 'Learner';

function updateNet() { const on = navigator.onLine, el = $('#netState'); if (!el) return; el.classList.toggle('is-online', on); el.innerHTML = `<i></i> ${on ? 'ONLINE' : 'OFFLINE'}`; el.title = on ? 'Internet available — AI tools can be used' : 'No internet — all offline features still work'; }
window.addEventListener('online', () => { updateNet(); toast('Back online — AI tools available'); });
window.addEventListener('offline', () => { updateNet(); toast('Offline — your quizzes keep working'); });
updateNet();

function render() { if (play) { renderPlayer(); return; } const tab = db.activeTab || 'home'; markNav(tab); ({ home, quizzes: library, create: () => creator(), revision: revisionPage, search: searchPage, reports, ai: aiStudio, tools, settings }[tab] || home)(); }

/* ------------------------------ HOME ------------------------------ */
function home() {
  const totalQ = db.quizzes.reduce((n, q) => n + q.questions.length, 0), avg = db.attempts.length ? Math.round(db.attempts.reduce((n, a) => n + a.percent, 0) / db.attempts.length) : 0;
  const saved = (() => { try { return JSON.parse(localStorage.getItem(PLAY_STORE) || 'null'); } catch { return null; } })();
  view.innerHTML = `
 ${saved && (saved.quiz?.isRevision || db.quizzes.some(q => q.id === saved.quiz?.id)) ? `<div class="resume-bar"><span>⏸ Unfinished attempt: <b>${esc(saved.quiz.title)}</b> · ${Object.keys(saved.answers || {}).length}/${saved.questions.length} answered · continue at Q${(saved.index || 0) + 1}${saved.lastAnswered != null ? ` (last answered Q${saved.lastAnswered + 1})` : ''}</span><div><button class="secondary" id="discardResume">Discard</button><button class="primary" id="resumeQuiz">Resume →</button></div></div>` : ''}
 ${(() => { const n = dueItems().length; return n ? `<div class="resume-bar revise-bar"><span>↻ <b>${n} question${n > 1 ? 's' : ''}</b> due for revision today (1 → 3 → 7 → 15 day cycle)</span><div><button class="primary" id="homeRevise">Revise now →</button></div></div>` : ''; })()}
 <div class="hero"><div class="hero-copy"><div class="eyebrow">✦ YOUR PERSONAL QUIZ COMMAND CENTRE</div><h1>Learn smarter.<br><span>Score higher.</span></h1><p>Create powerful tests, practise anywhere and track your progress — with or without internet.</p><div class="hero-actions"><button class="primary" id="heroCreate">＋ Create a quiz</button><button class="ghost light" id="heroImport">⇧ Import questions</button></div></div><div class="hero-art"><div class="orbit orbit1"></div><div class="orbit orbit2"></div><img class="hero-logo" src="${iconUrl}" alt=""/><div class="float-card fc1">⚡ <b>Focus mode</b></div><div class="float-card fc2">✓ <b>Offline ready</b></div><div class="hero-stat"><strong>${db.quizzes.length}</strong><small>QUIZZES SAVED</small></div></div></div>
 <div class="section-head"><div><div class="eyebrow">AT A GLANCE</div><h2>Your dashboard</h2></div><span class="muted">Stored securely on this phone</span></div>
 <div class="stats-grid"><div class="stat-card"><div class="stat-icon purple">▤</div><small>MY QUIZZES</small><strong>${db.quizzes.length}</strong><span>${totalQ} questions ready</span></div><div class="stat-card"><div class="stat-icon blue">◷</div><small>ATTEMPTS</small><strong>${db.attempts.length}</strong><span>Practice sessions</span></div><div class="stat-card"><div class="stat-icon green">↗</div><small>AVERAGE SCORE</small><strong>${avg}%</strong><span>Across all attempts</span></div><div class="stat-card"><div class="stat-icon amber">↻</div><small>IN REVISION</small><strong>${Object.keys(db.revision).length}</strong><span>${dueItems().length} due now · ${db.revStats.mastered || 0} mastered</span></div></div>
 <div class="two-col"><div class="panel"><div class="panel-head"><div><h3>Recent quizzes</h3><p>Pick up where you left off</p></div><button class="textbtn" id="seeAll">View all →</button></div>${db.quizzes.length ? db.quizzes.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 4).map(quizRow).join('') : '<div class="empty-mini"><span>▤</span><b>No quizzes yet</b><small>Create your first quiz or import a file.</small></div>'}</div><div class="panel insight"><div class="panel-head"><div><h3>Quick actions</h3><p>Everything you need, one tap away</p></div><span class="spark">✦</span></div><button class="action-tile" id="actCreate"><span class="tileicon">＋</span><span><b>Build a quiz</b><small>Create questions manually</small></span><span class="arrow">↗</span></button><button class="action-tile" id="actImport"><span class="tileicon bluebg">⇧</span><span><b>Import a file</b><small>TXT, JSON or PDF</small></span><span class="arrow">↗</span></button><button class="action-tile" id="actPdf"><span class="tileicon amberbg">📄</span><span><b>Coaching PDF → TXT</b><small>SFG · Vajiram · VisionIAS · any PDF</small></span><span class="arrow">↗</span></button><button class="action-tile" id="actReports"><span class="tileicon greenbg">▥</span><span><b>View performance</b><small>Accuracy, speed, subject & topic analysis</small></span><span class="arrow">↗</span></button><button class="action-tile" id="actAi"><span class="tileicon">✦</span><span><b>AI Study Studio</b><small>Analyst · Ask AI tutor · question generator</small></span><span class="arrow">↗</span></button><button class="action-tile" id="actSearch"><span class="tileicon bluebg">⌕</span><span><b>Search question bank</b><small>Find any question by keyword</small></span><span class="arrow">↗</span></button></div></div>
 <div class="footer-note">🔒 Private by design · No account · Works offline · AI optional</div>`;
  $('#heroCreate').onclick = () => setTab('create'); $('#heroImport').onclick = () => $('#fileInput').click(); $('#seeAll').onclick = () => setTab('quizzes'); $('#actCreate').onclick = () => setTab('create'); $('#actImport').onclick = () => $('#fileInput').click(); $('#actReports').onclick = () => setTab('reports'); $('#actPdf').onclick = () => openPdfStudio();
  $('#resumeQuiz')?.addEventListener('click', resumeQuiz); $('#discardResume')?.addEventListener('click', () => { localStorage.removeItem(PLAY_STORE); home(); });
  $('#homeRevise')?.addEventListener('click', () => startRevision('due')); $('#actAi').onclick = () => setTab('ai'); $('#actSearch').onclick = () => setTab('search');
  wireQuizRows();
}
function quizRow(q) { return `<div class="quiz-row" data-open="${q.id}"><div class="quiz-symbol">▤</div><div class="quiz-info"><b>${esc(q.title)}</b><small>${q.questions.length} questions · ${esc(q.subject || 'General')}</small></div><span class="tag">${q.questions.length ? 'READY' : 'DRAFT'}</span><button class="more" data-menu="${q.id}" aria-label="More">···</button></div>`; }
function wireQuizRows() { $$('[data-open]').forEach(x => x.onclick = () => quizMenu(x.dataset.open)); $$('[data-menu]').forEach(b => b.onclick = e => { e.stopPropagation(); quizMenu(b.dataset.menu); }); }
function quizMenu(id) {
  const q = db.quizzes.find(x => x.id === id); if (!q) return;
  actionSheet(q.title, `${q.questions.length} questions · ${q.subject || 'General'}`, [
    { icon: '▶', label: 'Play quiz', hint: 'Exam or practice mode', run: () => chooseMode(q.id) },
    { icon: '✎', label: 'Edit quiz', cls: 'practice-icon', run: () => editQuiz(q.id) },
    { icon: '⧉', label: 'Duplicate', run: () => { const c = structuredClone(q); c.id = uid(); c.title += ' (Copy)'; c.updatedAt = new Date().toISOString(); db.quizzes.unshift(c); save(); render(); toast('Quiz duplicated'); } },
    { icon: '⇩', label: 'Export', hint: 'JSON, TXT (😂 format) or PDF', run: () => exportQuiz(q) },
    { icon: '🌐', label: 'Translate · 100+ languages', hint: 'Online · bulk translation · no Gemini key', run: () => translateQuiz(q) },
    { icon: '×', label: 'Delete', danger: true, cls: 'danger-icon', run: async () => { if (await confirmBox('Delete quiz?', `"${q.title}" will be removed from this device.`, 'Delete', true)) { db.quizzes = db.quizzes.filter(x => x.id !== q.id); save(); render(); toast('Quiz deleted'); } } },
  ]);
}

/* ------------------------------ LIBRARY ------------------------------ */
function library() {
  view.innerHTML = `<div class="page-title"><div><div class="eyebrow">YOUR COLLECTION</div><h1>My quizzes</h1><p>Manage, practise and export your saved quizzes.</p></div><div class="title-actions"><button class="secondary" id="libImport">⇧ Import</button><button class="primary" id="libCreate">＋ New quiz</button></div></div><div class="toolbar"><input id="searchQuiz" placeholder="⌕  Search quizzes..." /><select id="filterSubject"><option value="">All subjects</option>${[...new Set(db.quizzes.map(q => q.subject || 'General'))].map(s => `<option>${esc(s)}</option>`).join('')}</select><span class="muted">${db.quizzes.length} saved</span></div><div class="quiz-grid" id="quizGrid">${db.quizzes.length ? db.quizzes.map(quizCard).join('') : '<div class="empty-state"><div>▤</div><h3>Your library is waiting</h3><p>Create your first quiz or import existing questions.</p><button class="primary" id="emptyCreate">Create a quiz</button></div>'}</div>`;
  $('#libImport').onclick = () => $('#fileInput').click(); $('#libCreate').onclick = () => setTab('create'); $('#emptyCreate')?.addEventListener('click', () => setTab('create'));
  const filter = () => { const term = $('#searchQuiz').value.toLowerCase(), sub = $('#filterSubject').value; $$('.quiz-card').forEach(c => c.hidden = !(c.dataset.title.includes(term) && (!sub || c.dataset.subject === sub))); };
  $('#searchQuiz').oninput = filter; $('#filterSubject').onchange = filter;
  $$('.quiz-card [data-action]').forEach(b => b.onclick = async () => {
    const q = db.quizzes.find(x => x.id === b.closest('.quiz-card').dataset.id); if (!q) return;
    const a = b.dataset.action;
    if (a === 'play') chooseMode(q.id); else if (a === 'edit') editQuiz(q.id); else if (a === 'more') quizMenu(q.id);
    else if (a === 'delete' && await confirmBox('Delete quiz?', `"${q.title}" will be removed from this device.`, 'Delete', true)) { db.quizzes = db.quizzes.filter(x => x.id !== q.id); save(); render(); }
  });
}
function quizCard(q) { const best = db.attempts.filter(a => a.quizId === q.id).reduce((m, a) => Math.max(m, a.percent), -1); return `<article class="quiz-card" data-id="${q.id}" data-title="${esc(q.title.toLowerCase())}" data-subject="${esc(q.subject || 'General')}"><div class="card-top"><div class="quiz-symbol large">▤</div><span class="tag">${q.questions.length} Q${best >= 0 ? ` · BEST ${best}%` : ''}</span></div><h3>${esc(q.title)}</h3><p>${esc(q.description || 'No description added.')}</p><div class="card-meta"><span>◷ ${q.settings.timer ? `${q.settings.timer}s / Q` : 'Untimed'}</span><span>▣ ${esc(q.subject || 'General')}</span></div><div class="card-buttons"><button class="primary" data-action="play" ${q.questions.length ? '' : 'disabled'}>▶ Play</button><button class="secondary" data-action="edit">Edit</button><button class="iconbtn" data-action="more" title="More">···</button><button class="iconbtn danger" data-action="delete" title="Delete">×</button></div></article>`; }

/* ------------------------------ CREATOR ------------------------------ */
function creator(editId = null) {
  const old = editId ? db.quizzes.find(q => q.id === editId) : null; currentQuiz = old ? structuredClone(old) : (currentQuiz && !db.quizzes.some(q => q.id === currentQuiz.id) && currentQuiz.questions.length ? currentQuiz : quizTemplate());
  view.innerHTML = `<div class="page-title"><div><div class="eyebrow">QUIZ STUDIO</div><h1>${old ? 'Edit quiz' : 'Create a quiz'}</h1><p>Build your question set. Changes are saved only on this device.</p></div><button class="secondary" id="backLib">← Library</button></div>
 <div class="editor-layout"><div class="panel editor-main"><div class="form-grid"><label>Quiz title<input id="qTitle" value="${esc(currentQuiz.title)}" placeholder="e.g. Indian Polity — Fundamental Rights"/></label><label>Subject / category<input id="qSubject" value="${esc(currentQuiz.subject)}" placeholder="General Studies"/></label><label class="wide">Description<textarea id="qDesc" rows="2" placeholder="Short description...">${esc(currentQuiz.description)}</textarea></label></div><div class="divider"></div><div class="panel-head"><div><h3>Questions <span class="countbubble" id="questionCount">${currentQuiz.questions.length}</span></h3><p>Add MCQs with correct answers and explanations.</p></div><div class="title-actions row"><button class="secondary" id="pasteQs">⎘ Paste text</button><button class="primary" id="addQuestion">＋ Add question</button></div></div><div id="questionEditor">${currentQuiz.questions.map(questionEditor).join('')}</div><div class="empty-mini" id="noQuestions" ${currentQuiz.questions.length ? 'hidden' : ''}><span>✎</span><b>No questions added</b><small>Add a question, or paste many questions at once.</small></div></div>
 <aside class="panel editor-settings"><h3>Quiz settings</h3><label>Timer per question<select id="timer"><option value="0">No timer</option>${[10, 15, 20, 30, 36, 45, 60, 72, 90, 120].map(n => `<option value="${n}" ${currentQuiz.settings.timer == n ? 'selected' : ''}>${n} seconds</option>`).join('')}</select></label><label>Negative marking<select id="negative">${[0, .25, .33, .5, 1].map(n => `<option value="${n}" ${Math.abs((currentQuiz.settings.negative || 0) - n) < .01 ? 'selected' : ''}>${n === 0 ? 'No negative marking' : '−' + n + ' per wrong answer'}</option>`).join('')}</select></label><label>Pass percentage<input id="passMark" type="number" min="0" max="100" value="${currentQuiz.settings.pass ?? 40}"/></label><button class="primary full" id="saveQuiz">Save quiz</button><button class="secondary full" id="translateInEditor">🌐 Translate quiz</button><button class="secondary full" id="previewQuiz">Save & play</button></aside></div>`;
  $('#backLib').onclick = () => setTab('quizzes');
  $('#addQuestion').onclick = () => { syncEditor(); currentQuiz.questions.push(question()); refreshQuestionEditor(); $$('.question-edit').pop()?.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
  $('#pasteQs').onclick = () => { const { el, close } = modal(`<div class="eyebrow">BULK ADD</div><h2>Paste questions</h2><p>Paste MCQs in any supported format (Q1. … 😂 … ✅, a) b) c) d) with Answer:, etc).</p><textarea id="bulkText" rows="10" placeholder="Q1. Question text\n😂\nOption A\nOption B ✅\nOption C\nOption D\nEx: explanation"></textarea><div class="dialog-actions"><button class="primary" id="bulkAdd">Add questions</button></div>`, { wide: true }); $('#bulkAdd', el).onclick = () => { const qs = parseText($('#bulkText', el).value); if (!qs.length) return toast('No questions detected in the text'); syncEditor(); currentQuiz.questions.push(...qs); close(); refreshQuestionEditor(); toast(`${qs.length} questions added`); }; };
  $('#saveQuiz').onclick = () => saveQuiz();
  $('#translateInEditor').onclick = () => { if(saveQuiz(true)){ const q=db.quizzes.find(x=>x.id===currentQuiz.id); if(q)translateQuiz(q); } };
  $('#previewQuiz').onclick = () => { if (saveQuiz(true)) chooseMode(currentQuiz.id); };
  wireQuestionButtons(); updateQuestionCount();
}
function questionEditor(q, i) { return `<div class="question-edit" data-qid="${q.id}"><div class="qedit-head"><b>QUESTION ${String(i + 1).padStart(2, '0')}</b><div><button class="mini" data-qmove="up" title="Move up">↑</button><button class="mini" data-qmove="down" title="Move down">↓</button><button class="mini delete" data-qremove title="Delete">×</button></div></div><textarea class="qtext" placeholder="Write your question...">${esc(q.text)}</textarea><div class="option-list">${q.options.map((o, j) => `<div class="option-edit"><input type="radio" name="correct-${q.id}" value="${j}" ${q.correct === j ? 'checked' : ''} title="Mark correct"/><span>${L(j)}</span><input class="opttext" value="${esc(o)}" placeholder="Option ${L(j)}"/><button class="mini delete" data-optremove="${j}" title="Remove option">×</button></div>`).join('')}</div><button class="textbtn addopt" data-addopt>＋ Add option</button><textarea class="explanation" rows="2" placeholder="Explanation (optional)">${esc(q.explanation || '')}</textarea><input class="qtopic" value="${esc(q.topic || '')}" placeholder="Topic / sub-topic (optional — used for topic-wise analytics)"/></div>`; }
function refreshQuestionEditor() { $('#questionEditor').innerHTML = currentQuiz.questions.map(questionEditor).join(''); $('#noQuestions').hidden = !!currentQuiz.questions.length; wireQuestionButtons(); updateQuestionCount(); }
function updateQuestionCount() { $('#questionCount').textContent = currentQuiz.questions.length; }
function wireQuestionButtons() {
  $$('#questionEditor [data-qremove]').forEach(b => b.onclick = () => { syncEditor(); const id = b.closest('.question-edit').dataset.qid; currentQuiz.questions = currentQuiz.questions.filter(q => q.id !== id); refreshQuestionEditor(); });
  $$('#questionEditor [data-addopt]').forEach(b => b.onclick = () => { syncEditor(); const q = currentQuiz.questions.find(x => x.id === b.closest('.question-edit').dataset.qid); if (q.options.length >= 8) return toast('Maximum 8 options'); q.options.push(''); refreshQuestionEditor(); });
  $$('#questionEditor [data-optremove]').forEach(b => b.onclick = () => { syncEditor(); const card = b.closest('.question-edit'), q = currentQuiz.questions.find(x => x.id === card.dataset.qid), idx = Number(b.dataset.optremove); if (q.options.length <= 2) return toast('At least 2 options required'); q.options.splice(idx, 1); if (q.correct === idx) q.correct = 0; else if (q.correct > idx) q.correct--; refreshQuestionEditor(); });
  $$('#questionEditor [data-qmove]').forEach(b => b.onclick = () => { syncEditor(); const card = b.closest('.question-edit'), i = currentQuiz.questions.findIndex(q => q.id === card.dataset.qid), j = b.dataset.qmove === 'up' ? i - 1 : i + 1; if (j < 0 || j >= currentQuiz.questions.length) return; [currentQuiz.questions[i], currentQuiz.questions[j]] = [currentQuiz.questions[j], currentQuiz.questions[i]]; refreshQuestionEditor(); });
}
function syncEditor() { if (!$('#qTitle')) return; currentQuiz.title = $('#qTitle').value.trim() || 'Untitled Quiz'; currentQuiz.subject = $('#qSubject').value.trim() || 'General'; currentQuiz.description = $('#qDesc').value; currentQuiz.settings = { timer: Number($('#timer').value), negative: Number($('#negative').value), pass: Math.min(100, Math.max(0, Number($('#passMark').value) || 0)) }; $$('.question-edit').forEach(card => { const q = currentQuiz.questions.find(x => x.id === card.dataset.qid); if (!q) return; q.text = $('.qtext', card).value; q.options = $$('.opttext', card).map(x => x.value); q.correct = Number($(`input[name="correct-${q.id}"]:checked`, card)?.value || 0); q.explanation = $('.explanation', card).value; q.topic = ($('.qtopic', card)?.value || '').trim(); }); }
function saveQuiz(silent = false) {
  syncEditor();
  if (!currentQuiz.questions.length) { toast('Add at least one question'); return false; }
  for (let i = 0; i < currentQuiz.questions.length; i++) {
    const q = currentQuiz.questions[i];
    // drop empty options, keep correct index pointing at the same option
    const keep = q.options.map((o, j) => ({ o: o.trim(), j })).filter(x => x.o);
    if (!q.text.trim() || keep.length < 2) { toast(`Question ${i + 1}: add text and at least 2 options`); $$('.question-edit')[i]?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return false; }
    const newCorrect = keep.findIndex(x => x.j === q.correct);
    if (newCorrect < 0) { toast(`Question ${i + 1}: the correct option is empty`); return false; }
    q.options = keep.map(x => x.o); q.correct = newCorrect;
  }
  currentQuiz.updatedAt = new Date().toISOString();
  const idx = db.quizzes.findIndex(q => q.id === currentQuiz.id);
  if (idx >= 0) db.quizzes[idx] = structuredClone(currentQuiz); else db.quizzes.unshift(structuredClone(currentQuiz));
  save();
  if (!silent) { toast('Quiz saved on this device ✓'); setTab('quizzes'); }
  return true;
}
function editQuiz(id) { db.activeTab = 'create'; markNav('create'); $('#crumb').textContent = labels.create; creator(id); window.scrollTo(0, 0); }

/* ------------------------------ PLAYER ------------------------------ */
function chooseMode(id) {
  const q = db.quizzes.find(x => x.id === id); if (!q || !q.questions.length) return toast('This quiz has no questions');
  const saved = savedPlay(); const canResume = saved && saved.quiz?.id === id && !saved.quiz?.isRevision;
  const { el, close } = modal(`<div class="eyebrow">CHOOSE YOUR EXPERIENCE</div><h2>${esc(q.title)}</h2><p>${q.questions.length} questions${q.settings.timer ? ` · ${q.settings.timer}s per question` : ''}${q.settings.negative ? ` · −${q.settings.negative} negative` : ''}</p>${canResume ? `<button class="mode-choice resume-choice" data-mode="resume"><span class="mode-icon practice-icon">⏯</span><span><b>Resume from Q${(saved.index || 0) + 1}</b><small>${Object.keys(saved.answers || {}).length}/${saved.questions.length} answered${saved.lastAnswered != null ? ` · last answered Q${saved.lastAnswered + 1}` : ''} · ${saved.mode === 'exam' ? 'Exam' : 'Practice'} mode</small></span><span class="mode-arrow">→</span></button>` : ''}<button class="mode-choice" data-mode="exam"><span class="mode-icon exam-icon">◷</span><span><b>Exam mode</b><small>Attempt freely, jump between questions, mark for review. Score and full review at the end.</small></span><span class="mode-arrow">→</span></button><button class="mode-choice" data-mode="practice"><span class="mode-icon practice-icon">✦</span><span><b>Practice mode</b><small>See the correct answer and explanation right after each response.</small></span><span class="mode-arrow">→</span></button>`);
  $$('[data-mode]', el).forEach(b => b.onclick = () => { const mode = b.dataset.mode; close(); if (mode === 'resume') return resumeQuiz(); chooseShuffle(id, mode); });
}
function chooseShuffle(id, mode) {
  const q = db.quizzes.find(x => x.id === id); if (!q) return;
  const { el, close } = modal(`<div class="eyebrow">PERSONALISE THIS ATTEMPT</div><h2>Shuffle questions & options?</h2><p>Choose a fresh arrangement for this attempt. This choice applies to both Exam and Practice mode.</p>
    <button class="mode-choice" data-shuffle="questions"><span class="mode-icon exam-icon">🔀</span><span><b>Only questions</b><small>Random question order; options stay in their original order.</small></span><span class="mode-arrow">→</span></button>
    <button class="mode-choice" data-shuffle="options"><span class="mode-icon practice-icon">🔤</span><span><b>Only options</b><small>Question order stays fixed; answer options are rearranged.</small></span><span class="mode-arrow">→</span></button>
    <button class="mode-choice" data-shuffle="both"><span class="mode-icon exam-icon">✨</span><span><b>Both</b><small>Randomise question order and each question's options.</small></span><span class="mode-arrow">→</span></button>
    <button class="mode-choice" data-shuffle="none"><span class="mode-icon practice-icon">☷</span><span><b>No shuffle</b><small>Keep the original order exactly as created.</small></span><span class="mode-arrow">→</span></button>` , { wide: true });
  $$('[data-shuffle]', el).forEach(b => b.onclick = () => { const kind = b.dataset.shuffle; close(); startQuiz(id, mode, kind); });
}
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function buildAttemptOrder(quiz, kind) {
  quiz.questions.forEach(x => { if (!x.id) x.id = uid(); });
  if (kind === 'none') return quiz.questions.map(x => ({ ...x, options: x.options.map((t, i) => ({ text: t, original: i })) }));
  const shuffleQ = kind === 'questions' || kind === 'both';
  const shuffleO = kind === 'options' || kind === 'both';
  const historyKey = `${quiz.id}:${kind}`;
  const history = db.shuffleHistory[historyKey] || [];
  const make = () => {
    let qs = quiz.questions.map(x => ({ ...x, id: x.id || uid(), options: x.options.map((t, i) => ({ text: t, original: i })) }));
    if (shuffleQ) shuffle(qs);
    if (shuffleO) qs.forEach(x => shuffle(x.options));
    const raw = JSON.stringify({ q: shuffleQ ? qs.map(x => x.id) : [], o: shuffleO ? qs.map(x => [x.id, x.options.map(o => o.original)]) : [] });
    let h1 = 2166136261, h2 = 2246822519; for (let i = 0; i < raw.length; i++) { const c = raw.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 ^ c, 3266489917); }
    const signature = (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
    return { qs, signature };
  };
  let candidate = make(), tries = 0;
  // Avoid repeating any recent arrangement. If a quiz has only a tiny number of
  // mathematically possible permutations, a repeat becomes unavoidable after exhaustion.
  while (history.includes(candidate.signature) && tries++ < 160) candidate = make();
  if (history.includes(candidate.signature)) toast('All recent unique arrangements have been used; starting a fresh shuffle cycle.');
  db.shuffleHistory[historyKey] = [...history, candidate.signature];
  save();
  return candidate.qs;
}
function savedPlay() { try { return JSON.parse(localStorage.getItem(PLAY_STORE) || 'null'); } catch { return null; } }
function initialLangs(q) {
  const ok = c => c === 'original' || q.translations?.[c]?.length === q.questions.length;
  const want = (db.settings.langs || ['original']).filter(Boolean);
  const langs = want.filter(ok); const missing = want.filter(c => !ok(c));
  if (missing.length && want[0] !== 'original') setTimeout(() => toast(`${missing.map(languageLabel).join(', ')} not translated for this quiz yet — tap 🌐 to translate`, 4200), 400);
  return langs.length ? langs : ['original'];
}
function startQuiz(id, mode = 'exam', shuffleKind = 'none', quizObj = null) {
  const q = quizObj || db.quizzes.find(x => x.id === id); if (!q || !q.questions.length) return toast('This quiz has no questions');
  const qs = q.isRevision ? shuffle(q.questions.map(x => ({ ...x, options: x.options.map((t, i) => ({ text: t, original: i })) }))) : buildAttemptOrder(q, shuffleKind);
  const langs = initialLangs(q);
  play = { quiz: q, mode, shuffleKind, questions: qs, index: 0, answers: {}, marked: {}, visited: { 0: true }, timeLeft: {}, qTime: {}, qEnter: Date.now(), lastAnswered: null, langs, langMode: langs.length > 1 ? (db.settings.langMode || 'single') : 'single', started: Date.now(), interval: null, finished: false, paletteOpen: false };
  enterPlayer();
}
function resumeQuiz() {
  try {
    const s = savedPlay(); const q = s.quiz?.isRevision ? s.quiz : db.quizzes.find(x => x.id === s.quiz.id); if (!q) throw 0;
    play = { ...s, quiz: q, interval: null, qEnter: Date.now(), away: false, qTime: s.qTime || {}, langs: s.langs || ['original'], langMode: s.langMode || 'single' };
    enterPlayer(); toast(`Attempt resumed at Q${play.index + 1}`);
  } catch { localStorage.removeItem(PLAY_STORE); toast('Could not resume that attempt'); }
}
function enterPlayer() { document.body.classList.add('in-quiz'); markNav(''); renderPlayer(); scrollTop(); }
function leavePlayer() { if (play) clearInterval(play.interval); play = null; localStorage.removeItem(PLAY_STORE); document.body.classList.remove('in-quiz'); }
const answeredCount = p => Object.keys(p.answers).filter(k => p.answers[k] != null).length;
function qState(p, i) { const a = p.answers[i] != null, m = !!p.marked[i]; if (p.mode === 'practice' && a) return p.answers[i] === p.questions[i].correct ? 'right' : 'wrongq'; if (a && m) return 'ans-marked'; if (m) return 'marked'; if (a) return 'answered'; if (p.visited[i]) return 'skipped'; return 'fresh'; }
const tMapCache = new WeakMap();
function translationOf(quiz, qid, code) {
  const arr = quiz?.translations?.[code]; if (!Array.isArray(arr)) return null;
  let m = tMapCache.get(arr); if (!m) { m = new Map(arr.map((x, i) => [x?.id || quiz.questions[i]?.id, x])); tMapCache.set(arr, m); }
  return m.get(qid) || null;
}
/** Text of a player question in one language. q.options are {text, original}. */
function qView(quiz, q, code) {
  const base = { text: q.text, opt: orig => q.options.find(o => o.original === orig)?.text ?? '', explanation: q.explanation };
  if (code === 'original') return base;
  const t = translationOf(quiz, q.id, code); if (!t) return base;
  return { text: t.text || q.text, opt: orig => t.options?.[orig] ?? base.opt(orig), explanation: t.explanation || q.explanation };
}
const langShort = c => c === 'original' ? 'ORIGINAL' : (QUIZ_LANGS[c] || c).toUpperCase();
function activeLangs(p) { const l = p.langs?.length ? p.langs : ['original']; return p.langMode === 'multi' ? l.slice(0, 3) : [l[0]]; }
/** Plain snapshot (original option order) used by bookmarks, revision and the AI tutor. */
function snapFromPlay(p, q) { return { text: q.text, options: q.options.slice().sort((a, b) => a.original - b.original).map(o => o.text), correct: q.correct, explanation: q.explanation || '', topic: q.topic || '', subject: q.subject || p.quiz.subject || 'General', quizId: p.quiz.isRevision ? (q.quizId || '') : p.quiz.id, quizTitle: p.quiz.isRevision ? (q.quizTitle || '') : p.quiz.title, qid: q.qid || q.id, selected: p.answers[p.index] ?? null }; }
function renderPlayer() {
  const p = play; if (!p) return; const q = p.questions[p.index]; if (!q) return finishQuiz();
  p.visited[p.index] = true; if (!p.qEnter) p.qEnter = Date.now();
  const sel = p.answers[p.index]; const answered = sel != null; const locked = p.mode === 'practice' && answered;
  const isRight = answered && sel === q.correct;
  const timer = p.quiz.settings.timer || 0; if (timer && p.timeLeft[p.index] == null) p.timeLeft[p.index] = timer;
  const done = answeredCount(p), total = p.questions.length, last = p.index === total - 1;
  const langs = activeLangs(p), multi = langs.length > 1, views = langs.map(c => ({ c, v: qView(p.quiz, q, c) }));
  const tag = c => multi ? `<span class="ml-tag">${esc(langShort(c))}</span>` : '';
  const qHtml = multi ? views.map(({ c, v }) => `<div class="ml-block">${tag(c)}<div>${escMl(v.text)}</div></div>`).join('') : escMl(views[0].v.text);
  const optHtml = o => `<span class="answer-text">${views.map(({ c, v }, k) => k ? `<small class="ml-sub"><em>${esc(langShort(c))}</em>${escMl(v.opt(o.original))}</small>` : escMl(v.opt(o.original))).join('')}</span>`;
  const rightIdx = q.options.findIndex(o => o.original === q.correct);
  const explHtml = views.map(({ c, v }) => `<p class="explanation-text">${tag(c)}${esc(explanationLines(v.explanation || 'No explanation was provided for this question.'))}</p>`).join('');
  const bm = isBookmarkedText(q.text);
  const feedback = locked ? `<div class="instant-feedback ${isRight ? 'is-correct' : 'is-wrong'}"><b>${isRight ? '✓ Correct answer' : '✕ Not quite — learn from it'}</b><div>Correct answer: <strong>${L(rightIdx)}. ${esc(views[0].v.opt(q.correct) || 'Not specified')}</strong></div>${explHtml}<div class="feedback-actions"><button class="secondary" id="askAiNow">✦ Ask AI tutor</button>${!isRight && !bm ? '<button class="textbtn" id="bmNow">⚐ Save as difficult</button>' : ''}</div></div>` : '';
  const slide = p.slideDir ? (p.slideDir > 0 ? 'slide-left' : 'slide-right') : ''; p.slideDir = 0;
  const unanswered = p.questions.findIndex((_, i) => i > p.index && p.answers[i] == null);
  view.innerHTML = `<div class="player-wrap"><div class="player-top"><button class="secondary" id="quitPlay">← Exit</button><span class="tag">${p.quiz.isRevision ? 'REVISION' : p.mode === 'exam' ? 'EXAM MODE' : 'PRACTICE MODE'}</span><div class="player-top-actions"><button class="secondary" id="playerTranslate" title="Language (L)">🌐 ${esc(langs.map(c => c === 'original' ? 'Original' : languageLabel(c)).join(' + '))}</button>${(p.langs || []).length > 1 ? `<button class="secondary" id="langToggle" title="Switch single / bilingual">${multi ? '1 language' : 'Bilingual'}</button>` : ''}<button class="secondary kbd-btn" id="kbdHelp" title="Keyboard shortcuts (?)">⌨</button><button class="secondary palette-toggle" id="paletteToggle">☷ ${p.index + 1}/${total}</button></div></div>
  <div class="progress"><i style="width:${Math.round(done / total * 100)}%"></i></div>
  <div class="player-grid ${p.paletteOpen ? 'palette-open' : ''}">
   <div class="player-card ${slide}"><div class="question-meta"><span>QUESTION ${String(p.index + 1).padStart(2, '0')} OF ${total}${q.topic ? ` · ${esc(q.topic)}` : ''}</span><span class="timer ${timer && p.timeLeft[p.index] <= 5 ? 'timer-low' : ''}" id="timerDisplay">${timer ? `◷ ${p.timeLeft[p.index]}s` : esc(q.subject || p.quiz.subject || 'General')}</span></div><h1 class="${multi ? 'multi' : ''}">${qHtml}</h1><div class="answer-list">${q.options.map((o, i) => `<button class="answer ${sel === o.original ? 'chosen' : ''} ${locked ? (o.original === q.correct ? 'answer-correct' : o.original === sel ? 'answer-wrong' : '') : ''}" data-answer="${o.original}" ${locked ? 'disabled' : ''}><span class="letter">${L(i)}</span>${optHtml(o)}<span class="radio"></span></button>`).join('')}</div>${feedback}
    <div class="player-tools">${p.mode === 'exam' ? `<button class="textbtn" id="markReview">${p.marked[p.index] ? '★ Marked for review' : '☆ Mark for review'}</button>` : ''}<button class="textbtn ${bm ? 'bm-on' : ''}" id="bookmarkQ">${bm ? '⚑ Saved as difficult' : '⚐ Bookmark difficult'}</button>${answered && !locked ? '<button class="textbtn" id="clearAns">⟲ Clear response</button>' : ''}</div>
    <div class="player-bottom"><button class="secondary" id="prevQuestion" ${p.index === 0 ? 'disabled' : ''}>← Previous</button><span class="muted">${done}/${total} answered</span>${last ? '<button class="primary" id="submitQuiz">Submit ✓</button>' : '<button class="primary" id="nextQuestion">Next →</button>'}</div>
   </div>
   <aside class="palette panel"><div class="panel-head"><div><h3>Question palette</h3><p>Tap any number to jump</p></div><button class="textbtn palette-close" id="paletteClose">×</button></div>
    <div class="jump-row"><input id="jumpTo" type="number" min="1" max="${total}" placeholder="Go to Q#"/><button class="secondary" id="jumpGo">Go</button><button class="secondary" id="jumpNextBlank" ${unanswered < 0 ? 'disabled' : ''} title="Next unanswered (U)">Next blank</button></div>
    <div class="palette-grid">${p.questions.map((x, i) => `<button class="pal ${qState(p, i)} ${i === p.index ? 'current' : ''} ${isBookmarkedText(x.text) ? 'bm' : ''}" data-jump="${i}">${i + 1}</button>`).join('')}</div>
    <div class="legend">${p.mode === 'exam' ? '<span><i class="answered"></i>Answered</span><span><i class="skipped"></i>Not answered</span><span><i class="marked"></i>Marked</span><span><i class="ans-marked"></i>Answered + marked</span><span><i class="fresh"></i>Not visited</span><span><i class="bmk"></i>Bookmarked</span>' : '<span><i class="right"></i>Correct</span><span><i class="wrongq"></i>Wrong</span><span><i class="skipped"></i>Skipped</span><span><i class="fresh"></i>Not visited</span><span><i class="bmk"></i>Bookmarked</span>'}</div>
    <button class="primary full" id="submitSide">Submit quiz</button></aside>
  </div>
  <div class="player-hint"><span class="touch-only">Swipe ← → on the question to move.</span><span class="desk-only">Keys: ← → move · 1-4 / A-D answer · M mark · F bookmark · G jump · ? help.</span> ${p.mode === 'exam' ? 'Answers are revealed after you submit.' : 'Choose an option to reveal the answer.'}</div></div>`;
  $('#playerTranslate').onclick = openPlayerLanguagePicker;
  $('#langToggle')?.addEventListener('click', () => { p.langMode = p.langMode === 'multi' ? 'single' : 'multi'; db.settings.langMode = p.langMode; save(); savePlay(); renderPlayer(); });
  $('#kbdHelp').onclick = showShortcuts;
  $('#quitPlay').onclick = () => exitPlayerPrompt();
  $$('.answer').forEach(b => b.onclick = () => { if (locked) return; selectAnswer(Number(b.dataset.answer)); });
  $('#prevQuestion').onclick = () => go(p.index - 1);
  $('#nextQuestion')?.addEventListener('click', () => go(p.index + 1));
  $('#submitQuiz')?.addEventListener('click', submitQuiz); $('#submitSide').onclick = submitQuiz;
  $('#markReview')?.addEventListener('click', toggleMark);
  $('#bookmarkQ').onclick = () => { toggleBookmark(snapFromPlay(p, q)); renderPlayer(); };
  $('#bmNow')?.addEventListener('click', () => { toggleBookmark(snapFromPlay(p, q)); renderPlayer(); });
  $('#askAiNow')?.addEventListener('click', () => askAI(snapFromPlay(p, q)));
  $('#clearAns')?.addEventListener('click', clearAnswer);
  $$('[data-jump]').forEach(b => b.onclick = () => { p.paletteOpen = false; go(Number(b.dataset.jump)); });
  const jump = () => { const n = Number($('#jumpTo').value); if (n >= 1 && n <= total) { p.paletteOpen = false; go(n - 1); } else toast(`Enter a number from 1 to ${total}`); };
  $('#jumpGo').onclick = jump; $('#jumpTo').addEventListener('keydown', e => { if (e.key === 'Enter') jump(); });
  $('#jumpNextBlank').onclick = () => { p.paletteOpen = false; nextUnanswered(); };
  $('#paletteToggle').onclick = () => { p.paletteOpen = !p.paletteOpen; renderPlayer(); };
  $('#paletteClose').onclick = () => { p.paletteOpen = false; renderPlayer(); };
  // Swipe left / right on the question card
  const card = $('.player-card'); let sx = 0, sy = 0, st = 0, track = false;
  card.addEventListener('touchstart', e => { if (e.touches.length !== 1) { track = false; return; } const t = e.touches[0]; sx = t.clientX; sy = t.clientY; st = Date.now(); track = true; }, { passive: true });
  card.addEventListener('touchend', e => { if (!track) return; track = false; const t = e.changedTouches[0]; const dx = t.clientX - sx, dy = t.clientY - sy; if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - st < 900) swipeGo(dx < 0 ? 1 : -1); }, { passive: true });
  clearInterval(p.interval);
  if (timer && !locked && p.timeLeft[p.index] > 0) {
    p.interval = setInterval(() => {
      p.timeLeft[p.index]--; const t = $('#timerDisplay'); if (t) { t.textContent = `◷ ${Math.max(0, p.timeLeft[p.index])}s`; t.classList.toggle('timer-low', p.timeLeft[p.index] <= 5); }
      if (p.timeLeft[p.index] % 5 === 0) savePlay();
      if (p.timeLeft[p.index] <= 0) { clearInterval(p.interval); p.timeLeft[p.index] = 0; if (p.index < total - 1) { toast('Time up — moved to next question'); go(p.index + 1); } else { toast('Time up'); renderPlayer(); } }
    }, 1000);
  } else if (timer && !locked && p.timeLeft[p.index] <= 0) {
    $$('.answer').forEach(b => b.disabled = true); const t = $('#timerDisplay'); if (t) t.textContent = '◷ Time up';
  }
}
function selectAnswer(orig) { const p = play; if (!p) return; p.answers[p.index] = orig; p.lastAnswered = p.index; savePlay(); renderPlayer(); }
function clearAnswer() { const p = play; if (!p || p.answers[p.index] == null || (p.mode === 'practice')) return; delete p.answers[p.index]; savePlay(); renderPlayer(); }
function toggleMark() { const p = play; if (!p || p.mode !== 'exam') return; p.marked[p.index] = !p.marked[p.index]; savePlay(); renderPlayer(); }
function nextUnanswered() { const p = play; if (!p) return; const n = p.questions.length; for (let k = 1; k <= n; k++) { const i = (p.index + k) % n; if (p.answers[i] == null) return go(i); } toast('All questions are answered'); }
function swipeGo(dir) { const p = play; if (!p) return; const i = p.index + dir; if (i < 0) return toast('This is the first question'); if (i >= p.questions.length) return toast('Last question — tap Submit when ready'); p.slideDir = dir; go(i); }
async function exitPlayerPrompt() {
  const p = play; if (!p) return;
  const r = await confirmBox('Exit quiz?', 'Choose "Save & exit" to resume later from the same question.', 'Save & exit');
  if (r && play === p) { clearInterval(p.interval); savePlay(); const t = db.activeTab; play = null; document.body.classList.remove('in-quiz'); setTab(t === 'create' ? 'quizzes' : 'home'); }
}
function showShortcuts() {
  const rows = [['← / →', 'Previous / next question'], ['Enter / Space', 'Next question (submit on the last one)'], ['1–8 or A–E', 'Choose that option'], ['X', 'Clear response (exam mode)'], ['M', 'Mark for review (exam mode)'], ['F', 'Bookmark as difficult'], ['G', 'Jump to a question number'], ['U', 'Next unanswered question'], ['Home / End', 'First / last question'], ['T', 'Show / hide palette'], ['L', 'Change language'], ['I', 'Ask AI tutor (after the answer is shown)'], ['S', 'Submit quiz'], ['Esc', 'Close dialog / exit quiz'], ['?', 'This help']];
  modal(`<div class="eyebrow">WINDOWS · KEYBOARD</div><h2>Keyboard shortcuts</h2><div class="kbd-list">${rows.map(([k, d]) => `<div><kbd>${esc(k)}</kbd><span>${esc(d)}</span></div>`).join('')}</div><p class="muted">On phones, swipe left / right on the question card to move.</p>`);
}
function jumpPrompt() {
  if (!play) return; const total = play.questions.length;
  const { el, close } = modal(`<div class="eyebrow">JUMP</div><h2>Go to question</h2><label>Question number (1–${total})<input id="jumpNum" type="number" min="1" max="${total}" value="${play.index + 1}"/></label><div class="dialog-actions"><button class="primary" id="jumpOk">Go</button></div>`);
  const inp = $('#jumpNum', el); setTimeout(() => { inp.focus(); inp.select(); }, 30);
  const ok = () => { const n = Number(inp.value); if (n >= 1 && n <= total) { close(); go(n - 1); } else toast(`Enter 1 to ${total}`); };
  $('#jumpOk', el).onclick = ok; inp.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
}
function go(i) { if (!play) return; if (i < 0 || i >= play.questions.length) return; clearInterval(play.interval); tickTime(play); play.index = i; savePlay(); renderPlayer(); window.scrollTo({ top: 0, behavior: 'smooth' }); $('.main')?.scrollTo?.({ top: 0, behavior: 'smooth' }); }
async function submitQuiz() {
  const p = play; if (!p) return; const left = p.questions.length - answeredCount(p); const marked = Object.values(p.marked).filter(Boolean).length;
  const msg = left || marked ? `${left ? `${left} unanswered` : ''}${left && marked ? ' · ' : ''}${marked ? `${marked} marked for review` : ''}. Submit anyway?` : 'All questions answered. Submit your attempt?';
  if (await confirmBox('Submit quiz?', msg, 'Submit')) finishQuiz();
}
function finishQuiz() {
  const p = play; if (!p) return; clearInterval(p.interval); tickTime(p); p.finished = true;
  let correct = 0, wrong = 0, blank = 0, score = 0; const neg = Number(p.quiz.settings.negative) || 0; const subject = p.quiz.subject || 'General';
  const details = p.questions.map((q, i) => { const ans = p.answers[i]; let status = 'blank'; if (ans == null) blank++; else if (ans === q.correct) { correct++; score++; status = 'correct'; } else { wrong++; score -= neg; status = 'wrong'; } return { qid: q.qid || q.id, question: q.text, selected: ans ?? null, correct: q.correct, status, explanation: q.explanation, options: q.options, topic: q.topic || '', subject: q.subject || subject, timeSec: Math.round((p.qTime?.[i] || 0) / 1000), revKey: q.revKey || null, quizId: q.quizId || null }; });
  const max = p.questions.length, percent = Math.max(0, Math.round(score / max * 100));
  const attempt = { id: uid(), quizId: p.quiz.id, quizTitle: p.quiz.title, subject, mode: p.mode, date: new Date().toISOString(), durationSec: Math.round((Date.now() - p.started) / 1000), total: max, correct, wrong, blank, score: Number(score.toFixed(2)), percent, pass: p.quiz.settings.pass ?? 40, negative: neg, details };
  if (p.quiz.isRevision) { attempt.isRevision = true; attempt.revisionSummary = applyRevisionResults(details); save(); leavePlayer(); renderResult(attempt); return; }
  attempt.revisionAdded = addWrongToRevision(p.quiz, details);
  db.attempts.unshift(attempt); save(); leavePlayer(); renderResult(attempt);
}
const fmtDur = s => s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : `${Math.floor(s / 60)}m ${s % 60}s`;
function renderResult(a, filter = 'all') {
  lastResult = a; scrollTop();
  const passed = a.percent >= (a.pass ?? 40);
  const idxOf = (d, orig) => d.options.findIndex(o => o.original === orig);
  const rows = a.details.map((d, i) => ({ d, i })).filter(({ d }) => filter === 'all' || d.status === filter);
  view.innerHTML = `<div class="result-wrap"><div class="result-hero"><div class="result-ring" style="--score:${a.percent * 3.6}deg"><div><strong>${a.percent}%</strong><small>SCORE</small></div></div><div><div class="eyebrow">${passed ? '🏆 PASSED' : 'SESSION COMPLETE'}</div><h1>${passed ? 'Great work!' : 'Quiz completed!'}</h1><p>${esc(a.quizTitle)} · ${new Date(a.date).toLocaleString()}${a.durationSec ? ` · ${fmtDur(a.durationSec)}` : ''}</p></div></div>
  <div class="stats-grid result-stats"><div class="stat-card"><small>CORRECT</small><strong class="green-text">${a.correct}</strong></div><div class="stat-card"><small>INCORRECT</small><strong class="red-text">${a.wrong}</strong></div><div class="stat-card"><small>UNANSWERED</small><strong>${a.blank}</strong></div><div class="stat-card"><small>MARKS</small><strong>${a.score}/${a.total}</strong></div></div>
  ${perfPanel(a)}
  <div class="panel artifact-panel" ${a.isRevision ? 'hidden' : ''}><div class="panel-head"><div><h3>🌐 Language & study exports</h3><p>Choose a language, then download or share each generated file directly.</p></div></div><div class="form-grid"><label>Export language<select id="artifactLang"><option value="original">Original</option></select></label><label>Translate into<select id="artifactTarget"></select></label></div><div class="dialog-actions"><button class="secondary" id="artifactTranslate">🌐 Translate / prepare language</button></div><div class="artifact-grid"><div class="artifact-item"><b>🎮 Playable HTML Quiz</b><div><button class="primary" id="downloadQuizHtml">⬇ Download HTML</button><button class="secondary" id="shareQuizHtml">↗ Share</button></div></div><div class="artifact-item"><b>📄 Test PDF</b><div><button class="primary" id="downloadTestPdf">⬇ Download PDF</button><button class="secondary" id="shareTestPdf">↗ Share</button></div></div><div class="artifact-item"><b>✅ Solution PDF</b><div><button class="primary" id="downloadSolPdf">⬇ Download PDF</button><button class="secondary" id="shareSolPdf">↗ Share</button></div></div><div class="artifact-item"><b>📚 Test + Solution PDF</b><div><button class="primary" id="downloadMergedPdf">⬇ Download PDF</button><button class="secondary" id="shareMergedPdf">↗ Share</button></div></div><div class="artifact-item"><b>📝 Notes HTML</b><div><button class="primary" id="downloadNotesHtml">⬇ Download HTML</button><button class="secondary" id="shareNotesHtml">↗ Share</button></div></div><div class="artifact-item"><b>📘 Notes PDF</b><div><button class="primary" id="downloadNotesPdf">⬇ Download PDF</button><button class="secondary" id="shareNotesPdf">↗ Share</button></div></div></div><p class="muted" id="artifactStatus">Files are saved to Downloads on web, or shared through Android's share sheet.</p><div class="dialog-actions"><button class="secondary" id="openTestMaker">Open supplied Test Series Maker</button><button class="secondary" id="openNotesMaker">Open supplied Notes Maker</button><button class="secondary" id="openQuizMaker">Open supplied Quiz Maker</button><button class="secondary" id="openTranslatorTool">Open supplied Translator</button></div></div>
  <div class="panel"><div class="panel-head"><div><h3>Answer review</h3><p>Review every response and explanation.</p></div><button class="secondary" id="resultPdf">⇩ PDF report</button></div>
  <div class="chips">${[['all', 'All', a.total], ['correct', 'Correct', a.correct], ['wrong', 'Wrong', a.wrong], ['blank', 'Unanswered', a.blank]].map(([k, l, n]) => `<button class="chip ${filter === k ? 'active' : ''}" data-filter="${k}">${l} · ${n}</button>`).join('')}</div>
  ${rows.length ? rows.map(({ d, i }) => `<div class="review-row"><div class="review-number">${i + 1}</div><div class="review-content"><b>${escMl(d.question)}</b><div class="review-status ${d.status}">${d.status.toUpperCase()} · ${d.selected == null ? 'Not answered' : `Your answer: ${L(idxOf(d, d.selected))}`} · Correct: ${L(idxOf(d, d.correct))}${d.timeSec ? ` · ⏱ ${d.timeSec}s` : ''}${d.topic ? ` · ${esc(d.topic)}` : ''}</div><div class="review-options">${d.options.map((o, j) => `<div class="${o.original === d.correct ? 'review-correct' : o.original === d.selected ? 'review-wrong' : ''}">${L(j)}. ${esc(o.text)} ${o.original === d.correct ? '✓' : o.original === d.selected ? '✕' : ''}</div>`).join('')}</div>${d.explanation ? `<p class="explanation-text">${esc(explanationLines(d.explanation))}</p>` : ''}<div class="review-actions"><button class="textbtn ${isBookmarkedText(d.question) ? 'bm-on' : ''}" data-rbm="${i}">${isBookmarkedText(d.question) ? '⚑ Saved as difficult' : '⚐ Save as difficult'}</button><button class="textbtn" data-rai="${i}">✦ Ask AI</button></div></div></div>`).join('') : '<div class="empty-mini"><b>Nothing here</b></div>'}</div>
<div class="result-actions"><button class="primary" id="resultHome">Back to dashboard</button>${a.isRevision ? '<button class="secondary" id="resultRevision">↻ Revision list</button>' : `<button class="secondary" id="resultAgain">↻ Retry quiz</button>${a.wrong + a.blank ? '<button class="secondary" id="retryWrong">✎ Practise mistakes</button>' : ''}`}</div></div>`;
  if (!a.isRevision) setupResultArtifacts(a); $('#resultHome').onclick = () => setTab('home'); $('#resultAgain')?.addEventListener('click', () => chooseMode(a.quizId)); $('#resultRevision')?.addEventListener('click', () => setTab('revision')); $('#resultPdf').onclick = () => exportAttemptPDF(a);
  const quizOf = () => db.quizzes.find(q => q.id === a.quizId);
  $$('[data-rbm]').forEach(b => b.onclick = () => { const d = a.details[Number(b.dataset.rbm)]; toggleBookmark(snapFromDetail(d, quizOf())); renderResult(a, filter); });
  $$('[data-rai]').forEach(b => b.onclick = () => { const d = a.details[Number(b.dataset.rai)]; askAI({ ...snapFromDetail(d, quizOf()), selected: d.selected }); });
  $('#perfToReports')?.addEventListener('click', () => setTab('reports'));
  $$('[data-filter]').forEach(b => b.onclick = () => renderResult(a, b.dataset.filter));
  $('#retryWrong')?.addEventListener('click', () => {
    const src = db.quizzes.find(q => q.id === a.quizId);
    const qs = a.details.filter(d => d.status !== 'correct').map(d => question(d.question, d.options.slice().sort((x, y) => x.original - y.original).map(o => o.text), d.correct, d.explanation));
    const mq = quizTemplate(`${a.quizTitle} — Mistakes`); mq.subject = src?.subject || 'Revision'; mq.settings = { ...(src?.settings || mq.settings), shuffleQ: false }; mq.questions = qs;
    db.quizzes.unshift(mq); save(); toast(`${qs.length} questions saved as "${mq.title}"`); chooseMode(mq.id);
  });
}

/* ------------------------------ REPORTS ------------------------------ */
function reports() {
  const at = db.attempts.filter(a => !a.isRevision), avg = at.length ? Math.round(at.reduce((s, a) => s + a.percent, 0) / at.length) : 0, best = at.length ? Math.max(...at.map(a => a.percent)) : 0;
  const pr = buildProfile(); const o = pr.overall;
  const trend = at.slice(0, 12).reverse();
  const qShort = t => esc(String(t || '').replace(/\s+/g, ' ').slice(0, 110)) + (String(t || '').length > 110 ? '…' : '');
  const statTable = (rows, label) => rows.length ? `<div class="table-wrap"><table class="stat-table"><thead><tr><th>${label}</th><th>Qs</th><th>✓</th><th>✕</th><th>Skip</th><th>Accuracy</th><th>Avg time</th></tr></thead><tbody>${rows.map(r => `<tr><td>${esc(r.key)}</td><td>${r.total}</td><td class="green-text">${r.correct}</td><td class="red-text">${r.wrong}</td><td>${r.blank}</td><td><div class="acc-bar"><i style="width:${r.acc}%" class="${r.acc >= 70 ? 'good' : r.acc >= 50 ? 'mid' : 'low'}"></i><span>${r.acc}%</span></div></td><td>${r.avgT ? r.avgT + 's' : '—'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-mini"><small>Complete a quiz to see this table.</small></div>';
  view.innerHTML = `<div class="page-title"><div><div class="eyebrow">YOUR PROGRESS</div><h1>Performance analytics</h1><p>Accuracy, speed, subjects, topics and negative marking — calculated on this device.</p></div><button class="secondary" id="exportAllReports">⇩ Export backup</button></div>
  <div class="stats-grid"><div class="stat-card"><small>ACCURACY</small><strong>${o.acc}%</strong><span>${o.correct} correct of ${o.attempted} attempted</span></div><div class="stat-card"><small>AVERAGE SCORE</small><strong>${avg}%</strong><span>${at.length} attempts · best ${best}%</span></div><div class="stat-card"><small>AVG TIME / QUESTION</small><strong>${o.avgT ? o.avgT + 's' : '—'}</strong><span>${o.avgTCorrect ? `✓ ${o.avgTCorrect}s · ✕ ${o.avgTWrong || '—'}s` : 'Time is tracked from v2.5'}</span></div><div class="stat-card"><small>NEGATIVE MARKS LOST</small><strong class="red-text">−${o.negLost}</strong><span>${o.wrong} wrong answers in total</span></div></div>
  <div class="stats-grid mini-stats"><div class="stat-card"><small>CORRECT</small><strong class="green-text">${o.correct}</strong></div><div class="stat-card"><small>INCORRECT</small><strong class="red-text">${o.wrong}</strong></div><div class="stat-card"><small>SKIPPED</small><strong>${o.blank}</strong></div><div class="stat-card"><small>RUSHED MISTAKES</small><strong class="amber-text">${o.rushed}</strong><span>wrong in under 12s</span></div></div>
  ${trend.length > 1 ? `<div class="panel trend"><div class="panel-head"><div><h3>Score trend</h3><p>Last ${trend.length} attempts</p></div></div><div class="bars">${trend.map(a => `<div class="bar" title="${esc(a.quizTitle)} · ${a.percent}%"><i style="height:${Math.max(4, a.percent)}%"></i><small>${a.percent}</small></div>`).join('')}</div></div>` : ''}
  <div class="two-col even"><div class="panel"><div class="panel-head"><div><h3>Subject-wise performance</h3><p>Weakest first</p></div></div>${statTable(pr.subjects, 'Subject')}</div><div class="panel"><div class="panel-head"><div><h3>Topic-wise performance</h3><p>Weakest 20 topics (untagged questions use the quiz name)</p></div></div>${statTable(pr.topics.slice(0, 20), 'Topic')}</div></div>
  <div class="two-col even"><div class="panel"><div class="panel-head"><div><h3>⚡ Fastest questions</h3><p>From recent attempts</p></div></div>${pr.fastest.length ? pr.fastest.map(d => `<div class="time-row"><b>${d.timeSec}s</b><span class="review-status ${d.status}">${d.status.toUpperCase()}</span><small>${qShort(d.question)}</small></div>`).join('') : '<div class="empty-mini"><small>No timed attempts yet.</small></div>'}</div><div class="panel"><div class="panel-head"><div><h3>🐢 Slowest questions</h3><p>Where you spend the most time</p></div></div>${pr.slowest.length ? pr.slowest.map(d => `<div class="time-row"><b>${d.timeSec}s</b><span class="review-status ${d.status}">${d.status.toUpperCase()}</span><small>${qShort(d.question)}</small></div>`).join('') : '<div class="empty-mini"><small>No timed attempts yet.</small></div>'}</div></div>
  <div class="panel"><div class="panel-head"><div><h3>➖ Negative marking calculator</h3><p>How wrong answers changed your marks</p></div></div><div class="neg-grid"><div><small>Raw correct</small><strong>+${o.correct}</strong></div><div><small>Lost to negative marking</small><strong class="red-text">−${o.negLost}</strong></div><div><small>Net marks</small><strong>${+(o.correct - o.negLost).toFixed(2)}</strong></div><div><small>If UPSC-style −⅓ applied</small><strong>${+(o.correct - o.wrong / 3).toFixed(2)}</strong></div></div><p class="muted">${o.wrong ? `Each wrong answer costs marks in negatively-marked tests. ${o.rushed ? `${o.rushed} of your wrong answers were given in under 12 seconds — slowing down on those could save marks.` : ''}` : 'No wrong answers recorded yet.'}</p></div>
  ${analystPanelHtml(pr)}
  <div class="panel"><div class="panel-head"><div><h3>Recent attempts</h3><p>Review results and download reports.</p></div>${at.length ? '<button class="textbtn danger-text" id="clearAttempts">Clear history</button>' : ''}</div>${at.length ? at.slice(0, 50).map(a => `<div class="attempt-row"><div class="attempt-icon">▥</div><div class="quiz-info"><b>${esc(a.quizTitle)}</b><small>${new Date(a.date).toLocaleString()} · ${a.correct}/${a.total} correct${a.mode ? ` · ${a.mode}` : ''}</small></div><strong class="${a.percent >= 60 ? 'green-text' : 'amber-text'}">${a.percent}%</strong><button class="textbtn" data-report="${a.id}">Review ↗</button></div>`).join('') : '<div class="empty-mini"><span>▥</span><b>No attempts yet</b><small>Complete a quiz to see your analytics here.</small></div>'}</div><div class="footer-note">Your performance data is stored locally. Export a backup regularly.</div>`;
  $('#exportAllReports').onclick = backup;
  $$('[data-report]').forEach(b => b.onclick = () => { const a = at.find(x => x.id === b.dataset.report); if (a) renderResult(a); });
  $('#clearAttempts')?.addEventListener('click', async () => { if (await confirmBox('Clear history?', 'All attempt results will be deleted. Quizzes and revision list stay.', 'Clear', true)) { db.attempts = []; save(); reports(); } });
  wireAnalyst();
}

/* ------------------------------ TOOLS ------------------------------ */
function tools() {
  view.innerHTML = `<div class="page-title"><div><div class="eyebrow">IMPORT · EXPORT · TRANSFORM</div><h1>File studio</h1><p>Work with your quiz files on this device.</p></div></div><div class="tool-grid">
  <div class="tool-card featured"><div class="tool-icon">📄</div><h3>PDF → TXT converter</h3><p>VisionIAS, ForumIAS SFG, Vajiram & Ravi, PW Only IAS, ForumIAS 100 and any text PDF. Converts to the 😂 quiz format.</p><button class="primary" id="pdfToTxt">Open converter</button></div>
  <div class="tool-card"><div class="tool-icon">⚡</div><h3>PW + Forum IAS suite</h3><p>Original supplied coaching converter with PW Only IAS and ForumIAS formats. Converted TXT can be imported directly into QUIZINOX.</p><button class="secondary" id="openCoachingSuite">Open PW + Forum suite</button></div>
  <div class="tool-card"><div class="tool-icon">⇧</div><h3>Import questions</h3><p>Load TXT, JSON or PDF files. Questions are detected automatically and saved as a quiz.</p><button class="secondary" id="toolImport">Choose a file</button></div>
  <div class="tool-card"><div class="tool-icon">🧹</div><h3>TXT fixer</h3><p>Removes blank lines after "…following:" headings, trailing spaces and extra empty lines.</p><button class="secondary" id="txtFix">Fix a TXT file</button></div>
  <div class="tool-card"><div class="tool-icon">😂</div><h3>Emoji formatter</h3><p>Converts Q.1) / numbered questions into the 😂-separated quiz format, expanding 1️⃣ 2️⃣ points.</p><button class="secondary" id="txtFormat">Format a TXT file</button></div>
  <div class="tool-card"><div class="tool-icon">⇩</div><h3>Backup & restore</h3><p>Export all quizzes, attempts and settings to one JSON file, or restore one.</p><button class="secondary" id="backupBtn">Export backup</button><button class="textbtn" id="restoreBtn">Restore from backup →</button></div>
  <div class="tool-card"><div class="tool-icon">📤</div><h3>Export quiz</h3><p>Save a quiz as JSON, TXT (😂 format) or a printable PDF.</p><button class="secondary" id="exportPick">Choose quiz to export</button></div>
  <div class="tool-card"><div class="tool-icon">✦</div><h3>AI question generator</h3><p>Online · Gemini free. UPSC MCQs, statements, match, assertion-reason and more from a topic, PDF or notes.</p><button class="secondary" id="aiOpen">Open AI generator</button></div>
  </div><div class="notice">🔐 Files are processed on your device. Scanned (image-only) PDFs have no text layer — use the AI generator with a text PDF instead.</div>`;
  $('#toolImport').onclick = () => $('#fileInput').click(); $('#pdfToTxt').onclick = () => openPdfStudio(); $('#openCoachingSuite').onclick = () => openCoachingSuite(); $('#txtFix').onclick = () => txtTool('fix'); $('#txtFormat').onclick = () => txtTool('format'); $('#backupBtn').onclick = backup; $('#restoreBtn').onclick = () => $('#restoreInput').click();
  $('#exportPick').onclick = () => { if (!db.quizzes.length) return toast('No quizzes to export'); actionSheet('Export which quiz?', '', db.quizzes.slice(0, 30).map(q => ({ icon: '▤', label: q.title, hint: `${q.questions.length} questions`, run: () => exportQuiz(q) }))); };
  $('#aiOpen').onclick = () => aiGenerator();
}
function pickFile(accept) { return new Promise(res => { const inp = document.createElement('input'); inp.type = 'file'; inp.accept = accept; inp.onchange = () => res(inp.files[0] || null); inp.click(); }); }
function openPdfStudio() {
  const engines = {
    generic: { name: 'Any PDF (auto)', hint: 'Normal text PDFs — auto-detects SFG-style Q./Ans./Exp. layouts', two: false },
    sfg: { name: 'ForumIAS SFG', hint: 'Single PDF with questions, Ans) and Exp) — 50 Q', two: false },
    vajiram: { name: 'Vajiram & Ravi', hint: 'Test booklet PDF + Solution PDF — 100 Q', two: true },
    vision: { name: 'VisionIAS', hint: 'Test booklet PDF + Solution PDF ("Q 1.A" answers) — 100 Q', two: true },
  };
  const st = { engine: 'generic', test: null, sol: null, result: null };
  const { el, close } = modal(`<div class="eyebrow">PDF → TXT · ON DEVICE</div><h2>Coaching PDF converter</h2><p>Choose the coaching format, select the PDF(s) and convert.</p>
   <div class="engine-grid">${Object.entries(engines).map(([k, e]) => `<button class="engine ${k === 'generic' ? 'active' : ''}" data-engine="${k}"><b>${e.name}</b><small>${e.hint}</small></button>`).join('')}</div>
   <div class="file-slots"><button class="file-slot" id="slotTest"><span>📄</span><b id="testLabel">Select PDF</b><small id="testName">No file chosen</small></button><button class="file-slot" id="slotSol" hidden><span>🧾</span><b>Select Solution PDF</b><small id="solName">No file chosen</small></button></div>
   <div class="progress small" id="pdfProg" hidden><i style="width:0%"></i></div><div class="muted" id="pdfStatus"></div>
   <div id="pdfResult"></div>
   <div class="dialog-actions"><button class="primary" id="runPdf" disabled>Convert</button></div>`, { wide: true });
  const refresh = () => {
    const e = engines[st.engine];
    $$('.engine', el).forEach(b => b.classList.toggle('active', b.dataset.engine === st.engine));
    $('#slotSol', el).hidden = !e.two; $('#testLabel', el).textContent = e.two ? 'Select Test PDF' : 'Select PDF';
    $('#testName', el).textContent = st.test?.name || 'No file chosen'; $('#solName', el).textContent = st.sol?.name || 'No file chosen';
    $('#runPdf', el).disabled = !st.test || (e.two && !st.sol);
  };
  $$('.engine', el).forEach(b => b.onclick = () => { st.engine = b.dataset.engine; st.result = null; $('#pdfResult', el).innerHTML = ''; refresh(); });
  $('#slotTest', el).onclick = async () => { const f = await pickFile('.pdf,application/pdf'); if (f) { st.test = f; refresh(); } };
  $('#slotSol', el).onclick = async () => { const f = await pickFile('.pdf,application/pdf'); if (f) { st.sol = f; refresh(); } };
  const prog = (pct, msg) => { const p = $('#pdfProg', el); p.hidden = false; $('i', p).style.width = pct + '%'; $('#pdfStatus', el).textContent = msg; };
  $('#runPdf', el).onclick = async () => {
    const btn = $('#runPdf', el); btn.disabled = true; btn.textContent = 'Converting…';
    try {
      prog(3, 'Opening PDF…');
      const pdf = await getPdfEngines();
      const testPages = await pdf.extractPages(st.test, (p, m) => prog(5 + p * (engines[st.engine].two ? .4 : .75), m));
      if (!testPages.some(p => p.items.length)) throw Error('This PDF has no selectable text (it is scanned/image-only).');
      let res;
      if (st.engine === 'generic') {
        const raw = pdf.genericText(testPages); const sfg = pdf.sfgFormat(raw);
        const nSfg = (sfg.match(/^Q\d+\./gm) || []).length, nRaw = parseText(raw).length;
        res = nSfg >= Math.max(3, nRaw) ? countResult(sfg) : countResult(raw, nRaw);
        res.note = nSfg >= Math.max(3, nRaw) ? 'Detected Q./Ans./Exp. layout — converted to 😂 quiz format.' : 'Extracted plain text.';
      } else if (st.engine === 'sfg') res = pdf.processSFG(testPages);
      else {
        const solPages = await pdf.extractPages(st.sol, (p, m) => prog(50 + p * .35, 'Solution: ' + m));
        prog(90, 'Matching answers and explanations…');
        res = st.engine === 'vajiram' ? pdf.processVajiram(testPages, solPages) : pdf.processVision(testPages, solPages);
      }
      if (!res.output.trim()) throw Error('No text could be extracted from this PDF.');
      if (st.engine === 'sfg' && !res.questionCount) throw Error('No SFG questions found. Questions must start like "Q.1)" with "Ans)" and "Exp)" lines. Try "Any PDF (auto)".');
      st.result = res; prog(100, 'Done ✓');
      const s = res.stats;
      $('#pdfResult', el).innerHTML = `<div class="convert-stats"><div><strong>${res.questionCount}</strong><small>questions</small></div><div><strong>${s?.matched ?? '—'}</strong><small>answers ✅</small></div><div><strong>${s?.explanationsFound ?? '—'}</strong><small>explanations</small></div></div>${res.note ? `<div class="muted">${esc(res.note)}</div>` : ''}${s && s.noAns ? `<div class="muted amber-text">${s.noAns} question(s) without a matched answer — check them before playing.</div>` : ''}<textarea class="txt-preview" readonly>${esc(res.output.slice(0, 20000))}</textarea><div class="dialog-actions"><button class="secondary" id="dlTxt">⇩ Save TXT</button><button class="secondary" id="copyTxt">⎘ Copy</button><button class="primary" id="importTxt" ${parseText(res.output).length ? '' : 'disabled'}>＋ Save as quiz</button></div>`;
      const base = st.test.name.replace(/\.pdf$/i, '');
      $('#dlTxt', el).onclick = async () => { const r = await saveFile(`${base}.txt`, res.output, 'text/plain'); toast(`TXT saved (${r.where}) ✓`); };
      $('#copyTxt', el).onclick = async () => { try { await navigator.clipboard.writeText(res.output); toast('Copied'); } catch { $('.txt-preview', el).select(); document.execCommand('copy'); toast('Copied'); } };
      $('#importTxt', el).onclick = () => { const qs = parseText(res.output); if (!qs.length) return toast('No questions detected'); const q = quizTemplate(base); q.subject = engines[st.engine].name.replace(' (auto)', ''); q.questions = qs; db.quizzes.unshift(q); save(); close(); toast(`${qs.length} questions saved as a quiz ✓`); setTab('quizzes'); };
    } catch (e) { console.error(e); prog(100, ''); $('#pdfStatus', el).innerHTML = `<span class="red-text">✕ ${esc(e.message || e)}</span>`; }
    finally { btn.textContent = 'Convert'; refresh(); }
  };
  refresh();
}
function countResult(output, n) { const qc = n ?? (output.match(/^Q\d+\./gm) || []).length; const m = (output.match(/✅/g) || []).length; const ex = (output.match(/^Ex:/gm) || []).length; return { output, questionCount: qc, stats: { matched: m, noAns: Math.max(0, qc - m), explanationsFound: ex } }; }
async function txtTool(mode) {
  const f = await pickFile('.txt,text/plain'); if (!f) return;
  const t = await f.text(); let out, msg;
  if (mode === 'fix') { const r = fixQuestionsFile(t); out = r.text; msg = `Fixed — ${r.removed} blank line(s) removed`; }
  else { out = convertFormat(t); msg = 'Formatted to 😂 quiz format'; }
  const n = parseText(out).length;
  const { el, close } = modal(`<div class="eyebrow">${mode === 'fix' ? 'TXT FIXER' : 'EMOJI FORMATTER'}</div><h2>${esc(f.name)}</h2><p>${msg}${n ? ` · ${n} questions detected` : ''}</p><textarea class="txt-preview" readonly>${esc(out.slice(0, 20000))}</textarea><div class="dialog-actions"><button class="secondary" id="dl">⇩ Save TXT</button><button class="primary" id="imp" ${n ? '' : 'disabled'}>＋ Save as quiz</button></div>`, { wide: true });
  $('#dl', el).onclick = async () => { const r = await saveFile(f.name.replace(/\.txt$/i, '') + (mode === 'fix' ? '_fixed' : '_formatted') + '.txt', out, 'text/plain'); toast(`Saved (${r.where}) ✓`); };
  $('#imp', el).onclick = () => { const q = quizTemplate(f.name.replace(/\.txt$/i, '')); q.questions = parseText(out); db.quizzes.unshift(q); save(); close(); toast(`${q.questions.length} questions imported ✓`); setTab('quizzes'); };
}
async function importFile(file) {
  try {
    const ext = file.name.split('.').pop().toLowerCase(), name = file.name.replace(/\.[^.]+$/, '');
    let qs = [];
    if (ext === 'pdf') {
      toast('Reading PDF on device…', 8000);
      const pdf = await getPdfEngines();
      const pages = await pdf.extractPages(file);
      if (!pages.some(p => p.items.length)) return toast('This PDF has no selectable text (scanned). Try the AI generator.');
      const raw = pdf.genericText(pages);
      const a = parseText(raw), b = parseText(pdf.sfgFormat(raw));
      qs = b.length > a.length ? b : a;
      if (!qs.length) { toast('No MCQs found. For Vajiram / VisionIAS use File Studio → PDF converter.', 5000); return; }
    } else {
      const text = await file.text();
      if (ext === 'json') { const obj = JSON.parse(text); if (obj?.app === 'QUIZINOX' && obj.data) return restoreBackup(file); qs = parseJSON(text); if (obj?.title && qs.length) { const q = { ...quizTemplate(obj.title), ...obj, id: uid(), questions: qs, settings: { ...quizTemplate().settings, ...(obj.settings || {}) } }; db.quizzes.unshift(q); save(); toast(`${qs.length} questions imported ✓`); setTab('quizzes'); return; } }
      else qs = parseText(text);
    }
    if (!qs.length) { toast('No MCQs detected. Questions need numbering (Q1. / 1.) and options.', 4500); return; }
    const q = quizTemplate(name || 'Imported quiz'); q.questions = qs; db.quizzes.unshift(q); save();
    toast(`${qs.length} questions imported ✓`); setTab('quizzes');
  } catch (e) { console.error(e); toast('Could not read this file: ' + e.message, 4500); }
}
function parseJSON(t) {
  const obj = typeof t === 'string' ? JSON.parse(t.replace(/^```(?:json)?\s*|\s*```$/g, '')) : t; const arr = Array.isArray(obj) ? obj : obj.questions || [];
  return arr.map(x => {
    const opts = Array.isArray(x.options) ? x.options.map(o => typeof o === 'string' ? o : (o.text ?? '')) : [];
    let c = x.correct_option_id ?? x.correct ?? x.answer ?? x.correctIndex ?? 0;
    if (typeof c === 'string') { const k = c.trim().toUpperCase().replace(/[().]/g, ''); c = /^[A-H]$/.test(k) ? k.charCodeAt(0) - 65 : /^\d+$/.test(k) ? Number(k) : Math.max(0, opts.findIndex(o => o.trim().toLowerCase() === c.trim().toLowerCase())); }
    return question(String(x.question || x.question_text || x.text || '').trim(), opts.map(o => String(o).trim()), c, x.explanation || '');
  }).filter(q => q.text && q.options.length >= 2 && Number.isInteger(q.correct) && q.correct >= 0 && q.correct < q.options.length);
}
function quizToTxt(q) { return q.questions.map((x, i) => `Q${i + 1}. ${x.text}\n😂\n${x.options.map((o, j) => j === x.correct ? `${o} ✅` : o).join('\n')}${x.explanation ? `\nEx: ${x.explanation}` : ''}`).join('\n\n') + '\n'; }
function exportQuiz(q) {
  actionSheet(`Export "${q.title}"`, 'Choose a format', [
    { icon: '{ }', label: 'JSON', hint: 'Full quiz with settings — re-import anytime', run: async () => { const r = await saveFile(slug(q.title) + '.json', JSON.stringify(q, null, 2), 'application/json'); toast(`Saved (${r.where}) ✓`); } },
    { icon: '😂', label: 'TXT (quiz format)', hint: 'Q1. … 😂 … ✅ … Ex:', cls: 'practice-icon', run: async () => { const r = await saveFile(slug(q.title) + '.txt', quizToTxt(q), 'text/plain'); toast(`Saved (${r.where}) ✓`); } },
    { icon: '⎙', label: 'PDF question paper', hint: 'Questions + answer key', run: () => exportQuizPDF(q) },
  ]);
}
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9\u0900-\u097f]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'quiz'; }
function backup() { saveFile(`quizinox-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ app: 'QUIZINOX', version: 2, exportedAt: new Date().toISOString(), data: { ...db, settings: { ...db.settings, geminiKey: '', aiKeys: [] } } }, null, 2), 'application/json').then(r => toast(`Backup saved (${r.where}) ✓`)); }
async function restoreBackup(file) {
  try {
    const b = JSON.parse(await file.text()); const d = b.data || b;
    if (!Array.isArray(d.quizzes) || !Array.isArray(d.attempts)) throw Error('Not a QUIZINOX backup file');
    actionSheet('Restore backup', `${d.quizzes.length} quizzes · ${d.attempts.length} attempts`, [
      { icon: '⊕', label: 'Merge with current data', hint: 'Keeps your current quizzes, adds missing ones', cls: 'practice-icon', run: () => { const qIds = new Set(db.quizzes.map(q => q.id)), aIds = new Set(db.attempts.map(a => a.id)); db.quizzes.push(...d.quizzes.filter(q => !qIds.has(q.id))); db.attempts.push(...d.attempts.filter(a => !aIds.has(a.id))); db.revision = { ...(d.revision || {}), ...db.revision }; db.bookmarks = { ...(d.bookmarks || {}), ...db.bookmarks }; db.attempts.sort((x, y) => String(y.date).localeCompare(String(x.date))); save(); setTab('home'); toast('Backup merged ✓'); } },
      { icon: '↺', label: 'Replace everything', hint: 'Current data on this device is replaced', danger: true, cls: 'danger-icon', run: () => { const keys = db.settings.aiKeys || []; db = normalizeState({ ...d, settings: { ...(d.settings || {}), geminiKey: '', aiKeys: keys } }); save(); $('#profileName').textContent = db.settings.name || 'Learner'; setTab('home'); toast('Backup restored ✓'); } },
    ]);
  } catch (e) { toast('Backup invalid: ' + e.message); }
}

/* ------------------------------ PDF REPORTS ------------------------------ */
// jsPDF core fonts only cover Latin-1; strip unsupported characters so the PDF never breaks.
const pdfSafe = s => String(s ?? '').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, '-').replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '');
function pdfWriter(title, jsPDF) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' }); let y = 18;
  const ensure = h => { if (y + h > 284) { doc.addPage(); y = 16; } };
  const text = (t, x = 14, size = 10, style = 'normal', width = 182, color = [20, 24, 36]) => { doc.setFont('helvetica', style); doc.setFontSize(size); doc.setTextColor(...color); const lines = doc.splitTextToSize(pdfSafe(t), width); const lh = size * 0.45; ensure(lines.length * lh); doc.text(lines, x, y); y += lines.length * lh + 1.2; };
  doc.setFillColor(17, 24, 39); doc.rect(0, 0, 210, 12, 'F'); doc.setTextColor(255, 255, 255); doc.setFontSize(9); doc.text('QUIZINOX', 14, 8); y = 22;
  text(title, 14, 17, 'bold');
  return { doc, text, gap: (h = 3) => { y += h; }, ensure };
}
async function exportAttemptPDF(a) {
  const { jsPDF } = await getJsPDF();
  const w = pdfWriter('Result Report', jsPDF);
  w.text(a.quizTitle, 14, 12, 'bold'); w.text(`Date: ${new Date(a.date).toLocaleString()}${a.durationSec ? `   Time taken: ${fmtDur(a.durationSec)}` : ''}`);
  w.text(`Score: ${a.percent}%   Marks: ${a.score}/${a.total}   Correct: ${a.correct}   Wrong: ${a.wrong}   Unanswered: ${a.blank}`, 14, 11, 'bold'); w.gap(4);
  a.details.forEach((d, i) => {
    const idx = o => d.options.findIndex(x => x.original === o);
    w.text(`${i + 1}. ${d.question}`, 14, 10, 'bold');
    d.options.forEach((o, j) => w.text(`${L(j)}. ${o.text}${o.original === d.correct ? '  (correct)' : o.original === d.selected ? '  (your answer)' : ''}`, 18, 9, o.original === d.correct ? 'bold' : 'normal', 176, o.original === d.correct ? [10, 120, 80] : o.original === d.selected ? [190, 40, 60] : [60, 66, 80]));
    w.text(`Your answer: ${d.selected == null ? 'Not answered' : L(idx(d.selected))}  |  Correct: ${L(idx(d.correct))}  |  ${d.status.toUpperCase()}`, 18, 9, 'italic');
    if (d.explanation) w.text('Explanation: ' + d.explanation, 18, 9, 'normal', 176, [70, 76, 92]);
    w.gap(3);
  });
  saveFile(`${slug(a.quizTitle)}-result.pdf`, w.doc.output('blob'), 'application/pdf').then(r => toast(`PDF saved (${r.where}) ✓`));
}
async function exportQuizPDF(q) {
  const { jsPDF } = await getJsPDF();
  const w = pdfWriter(q.title, jsPDF);
  w.text(`${q.questions.length} questions · ${q.subject || 'General'}${q.settings.negative ? ` · Negative: -${q.settings.negative}` : ''}`, 14, 10, 'italic'); w.gap(3);
  q.questions.forEach((x, i) => { w.text(`${i + 1}. ${x.text}`, 14, 10, 'bold'); x.options.forEach((o, j) => w.text(`${L(j)}. ${o}`, 18, 9.5)); w.gap(2.5); });
  w.doc.addPage(); w.text('Answer key & explanations', 14, 14, 'bold');
  q.questions.forEach((x, i) => { w.text(`${i + 1}. ${L(x.correct)}${x.explanation ? ' — ' + x.explanation : ''}`, 14, 9.5); });
  saveFile(`${slug(q.title)}.pdf`, w.doc.output('blob'), 'application/pdf').then(r => toast(`PDF saved (${r.where}) ✓`));
}

/* ------------------------------ AI (ONLINE) ------------------------------ */
async function gemini(prompt, { json = true, ...rest } = {}) { const r = await AI.aiCall(prompt, { json, ...rest }); return r.text; }
const GEN_TYPES = {
  mcq: { label: 'Standard MCQ', rule: 'Standard single-best-answer MCQ with 4 options.' },
  statement: { label: 'Statement-based', rule: 'Statement-based (UPSC style): start with "Consider the following statements:" then 2–4 numbered statements, each on its own line (use \\n), then ask "Which of the statements given above is/are correct?" or "How many of the above statements are correct?". Options like "1 only", "1 and 2 only", "2 and 3 only", "1, 2 and 3" or "Only one", "Only two", "All three", "None".' },
  match: { label: 'Match the following', rule: 'Match the following: put "List-I" (A, B, C, D) and "List-II" (1, 2, 3, 4) inside the question, each item on its own line (use \\n). Options are codes like "A-2, B-3, C-1, D-4".' },
  ar: { label: 'Assertion–Reason', rule: 'Assertion–Reason: question has "Assertion (A): ..." and "Reason (R): ..." on separate lines (use \\n). Options exactly: "Both A and R are true and R is the correct explanation of A", "Both A and R are true but R is not the correct explanation of A", "A is true but R is false", "A is false but R is true".' },
  multi: { label: 'Multiple correct answers', rule: 'Multiple-correct: list 3–4 numbered items in the question (use \\n) and ask which of them are correct. Options are combinations such as "1 and 2 only", "2 and 3 only", "1, 3 and 4 only", "1, 2, 3 and 4" — exactly one combination is fully correct.' },
  pairs: { label: 'Pairs (how many matched)', rule: 'Pairs (UPSC style): "Consider the following pairs:" then 3–4 lines "Item : Match" (use \\n). Ask how many pairs are correctly matched. Options: "Only one pair", "Only two pairs", "All three pairs", "None of the pairs" (adjust to the number of pairs).' },
  chrono: { label: 'Chronology / sequence', rule: 'Chronology/sequence: 4 numbered events or items in the question (use \\n); ask for the correct order. Options are sequences like "2-1-4-3".' },
};
function aiItemsToQuestions(obj, fallbackType = 'mcq') {
  const arr = Array.isArray(obj) ? obj : (obj?.questions || []);
  return arr.map(x => {
    const opts = (Array.isArray(x?.options) ? x.options : []).map(o => String(typeof o === 'string' ? o : (o?.text ?? '')).replace(/^\(?[A-Ha-h][).]\s+/, '').trim()).filter(Boolean);
    let c = x?.correct ?? x?.answer ?? x?.correct_option ?? x?.correctIndex ?? 0;
    if (typeof c === 'string') { const k = c.trim().toUpperCase().replace(/[().]/g, ''); c = /^[A-H]$/.test(k) ? k.charCodeAt(0) - 65 : /^\d+$/.test(k) ? Number(k) : opts.findIndex(o => o.toLowerCase() === String(x.correct).trim().toLowerCase()); }
    const q = question(String(x?.question || x?.text || '').trim(), opts, Number(c), String(x?.explanation || '').trim(), String(x?.topic || '').trim());
    if (!Number.isInteger(Number(c))) q.correct = -1;
    q.qtype = String(x?.type || fallbackType); q.difficulty = String(x?.difficulty || '');
    return q;
  }).filter(q => q.text && q.options.length >= 2 && Number.isInteger(q.correct) && q.correct >= 0 && q.correct < q.options.length);
}
function splitChunks(text, size = 12000) {
  const t = String(text || '').replace(/\r\n?/g, '\n').trim(); if (!t) return [];
  const out = []; let i = 0;
  while (i < t.length) { let end = Math.min(t.length, i + size); if (end < t.length) { const br = t.lastIndexOf('\n\n', end); if (br > i + size * 0.5) end = br; } out.push(t.slice(i, end)); i = end; }
  return out;
}
function aiGenerator(preset = {}) {
  if (!AI.getKeys().length) { toast('Add a Gemini API key in Settings first'); setTab('settings'); return; }
  let sourceText = preset.sourceText || ''; let source = preset.source || 'topic'; let cancel = null; let generated = [];
  const types = new Set(preset.types || ['mcq', 'statement']);
  const weak = buildProfile().topics.filter(t => t.total >= 2).slice(0, 5).map(t => t.key);
  const { el, close } = modal(`<div class="eyebrow">AI · ONLINE · GEMINI FREE</div><h2>AI question generator</h2><p>UPSC-level questions from a topic, a PDF / TXT, pasted notes or your weak topics.</p>
   <div class="seg" id="genSource">${[['topic', '✎ Topic'], ['file', '📄 PDF / TXT'], ['paste', '⎘ Paste notes'], ['weak', '◎ My weak topics']].map(([k, l]) => `<button data-src="${k}" class="${k === source ? 'active' : ''}">${l}</button>`).join('')}</div>
   <label>Topic / instructions<input id="aiTopic" value="${esc(preset.topic || '')}" placeholder="e.g. Indian Polity — Fundamental Rights (Articles 12–35)"/></label>
   <div class="file-slots" id="genFileBox" hidden><button class="file-slot" id="aiSrc"><span>📄</span><b>Choose notes / PDF</b><small id="aiSrcName">TXT or text PDF</small></button></div>
   <label id="genPasteBox" hidden>Paste your notes<textarea id="aiPaste" rows="6" placeholder="Paste notes, an article or NCERT text…"></textarea></label>
   <label>Focus on (optional)<input id="aiFocus" placeholder="e.g. recent amendments, landmark cases, maps, current affairs links"/></label>
   <div class="eyebrow gen-label">QUESTION TYPES</div>
   <div class="type-chips">${Object.entries(GEN_TYPES).map(([k, t]) => `<button class="chip ${types.has(k) ? 'active' : ''}" data-type="${k}">${t.label}</button>`).join('')}</div>
   <div class="form-grid three"><label>Questions<select id="aiCount">${[5, 10, 15, 20, 25, 30, 40, 50].map(n => `<option ${n === (preset.count || 10) ? 'selected' : ''}>${n}</option>`).join('')}</select></label><label>Difficulty<select id="aiDiff"><option>Mixed</option><option>Easy</option><option>Moderate</option><option selected>Hard (UPSC Prelims level)</option><option>Very hard (UPSC toppers)</option></select></label><label>Exam style<select id="aiExam"><option>UPSC Civil Services Prelims</option><option>State PSC</option><option>SSC / Banking / Railways</option><option>NCERT basics</option><option>General knowledge</option></select></label>
   <label>Language<select id="aiLang"><option>English</option><option>Hindi</option><option>Bilingual (English + Hindi)</option></select></label><label>Explanations<select id="aiExpl"><option value="detailed">Detailed (why right + why others wrong)</option><option value="short">Short (1–3 lines)</option></select></label><label>Save to<select id="aiTarget"><option value="new">New quiz</option>${db.quizzes.slice(0, 40).map(q => `<option value="${q.id}">Add to: ${esc(q.title.slice(0, 40))}</option>`).join('')}</select></label></div>
   <div class="notice compact" id="aiBudget"></div>
   <div class="progress small" id="genProg" hidden><i style="width:0%"></i></div><div class="muted" id="aiStatus"></div><div id="genPreview"></div>
   <div class="dialog-actions"><button class="secondary" id="aiCancel" hidden>Stop</button><button class="primary" id="aiGo">✦ Generate</button></div>`, { wide: true });
  const budget = () => { const n = Number($('#aiCount', el).value); const per = $('#aiExpl', el).value === 'detailed' ? 6 : 10; const req = Math.ceil(n / per); const m = db.settings.aiModel || AI.FALLBACK_CHAIN[0]; $('#aiBudget', el).innerHTML = `Uses about <b>${req} AI request${req > 1 ? 's' : ''}</b> (${per} questions per request). Free quota left today on ${esc(AI.limitsFor(m).name)}: ~<b>${AI.remainingToday(m)}</b> requests across ${AI.getKeys().filter(k => k.enabled !== false && k.status !== 'invalid').length} key(s).`; };
  const setSource = k => { source = k; $$('#genSource button', el).forEach(b => b.classList.toggle('active', b.dataset.src === k)); $('#genFileBox', el).hidden = k !== 'file'; $('#genPasteBox', el).hidden = k !== 'paste'; if (k === 'weak') { if (!weak.length) { toast('Complete a few quizzes first so weak topics can be found'); } else $('#aiTopic', el).value = 'My weak topics: ' + weak.join('; '); } };
  $$('#genSource button', el).forEach(b => b.onclick = () => setSource(b.dataset.src)); setSource(source);
  $$('[data-type]', el).forEach(b => b.onclick = () => { const k = b.dataset.type; if (types.has(k) && types.size > 1) types.delete(k); else types.add(k); b.classList.toggle('active', types.has(k)); });
  ['#aiCount', '#aiExpl'].forEach(id => $(id, el).onchange = budget); budget();
  $('#aiSrc', el).onclick = async () => { const f = await pickFile('.txt,.pdf,text/plain,application/pdf'); if (!f) return; $('#aiSrcName', el).textContent = 'Reading…'; try { if (/\.pdf$/i.test(f.name)) { const pdf = await getPdfEngines(); sourceText = pdf.genericText(await pdf.extractPages(f)); } else sourceText = await f.text(); if (!sourceText.trim()) throw Error('No text found'); $('#aiSrcName', el).textContent = `${f.name} · ${sourceText.length.toLocaleString()} chars · ${splitChunks(sourceText).length} part(s)`; if (!$('#aiTopic', el).value) $('#aiTopic', el).value = f.name.replace(/\.[^.]+$/, ''); } catch (e) { sourceText = ''; $('#aiSrcName', el).textContent = 'Could not read: ' + e.message; } };
  $('#aiCancel', el).onclick = () => cancel?.abort();
  const prog = (pct, msg) => { const p = $('#genProg', el); p.hidden = false; $('i', p).style.width = pct + '%'; if (msg != null) $('#aiStatus', el).textContent = msg; };
  const showPreview = () => {
    $('#genPreview', el).innerHTML = generated.length ? `<div class="gen-preview"><div class="panel-head"><div><h3>${generated.length} questions ready</h3><p>Untick any you don't want, then save.</p></div><button class="textbtn" id="genToggleAll">Toggle all</button></div>${generated.map((q, i) => `<label class="gen-item"><input type="checkbox" data-keep="${i}" checked/><span><em class="tag">${esc(GEN_TYPES[q.qtype]?.label || q.qtype)}</em> ${escMl(q.text.slice(0, 400))}<small>✓ ${esc(q.options[q.correct] || '')}${q.topic ? ` · ${esc(q.topic)}` : ''}</small></span></label>`).join('')}<div class="dialog-actions"><input id="genTitle" placeholder="Quiz title" value="${esc(($('#aiTopic', el).value.trim() || 'Notes').slice(0, 70) + ' — AI Quiz')}"/><button class="primary" id="genSave">＋ Save selected</button></div></div>` : '';
    $('#genToggleAll', el)?.addEventListener('click', () => { const boxes = $$('[data-keep]', el); const on = !boxes.every(b => b.checked); boxes.forEach(b => b.checked = on); });
    $('#genSave', el)?.addEventListener('click', () => {
      const keep = $$('[data-keep]', el).filter(b => b.checked).map(b => generated[Number(b.dataset.keep)]); if (!keep.length) return toast('Select at least one question');
      const target = $('#aiTarget', el).value;
      if (target !== 'new') { const qz = db.quizzes.find(q => q.id === target); if (qz) { qz.questions.push(...keep); qz.updatedAt = new Date().toISOString(); if (qz.translations) qz.translations = {}; save(); close(); toast(`${keep.length} questions added to "${qz.title}" ✓`); setTab('quizzes'); return; } }
      const q = quizTemplate($('#genTitle', el).value.trim() || 'AI Quiz'); q.subject = preset.subject || 'AI generated'; q.description = `AI generated · ${$('#aiExam', el).value} · ${$('#aiDiff', el).value}`; q.questions = keep; db.quizzes.unshift(q); save(); close(); toast(`${keep.length} AI questions saved ✓`); setTab('quizzes');
    });
  };
  $('#aiGo', el).onclick = async () => {
    let topic = $('#aiTopic', el).value.trim(); const focus = $('#aiFocus', el).value.trim();
    let src = source === 'file' ? sourceText : source === 'paste' ? $('#aiPaste', el).value.trim() : '';
    if (source === 'file' && !src) return toast('Choose a notes / PDF file first');
    if (source === 'paste' && src.length < 80) return toast('Paste some notes (at least a few lines)');
    if (!topic && !src) return toast('Enter a topic');
    const count = Number($('#aiCount', el).value), lang = $('#aiLang', el).value, diff = $('#aiDiff', el).value, exam = $('#aiExam', el).value, detail = $('#aiExpl', el).value;
    const per = detail === 'detailed' ? 6 : 10, batches = Math.ceil(count / per), chunks = splitChunks(src);
    const typeList = [...types]; const plan = Array.from({ length: count }, (_, i) => typeList[i % typeList.length]);
    const langRule = lang === 'Hindi' ? 'Write everything (questions, options, explanations, topic) in Hindi (Devanagari script).' : lang.startsWith('Bilingual') ? 'Bilingual: write every question, option and explanation in English, then a new line (\\n) with the Hindi (Devanagari) translation of the same text.' : 'Write everything in clear English.';
    const btn = $('#aiGo', el); btn.disabled = true; btn.textContent = 'Generating…'; $('#aiCancel', el).hidden = false; cancel = new AbortController(); generated = []; showPreview();
    const seen = new Set();
    try {
      for (let b = 0; b < batches; b++) {
        const slice = plan.slice(b * per, b * per + per); const n = slice.length; if (!n) break;
        const mix = Object.entries(slice.reduce((m, t) => (m[t] = (m[t] || 0) + 1, m), {}));
        const chunk = chunks.length ? chunks[Math.min(chunks.length - 1, Math.floor(b * chunks.length / batches))] : '';
        const avoid = generated.slice(-20).map(q => q.text.replace(/\s+/g, ' ').slice(0, 90));
        const prompt = `You are an expert question setter for ${exam}. Create exactly ${n} NEW, high-quality multiple-choice questions${topic ? ` on: ${topic}` : ''}.${focus ? ` Focus on: ${focus}.` : ''}
Difficulty: ${diff}. ${langRule}
Question mix for this set: ${mix.map(([t, k]) => `${k} × ${GEN_TYPES[t].label}`).join(', ')}.
Rules for each type:
${mix.map(([t]) => `- ${GEN_TYPES[t].label}: ${GEN_TYPES[t].rule}`).join('\n')}
General rules:
- Exactly 4 options and exactly one correct option. "correct" is the zero-based index (0–3). Vary the position of the correct option.
- Explanation: ${detail === 'detailed' ? '4–6 sentences explaining why the correct option is right AND why each other option is wrong, plus one related fact worth remembering.' : '1–3 crisp sentences.'}
- "topic": short sub-topic (2–5 words). "type": one of ${mix.map(([t]) => `"${t}"`).join(', ')}.
- Facts must be accurate and unambiguous. Avoid "All of the above"/"None of the above" unless the type requires it.
${chunk ? `Base every question ONLY on the source material between the <source> tags:\n<source>\n${chunk}\n</source>\n` : ''}${avoid.length ? `Do not repeat or closely copy these existing questions:\n- ${avoid.join('\n- ')}\n` : ''}Return ONLY JSON: {"questions":[{"type":"${mix[0][0]}","question":"...","options":["...","...","...","..."],"correct":0,"explanation":"...","topic":"...","difficulty":"moderate"}]}`;
        prog(Math.round(b / batches * 100), `Set ${b + 1} of ${batches}…`);
        let got = [];
        for (let tryNo = 0; tryNo < 2 && !got.length; tryNo++) {
          try {
            const r = await AI.aiCall(prompt, { json: true, maxTokens: 8192, temperature: 0.7, signal: cancel.signal, onStatus: m => prog(Math.round(b / batches * 100), `Set ${b + 1}/${batches}: ${m}`) });
            got = aiItemsToQuestions(AI.parseJsonLoose(r.text), slice[0]);
          } catch (e) { if (['abort', 'nokey', 'offline', 'limit', 'blocked'].includes(e.code) || tryNo === 1) throw e; }
        }
        for (const q of got) { const k = normQ(q.text).slice(0, 120); if (seen.has(k)) continue; seen.add(k); generated.push(q); }
        showPreview();
      }
      prog(100, `Done ✓ ${generated.length} questions generated.`);
    } catch (e) {
      prog(100, ''); $('#aiStatus', el).innerHTML = `<span class="${e.code === 'abort' ? 'amber-text' : 'red-text'}">${e.code === 'abort' ? '■ Stopped.' : '✕ ' + esc(e.message)}</span>${generated.length ? ` <span class="muted">${generated.length} questions made before this — you can still save them.</span>` : ''}`;
    } finally { btn.disabled = false; btn.textContent = generated.length ? '✦ Generate again' : '✦ Generate'; $('#aiCancel', el).hidden = true; cancel = null; budget(); }
  };
}
const QUIZ_LANGS = Object.fromEntries(`hi:Hindi|bn:Bengali|te:Telugu|mr:Marathi|ta:Tamil|gu:Gujarati|ur:Urdu|kn:Kannada|ml:Malayalam|pa:Punjabi|or:Odia|as:Assamese|ne:Nepali|sa:Sanskrit|sd:Sindhi|gom:Konkani|mai:Maithili|doi:Dogri|bho:Bhojpuri|mni-Mtei:Manipuri|si:Sinhala|af:Afrikaans|sq:Albanian|am:Amharic|ar:Arabic|hy:Armenian|ay:Aymara|az:Azerbaijani|bm:Bambara|eu:Basque|be:Belarusian|bs:Bosnian|bg:Bulgarian|ca:Catalan|ceb:Cebuano|ny:Chichewa|zh-CN:Chinese Simplified|zh-TW:Chinese Traditional|co:Corsican|hr:Croatian|cs:Czech|da:Danish|dv:Dhivehi|nl:Dutch|en:English|eo:Esperanto|et:Estonian|tl:Filipino|fi:Finnish|fr:French|fy:Frisian|gl:Galician|ka:Georgian|de:German|el:Greek|gn:Guarani|ht:Haitian Creole|ha:Hausa|haw:Hawaiian|iw:Hebrew|hmn:Hmong|hu:Hungarian|is:Icelandic|ig:Igbo|ilo:Ilocano|id:Indonesian|ga:Irish|it:Italian|ja:Japanese|jw:Javanese|kk:Kazakh|km:Khmer|rw:Kinyarwanda|ko:Korean|ku:Kurdish|ky:Kyrgyz|lo:Lao|la:Latin|lv:Latvian|ln:Lingala|lt:Lithuanian|lg:Luganda|lb:Luxembourgish|mk:Macedonian|mg:Malagasy|ms:Malay|mt:Maltese|mi:Maori|mn:Mongolian|my:Myanmar|no:Norwegian|om:Oromo|ps:Pashto|fa:Persian|pl:Polish|pt:Portuguese|qu:Quechua|ro:Romanian|ru:Russian|sm:Samoan|gd:Scots Gaelic|sr:Serbian|st:Sesotho|sn:Shona|sk:Slovak|sl:Slovenian|so:Somali|es:Spanish|su:Sundanese|sw:Swahili|sv:Swedish|tg:Tajik|tt:Tatar|th:Thai|ti:Tigrinya|tr:Turkish|tk:Turkmen|ak:Twi|uk:Ukrainian|ug:Uyghur|uz:Uzbek|vi:Vietnamese|cy:Welsh|xh:Xhosa|yi:Yiddish|yo:Yoruba|zu:Zulu`.split('|').map(x=>{const i=x.indexOf(':');return [x.slice(0,i),x.slice(i+1)]}));
const languageLabel = c => QUIZ_LANGS[c] || c;
const TSEP='ZXQLINESEPZX', tCache=new Map();
async function translateBatch(texts,tl,sl='auto'){
  if(!navigator.onLine)throw Error('Internet connection required.');
  const out=new Array(texts.length), ids=[]; texts.forEach((x,i)=>{if(String(x||'').trim())ids.push(i);else out[i]=x;});
  const batches=[];let b=[],n=0;for(const i of ids){const z=String(texts[i]).length+TSEP.length+4;if(b.length&&n+z>3000){batches.push(b);b=[];n=0;}b.push(i);n+=z;}if(b.length)batches.push(b);
  async function one(input,ep){const url=ep===1?`https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t`:`https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}`;const c=new AbortController(),tm=setTimeout(()=>c.abort(),25000);try{const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'},body:'q='+encodeURIComponent(input),signal:c.signal});if(!r.ok)throw Error('Translation service HTTP '+r.status);const d=await r.json();if(ep===1&&Array.isArray(d?.[0]))return d[0].map(x=>x?.[0]||'').join('');const x=Array.isArray(d)?d[0]:null;if(Array.isArray(x))return String(x[0]||'');if(typeof x==='string')return x;if(d?.sentences)return d.sentences.map(x=>x.trans||'').join('');throw Error('Unexpected translation response');}finally{clearTimeout(tm);}}
  async function run(g,depth=0){const input=g.map(i=>texts[i]).join('\n'+TSEP+'\n'),key=sl+'|'+tl+'|'+input;try{let val=tCache.get(key);if(!val){let err;for(let k=0;k<4;k++){try{val=await one(input,k%2?2:1);tCache.set(key,val);break;}catch(e){err=e;await new Promise(r=>setTimeout(r,400*(k+1)));}}if(val==null)throw err||Error('Translation failed');}const parts=val.split(new RegExp(`\\s*${TSEP}\\s*`,'i'));if(parts.length!==g.length&&g.length>1)throw Error('Batch formatting changed');g.forEach((i,j)=>out[i]=parts[j]||texts[i]);}catch(e){if(g.length>1&&depth<3){const m=Math.ceil(g.length/2);await Promise.all([run(g.slice(0,m),depth+1),run(g.slice(m),depth+1)]);}else throw e;}}
  let nextBatch=0;await Promise.all(Array.from({length:Math.min(6,batches.length)},async()=>{while(nextBatch<batches.length){const i=nextBatch++;await run(batches[i]);}}));return out;
}
async function translateQuestionSet(qs,code){const flat=[],map=[];qs.forEach((q,i)=>{flat.push(q.text);map.push([i,'q']);q.options.forEach((o,j)=>{flat.push(o);map.push([i,'o',j]);});flat.push(q.explanation||'');map.push([i,'e']);});const tr=await translateBatch(flat,code);const out=qs.map(q=>({...q,options:[...q.options]}));map.forEach((m,i)=>{if(m[1]==='q')out[m[0]].text=tr[i]||qs[m[0]].text;else if(m[1]==='o')out[m[0]].options[m[2]]=tr[i]||qs[m[0]].options[m[2]];else out[m[0]].explanation=tr[i]||qs[m[0]].explanation;});return out;}
async function ensureQuizTranslation(q,code,status=()=>{}){if(code==='original')return q.questions;q.translations||={};if(q.translations[code]?.length===q.questions.length)return q.translations[code];status(`Bulk translating ${q.questions.length} questions into ${languageLabel(code)}…`);const out=await translateQuestionSet(q.questions,code);q.translations[code]=out;save();return out;}
function chooseLanguage(q,callback,current='original'){const opts=Object.entries(QUIZ_LANGS).map(([c,n])=>`<option value="${esc(c)}">${esc(n)} (${c})</option>`).join('');const {el,close}=modal(`<div class="eyebrow">ONLINE · BULK TRANSLATION</div><h2>Switch quiz language</h2><p>Question, every option and explanation are translated together. The original remains unchanged.</p><label>Language<select id="langPick"><option value="original">Original</option>${opts}</select></label><div class="muted" id="langStatus">Requires internet. Public Google translation endpoints may rate-limit.</div><div class="dialog-actions"><button class="primary" id="langApply">Translate / Switch</button></div>`,{wide:true});$('#langPick',el).value=current;$('#langApply',el).onclick=async()=>{const code=$('#langPick',el).value,b=$('#langApply',el);b.disabled=true;b.textContent='Translating…';try{await callback(code,m=>$('#langStatus',el).textContent=m);close();}catch(e){$('#langStatus',el).textContent='Translation failed: '+e.message;b.disabled=false;b.textContent='Retry';}};}
function openPlayerLanguagePicker() {
  if (!play) return; const p = play; const cur = p.langs?.length ? p.langs : ['original'];
  const opts = (sel, none) => `${none ? '<option value="">— none —</option>' : ''}<option value="original" ${sel === 'original' ? 'selected' : ''}>Original (as created)</option>${Object.entries(QUIZ_LANGS).map(([c, n]) => `<option value="${esc(c)}" ${c === sel ? 'selected' : ''}>${esc(n)}${p.quiz.translations?.[c] ? ' ✓' : ''}</option>`).join('')}`;
  const { el, close } = modal(`<div class="eyebrow">MULTI-LANGUAGE MODE</div><h2>Question language</h2><p>Show one language, or 2–3 languages together (bilingual / multilingual). Answers are kept when you switch. ✓ = already translated (works offline).</p>
   <div class="seg" id="lmMode"><button data-m="single" class="${p.langMode !== 'multi' ? 'active' : ''}">One language</button><button data-m="multi" class="${p.langMode === 'multi' ? 'active' : ''}">Bilingual / multilingual</button></div>
   <label>Main language<select id="lm1">${opts(cur[0] || 'original')}</select></label>
   <div id="lmExtra"><label>Second language<select id="lm2">${opts(cur[1] || (cur[0] === 'hi' ? 'original' : 'hi'), true)}</select></label><label>Third language (optional)<select id="lm3">${opts(cur[2] || '', true)}</select></label></div>
   <div class="muted" id="langStatus">Missing languages are translated online once and then saved on this device.</div><div class="dialog-actions"><button class="primary" id="langApply">Apply</button></div>`, { wide: true });
  let mode = p.langMode === 'multi' ? 'multi' : 'single';
  const sync = () => { $$('#lmMode button', el).forEach(b => b.classList.toggle('active', b.dataset.m === mode)); $('#lmExtra', el).hidden = mode !== 'multi'; };
  $$('#lmMode button', el).forEach(b => b.onclick = () => { mode = b.dataset.m; sync(); }); sync();
  $('#langApply', el).onclick = async () => {
    const picks = [...new Set([$('#lm1', el).value, $('#lm2', el).value, $('#lm3', el).value].filter(Boolean))];
    const need = (mode === 'multi' ? picks : picks.slice(0, 1)).filter(c => c !== 'original');
    if (mode === 'multi' && picks.length < 2) return toast('Choose a second language for bilingual mode');
    const b = $('#langApply', el); b.disabled = true; b.textContent = 'Preparing…';
    try {
      for (const c of need) await ensureQuizTranslation(p.quiz, c, m => $('#langStatus', el).textContent = m);
      if (play !== p) return close();
      p.langs = picks; p.langMode = mode; db.settings.langs = picks; db.settings.langMode = mode; save(); savePlay(); close(); renderPlayer();
      toast(mode === 'multi' ? `Showing ${picks.map(c => c === 'original' ? 'Original' : languageLabel(c)).join(' + ')}` : `Showing ${picks[0] === 'original' ? 'original language' : languageLabel(picks[0])}`);
    } catch (e) { $('#langStatus', el).textContent = 'Translation failed: ' + e.message; b.disabled = false; b.textContent = 'Retry'; }
  };
}
async function translateQuiz(q){chooseLanguage(q,async(code,status)=>{if(code==='original')return;await ensureQuizTranslation(q,code,status);toast(`${languageLabel(code)} translation saved ✓`);render();});}
function openCoachingSuite(){const url=import.meta.env.BASE_URL+'tools/coaching-suite.html';modal(`<div class="eyebrow">PW + FORUM IAS · ORIGINAL TOOL</div><h2>Coaching PDF Converter Suite</h2><p>PW Only IAS, ForumIAS 100, SFG, VisionIAS and Vajiram. Downloaded TXT files are detected and can be imported into QUIZINOX.</p><iframe title="Coaching converter" src="${url}" style="width:100%;height:74vh;border:1px solid var(--line);border-radius:12px;background:#080808"></iframe>`,{wide:true});}
window.addEventListener('message',ev=>{if(ev.data?.type!=='QUIZINOX_COACHING_TXT')return;const txt=String(ev.data.text||''),name=String(ev.data.name||'Coaching Test').replace(/\.txt$/i,'');const qs=parseText(txt);if(!qs.length)return toast('TXT received but MCQs could not be parsed.');const q=quizTemplate(name);q.subject=ev.data.coaching||'Coaching PDF';q.questions=qs;const {el,close}=modal(`<div class="eyebrow">CONVERSION COMPLETE</div><h2>${esc(name)}</h2><p>${qs.length} questions detected.</p><textarea class="txt-preview" readonly>${esc(txt.slice(0,15000))}</textarea><div class="dialog-actions"><button class="secondary" id="coachingTxtSave">Save TXT</button><button class="primary" id="coachingImport">Import as QUIZINOX quiz</button></div>`,{wide:true});$('#coachingTxtSave',el).onclick=()=>saveFile(`${slug(name)}.txt`,txt,'text/plain');$('#coachingImport',el).onclick=()=>{db.quizzes.unshift(q);save();close();toast('Quiz imported ✓');setTab('quizzes');};});
function resultQuizForLanguage(a,code){const q=db.quizzes.find(x=>x.id===a.quizId);if(code!=='original'&&q?.translations?.[code])return {title:a.quizTitle,questions:q.translations[code]};if(code==='original'&&q?.questions)return {title:a.quizTitle,questions:q.questions};return {title:a.quizTitle,questions:a.details.map(d=>({text:d.question,options:d.options.slice().sort((x,y)=>x.original-y.original).map(x=>x.text),correct:d.options.findIndex(x=>x.original===d.correct),explanation:d.explanation||''}))};}
function setupResultArtifacts(a){
  const q=db.quizzes.find(x=>x.id===a.quizId),sel=$('#artifactLang'),target=$('#artifactTarget');if(!sel||!target)return;
  const refresh=()=>{sel.innerHTML='<option value="original">Original</option>'+Object.keys(q?.translations||{}).map(c=>`<option value="${esc(c)}">${esc(languageLabel(c))}</option>`).join('');};
  refresh();target.innerHTML=Object.entries(QUIZ_LANGS).map(([c,n])=>`<option value="${esc(c)}">${esc(n)}</option>`).join('');
  const cur=()=>resultQuizForLanguage(a,sel.value), name=(suffix,ext)=>`${slug(cur().title)}-${slug(languageLabel(sel.value))}-${suffix}.${ext}`;
  const getHtml=async(kind)=>kind==='quiz'?await makeSuppliedQuizHtml(cur(),languageLabel(sel.value)):kind==='notes'?buildNotesDoc(cur()):null;
  const download=async(kind)=>{try{if(kind==='quiz'||kind==='notes'){const html=await getHtml(kind);await saveFile(name(kind,'html'),html,'text/html');toast(`${kind==='quiz'?'Quiz':'Notes'} HTML downloaded ✓`);return;}const blob=await makeStudyPdf(cur(),kind);await saveFile(name(kind,'pdf'),blob,'application/pdf');toast('PDF downloaded ✓');}catch(e){console.error(e);toast('Could not create file: '+e.message,5000);}};
  const share=async(kind)=>{try{if(kind==='quiz'||kind==='notes'){const html=await getHtml(kind);await shareFile(name(kind,'html'),html,'text/html');}else{const blob=await makeStudyPdf(cur(),kind);await shareFile(name(kind,'pdf'),blob,'application/pdf');}}catch(e){console.error(e);toast('Share failed: '+e.message,5000);}};
  $('#artifactTranslate').onclick=async()=>{const c=target.value,b=$('#artifactTranslate');b.disabled=true;b.textContent='Translating…';try{await ensureQuizTranslation(q,c,m=>$('#artifactStatus').textContent=m);refresh();sel.value=c;$('#artifactStatus').textContent=`${languageLabel(c)} is ready. Exports now use this language.`;}catch(e){$('#artifactStatus').textContent='Translation failed: '+e.message;}finally{b.disabled=false;b.textContent='🌐 Translate / prepare language';}};
  [['downloadQuizHtml','quiz'],['downloadNotesHtml','notes'],['downloadTestPdf','test'],['downloadSolPdf','solution'],['downloadMergedPdf','merged'],['downloadNotesPdf','notespdf']].forEach(([id,k])=>$('#'+id).onclick=()=>download(k==='notespdf'?'notes-pdf':k));
  [['shareQuizHtml','quiz'],['shareNotesHtml','notes'],['shareTestPdf','test'],['shareSolPdf','solution'],['shareMergedPdf','merged'],['shareNotesPdf','notespdf']].forEach(([id,k])=>$('#'+id).onclick=()=>share(k==='notespdf'?'notes-pdf':k));
  $('#openTestMaker').onclick=()=>openSuppliedTool('test-series-maker',cur());$('#openNotesMaker').onclick=()=>openSuppliedTool('notes-generator',cur());$('#openQuizMaker').onclick=()=>openSuppliedTool('quiz-maker',cur());$('#openTranslatorTool').onclick=()=>openSuppliedTool('txt-pdf-translator',cur());
}

async function makeSuppliedQuizHtml(q,lang){
  const content=q.questions.map((x,i)=>`Q${i+1}. ${x.text}\n😂\n${x.options.map((o,j)=>o+(j===x.correct?' ✅':'')).join('\n')}${x.explanation?'\nEx: '+x.explanation:''}`).join('\n\n')+'\n';
  return new Promise((resolve,reject)=>{
    const frame=document.createElement('iframe');frame.style.cssText='position:fixed;left:-10000px;top:0;width:1200px;height:900px';
    const timer=setTimeout(()=>{frame.remove();reject(new Error('Supplied Quiz Maker did not finish in time.'));},30000);
    const cleanup=()=>{clearTimeout(timer);frame.remove();};
    const receive=ev=>{if(ev.source!==frame.contentWindow||ev.data?.type!=='QUIZINOX_GENERATED_HTML')return;window.removeEventListener('message',receive);cleanup();resolve(ev.data.html);};
    window.addEventListener('message',receive);
    frame.onload=async()=>{try{const d=frame.contentDocument,w=frame.contentWindow,input=d.getElementById('file-input');if(!input)throw Error('Supplied Quiz Maker input was not found');const f=new File([content],`${slug(q.title)}.txt`,{type:'text/plain'});const dt=new w.DataTransfer();dt.items.add(f);input.files=dt.files;input.dispatchEvent(new w.Event('change',{bubbles:true}));await new Promise(r=>setTimeout(r,250));const mode=d.querySelector('input[name="quiz-mode"][value="combined"]');if(mode)mode.checked=true;const trans=d.querySelector('input[name="translate-mode"][value="off"]');if(trans)trans.checked=true;const gen=d.getElementById('generate-btn');if(!gen)throw Error('Quiz Maker generate button not found');gen.click();}catch(e){window.removeEventListener('message',receive);cleanup();reject(e);}};
    frame.src=import.meta.env.BASE_URL+'tools/quiz-maker.html';document.body.appendChild(frame);
  });
}

function buildPrintDoc(q,mode='test'){
  const part=(x,i)=>`<section><b>Q${i+1}. ${esc(x.text)}</b>${x.options.map((o,j)=>`<p>${String.fromCharCode(65+j)}. ${esc(o)}</p>`).join('')}</section>`;
  const test=`<h1>${esc(q.title)} — Test</h1>${q.questions.map(part).join('')}`;
  const sol=`<h1>${esc(q.title)} — Solution & Answer Key</h1>${q.questions.map((x,i)=>`<section><b>Q${i+1}. ${String.fromCharCode(65+x.correct)}. ${esc(x.options[x.correct]||'')}</b><p>${esc(x.explanation||'No explanation provided.')}</p></section>`).join('')}`;
  const body=mode==='test'?test:mode==='solution'?sol:test+'<div style="break-before:page"></div>'+sol;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(q.title)}</title><style>body{font:12pt Arial,sans-serif;color:#111;margin:22px}h1{text-align:center}section{break-inside:avoid;margin:14px 0;padding-bottom:9px;border-bottom:1px solid #ddd}p{margin:5px 0}@media print{body{margin:16mm}}</style></head><body>${body}</body></html>`;
}
function buildNotesDoc(q){return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(q.title)} — Notes</title><style>body{font:15px/1.7 Georgia,serif;background:#f4f0e7;color:#18243b;padding:25px;max-width:950px;margin:auto}.page{background:#fffdf6;padding:25px;border:1px solid #ddd;margin:16px 0;break-inside:avoid}h1,h2{color:#193d70}h2{border-bottom:1px solid #ddd;padding-bottom:6px}.answer{color:#14734b;font-weight:bold}@media print{body{background:white}}</style></head><body><h1>${esc(q.title)} — Study Notes</h1><p>Study notes generated from ${q.questions.length} quiz questions.</p>${q.questions.map((x,i)=>`<article class="page"><h2>Topic ${i+1}: ${esc(x.text)}</h2><p><b>Question focus:</b> ${esc(x.text)}</p><p class="answer">Correct answer: ${String.fromCharCode(65+x.correct)}. ${esc(x.options[x.correct]||'')}</p><h3>Explanation / Key points</h3><p>${esc(x.explanation||'No explanation supplied in the source quiz.')}</p><h3>Options for revision</h3><ol type="A">${x.options.map(o=>`<li>${esc(o)}</li>`).join('')}</ol></article>`).join('')}</body></html>`;}
async function makeStudyPdf(q,mode){
  const { jsPDF } = await getJsPDF();
  const doc=new jsPDF({unit:'mm',format:'a4'});let y=18;const page=()=>{doc.addPage();y=18;};
  // Embed Noto Sans Devanagari when available so Hindi is retained in downloaded PDFs.
  let pdfFont='helvetica';
  try{for(const [file,style] of [['NotoSansDevanagari-Regular.ttf','normal'],['NotoSansDevanagari-Bold.ttf','bold']]){const r=await fetch(import.meta.env.BASE_URL+'fonts/'+file);if(!r.ok)continue;const bytes=new Uint8Array(await r.arrayBuffer());let bin='';for(let i=0;i<bytes.length;i+=0x8000)bin+=String.fromCharCode(...bytes.subarray(i,i+0x8000));doc.addFileToVFS(file,btoa(bin));doc.addFont(file,'NotoDevanagari',style);}pdfFont='NotoDevanagari';}catch{pdfFont='helvetica';}
  const txt=(str,size=10,bold=false)=>{doc.setFont(pdfFont,bold?'bold':'normal');doc.setFontSize(size);const lines=doc.splitTextToSize(String(str??''),180);for(const line of lines){if(y>282)page();doc.text(line,15,y);y+=Math.max(5,size*.48);}};
  doc.setFillColor(18,31,52);doc.rect(0,0,210,11,'F');doc.setTextColor(255,255,255);doc.setFont('helvetica','bold');doc.setFontSize(9);doc.text('QUIZINOX',15,7.5);doc.setTextColor(25,35,52);y=20;txt(q.title,17,true);txt(`${q.questions.length} Questions · ${mode==='test'?'Test':mode==='solution'?'Solution':'Test + Solution'}`,10);y+=4;
  const writeTest=()=>q.questions.forEach((x,i)=>{txt(`Q${i+1}. ${x.text}`,11,true);x.options.forEach((o,j)=>txt(`${String.fromCharCode(65+j)}. ${o}`,10));y+=2;});
  const writeSolutions=()=>q.questions.forEach((x,i)=>{txt(`Q${i+1}. ${String.fromCharCode(65+x.correct)}. ${x.options[x.correct]||''}`,11,true);if(x.explanation)txt(`Explanation: ${x.explanation}`,10);y+=3;});
  if(mode==='test')writeTest();else if(mode==='solution')writeSolutions();else if(mode==='merged'){writeTest();page();writeSolutions();}else if(mode==='notes-pdf'){q.questions.forEach((x,i)=>{txt(`Topic ${i+1}: ${x.text}`,12,true);txt(`Correct answer: ${String.fromCharCode(65+x.correct)}. ${x.options[x.correct]||''}`,10,true);txt(`Key points: ${x.explanation||'No explanation supplied.'}`,10);txt('Options: '+x.options.join(' | '),9);y+=4;});}
  return doc.output('blob');
}

function openSuppliedTool(kind,q){
  const paths={'test-series-maker':'test-series-maker.html','notes-generator':'notes-generator.html','quiz-maker':'quiz-maker.html','txt-pdf-translator':'txt-pdf-translator.html'};
  const inputs={'test-series-maker':'fileInput','notes-generator':'file-input','quiz-maker':'file-input','txt-pdf-translator':'file'};
  const url=import.meta.env.BASE_URL+'tools/'+paths[kind];
  const {el}=modal(`<div class="eyebrow">SUPPLIED ORIGINAL TOOL</div><h2>${esc(kind.replace(/-/g,' '))}</h2><p>QUIZINOX is preparing the selected language's quiz text and loading it into the original tool.</p><iframe id="suppliedToolFrame" title="${esc(kind)}" src="${url}" style="width:100%;height:76vh;border:1px solid var(--line);border-radius:12px;background:#fff"></iframe>`,{wide:true});
  const frame=$('#suppliedToolFrame',el),lang=$('#artifactLang')?.value||'original';
  const content=q.questions.map((x,i)=>`Q${i+1}. ${x.text}\n😂\n${x.options.map((o,j)=>o+(j===x.correct?' ✅':'')).join('\n')}${x.explanation?'\nEx: '+x.explanation:''}`).join('\n\n')+'\n';
  frame.addEventListener('load',async()=>{
    try{
      const doc=frame.contentDocument,win=frame.contentWindow,input=doc.getElementById(inputs[kind]);
      if(!input)return;
      const f=new File([content],`${slug(q.title)}-${slug(languageLabel(lang))}.txt`,{type:'text/plain'});
      const dt=new win.DataTransfer();dt.items.add(f);input.files=dt.files;input.dispatchEvent(new win.Event('change',{bubbles:true}));
      if(kind==='test-series-maker'){
        await new Promise(r=>setTimeout(r,450));
        doc.getElementById('btnGeneratePDFs')?.click();
      }
      if(kind==='quiz-maker'){
        const gen=doc.querySelector('#generate-btn, #generateBtn, button[type="submit"]');
        if(gen)gen.click();
      }
      if(kind==='txt-pdf-translator'){
        const sl=doc.getElementById('sl'),tl=doc.getElementById('tl');
        if(tl&&lang!=='original')tl.value=lang;
      }
    }catch(e){toast('Could not prefill original tool: '+e.message);}
  },{once:true});
}


/* ------------------------------ SETTINGS ------------------------------ */
function settings() {
  const used = (() => { try { return Math.round((localStorage.getItem(STORE) || '').length / 1024); } catch { return 0; } })();
  const st = db.settings, model = st.aiModel || AI.FALLBACK_CHAIN[0];
  const langOpts = (sel, none) => `${none ? '<option value="">— none —</option>' : ''}<option value="original" ${sel === 'original' ? 'selected' : ''}>Original (as created)</option>${Object.entries(QUIZ_LANGS).map(([c, n]) => `<option value="${esc(c)}" ${c === sel ? 'selected' : ''}>${esc(n)}</option>`).join('')}`;
  view.innerHTML = `<div class="page-title"><div><div class="eyebrow">APP PREFERENCES</div><h1>Settings</h1><p>Personalize the app, manage AI keys and local data.</p></div></div><div class="settings-layout"><div class="panel"><h3>Profile</h3><label>Your display name<input id="userName" value="${esc(st.name || 'Learner')}"/></label><button class="primary" id="saveProfile">Save profile</button><div class="divider"></div>
  <h3>AI keys <span class="tag">OPTIONAL · ONLINE · GEMINI FREE</span></h3><p class="muted">AI runs only when you tap an AI button. Get free keys at <b>aistudio.google.com/apikey</b>. Add several keys — if one is invalid, busy or out of free quota, QUIZINOX automatically uses the next one. Keys stay on this device and are never included in backups.</p>
  <div id="keyList" class="key-list"></div>
  <div class="key-add"><input id="newKeyLabel" placeholder="Label (e.g. Gmail 2)"/><input id="newKey" type="password" autocomplete="off" placeholder="Paste Gemini API key (AIza…)"/><button class="primary" id="addKey">＋ Add key</button></div>
  <div class="title-actions row"><button class="textbtn" id="bulkKeys">⎘ Paste many keys at once</button><button class="secondary" id="testKeys">Test all keys</button><button class="textbtn" id="resetKeys">Reset limit status</button></div>
  <label>Preferred model<select id="aiModel">${Object.entries(AI.MODELS).map(([id, m]) => `<option value="${id}" ${model === id ? 'selected' : ''}>${esc(m.name)} — ${esc(m.note)}</option>`).join('')}${AI.MODELS[model] ? '' : `<option value="${esc(model)}" selected>${esc(model)} (custom)</option>`}</select></label>
  <label>Custom model name (optional)<input id="aiCustomModel" placeholder="e.g. gemini-3-flash — leave empty to use the list above" value="${AI.MODELS[model] ? '' : esc(model)}"/></label>
  <label class="check"><input type="checkbox" id="aiFallback" ${st.aiAutoFallback === false ? '' : 'checked'}/> Auto-switch to another free model when this one is busy, missing or out of quota</label>
  <div class="form-grid"><label>AI Study Analyst runs per day<select id="analystDaily">${[2, 3, 5, 10].map(n => `<option ${Number(st.analystDaily) === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label><label>AI answer language<select id="tutorLangSet">${['English', 'Hindi', 'Hinglish'].map(l => `<option ${st.tutorLang === l ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
  <button class="secondary" id="saveAi">Save AI settings</button>
  <div class="notice compact"><b>Free-tier guard.</b> QUIZINOX uses at most ${Math.round(AI.SAFETY * 100)}% of Google's published free limits per key: ${Object.values(AI.MODELS).map(m => `${esc(m.name)} ${AI.safeCap(m.rpm)}/min · ${AI.safeCap(m.rpd)}/day`).join(' · ')}. Daily limits reset at midnight Pacific time (about 1:30 pm IST). Keys made in the <b>same</b> Google Cloud project share one quota — keys from different Google accounts/projects add real capacity. Google may change these limits.</div>
  <div class="divider"></div>
  <h3>Question languages</h3><p class="muted">Default display for new attempts. Languages that aren't translated yet for a quiz can be added from 🌐 inside the quiz.</p>
  <div class="form-grid"><label>Display mode<select id="langModeSet"><option value="single" ${st.langMode !== 'multi' ? 'selected' : ''}>One language</option><option value="multi" ${st.langMode === 'multi' ? 'selected' : ''}>Bilingual / multilingual</option></select></label><label>Main language<select id="lang1Set">${langOpts(st.langs?.[0] || 'original')}</select></label><label>Second language<select id="lang2Set">${langOpts(st.langs?.[1] || '', true)}</select></label><label>Third language<select id="lang3Set">${langOpts(st.langs?.[2] || '', true)}</select></label></div><button class="secondary" id="saveLangs">Save language preference</button>
  <div class="divider"></div>
  <h3>Data management</h3><p class="muted">Your quizzes and reports use about ${used} KB on this device. Export a backup before clearing app data.</p><button class="secondary" id="settingsBackup">⇩ Export backup</button><button class="textbtn" id="settingsRestore">Restore backup</button><button class="textbtn" id="clearAiCache">Clear saved AI answers</button><button class="textbtn danger-text" id="clearData">Delete all local data</button></div>
  <div class="panel"><h3>About QUIZINOX</h3><img class="about-logo" src="${iconUrl}" alt="QUIZINOX"/><h2>QUIZINOX</h2><p class="muted">A private, offline-first quiz workspace.</p><div class="about-list"><span>✓ Works fully offline — quizzes, results, PDF tools, search, revision</span><span>✓ Smart navigation: swipe, keyboard shortcuts, jump, bookmarks, resume</span><span>✓ Detailed analytics: accuracy, speed, subject/topic, negative marking</span><span>✓ Automatic revision: 1 → 3 → 7 → 15 days</span><span>✓ Multi-language & bilingual question display</span><span>✓ AI analyst, Ask-AI tutor & UPSC question generator (optional, free Gemini keys)</span><span>✓ Coaching PDF converter: SFG · Vajiram · VisionIAS · PW · ForumIAS</span><span>✓ No account, no subscription</span></div><div class="notice">Uninstalling the app or clearing its data erases saved quizzes — keep a backup.</div><div class="version">Version ${APP_VERSION}</div></div></div>`;
  const renderKeys = () => {
    const keys = st.aiKeys || [], usage = Object.fromEntries(AI.usageSummary().map(u => [u.id, u]));
    $('#keyList').innerHTML = keys.length ? keys.map((k, i) => { const a = AI.keyAvailability(k, model); const pill = k.enabled === false ? ['OFF', ''] : k.status === 'invalid' ? ['INVALID', 'red'] : a.reason === 'daily' ? ['DAILY LIMIT', 'amber'] : a.reason === 'cooldown' || a.reason === 'minute' ? [`WAIT ${Math.ceil((a.wait || 0) / 1000)}s`, 'amber'] : k.status === 'ok' ? ['READY', 'green'] : ['NOT TESTED', '']; return `<div class="key-row"><span class="key-num">${i + 1}</span><div class="key-info"><b>${esc(k.label || 'Key ' + (i + 1))}</b><small>••••${esc(String(k.key).slice(-4))} · ${usage[k.id]?.total || 0} requests today${k.lastError ? ` · ${esc(k.lastError)}` : ''}</small></div><span class="pill ${pill[1]}">${pill[0]}</span><button class="textbtn" data-ktest="${k.id}">Test</button><button class="textbtn" data-ktoggle="${k.id}">${k.enabled === false ? 'Enable' : 'Disable'}</button><button class="mini delete" data-kdel="${k.id}" title="Remove">×</button></div>`; }).join('') : '<div class="empty-mini"><span>⚿</span><b>No API keys yet</b><small>Offline features work without a key.</small></div>';
    $$('[data-ktest]').forEach(b => b.onclick = async () => { b.textContent = '…'; try { const r = await AI.testKey(b.dataset.ktest, model); toast(r.ok ? `Key works ✓ (${r.model})` : '✕ ' + r.message, 4500); } catch (e) { toast('✕ ' + e.message, 4500); } renderKeys(); });
    $$('[data-ktoggle]').forEach(b => b.onclick = () => { const k = st.aiKeys.find(x => x.id === b.dataset.ktoggle); k.enabled = k.enabled === false; save(); renderKeys(); });
    $$('[data-kdel]').forEach(b => b.onclick = async () => { if (!(await confirmBox('Remove key?', 'This API key will be deleted from this device.', 'Remove', true))) return; st.aiKeys = st.aiKeys.filter(x => x.id !== b.dataset.kdel); AI.forgetKeyUsage(b.dataset.kdel); save(); renderKeys(); });
  };
  const addKeys = (list) => { let n = 0; for (const { label, key } of list) { const v = key.trim(); if (!v || st.aiKeys.some(k => k.key === v)) continue; st.aiKeys.push({ id: uid(), label: label || `Key ${st.aiKeys.length + 1}`, key: v, enabled: true, status: 'unknown' }); n++; } save(); renderKeys(); return n; };
  renderKeys();
  $('#addKey').onclick = () => { const key = $('#newKey').value.trim(); if (key.length < 20) return toast('Paste a valid Gemini API key'); const n = addKeys([{ label: $('#newKeyLabel').value.trim(), key }]); $('#newKey').value = ''; $('#newKeyLabel').value = ''; toast(n ? 'Key added ✓ — tap Test to check it' : 'This key is already saved'); };
  $('#bulkKeys').onclick = () => { const { el, close } = modal(`<div class="eyebrow">AI KEYS</div><h2>Paste many keys</h2><p>One key per line. Optional label: <code>Label = AIza…</code></p><textarea id="bulkKeyText" rows="7" placeholder="AIza...\nGmail 2 = AIza..."></textarea><div class="dialog-actions"><button class="primary" id="bulkKeyAdd">Add keys</button></div>`, { wide: true }); $('#bulkKeyAdd', el).onclick = () => { const list = $('#bulkKeyText', el).value.split(/\n+/).map(l => l.trim()).filter(Boolean).map(l => { const m = l.match(/^(.*?)\s*[=:]\s*(\S{20,})$/); return m ? { label: m[1].trim(), key: m[2] } : { label: '', key: l }; }).filter(x => x.key.length >= 20); const n = addKeys(list); close(); toast(`${n} key(s) added`); }; };
  $('#testKeys').onclick = async () => { const keys = (st.aiKeys || []).filter(k => k.enabled !== false); if (!keys.length) return toast('Add a key first'); toast(`Testing ${keys.length} key(s)…`); let ok = 0; for (const k of keys) { try { const r = await AI.testKey(k.id, model); if (r.ok) ok++; } catch { /* shown in list */ } renderKeys(); } toast(`${ok}/${keys.length} key(s) working`, 4000); };
  $('#resetKeys').onclick = () => { AI.resetUsageFlags(); (st.aiKeys || []).forEach(k => { if (k.status !== 'invalid') k.status = 'unknown'; else { k.status = 'unknown'; k.lastError = ''; } }); save(); renderKeys(); toast('Key status reset'); };
  $('#saveAi').onclick = () => { const custom = $('#aiCustomModel').value.trim(); st.aiModel = custom || $('#aiModel').value; st.aiAutoFallback = $('#aiFallback').checked; st.analystDaily = Number($('#analystDaily').value) || 5; st.tutorLang = $('#tutorLangSet').value; save(); toast('AI settings saved ✓'); settings(); };
  $('#saveLangs').onclick = () => { const picks = [...new Set([$('#lang1Set').value, $('#lang2Set').value, $('#lang3Set').value].filter(Boolean))]; st.langs = picks.length ? picks : ['original']; st.langMode = $('#langModeSet').value === 'multi' && picks.length > 1 ? 'multi' : 'single'; save(); toast('Language preference saved ✓'); };
  $('#saveProfile').onclick = () => { st.name = $('#userName').value.trim() || 'Learner'; $('#profileName').textContent = st.name; save(); toast('Profile updated'); };
  $('#settingsBackup').onclick = backup; $('#settingsRestore').onclick = () => $('#restoreInput').click();
  $('#clearAiCache').onclick = () => { AI.clearCache(); toast('Saved AI answers cleared'); };
  $('#clearData').onclick = async () => { if (await confirmBox('Delete everything?', 'All quizzes, attempts, revision lists and settings on this device will be permanently deleted.', 'Delete all', true)) { localStorage.removeItem(STORE); localStorage.removeItem(PLAY_STORE); db = defaultState(); save(); $('#profileName').textContent = 'Learner'; setTab('home'); toast('Local data cleared'); } };
}

/* =====================================================================
   QUIZINOX v2.5 — revision, bookmarks, search, analytics, AI studio
   ===================================================================== */
const normQ = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, '').trim();
const qKey = text => 'q' + AI.hash(normQ(text));
const DAY = 86400000;
const REV_DAYS = [1, 3, 7, 15];
const fmtIn = ms => { const d = Math.round(ms / DAY); if (ms <= 0) return 'due now'; if (d <= 0) { const h = Math.max(1, Math.round(ms / 3600000)); return `in ${h}h`; } return `in ${d} day${d > 1 ? 's' : ''}`; };

/* ---------- bookmarks (difficult questions) ---------- */
function isBookmarkedText(text) { return !!db.bookmarks[qKey(text)]; }
function snapFromDetail(d, quiz) { return { text: d.question, options: d.options.slice().sort((x, y) => x.original - y.original).map(o => o.text), correct: d.correct, explanation: d.explanation || '', topic: d.topic || '', subject: d.subject || quiz?.subject || 'General', quizId: quiz?.id || d.quizId || '', quizTitle: quiz?.title || '', qid: d.qid || '' }; }
function snapFromQuestion(q, quiz) { return { text: q.text, options: q.options.slice(), correct: q.correct, explanation: q.explanation || '', topic: q.topic || '', subject: quiz?.subject || 'General', quizId: quiz?.id || '', quizTitle: quiz?.title || '', qid: q.id }; }
function toggleBookmark(snap) {
  const k = qKey(snap.text);
  if (db.bookmarks[k]) {
    delete db.bookmarks[k]; const r = db.revision[k];
    if (r) { r.sources.difficult = false; if (!r.sources.wrong) delete db.revision[k]; }
    save(); toast('Removed from difficult questions'); return false;
  }
  const { selected, ...clean } = snap;
  db.bookmarks[k] = { ...clean, key: k, added: Date.now() }; addRevisionItem(clean, 'difficult'); save();
  toast('⚑ Saved as difficult · added to revision'); return true;
}

/* ---------- automatic revision (1 → 3 → 7 → 15 days) ---------- */
function addRevisionItem(snap, source) {
  const k = qKey(snap.text), now = Date.now(), r = db.revision[k];
  const { selected, ...clean } = snap;
  if (r) {
    r.sources = { ...(r.sources || {}), [source]: true };
    if (source === 'wrong') { r.stage = 0; r.due = now + DAY; r.lapses = (r.lapses || 0) + 1; }
    Object.assign(r, { text: clean.text, options: clean.options, correct: clean.correct, explanation: clean.explanation || r.explanation, topic: clean.topic || r.topic });
    return false;
  }
  db.revision[k] = { ...clean, key: k, sources: { [source]: true }, stage: 0, due: now + DAY, added: now, reviews: 0, lapses: source === 'wrong' ? 1 : 0 };
  return true;
}
function addWrongToRevision(quiz, details) { let n = 0; details.forEach(d => { if (d.status === 'wrong') { addRevisionItem(snapFromDetail(d, quiz), 'wrong'); n++; } }); return n; }
function dueItems() { const now = Date.now(); return Object.values(db.revision || {}).filter(r => r.due <= now).sort((a, b) => a.due - b.due); }
function applyRevisionResults(details) {
  const now = Date.now(), out = { advanced: 0, mastered: 0, reset: 0, skipped: 0, early: 0 };
  for (const d of details) {
    const r = d.revKey && db.revision[d.revKey]; if (!r) continue;
    if (d.status === 'blank') { out.skipped++; continue; }
    r.reviews = (r.reviews || 0) + 1; r.lastReviewed = now;
    if (d.status === 'wrong') { r.stage = 0; r.due = now + DAY; r.lapses = (r.lapses || 0) + 1; r.sources.wrong = true; out.reset++; continue; }
    if (r.due > now + 12 * 3600000) { out.early++; continue; } // correct before it was due → schedule unchanged
    if (r.stage >= REV_DAYS.length - 1) { delete db.revision[d.revKey]; db.revStats.mastered = (db.revStats.mastered || 0) + 1; out.mastered++; continue; }
    r.stage++; r.due = now + REV_DAYS[r.stage] * DAY; out.advanced++;
  }
  return out;
}
function startRevision(scope = 'due', limit = 30) {
  const all = Object.values(db.revision || {});
  let items = scope === 'due' ? dueItems() : scope === 'wrong' ? all.filter(r => r.sources?.wrong) : scope === 'difficult' ? all.filter(r => r.sources?.difficult) : all.slice().sort((a, b) => a.due - b.due);
  if (scope === 'bookmarks') items = Object.values(db.bookmarks).map(b => db.revision[b.key] || { ...b, sources: { difficult: true }, stage: 0, due: Date.now() + DAY });
  if (!items.length) return toast(scope === 'due' ? 'Nothing is due right now 🎉' : 'No questions in this list yet');
  items = items.slice(0, limit);
  const quiz = { id: 'revision', isRevision: true, title: `Revision · ${new Date().toLocaleDateString()}`, subject: 'Revision', settings: { timer: 0, negative: 0, pass: 0 }, questions: items.map(r => ({ id: r.key, revKey: db.revision[r.key] ? r.key : null, text: r.text, options: r.options.slice(), correct: r.correct, explanation: r.explanation || '', topic: r.topic || '', subject: r.subject || 'General', quizId: r.quizId || '', quizTitle: r.quizTitle || '', qid: r.qid || '' })) };
  startQuiz('revision', 'practice', 'questions', quiz);
}
function revisionPage(filter = 'due') {
  const all = Object.values(db.revision || {}), now = Date.now(), due = all.filter(r => r.due <= now), week = all.filter(r => r.due > now && r.due <= now + 7 * DAY);
  const stages = REV_DAYS.map((d, i) => all.filter(r => (r.stage || 0) === i).length);
  const bms = Object.values(db.bookmarks).sort((a, b) => b.added - a.added);
  const lists = { due, upcoming: all.filter(r => r.due > now).sort((a, b) => a.due - b.due), wrong: all.filter(r => r.sources?.wrong), difficult: bms, all: all.slice().sort((a, b) => a.due - b.due) };
  const rows = (lists[filter] || []).slice(0, 200);
  view.innerHTML = `<div class="page-title"><div><div class="eyebrow">SPACED REPETITION</div><h1>Automatic revision</h1><p>Wrong answers join this list automatically. Each question comes back after 1, 3, 7 and 15 days, and leaves only after you recall it correctly on the 15-day review.</p></div><div class="title-actions row"><select id="revLimit">${[10, 20, 30, 50, 100].map(n => `<option value="${n}" ${n === 30 ? 'selected' : ''}>${n} per session</option>`).join('')}</select><button class="primary" id="revDue" ${due.length ? '' : 'disabled'}>▶ Revise due (${due.length})</button></div></div>
  <div class="stats-grid"><div class="stat-card"><div class="stat-icon amber">↻</div><small>DUE NOW</small><strong>${due.length}</strong><span>Ready for recall</span></div><div class="stat-card"><div class="stat-icon blue">◷</div><small>NEXT 7 DAYS</small><strong>${week.length}</strong><span>Coming up</span></div><div class="stat-card"><div class="stat-icon purple">⚑</div><small>DIFFICULT SAVED</small><strong>${bms.length}</strong><span>Bookmarked separately</span></div><div class="stat-card"><div class="stat-icon green">✓</div><small>MASTERED</small><strong>${db.revStats.mastered || 0}</strong><span>Left revision after recall</span></div></div>
  <div class="panel stage-panel"><div class="stage-flow">${REV_DAYS.map((d, i) => `<div class="stage"><small>STEP ${i + 1}</small><b>Day ${d}</b><strong>${stages[i]}</strong></div>${i < REV_DAYS.length - 1 ? '<span class="stage-arrow">→</span>' : ''}`).join('')}<span class="stage-arrow">→</span><div class="stage done"><small>DONE</small><b>Mastered</b><strong>${db.revStats.mastered || 0}</strong></div></div><p class="muted">Correct on time → next step. Wrong → back to Day 1. Correct before the due date keeps the schedule unchanged.</p></div>
  <div class="chips revision-chips">${[['due', 'Due now', due.length], ['upcoming', 'Upcoming', lists.upcoming.length], ['wrong', 'From mistakes', lists.wrong.length], ['difficult', 'Difficult (saved)', bms.length], ['all', 'All', all.length]].map(([k, l, n]) => `<button class="chip ${filter === k ? 'active' : ''}" data-rf="${k}">${l} · ${n}</button>`).join('')}</div>
  <div class="panel"><div class="panel-head"><div><h3>${filter === 'difficult' ? 'Difficult questions' : 'Revision list'}</h3><p>${filter === 'difficult' ? 'Saved separately with ⚑. They are also scheduled for revision.' : 'Most urgent first'}</p></div><div class="title-actions row">${filter === 'difficult' ? `<button class="secondary" id="revBm" ${bms.length ? '' : 'disabled'}>▶ Practise difficult</button>` : `<button class="secondary" id="revScope" ${rows.length ? '' : 'disabled'}>▶ Revise this list now</button>`}</div></div>
  ${rows.length ? rows.map(r => `<div class="rev-row"><div class="rev-info"><b>${esc(String(r.text).replace(/\s+/g, ' ').slice(0, 180))}${String(r.text).length > 180 ? '…' : ''}</b><small>${r.sources?.wrong ? '<span class="pill red">MISTAKE</span>' : ''}${r.sources?.difficult || filter === 'difficult' ? '<span class="pill purple">DIFFICULT</span>' : ''}${filter !== 'difficult' ? `<span class="pill">Step ${(r.stage || 0) + 1}/4 · ${fmtIn(r.due - now)}</span>` : ''}${r.topic ? `<span class="pill">${esc(r.topic)}</span>` : ''}${r.quizTitle ? ` ${esc(r.quizTitle)}` : ''}</small></div><div class="rev-actions"><button class="textbtn" data-rai="${r.key}">✦ Ask AI</button><button class="mini delete" data-rdel="${r.key}" title="Remove">×</button></div></div>`).join('') : `<div class="empty-mini"><span>↻</span><b>${filter === 'due' ? 'Nothing due right now' : 'Empty list'}</b><small>${filter === 'due' ? 'Wrong answers from quizzes appear here the next day.' : 'Bookmark difficult questions with ⚐ while playing.'}</small></div>`}</div>`;
  const limit = () => Number($('#revLimit').value) || 30;
  $('#revDue').onclick = () => startRevision('due', limit());
  $('#revScope')?.addEventListener('click', () => startRevision(filter === 'due' ? 'due' : filter === 'wrong' ? 'wrong' : 'all', limit()));
  $('#revBm')?.addEventListener('click', () => startRevision('bookmarks', limit()));
  $$('[data-rf]').forEach(b => b.onclick = () => revisionPage(b.dataset.rf));
  const find = k => db.revision[k] || db.bookmarks[k];
  $$('[data-rai]').forEach(b => b.onclick = () => { const r = find(b.dataset.rai); if (r) askAI(r); });
  $$('[data-rdel]').forEach(b => b.onclick = async () => { const k = b.dataset.rdel; if (!(await confirmBox('Remove question?', filter === 'difficult' ? 'It will be removed from difficult questions.' : 'It will be removed from the revision list.', 'Remove', true))) return; if (filter === 'difficult') { delete db.bookmarks[k]; if (db.revision[k] && !db.revision[k].sources?.wrong) delete db.revision[k]; } else delete db.revision[k]; save(); revisionPage(filter); });
}

/* ---------- question bank search ---------- */
let searchState = { q: '', quiz: '', field: 'all', all: true, tr: true };
function searchPage() {
  view.innerHTML = `<div class="page-title"><div><div class="eyebrow">QUESTION BANK</div><h1>Question search</h1><p>Search every question, option, explanation and topic in all your quizzes — works offline. Use "quotes" for an exact phrase.</p></div></div>
  <div class="panel search-panel"><input id="qSearch" class="search-input" placeholder="⌕  e.g. Article 21 · Harappa · “basic structure”" value="${esc(searchState.q)}" autocomplete="off"/>
  <div class="search-filters"><select id="qsQuiz"><option value="">All quizzes</option>${db.quizzes.map(q => `<option value="${q.id}" ${searchState.quiz === q.id ? 'selected' : ''}>${esc(q.title.slice(0, 50))}</option>`).join('')}</select><select id="qsField">${[['all', 'Everywhere'], ['question', 'Question text'], ['options', 'Options'], ['explanation', 'Explanations'], ['topic', 'Topic / subject']].map(([k, l]) => `<option value="${k}" ${searchState.field === k ? 'selected' : ''}>${l}</option>`).join('')}</select><label class="check"><input type="checkbox" id="qsAll" ${searchState.all ? 'checked' : ''}/> All words must match</label><label class="check"><input type="checkbox" id="qsTr" ${searchState.tr ? 'checked' : ''}/> Search translations too</label></div></div>
  <div id="qsBulk"></div><div id="qsResults"></div>`;
  let t = null; const run = () => { searchState = { q: $('#qSearch').value, quiz: $('#qsQuiz').value, field: $('#qsField').value, all: $('#qsAll').checked, tr: $('#qsTr').checked }; runSearch(); };
  $('#qSearch').addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 180); });
  ['#qsQuiz', '#qsField', '#qsAll', '#qsTr'].forEach(id => $(id).onchange = run);
  setTimeout(() => $('#qSearch')?.focus(), 50); run();
}
function searchTerms(q) { const out = []; String(q).replace(/[“”"]([^“”"]+)[“”"]|(\S+)/g, (_, a, b) => { const v = (a || b || '').toLowerCase().trim(); if (v) out.push(v); }); return out; }
function highlight(text, terms) {
  let h = escMl(text); if (!terms.length) return h;
  const re = new RegExp(`(${terms.map(t => esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length).join('|')})`, 'gi');
  return h.replace(/(<[^>]+>)|([^<]+)/g, (m, tag, txt) => tag || txt.replace(re, '<mark>$1</mark>'));
}
function runSearch() {
  const { q, quiz, field, all, tr } = searchState; const terms = searchTerms(q); const box = $('#qsResults'), bulk = $('#qsBulk'); if (!box) return;
  if (!terms.length) { const total = db.quizzes.reduce((n, x) => n + x.questions.length, 0); bulk.innerHTML = ''; box.innerHTML = `<div class="empty-mini"><span>⌕</span><b>Search ${total} questions in ${db.quizzes.length} quizzes</b><small>Type a keyword, name, article number or phrase.</small></div>`; return; }
  const hits = [];
  for (const qz of db.quizzes) {
    if (quiz && qz.id !== quiz) continue;
    qz.questions.forEach((x, i) => {
      const parts = { question: [x.text], options: [x.options.join(' \n ')], explanation: [x.explanation || ''], topic: [`${x.topic || ''} ${qz.subject || ''} ${qz.title}`] };
      if (tr) for (const arr of Object.values(qz.translations || {})) { const t = arr?.[i]; if (!t) continue; parts.question.push(t.text || ''); parts.options.push((t.options || []).join(' \n ')); parts.explanation.push(t.explanation || ''); }
      const hay = (field === 'all' ? Object.values(parts).flat() : parts[field]).join(' \n ').toLowerCase();
      const ok = all ? terms.every(t => hay.includes(t)) : terms.some(t => hay.includes(t));
      if (ok) hits.push({ qz, x, i, score: terms.reduce((n, t) => n + (x.text.toLowerCase().includes(t) ? 3 : 1), 0) });
    });
  }
  hits.sort((a, b) => b.score - a.score);
  const shown = hits.slice(0, 150);
  bulk.innerHTML = hits.length ? `<div class="search-bulk"><span><b>${hits.length}</b> matching question${hits.length > 1 ? 's' : ''}${hits.length > shown.length ? ` · showing first ${shown.length}` : ''}</span><button class="primary" id="qsMake">▶ Practise these as a quiz</button></div>` : '';
  box.innerHTML = shown.length ? shown.map((h, n) => `<div class="search-hit"><div class="hit-meta"><span class="tag">${esc(h.qz.title.slice(0, 40))} · Q${h.i + 1}</span>${h.x.topic ? `<span class="pill">${highlight(h.x.topic, terms)}</span>` : ''}${isBookmarkedText(h.x.text) ? '<span class="pill purple">⚑ DIFFICULT</span>' : ''}</div><b class="hit-q">${highlight(h.x.text, terms)}</b><details><summary>Show options & answer</summary><div class="review-options">${h.x.options.map((o, j) => `<div class="${j === h.x.correct ? 'review-correct' : ''}">${L(j)}. ${highlight(o, terms)} ${j === h.x.correct ? '✓' : ''}</div>`).join('')}</div>${h.x.explanation ? `<p class="explanation-text">${highlight(explanationLines(h.x.explanation), terms)}</p>` : ''}</details><div class="review-actions"><button class="textbtn" data-sbm="${n}">${isBookmarkedText(h.x.text) ? '⚑ Saved' : '⚐ Save as difficult'}</button><button class="textbtn" data-sai="${n}">✦ Ask AI</button><button class="textbtn" data-sopen="${n}">▤ Open quiz</button></div></div>`).join('') : `<div class="empty-mini"><span>⌕</span><b>No questions found</b><small>${all && terms.length > 1 ? 'Try unticking "All words must match".' : 'Check the spelling or try another keyword.'}</small></div>`;
  $$('[data-sbm]').forEach(b => b.onclick = () => { const h = shown[Number(b.dataset.sbm)]; toggleBookmark(snapFromQuestion(h.x, h.qz)); runSearch(); });
  $$('[data-sai]').forEach(b => b.onclick = () => { const h = shown[Number(b.dataset.sai)]; askAI(snapFromQuestion(h.x, h.qz)); });
  $$('[data-sopen]').forEach(b => b.onclick = () => quizMenu(shown[Number(b.dataset.sopen)].qz.id));
  $('#qsMake')?.addEventListener('click', () => { const qz = quizTemplate(`Search: ${q.slice(0, 40)}`); qz.subject = 'Search practice'; qz.questions = hits.slice(0, 200).map(h => ({ ...structuredClone(h.x), id: uid() })); db.quizzes.unshift(qz); save(); toast(`${qz.questions.length} questions saved as "${qz.title}"`); chooseMode(qz.id); });
}

/* ---------- analytics engine ---------- */
function groupStats(list) {
  const m = new Map();
  for (const d of list) { const k = d.key || 'General'; const g = m.get(k) || { key: k, total: 0, correct: 0, wrong: 0, blank: 0, time: 0, timed: 0 }; g.total++; g[d.status === 'correct' ? 'correct' : d.status === 'wrong' ? 'wrong' : 'blank']++; if (d.timeSec > 0) { g.time += d.timeSec; g.timed++; } m.set(k, g); }
  return [...m.values()].map(g => ({ ...g, acc: g.correct + g.wrong ? Math.round(g.correct / (g.correct + g.wrong) * 100) : 0, avgT: g.timed ? Math.round(g.time / g.timed) : 0 })).sort((a, b) => a.acc - b.acc || b.total - a.total);
}
function buildProfile() {
  const at = db.attempts.filter(a => !a.isRevision).slice(0, 60);
  const all = [];
  at.forEach(a => { const qz = db.quizzes.find(q => q.id === a.quizId); (a.details || []).forEach(d => all.push({ ...d, subject: d.subject || a.subject || qz?.subject || 'General', topicKey: d.topic || a.quizTitle || 'General', neg: Number(a.negative ?? qz?.settings?.negative ?? 0) || 0 })); });
  const correct = all.filter(d => d.status === 'correct').length, wrong = all.filter(d => d.status === 'wrong').length, blank = all.length - correct - wrong;
  const timed = all.filter(d => d.timeSec > 0); const avg = arr => arr.length ? Math.round(arr.reduce((s, d) => s + d.timeSec, 0) / arr.length) : 0;
  const wrongMap = new Map();
  all.forEach(d => { if (d.status !== 'wrong') return; const k = qKey(d.question); const e = wrongMap.get(k) || { text: d.question, count: 0, topic: d.topicKey, correctText: d.options?.find(o => o.original === d.correct)?.text || '' }; e.count++; wrongMap.set(k, e); });
  const recentTimed = at.slice(0, 15).flatMap(a => (a.details || []).filter(d => d.timeSec > 0));
  const sortedT = recentTimed.slice().sort((x, y) => x.timeSec - y.timeSec);
  return {
    attempts: at.length,
    overall: { total: all.length, correct, wrong, blank, attempted: correct + wrong, acc: correct + wrong ? Math.round(correct / (correct + wrong) * 100) : 0, avgT: avg(timed), avgTCorrect: avg(timed.filter(d => d.status === 'correct')), avgTWrong: avg(timed.filter(d => d.status === 'wrong')), rushed: timed.filter(d => d.status === 'wrong' && d.timeSec < 12).length, slow: timed.filter(d => d.timeSec > 90).length, negLost: +all.reduce((s, d) => s + (d.status === 'wrong' ? d.neg : 0), 0).toFixed(2), skipRate: all.length ? Math.round(blank / all.length * 100) : 0, avgPercent: at.length ? Math.round(at.reduce((s, a) => s + a.percent, 0) / at.length) : 0 },
    trend: at.slice(0, 10).reverse().map(a => a.percent),
    subjects: groupStats(all.map(d => ({ ...d, key: d.subject }))),
    topics: groupStats(all.map(d => ({ ...d, key: d.topicKey }))),
    repeated: [...wrongMap.values()].filter(e => e.count >= 2).sort((a, b) => b.count - a.count),
    fastest: sortedT.slice(0, 5), slowest: sortedT.slice(-5).reverse(),
  };
}
function perfPanel(a) {
  const det = a.details || [], attempted = a.correct + a.wrong, acc = attempted ? Math.round(a.correct / attempted * 100) : 0;
  const timed = det.map((d, i) => ({ i, t: d.timeSec || 0, d })).filter(x => x.t > 0);
  const avgT = timed.length ? Math.round(timed.reduce((s, x) => s + x.t, 0) / timed.length) : 0;
  const sorted = timed.slice().sort((x, y) => x.t - y.t); const fastest = sorted.slice(0, 3), slowest = sorted.slice(-3).reverse();
  const neg = Number(a.negative || 0), lost = +(a.wrong * neg).toFixed(2);
  const topics = groupStats(det.map(d => ({ ...d, key: d.topic || d.subject || a.subject || 'General' })));
  const rs = a.revisionSummary;
  const tq = x => `<span>Q${x.i + 1} · <b>${x.t}s</b> <em class="review-status ${x.d.status}">${x.d.status}</em></span>`;
  return `<div class="panel perf-panel"><div class="panel-head"><div><h3>📊 Performance breakdown</h3><p>Accuracy, speed, topics and negative marking for this attempt</p></div>${a.isRevision ? '' : '<button class="textbtn" id="perfToReports">All analytics →</button>'}</div>
   ${rs ? `<div class="notice revise-note">↻ Revision updated: <b>${rs.advanced}</b> moved to the next step · <b>${rs.mastered}</b> mastered & removed · <b>${rs.reset}</b> back to Day 1${rs.early ? ` · ${rs.early} practised early (schedule unchanged)` : ''}${rs.skipped ? ` · ${rs.skipped} skipped` : ''}.</div>` : a.revisionAdded ? `<div class="notice revise-note">↻ ${a.revisionAdded} wrong answer${a.revisionAdded > 1 ? 's were' : ' was'} added to your revision list — first review tomorrow.</div>` : ''}
   <div class="perf-grid"><div><small>ACCURACY</small><strong>${acc}%</strong><span>${a.correct}/${attempted} attempted</span></div><div><small>CORRECT · WRONG · SKIPPED</small><strong><b class="green-text">${a.correct}</b> · <b class="red-text">${a.wrong}</b> · ${a.blank}</strong><span>of ${a.total} questions</span></div><div><small>AVG TIME / QUESTION</small><strong>${avgT ? avgT + 's' : '—'}</strong><span>${a.durationSec ? 'Total ' + fmtDur(a.durationSec) : ''}</span></div><div><small>NEGATIVE MARKING</small><strong>${neg ? `−${lost}` : 'None'}</strong><span>${neg ? `${a.wrong} × −${neg}` : `With −⅓: ${+(a.correct - a.wrong / 3).toFixed(2)}`}</span></div></div>
   <div class="neg-line">Marks: <b>+${a.correct}</b> for correct ${neg ? `− <b>${lost}</b> for ${a.wrong} wrong (${neg} each)` : ''} = <b>${a.score} / ${a.total}</b> (${a.percent}%)${neg && a.wrong ? ` · without negative marking you would have ${a.correct}/${a.total}` : ''}</div>
   ${timed.length > 1 ? `<div class="two-col even tight"><div><h4>⚡ Fastest</h4><div class="time-list">${fastest.map(tq).join('')}</div></div><div><h4>🐢 Slowest</h4><div class="time-list">${slowest.map(tq).join('')}</div></div></div>` : ''}
   ${topics.length > 1 ? `<h4>Topic-wise</h4><div class="table-wrap"><table class="stat-table"><thead><tr><th>Topic</th><th>Qs</th><th>✓</th><th>✕</th><th>Skip</th><th>Accuracy</th><th>Avg time</th></tr></thead><tbody>${topics.map(r => `<tr><td>${esc(r.key)}</td><td>${r.total}</td><td class="green-text">${r.correct}</td><td class="red-text">${r.wrong}</td><td>${r.blank}</td><td>${r.acc}%</td><td>${r.avgT ? r.avgT + 's' : '—'}</td></tr>`).join('')}</tbody></table></div>` : ''}</div>`;
}

/* ---------- AI personal study analyst ---------- */
function aiLogToday() { const day = AI.pacificDay(); if (db.aiLog.day !== day) db.aiLog = { day, analyst: 0, tutor: 0 }; return db.aiLog; }
function analystRemaining() { return Math.max(0, (Number(db.settings.analystDaily) || 5) - (aiLogToday().analyst || 0)); }
function analystPanelHtml(pr) {
  const o = pr.overall, weakS = pr.subjects.filter(s => s.correct + s.wrong >= 5 && s.acc < 60), strongS = pr.subjects.filter(s => s.correct + s.wrong >= 5 && s.acc >= 75);
  const local = pr.attempts ? `<div class="insight-grid"><div><h4>Weak subjects</h4>${weakS.length ? weakS.slice(0, 5).map(s => `<p>◎ <b>${esc(s.key)}</b> — ${s.acc}% accuracy (${s.correct + s.wrong} attempted)</p>`).join('') : '<p class="muted">No clearly weak subject yet (needs ≥5 attempted questions with <60% accuracy).</p>'}${strongS.length ? `<p class="green-text">Strong: ${strongS.slice(0, 4).map(s => esc(s.key)).join(', ')}</p>` : ''}</div><div><h4>Repeated mistakes</h4>${pr.repeated.length ? pr.repeated.slice(0, 5).map(e => `<p>✕${e.count} · ${esc(e.text.replace(/\s+/g, ' ').slice(0, 90))}…</p>`).join('') : '<p class="muted">No question answered wrong more than once. 👍</p>'}</div><div><h4>Accuracy & speed</h4><p>Accuracy <b>${o.acc}%</b> · skipped ${o.skipRate}%</p>${o.avgT ? `<p>Average <b>${o.avgT}s</b> per question (✓ ${o.avgTCorrect || '—'}s · ✕ ${o.avgTWrong || '—'}s)</p>` : ''}${o.rushed ? `<p class="amber-text">${o.rushed} mistakes made in under 12s — possible rushing.</p>` : ''}${o.slow ? `<p>${o.slow} questions took more than 90s.</p>` : ''}</div></div>` : '<div class="empty-mini"><small>Complete at least one quiz to get an analysis.</small></div>';
  const rep = db.aiAnalysis;
  return `<div class="panel analyst-panel" id="analystPanel"><div class="panel-head"><div><h3>🤖 AI Personal Study Analyst</h3><p>Offline insights below · tap the button for a personalised AI plan (uses 1 free AI request, ${analystRemaining()} left today)</p></div><button class="primary" id="runAnalyst" ${pr.attempts ? '' : 'disabled'}>✦ Analyse with AI</button></div>${local}<div class="muted" id="analystStatus"></div><div id="analystReport">${rep ? renderAnalysis(rep) : ''}</div></div>`;
}
function renderAnalysis(rep) {
  const d = rep.data || {}; const list = (arr, fn) => Array.isArray(arr) && arr.length ? arr.map(fn).join('') : '';
  return `<div class="ai-report"><div class="ai-report-head"><span class="tag">AI REPORT</span><small>${new Date(rep.date).toLocaleString()} · based on ${rep.attempts} attempts · ${esc(rep.model || '')}</small></div>
   ${d.summary ? `<p class="ai-summary">${esc(d.summary)}</p>` : ''}
   ${list(d.weakSubjects, w => `<div class="ai-card"><b>◎ ${esc(w.name || '')}</b><p>${esc(w.why || '')}</p>${w.fix ? `<p class="green-text">→ ${esc(w.fix)}</p>` : ''}</div>`) ? `<h4>Weak areas</h4><div class="ai-cards">${list(d.weakSubjects, w => `<div class="ai-card"><b>◎ ${esc(w.name || '')}</b><p>${esc(w.why || '')}</p>${w.fix ? `<p class="green-text">→ ${esc(w.fix)}</p>` : ''}</div>`)}</div>` : ''}
   ${list(d.repeatedMistakes, m => `<li><b>${esc(m.pattern || '')}</b> — ${esc(m.advice || '')}</li>`) ? `<h4>Repeated mistake patterns</h4><ul>${list(d.repeatedMistakes, m => `<li><b>${esc(m.pattern || '')}</b> — ${esc(m.advice || '')}</li>`)}</ul>` : ''}
   ${d.accuracy || d.speed ? `<div class="two-col even tight">${d.accuracy ? `<div><h4>Accuracy</h4><p>${esc(d.accuracy)}</p></div>` : ''}${d.speed ? `<div><h4>Speed</h4><p>${esc(d.speed)}</p></div>` : ''}</div>` : ''}
   ${list(d.plan, p => `<div class="plan-day"><b>${esc(p.day || '')}</b><span>${esc(p.focus || '')}</span>${Array.isArray(p.tasks) ? `<ul>${p.tasks.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}</div>`) ? `<h4>Personalised 7-day improvement plan</h4><div class="plan-grid">${list(d.plan, p => `<div class="plan-day"><b>${esc(p.day || '')}</b><span>${esc(p.focus || '')}</span>${Array.isArray(p.tasks) ? `<ul>${p.tasks.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}</div>`)}</div>` : ''}
   ${list(d.tips, t => `<li>${esc(t)}</li>`) ? `<h4>Tips</h4><ul>${list(d.tips, t => `<li>${esc(t)}</li>`)}</ul>` : ''}</div>`;
}
function wireAnalyst() {
  const btn = $('#runAnalyst'); if (!btn) return;
  btn.onclick = async () => {
    if (!AI.getKeys().length) { toast('Add a Gemini API key in Settings first'); return setTab('settings'); }
    if (analystRemaining() <= 0) return toast(`Daily AI analysis limit reached (${db.settings.analystDaily}/day). Change it in Settings.`, 4500);
    if (db.aiAnalysis && Date.now() - new Date(db.aiAnalysis.date).getTime() < 3 * 60000) return toast('Please wait a few minutes before analysing again — your report is below.');
    const pr = buildProfile(); if (!pr.attempts) return toast('Complete a quiz first');
    const st = $('#analystStatus'); btn.disabled = true; btn.textContent = 'Analysing…';
    const compact = { attempts: pr.attempts, overall: pr.overall, scoreTrend: pr.trend, subjects: pr.subjects.slice(0, 12).map(s => ({ subject: s.key, attempted: s.correct + s.wrong, skipped: s.blank, accuracy: s.acc, avgTimeSec: s.avgT })), weakestTopics: pr.topics.slice(0, 20).map(s => ({ topic: s.key, attempted: s.correct + s.wrong, accuracy: s.acc, avgTimeSec: s.avgT })), repeatedMistakes: pr.repeated.slice(0, 12).map(e => ({ question: e.text.replace(/\s+/g, ' ').slice(0, 160), timesWrong: e.count, topic: e.topic, correctAnswer: String(e.correctText).slice(0, 80) })), revision: { inList: Object.keys(db.revision).length, due: dueItems().length, mastered: db.revStats.mastered || 0 } };
    const lang = db.settings.tutorLang || 'English';
    const prompt = `You are an expert UPSC / competitive-exam study coach. Analyse this student's quiz performance data and give a practical, personalised improvement plan. Write in ${lang}${lang === 'Hinglish' ? ' (Hindi in Roman script mixed with English)' : ''}. Be specific: refer to the actual subjects, topics and numbers. Keep it encouraging but honest.
DATA (JSON): ${JSON.stringify(compact)}
Return ONLY JSON with this shape:
{"summary":"3-4 sentence overview","weakSubjects":[{"name":"","why":"","fix":""}],"repeatedMistakes":[{"pattern":"","advice":""}],"accuracy":"insight about accuracy, negative marking and guessing","speed":"insight about time per question, rushing or slowness","plan":[{"day":"Day 1","focus":"","tasks":["",""]}],"tips":["",""]}
Give 2-5 weakSubjects, up to 4 repeatedMistakes, exactly 7 plan days, 3-5 tips.`;
    try {
      const r = await AI.aiCall(prompt, { json: true, maxTokens: 4096, temperature: 0.5, onStatus: m => st.textContent = m });
      const data = AI.parseJsonLoose(r.text);
      aiLogToday().analyst++; db.aiAnalysis = { date: new Date().toISOString(), attempts: pr.attempts, model: r.model, data }; save();
      st.textContent = ''; $('#analystReport').innerHTML = renderAnalysis(db.aiAnalysis); toast('AI analysis ready ✓');
    } catch (e) { st.innerHTML = `<span class="red-text">✕ ${esc(e.message)}</span>`; }
    finally { btn.disabled = false; btn.textContent = '✦ Analyse with AI'; }
  };
}

/* ---------- Ask AI — question tutor ---------- */
const TUTOR_MODES = {
  why: { label: '✅ Why is this answer correct?', task: 'Explain clearly why the correct option is right. Give the key concept and the exact fact that decides the answer.' },
  wrong: { label: '❌ Why are the other options wrong?', task: 'Go through every incorrect option one by one and explain precisely why each is wrong (or partly wrong).' },
  simple: { label: '🧒 Explain the topic simply', task: 'Explain the underlying topic in very simple language, as to a beginner, with one everyday example and a memory trick.' },
  upsc: { label: '📚 UPSC: what else to read?', task: 'List the closely related facts, concepts, articles/acts/places/events and current-affairs links a UPSC aspirant should also study around this question, and 2-3 likely future question angles. Mention standard sources (NCERT/Laxmikanth/Spectrum etc.) only where appropriate.' },
  similar: { label: '🔁 2 similar practice MCQs', task: 'Create 2 new similar MCQs on the same concept with 4 options each, then give the answers with one-line explanations at the end.' },
};
function md(src) {
  const lines = esc(src).split('\n'); let html = '', list = null; const close = () => { if (list) { html += `</${list}>`; list = null; } };
  const inline = t => t.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  for (const raw of lines) { const l = raw.trim(); let m;
    if (!l) { close(); continue; }
    if ((m = l.match(/^#{1,6}\s+(.*)/))) { close(); html += `<h4>${inline(m[1])}</h4>`; }
    else if ((m = l.match(/^[-*•]\s+(.*)/))) { if (list !== 'ul') { close(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(m[1])}</li>`; }
    else if ((m = l.match(/^\d+[.)]\s+(.*)/))) { if (list !== 'ol') { close(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(m[1])}</li>`; }
    else { close(); html += `<p>${inline(l)}</p>`; } }
  close(); return html;
}
function askAI(snap, preset = null) {
  if (!snap?.text) return;
  const opts = (snap.options || []).map((o, i) => `<div class="${i === snap.correct ? 'review-correct' : i === snap.selected ? 'review-wrong' : ''}">${L(i)}. ${esc(o)}</div>`).join('');
  const { el } = modal(`<div class="eyebrow">ASK AI · QUESTION TUTOR</div><h2>Ask AI about this question</h2><div class="tutor-q"><b>${escMl(String(snap.text).slice(0, 700))}</b><div class="review-options">${opts}</div></div>
   <div class="tutor-modes">${Object.entries(TUTOR_MODES).map(([k, m]) => `<button class="chip" data-tm="${k}">${m.label}</button>`).join('')}</div>
   <div class="tutor-ask"><input id="tutorOwn" placeholder="Or type your own doubt about this question…"/><select id="tutorLang">${['English', 'Hindi', 'Hinglish'].map(l => `<option ${db.settings.tutorLang === l ? 'selected' : ''}>${l}</option>`).join('')}</select><button class="primary" id="tutorAsk">Ask</button></div>
   <div class="muted" id="tutorStatus">Each new answer uses 1 free AI request. Repeated questions load instantly from this device.</div><div id="tutorOut" class="tutor-out"></div>`, { wide: true });
  const run = async (mode, own = '') => {
    const lang = $('#tutorLang', el).value; db.settings.tutorLang = lang; save();
    const key = 'tutor:' + AI.hash([snap.text, (snap.options || []).join('|'), mode, own, lang].join('§'));
    const out = $('#tutorOut', el), st = $('#tutorStatus', el);
    const show = (text, note) => { out.innerHTML = `<div class="ai-answer">${md(text)}</div><div class="dialog-actions"><span class="muted">${esc(note)}</span><button class="secondary" id="tutorCopy">⎘ Copy</button>${snap.quizId && snap.qid ? '<button class="secondary" id="tutorSave">📌 Add to explanation</button>' : ''}</div>`;
      $('#tutorCopy', el).onclick = async () => { try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Copy not available'); } };
      $('#tutorSave', el)?.addEventListener('click', () => { const qz = db.quizzes.find(q => q.id === snap.quizId); const qq = qz?.questions.find(x => x.id === snap.qid); if (!qq) return toast('Original question not found'); qq.explanation = `${qq.explanation ? qq.explanation + '\n\n' : ''}AI note: ${text.replace(/\*\*/g, '').replace(/^#+\s*/gm, '').trim()}`; if (qz.translations) qz.translations = {}; qz.updatedAt = new Date().toISOString(); save(); toast('Added to the question explanation ✓'); }); };
    const cached = AI.cacheGet(key); if (cached) { st.textContent = ''; return show(cached, 'Saved answer · no AI request used'); }
    if (!AI.getKeys().length) { st.innerHTML = '<span class="red-text">Add a Gemini API key in Settings → AI keys first.</span>'; return; }
    $$('[data-tm]', el).forEach(b => b.disabled = true); $('#tutorAsk', el).disabled = true; out.innerHTML = '<div class="ai-loading"><i></i><i></i><i></i></div>';
    const task = own ? `Answer the student's doubt: "${own.slice(0, 500)}"` : TUTOR_MODES[mode].task;
    const prompt = `You are an expert, friendly UPSC / competitive-exam tutor. Reply in ${lang}${lang === 'Hinglish' ? ' (Hindi written in Roman script, mixed with English)' : ''}. Use short headings and bullet points, be accurate and concise (under 350 words). If a fact is uncertain, say so instead of guessing.

Question:
${String(snap.text).slice(0, 2500)}

Options:
${(snap.options || []).map((o, i) => `${L(i)}. ${o}`).join('\n')}

Correct answer: ${L(snap.correct)}. ${snap.options?.[snap.correct] || ''}
${snap.explanation ? `Explanation given in the quiz: ${String(snap.explanation).slice(0, 1500)}\n` : ''}${snap.selected != null && snap.selected !== snap.correct ? `The student chose ${L(snap.selected)} (wrong).\n` : ''}
Task: ${task}`;
    try { const r = await AI.aiCall(prompt, { json: false, maxTokens: 1200, temperature: 0.35, onStatus: m => st.textContent = m }); AI.cacheSet(key, r.text); aiLogToday().tutor++; save(); st.textContent = ''; show(r.text, `Answered by ${AI.limitsFor(r.model).name}`); }
    catch (e) { out.innerHTML = ''; st.innerHTML = `<span class="red-text">✕ ${esc(e.message)}</span>`; }
    finally { $$('[data-tm]', el).forEach(b => b.disabled = false); $('#tutorAsk', el).disabled = false; }
  };
  $$('[data-tm]', el).forEach(b => b.onclick = () => { $$('[data-tm]', el).forEach(x => x.classList.toggle('active', x === b)); run(b.dataset.tm); });
  const own = () => { const v = $('#tutorOwn', el).value.trim(); if (!v) return toast('Type your doubt first'); run('own', v); };
  $('#tutorAsk', el).onclick = own; $('#tutorOwn', el).addEventListener('keydown', e => { if (e.key === 'Enter') own(); });
  if (preset) $(`[data-tm="${preset}"]`, el)?.click();
}

/* ---------- AI studio page ---------- */
function aiStudio() {
  const keys = AI.getKeys(), healthy = keys.filter(k => k.enabled !== false && k.status !== 'invalid').length, m = db.settings.aiModel || AI.FALLBACK_CHAIN[0];
  view.innerHTML = `<div class="page-title"><div><div class="eyebrow">ONLINE · OPTIONAL · GEMINI FREE</div><h1>AI Study Studio</h1><p>AI only runs when you tap a button. Requests are paced to stay inside Google's free limits, and multiple keys back each other up.</p></div><button class="secondary" id="aiKeysBtn">⚙ AI keys (${keys.length})</button></div>
  <div class="stats-grid"><div class="stat-card"><div class="stat-icon purple">⚿</div><small>API KEYS</small><strong>${healthy}/${keys.length}</strong><span>${keys.length ? 'healthy keys' : 'Add a free key in Settings'}</span></div><div class="stat-card"><div class="stat-icon blue">✦</div><small>MODEL</small><strong class="small-strong">${esc(AI.limitsFor(m).name)}</strong><span>${db.settings.aiAutoFallback === false ? 'No fallback' : 'Auto fallback on'}</span></div><div class="stat-card"><div class="stat-icon green">↯</div><small>REQUESTS TODAY</small><strong>${AI.todayTotal()}</strong><span>~${AI.remainingToday(m)} free left on this model</span></div><div class="stat-card"><div class="stat-icon amber">◎</div><small>ANALYST RUNS LEFT</small><strong>${analystRemaining()}</strong><span>of ${db.settings.analystDaily}/day</span></div></div>
  ${keys.length ? '' : '<div class="notice">🔑 To use AI, get a free Gemini API key at <b>aistudio.google.com/apikey</b> and add it in Settings → AI keys. You can add several keys — if one fails or runs out, the next is used automatically.</div>'}
  <div class="tool-grid ai-grid">
   <div class="tool-card featured"><div class="tool-icon">🤖</div><h3>AI Personal Study Analyst</h3><p>Analyses all your attempts: weak subjects, repeated mistakes, accuracy, speed — then gives a personalised 7-day plan. 1 request per analysis.</p><button class="primary" id="goAnalyst">Open analyst</button></div>
   <div class="tool-card"><div class="tool-icon">💬</div><h3>Ask AI — Question Tutor</h3><p>On any question: why the answer is correct, why the others are wrong, simple explanation, what else to read for UPSC, similar MCQs. Find "✦ Ask AI" in practice mode, results, revision and search.</p><button class="secondary" id="goTutor">Pick a question</button></div>
   <div class="tool-card"><div class="tool-icon">✦</div><h3>AI Question Generator</h3><p>From a topic, PDF, notes or your weak topics: UPSC MCQs, statements, match the following, assertion-reason, multiple-correct, pairs and chronology. Choose difficulty, language and explanation depth.</p><button class="secondary" id="goGen">Open generator</button></div>
  </div>
  <div class="panel"><div class="panel-head"><div><h3>💡 Ask a general study doubt</h3><p>Any concept, comparison or "explain like I'm new" question</p></div></div><textarea id="doubtText" rows="3" placeholder="e.g. Difference between Fundamental Rights and Directive Principles with examples"></textarea><div class="dialog-actions"><select id="doubtLang" class="auto-w">${['English', 'Hindi', 'Hinglish'].map(l => `<option ${db.settings.tutorLang === l ? 'selected' : ''}>${l}</option>`).join('')}</select><button class="primary" id="doubtAsk">Ask AI</button></div><div class="muted" id="doubtStatus"></div><div id="doubtOut" class="tutor-out"></div></div>`;
  $('#aiKeysBtn').onclick = () => setTab('settings'); $('#goGen').onclick = () => aiGenerator();
  $('#goAnalyst').onclick = () => { setTab('reports'); setTimeout(() => $('#analystPanel')?.scrollIntoView({ behavior: 'smooth' }), 80); };
  $('#goTutor').onclick = () => { if (dueItems().length || Object.keys(db.revision).length) setTab('revision'); else setTab('search'); toast('Tap "✦ Ask AI" on any question'); };
  $('#doubtAsk').onclick = async () => {
    const q = $('#doubtText').value.trim(); if (q.length < 5) return toast('Type your doubt first'); const lang = $('#doubtLang').value; db.settings.tutorLang = lang; save();
    const key = 'doubt:' + AI.hash(q + '§' + lang); const out = $('#doubtOut'), st = $('#doubtStatus'); const c = AI.cacheGet(key); if (c) { out.innerHTML = `<div class="ai-answer">${md(c)}</div>`; st.textContent = 'Saved answer · no AI request used'; return; }
    const b = $('#doubtAsk'); b.disabled = true; out.innerHTML = '<div class="ai-loading"><i></i><i></i><i></i></div>';
    try { const r = await AI.aiCall(`You are an expert, friendly UPSC / competitive-exam tutor. Reply in ${lang}${lang === 'Hinglish' ? ' (Hindi in Roman script mixed with English)' : ''}. Use short headings and bullet points, accurate and under 400 words. If unsure of a fact, say so.\n\nStudent's doubt: ${q.slice(0, 1500)}`, { json: false, maxTokens: 1300, temperature: 0.4, onStatus: m => st.textContent = m }); AI.cacheSet(key, r.text); st.textContent = `Answered by ${AI.limitsFor(r.model).name}`; out.innerHTML = `<div class="ai-answer">${md(r.text)}</div>`; }
    catch (e) { out.innerHTML = ''; st.innerHTML = `<span class="red-text">✕ ${esc(e.message)}</span>`; } finally { b.disabled = false; }
  };
}

/* ---------- keyboard shortcuts (Windows / desktop) ---------- */
document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const overlays = $$('.mode-overlay');
  if (e.key === 'Escape' && overlays.length) { overlays[overlays.length - 1].remove(); e.preventDefault(); return; }
  if (!play || overlays.length) return;
  const t = e.target, tag = (t?.tagName || '').toLowerCase();
  if (['input', 'textarea', 'select'].includes(tag) || t?.isContentEditable) return;
  const p = play, k = e.key, lower = k.length === 1 ? k.toLowerCase() : k, total = p.questions.length;
  const q = p.questions[p.index]; const locked = p.mode === 'practice' && p.answers[p.index] != null;
  const optIdx = /^[1-8]$/.test(k) ? Number(k) - 1 : /^[a-e]$/.test(lower) && k.length === 1 ? lower.charCodeAt(0) - 97 : -1;
  if (optIdx >= 0) { const btn = $$('.answer')[optIdx]; if (btn && !btn.disabled && !locked) selectAnswer(q.options[optIdx].original); e.preventDefault(); return; }
  switch (lower) {
    case 'ArrowRight': case 'PageDown': swipeGo(1); break;
    case 'ArrowLeft': case 'PageUp': swipeGo(-1); break;
    case 'Enter': case ' ': if (tag === 'button') return; if (p.index < total - 1) go(p.index + 1); else submitQuiz(); break;
    case 'Home': go(0); break;
    case 'End': go(total - 1); break;
    case 'm': toggleMark(); break;
    case 'f': toggleBookmark(snapFromPlay(p, q)); renderPlayer(); break;
    case 'x': case 'Delete': clearAnswer(); break;
    case 'g': jumpPrompt(); break;
    case 'u': nextUnanswered(); break;
    case 't': p.paletteOpen = !p.paletteOpen; renderPlayer(); break;
    case 'l': openPlayerLanguagePicker(); break;
    case 'i': if (locked) askAI(snapFromPlay(p, q)); else toast(p.mode === 'exam' ? 'Ask AI is available after you submit (in the results)' : 'Answer first, then ask AI'); break;
    case 's': submitQuiz(); break;
    case 'Escape': exitPlayerPrompt(); break;
    case '?': case '/': showShortcuts(); break;
    default: return;
  }
  e.preventDefault();
});

/* ------------------------------ BACK BUTTON ------------------------------ */
onBackButton(async exit => {
  const open = $$('.mode-overlay'); if (open.length) { open[open.length - 1].remove(); return; }
  if (play) { exitPlayerPrompt(); return; }
  if (lastResult || db.activeTab !== 'home') { setTab('home'); return; }
  exit();
});
window.addEventListener('beforeunload', () => savePlay());
document.addEventListener('visibilitychange', () => { if (!play) return; if (document.hidden) { savePlay(); play.away = true; } else { play.away = false; play.qEnter = Date.now(); } });

render(); updateCounts();
