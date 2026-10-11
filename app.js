/* =========================================================
 * 畫面 + 同步
 * ========================================================= */

const App = { boot: null, bootMap: {}, view: 'home', draft: null, game: null, state: null, ui: null, edit: null, modals: [], syncing: {} };

const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const J = v => esc(JSON.stringify(v));
const $ = sel => document.querySelector(sel);
const range = n => Array.from({ length: n }, (_, i) => i);
const MARK_ZH = { stay: '留壘', score: '得分', out: '出局' };
const BATTER_ZH = { safe: '上壘', scored: '得分', out: '出局' };

// 會改到資料的後端函式：成功後清除手機上的暫存，避免看到舊資料
const WRITE_FNS = new Set(['addPlayer', 'createGame', 'addEvent', 'deleteEvent', 'replaceEvents', 'importGame', 'unimportGame', 'saveOpening', 'saveManual', 'deleteManual', 'setPlacing', 'deleteGame', 'saveSummaries', 'saveTeamHistory', 'saveSchedule', 'deleteSchedule', 'claimGame']);
App.perf = [];
/* ---------------- 與後端（Apps Script）通訊 ----------------
 * 以 fetch 呼叫 Apps Script 的 doPost。用 text/plain 送出可以避開瀏覽器的跨網域預檢（Apps Script 不支援）。
 * 逾時會自動中止，讓「未同步」的重試機制不會卡在沒有回應的連線上。 */
const API_TIMEOUT = 45000;
function apiKey() { try { return localStorage.getItem('sb_key') || ''; } catch (e) { return ''; } }
async function apiCall(fn, args, retried) {
  const url = window.API_URL;
  if (!url || url.indexOf('PASTE') >= 0) throw new Error('尚未設定後端網址（請編輯 config.js）');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), API_TIMEOUT);
  let j;
  try {
    const res = await fetch(url, {
      method: 'POST', redirect: 'follow', signal: ctl.signal,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ fn: fn, args: args, key: apiKey() })
    });
    j = await res.json();
  } catch (e) {
    throw new Error(e && e.name === 'AbortError' ? '連線逾時' : '網路無法連線');
  } finally { clearTimeout(timer); }
  if (!j || !j.ok) {
    const msg = (j && j.error) || '後端錯誤';
    if (msg === 'AUTH' && !retried && !(App._authAt && Date.now() - App._authAt < 60000)) {
      App._authAt = Date.now();   // 60 秒內不重複詢問，避免背景重試一直跳出輸入框
      const k = window.prompt(apiKey() ? '通行碼不正確，請重新輸入：' : '請輸入隊伍通行碼：');
      if (k) { try { localStorage.setItem('sb_key', k.trim()); } catch (e) { } return apiCall(fn, args, true); }
    }
    throw new Error(msg === 'AUTH' ? '通行碼不正確' : msg);
  }
  return j.data;
}
function gs(fn, ...args) {
  const t0 = performance.now();
  return apiCall(fn, args).then(r => {
    App.perf.unshift({ fn, ms: Math.round(performance.now() - t0), at: new Date().toLocaleTimeString() });
    App.perf.length = Math.min(App.perf.length, 30);
    if (WRITE_FNS.has(fn)) bustCache();
    return r;
  });
}

/* ---------------- 暫存：記憶體 + 手機 localStorage ----------------
 * 先用暫存立刻顯示，背景再向伺服器確認；資料有變且仍在同一頁才重畫 */
const CK = 'sbc_';
const CACHE_TTL = 30 * 86400000;      // 頁面暫存最多保留 30 天
const CACHE_MAX = 1024 * 1024;        // 頁面暫存總量上限約 1MB
App.mem = {};
function cacheGet(key) {
  if (App.mem[key]) return App.mem[key];
  const w = lsGet(CK + key, null);
  if (!w || !w.__c || Date.now() - w.t > CACHE_TTL) { lsDel(CK + key); return null; }
  App.mem[key] = w.d;
  return w.d;
}
function cacheSet(key, d) {
  App.mem[key] = d;
  lsSet(CK + key, { __c: 1, t: Date.now(), d });
  trimCache();
}
function bustCache() {
  App.mem = {};
  lsKeys().filter(k => k.indexOf(CK) === 0).forEach(lsDel);
}
/** 頁面暫存超過上限時，從最舊的開始刪 */
function trimCache() {
  try {
    const list = lsKeys().filter(k => k.indexOf(CK) === 0).map(k => {
      const raw = localStorage.getItem(k) || '';
      let t = 0; try { t = JSON.parse(raw).t || 0; } catch (e) { }
      return { k, t, n: raw.length * 2 };
    }).sort((a, b) => a.t - b.t);
    let total = list.reduce((a, x) => a + x.n, 0);
    const now = Date.now();
    for (const x of list) {
      if (total <= CACHE_MAX && now - x.t <= CACHE_TTL) continue;
      lsDel(x.k); delete App.mem[x.k.slice(CK.length)]; total -= x.n;
    }
  } catch (e) { }
}
async function swr(key, fn, args, apply, views) {
  views = [].concat(views || []);
  const hit = cacheGet(key);
  const fresh = gs(fn, ...args).then(d => {
    const changed = !hit || JSON.stringify(d) !== JSON.stringify(hit);
    cacheSet(key, d);
    if (hit && changed) {
      apply(d);
      if (views.includes(App.view) && !App.modals.length && !App.edit) render();
    }
    return d;
  });
  if (hit) { apply(hit); fresh.catch(() => { }); return; }
  apply(await fresh);
}

/* ----- 載入時間紀錄：首頁標題連點 5 下顯示 ----- */
let perfTaps = [];
function perfTap() {
  const now = Date.now();
  perfTaps = perfTaps.filter(t => now - t < 2000).concat(now);
  if (perfTaps.length < 5) return;
  perfTaps = [];
  openModal({
    title: '載入時間紀錄（最近 30 次）',
    body: App.perf.length ? `<table class="tbl"><tr><th>時間</th><th class="nm">呼叫</th><th>耗時</th></tr>${App.perf.map(x => `<tr><td>${esc(x.at)}</td><td class="nm">${esc(x.fn)}</td><td>${(x.ms / 1000).toFixed(2)} 秒</td></tr>`).join('')}</table>` : '<p class="muted">尚無紀錄</p>',
    buttons: [{ label: '清除手機暫存', onClick: () => { bustCache(); toast('已清除'); } }, { label: '關閉', cls: 'primary' }]
  });
}
function lsGet(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
function lsKeys() { try { return Object.keys(localStorage); } catch (e) { return []; } }
function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { } }
/** 寫入手機；空間不足時先清掉頁面暫存與已結束的比賽再試一次。回傳是否成功 */
function lsSet(k, v) {
  const str = JSON.stringify(v);
  try { localStorage.setItem(k, str); return true; } catch (e) { }
  bustCache(); cleanupGames(true);
  try { localStorage.setItem(k, str); return true; } catch (e) { }
  storageWarn();
  return false;
}
function storageWarn() {
  if (App.warnedStorage) return;
  App.warnedStorage = true;
  toast('⚠ 手機儲存空間不足：紀錄仍會繼續上傳，但請保持網路連線，不要關閉網頁');
}
const qKey = id => 'sb_q_' + id, evKey = id => 'sb_ev_' + id, setupKey = id => 'sb_setup_' + id;
/* 待上傳佇列：以記憶體為準，手機只是備份；手機寫不進去時紀錄也不會漏送 */
App.q = {};
/** 這支手機的識別碼（用來判斷誰在記錄比賽） */
function deviceId() {
  if (App.dev) return App.dev;
  let d = lsGet('sb_device', null);
  if (!d) { d = 'D' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); lsSet('sb_device', d); }
  return (App.dev = d);
}
function qGet(id) { if (!App.q[id]) App.q[id] = lsGet(qKey(id), []); return App.q[id]; }
function qSet(id, q) { App.q[id] = q; if (q.length) lsSet(qKey(id), q); else lsDel(qKey(id)); }
/** 清除不再需要的比賽暫存：佇列已空、而且不是進行中或正在開啟的比賽（伺服器上已有完整資料） */
function cleanupGames(aggressive) {
  const live = new Set(((App.boot && App.boot.live) || []).map(g => g.gameId));
  const cur = App.game && App.game.setup && App.game.setup.gameId;
  const ids = new Set();
  lsKeys().forEach(k => { const m = k.match(/^sb_(?:q|ev|setup)_(.+)$/); if (m) ids.add(m[1]); });
  ids.forEach(id => {
    if (qGet(id).length) return;                       // 還有沒上傳的紀錄，絕對不能刪
    if (id === cur) return;
    if (live.has(id) && !aggressive) return;           // 進行中的比賽保留，方便斷網時重新開啟
    [qKey(id), evKey(id), setupKey(id)].forEach(lsDel);
  });
}

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2500);
}

function P(pid) {
  return (App.pctx && App.pctx.players[pid]) || (App.game && App.game.setup.players[pid]) || App.bootMap[pid] || { name: '?', num: '' };
}

/* ---------------- Modal ---------------- */
function openModal(m) { App.modals.push(m); renderModal(); }
function closeModal() { App.modals.pop(); renderModal(); }
function renderModal() {
  const root = $('#modal-root'), m = App.modals[App.modals.length - 1];
  if (!m) { root.innerHTML = ''; return; }
  const body = typeof m.body === 'function' ? m.body() : m.body;
  root.innerHTML = `<div class="backdrop" onclick="backdropClick(event)"><div class="modal">
    <div class="mtitle">${esc(m.title)}</div><div class="mbody">${body}</div>
    <div class="mbtns">${(m.buttons || []).map((b, i) => `<button class="${b.cls || ''}" onclick="modalBtn(${i})">${esc(b.label)}</button>`).join('')}</div>
  </div></div>`;
}
function backdropClick(e) {
  const m = App.modals[App.modals.length - 1];
  if (e.target.classList.contains('backdrop') && m && !m.forced) closeModal();
}
function modalBtn(i) {
  const m = App.modals[App.modals.length - 1], b = m.buttons[i];
  const r = b.onClick ? b.onClick() : undefined;
  if (r === false) return;
  App.modals = App.modals.filter(x => x !== m);
  renderModal();
}
function confirmModal(title, text, okLabel, fn) {
  openModal({ title, body: `<p>${esc(text)}</p>`, buttons: [{ label: '取消' }, { label: okLabel, cls: 'primary', onClick: fn }] });
}
function pickPlayer(title, pids, cb, tagFn) {
  openModal({
    title,
    body: () => pids.length
      ? `<div class="pgrid">${pids.map(pid => {
        const tag = tagFn ? tagFn(pid) : '';
        return `<button class="pbtn" onclick="App._pick(${J(pid)})"><b>#${esc(P(pid).num)}</b>${esc(P(pid).name)}${tag ? `<small>${esc(tag)}</small>` : ''}</button>`;
      }).join('')}</div>`
      : '<p class="muted">沒有可選擇的球員</p>',
    buttons: [{ label: '取消' }]
  });
  App._pick = pid => { App.modals.pop(); renderModal(); cb(pid); };
}

/* ---------------- 啟動 / 路由 ---------------- */
function sortPlayers() {
  App.boot.players.sort((a, b) => (parseInt(a.num, 10) || 999) - (parseInt(b.num, 10) || 999));
  App.bootMap = {}; App.boot.players.forEach(p => App.bootMap[p.pid] = p);
}
/* 手機裡還沒結束的比賽（離線時重新開啟 App，也能找到並繼續記錄） */
function localLive() {
  const out = [];
  lsKeys().forEach(k => {
    const m = k.match(/^sb_setup_(.+)$/); if (!m) return;
    const st = lsGet(k, null); if (!st) return;
    let s; try { s = replay(st, lsGet(evKey(m[1]), [])); } catch (e) { return; }
    if (s.over) return;
    out.push({ gameId: m[1], date: st.date, cup: st.cup || '', opp: st.opp, our: totalRuns(s, 'our'), oppScore: totalRuns(s, 'opp'), label: '進行中（' + halfLabel(s) + '）', _local: true, setup: st });
  });
  return out;
}
function mergeLocalLive() {
  if (!App.boot) return;
  const live = (App.boot.live || []).filter(g => !g._local);
  localLive().forEach(g => { if (!live.some(x => x.gameId === g.gameId)) live.unshift(g); });
  App.boot.live = live;
}
/** 完全連不上伺服器、也沒有首頁暫存時，用手機裡的比賽資料組一個最小的首頁 */
function offlineBoot() {
  const lg = localLive(), pl = {};
  lg.forEach(g => Object.keys(g.setup.players || {}).forEach(pid => { pl[pid] = { pid: pid, name: g.setup.players[pid].name, num: g.setup.players[pid].num }; }));
  applyBoot({ ourTeam: (lg[0] && lg[0].setup.ourTeam) || '我方', homeTitle: '壘球紀錄（離線）', homeBg: '', players: Object.keys(pl).map(k => pl[k]), live: [], upcoming: [] });
}
const applyBoot = d => { App.boot = d; sortPlayers(); mergeLocalLive(); };
/** 載入首頁資料；手機裡有進行中的比賽時，網路太慢（8 秒）就先用手機裡的資料開啟 */
async function loadBoot() {
  const run = swr('boot', 'getBootstrap', [], applyBoot, 'home');
  if (!localLive().length) return run;
  run.catch(() => { });
  let timer;
  const slow = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('slow')), 8000); });
  try { await Promise.race([run, slow]); } finally { clearTimeout(timer); }
}
async function boot() {
  try { await loadBoot(); }
  catch (e) { if (!App.boot && localLive().length) offlineBoot(); }
  if (!App.boot) { $('#app').innerHTML = '<div class="err">載入失敗：網路無法連線，而且手機裡沒有進行中的比賽。</div>'; return; }
  cleanupGames(); trimCache();
  flushAll();
  go('home');
}
/* 記錄比賽時保持螢幕不休眠（瀏覽器支援時）；離開比賽或比賽結束就釋放 */
let _wl = null;
async function wakeOn() {
  try {
    if ('wakeLock' in navigator && !_wl && !document.hidden) {
      _wl = await navigator.wakeLock.request('screen');
      _wl.addEventListener('release', () => { _wl = null; });
    }
  } catch (e) { _wl = null; }
}
function wakeOff() { try { if (_wl) { _wl.release(); } } catch (e) { } _wl = null; }
function wakeSync() { (App.game && App.state && !App.state.over) ? wakeOn() : wakeOff(); }
/* 網路恢復、或切回此頁面時，立刻補傳尚未上傳的紀錄 */
window.addEventListener('online', () => flushAll());
document.addEventListener('visibilitychange', () => { if (!document.hidden) { wakeSync(); flushAll(); } });
function go(v) { if (v !== 'live') stopLive(); App.view = v; render(); window.scrollTo(0, 0); wakeSync(); }
function render() {
  const f = { home: renderHome, setup: renderSetup, oppsetup: renderOppSetup, game: renderGame, box: renderBox, edit: renderEditList, season: renderSeason, player: renderPlayer, opening: renderOpening, manual: renderManualList, manualEdit: renderManualEdit, team: renderTeam, teamTotal: renderTeamTotal, schedule: renderSchedule, live: renderLive }[App.view];
  $('#app').innerHTML = f();
}
async function goHome() {
  App.game = null; App.edit = null;
  if (!cacheGet('boot')) $('#app').innerHTML = '<div class="loading">載入中…</div>';
  try { await loadBoot(); } catch (e) { if (!App.boot && localLive().length) offlineBoot(); }
  if (!App.boot) { $('#app').innerHTML = '<div class="err">載入失敗：網路無法連線</div>'; return; }
  mergeLocalLive();
  go('home');
}
window.addEventListener('load', boot);

/* ---------------- 同步（先存手機，再背景上傳） ---------------- */
/** 比賽摘要：逐局比分與 R、H、E，存在 Games 分頁，球隊成績頁不用重讀事件 */
function gameSummary(setup, s) {
  const inn = Math.max(setup.innings || 7, s.runs.our.length, s.runs.opp.length);
  const ln = t => range(inn).map(k => s.runs[t][k] == null ? null : s.runs[t][k]);
  return {
    v: 1, weBatFirst: !!setup.weBatFirst, ourTeam: setup.ourTeam, opp: setup.opp, inn,
    line: { our: ln('our'), opp: ln('opp') }, R: { our: totalRuns(s, 'our'), opp: totalRuns(s, 'opp') },
    H: { our: s.hits.our, opp: s.hits.opp }, E: { our: s.errs.our, opp: s.errs.opp },
    over: !!s.over, label: s.over ? '' : '進行中（' + halfLabel(s) + '）'
  };
}
function metaFor(s, i, noSum) {
  const l = s.log[i] || {};
  const sum = noSum || !App.game ? undefined : gameSummary(App.game.setup, s);
  return { label: l.label || '', text: l.text || '', our: totalRuns(s, 'our'), opp: totalRuns(s, 'opp'), status: s.over ? '結束' : '進行中', summary: sum };
}
function enqueue(op) {
  const id = App.game.setup.gameId;
  const q = qGet(id).slice(); q.push(op);
  qSet(id, q); lsSet(evKey(id), App.game.events);
  updateSync(); flush(id);
}
async function flush(id) {
  if (App.syncing[id] || (App.deleted && App.deleted[id])) return;
  App.syncing[id] = true;
  let failed = false;
  try {
    for (; ;) {
      const q = qGet(id);
      if (!q.length || (App.deleted && App.deleted[id]) || (App.locked && App.locked[id])) break;
      const op = q[0];
      if (op.op === 'add') await gs('addEvent', id, op.seq, op.ev, op.meta, deviceId());
      else if (op.op === 'del') await gs('deleteEvent', id, op.seq, op.meta, deviceId());
      else await gs('replaceEvents', id, op.events, op.metas, op.meta, deviceId());
      const q2 = qGet(id).slice(); q2.shift(); qSet(id, q2);
      updateSync();
    }
  } catch (e) {
    if (String(e && e.message).indexOf('LOCKED') >= 0) { lockedOut(id); App.syncing[id] = false; return; }
    failed = true;
  }
  App.syncing[id] = false;
  updateSync();
  if (failed) setTimeout(() => flush(id), 5000);
}
/** 伺服器拒絕：這場比賽已由其他手機接手 */
function lockedOut(id) {
  App.locked = App.locked || {};
  if (App.locked[id]) return;
  App.locked[id] = true;
  updateSync();
  const n = qGet(id).length;
  openModal({
    title: '這場比賽已由其他手機接手', forced: true,
    body: `<p>另一支手機已經接手記錄這場比賽，這支手機上 <b>${n}</b> 筆還沒上傳的紀錄<b>不會</b>送出，以免覆蓋對方的紀錄。</p>
      <p class="small muted">如果確定要改回由這支手機記錄，請回首頁重新點這場比賽並選擇「繼續紀錄」接手（對方的紀錄會保留，你這邊未上傳的會捨棄）。</p>`,
    buttons: [{ label: '捨棄並回首頁', onClick: () => { qSet(id, []); [evKey(id), setupKey(id)].forEach(lsDel); delete App.locked[id]; goHome(); } },
      { label: '👀 改為觀看', cls: 'primary', onClick: () => { qSet(id, []); delete App.locked[id]; goLive(id); } }]
  });
}
function flushAll() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf('sb_q_') === 0) flush(k.slice(5));
    }
  } catch (e) { }
}
function syncLabel() {
  if (!App.game) return '';
  const id = App.game.setup.gameId;
  if (App.locked && App.locked[id]) return '<span class="sync warn">已由他人接手</span>';
  const n = qGet(id).length;
  return n ? `<span class="sync warn">未同步 ${n}</span>` : '<span class="sync ok">已同步</span>';
}
function updateSync() { const el = $('#sync'); if (el) el.innerHTML = syncLabel(); }

/* ---------------- 首頁 ---------------- */
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
function mdw(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${m}/${d}（${WEEK[new Date(y, m - 1, d).getDay()]}）`;
}
function renderHome() {
  const live = App.boot.live || [];
  const up = (App.boot.upcoming || []).filter(x => x.date >= today()).slice(0, 10);
  const bg = App.boot.homeBg;
  const nav = [
    ['⚾', '記錄新比賽', 'newGame()', 'main'],
    ['🏆', '記錄新賽事', 'goSchedule()', ''],
    ['📈', '球隊年度成績', 'goTeam()', ''],
    ['🗂️', '球隊總成績', 'goTeamTotal()', ''],
    ['📊', '選手年度成績', 'goSeason()', ''],
    ['🏅', '選手總成績', 'goCareer()', ''],
    ['✏️', '年度原始數據', 'goOpening()', ''],
    ['📝', '手動補登資料', 'goManual()', '']
  ];
  return `<div class="home ${bg ? 'hasbg' : ''}"${bg ? ` style="background-image:url('${esc(bg)}')"` : ''}>
  <div class="topbar hometop"><div class="title" onclick="perfTap()">${esc(App.boot.homeTitle || '鈾興慢速壘球')}</div></div>
  <div class="page">
    <div class="homegrid">${nav.map(([ic, z, fn, cls]) => `<button class="hbtn ${cls}" onclick="${fn}"><span class="hic">${ic}</span><span>${z}</span>${cls === 'soon' ? '<small>即將推出</small>' : ''}</button>`).join('')}</div>
    ${live.length ? `<div class="sec">進行中的比賽</div>${live.map(x => `<div class="livecard" onclick="liveMenu(${J(x.gameId)})">
        <div><div class="lvtop"><span class="lvdot"></span>LIVE　${esc(x.label || '')}</div>
          <div class="gt">${esc(mdw(x.date))} ${esc(x.cup)}</div><div class="gs">vs ${esc(x.opp)}</div></div>
        <div class="gscore">${x.our} : ${x.oppScore}</div></div>`).join('')}` : ''}
    <div class="sec">即將到來的比賽</div>
    ${up.length ? up.map(x => `<div class="upitem" onclick="newGame(${J({ date: x.date, cup: x.cup, venue: x.venue })})">
        <div class="update"><b>${esc(mdw(x.date).split('（')[0])}</b><small>週${esc(mdw(x.date).split('（')[1].replace('）', ''))}</small></div>
        <div class="upmain"><div class="gt">${esc(x.cup || '未命名賽事')}</div><div class="gs">📍 ${esc(x.venue || '場地未定')}</div></div>
        <div class="uptime">${esc(x.time || '')}</div></div>`).join('')
      : '<p class="muted nogame">目前沒有排定的比賽，可以按「記錄新賽事」新增。</p>'}
  </div></div>`;
}
function liveMenu(id) {
  const x = (App.boot.live || []).find(g => g.gameId === id) || {};
  openModal({
    title: `${x.date ? mdw(x.date) : ''} vs ${x.opp || ''}`,
    body: `<p class="small muted">${esc(x.cup || '')}　目前 ${x.our} : ${x.oppScore}　${esc(x.label || '')}</p>
      <p class="small">「觀看即時比賽」只能看、不能修改；「繼續紀錄」給記錄員接手未完成的比賽。</p>`,
    buttons: [{ label: '取消' }, { label: '✏️ 繼續紀錄', onClick: () => openGame(id) }, { label: '👀 觀看即時比賽', cls: 'primary', onClick: () => goLive(id) }]
  });
}
function soon() { toast('即將推出，敬請期待'); }

/* ---------------- 賽前設定 ---------------- */
function today() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function newGame(pre) {
  pre = pre || {};
  App.draft = { date: pre.date || today(), cup: pre.cup || '', venue: pre.venue || '', opp: '', weBatFirst: true, oppCount: 10, lineup: range(11).map(() => ({ pid: null, pos: null })), reserves: [], oppJerseys: range(12).map(() => '') };
  go('setup');
}
function usedInDraft() {
  const d = App.draft;
  return new Set([...d.lineup.map(l => l.pid).filter(Boolean), ...d.reserves]);
}
function renderSetup() {
  const d = App.draft;
  return `<div class="topbar"><button class="back" onclick="goHome()">‹</button><div class="title">新比賽</div></div>
  <div class="page">
    <div class="form">
      <label>日期<input type="date" value="${esc(d.date)}" onchange="App.draft.date=this.value"></label>
      <label>盃賽名稱<input value="${esc(d.cup)}" oninput="App.draft.cup=this.value" placeholder="例：秋季聯賽"></label>
      <label>我方隊名<input value="${esc(App.boot.ourTeam)}" disabled></label>
      <label>對方隊名<input value="${esc(d.opp)}" oninput="App.draft.opp=this.value"></label>
    </div>
    <div class="row2"><span>我方</span><div class="seg">
      <button class="${d.weBatFirst ? 'on' : ''}" onclick="App.draft.weBatFirst=true;render()">先攻</button>
      <button class="${!d.weBatFirst ? 'on' : ''}" onclick="App.draft.weBatFirst=false;render()">後攻</button></div></div>

    <div class="sec">先發名單 <small>（第 11 棒不填 = 10 人打擊）</small></div>
    <div class="lgrid">${d.lineup.map((l, i) => `<div class="lrow"><span class="slot">${i + 1}</span>
      <button class="pick ${l.pid ? '' : 'empty'}" onclick="pickLineup(${i})">${l.pid ? esc(P(l.pid).name) : '點選球員'}</button>
      <span class="num">${l.pid ? '#' + esc(P(l.pid).num) : ''}</span>
      <button class="pick pos ${l.pos ? '' : 'empty'}" onclick="pickPos(${i})">${l.pos ? esc(POS_ZH[l.pos]) : '守位'}</button>
      <button class="x" onclick="clearRow(${i})">✕</button></div>`).join('')}</div>

    <div class="sec">預備名單 <small>（沒選的在隊球員，開賽時會自動列為預備）</small></div>
    <div class="chips">
      ${d.reserves.map(pid => `<span class="chip"><b style="margin:0;color:var(--pri)">#${esc(P(pid).num)}</b> ${esc(P(pid).name)} <b onclick="removeReserve(${J(pid)})">✕</b></span>`).join('')}
      <button class="chip add" onclick="pickReserve()">＋ 預備</button>
    </div>
    <button class="btn ghost" onclick="addPlayerDialog()">＋ 新增球員到名冊</button>
    <div id="setupErr" class="errbox"></div>
    <button class="btn primary big" onclick="goOppSetup()">下一步：對方打序 ›</button>
  </div>`;
}

/* ----- 對方打序 ----- */
function goOppSetup() {
  const errs = validateOurSetup();
  if (errs.length) { $('#setupErr').innerHTML = errs.map(esc).join('<br>'); return; }
  go('oppsetup');
  setTimeout(() => { const el = $('#oj0'); if (el && !el.value) el.focus(); }, 50);
}
function renderOppSetup() {
  const d = App.draft;
  return `<div class="topbar"><button class="back" onclick="go('setup')">‹</button><div class="title">對方打序：${esc(d.opp)}</div></div>
  <div class="page">
    <div class="row2"><span>對方打擊人數</span><div class="seg">
      ${[10, 11, 12].map(n => `<button class="${d.oppCount === n ? 'on' : ''}" onclick="App.draft.oppCount=${n};render()">${n} 人</button>`).join('')}</div></div>
    <p class="muted small">輸入每一棒的背號，按 Enter 自動跳到下一棒。不知道可以先空著，比賽中再補。</p>
    <div class="ojgrid">
      ${range(d.oppCount).map(i => `<div class="ojrow"><span class="slot">${i + 1}</span>
        <input id="oj${i}" class="jin" inputmode="numeric" enterkeyhint="next" value="${esc(d.oppJerseys[i])}" placeholder="背號"
          oninput="App.draft.oppJerseys[${i}]=this.value.trim()" onkeydown="ojKey(event,${i})"></div>`).join('')}
    </div>
    <div id="setupErr" class="errbox"></div>
    <button class="btn primary big" id="startBtn" onclick="startGame()">開始比賽</button>
  </div>`;
}
function ojKey(e, i) {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const nx = $('#oj' + (i + 1));
  if (nx) nx.focus(); else e.target.blur();
}
function validateOurSetup() {
  const d = App.draft, errs = [];
  if (!d.opp.trim()) errs.push('請輸入對方隊名');
  const firstEmpty = d.lineup.findIndex(l => !l.pid);
  const n = firstEmpty < 0 ? 11 : firstEmpty;
  if (d.lineup.filter(l => l.pid).length !== n) errs.push('先發名單中間不可有空格');
  if (n < 10) errs.push('先發至少需要 10 人');
  if (n >= 10) errs.push(...validatePositions(d.lineup.slice(0, n)));
  return errs;
}
function pickLineup(i) {
  const used = usedInDraft(), cur = App.draft.lineup[i].pid;
  const list = App.boot.players.map(p => p.pid).filter(pid => !used.has(pid) || pid === cur);
  pickPlayer(`第 ${i + 1} 棒`, list, pid => {
    App.draft.lineup[i].pid = pid; render();
    if (!App.draft.lineup[i].pos) pickPos(i);
  });
}
function pickPos(i) {
  const taken = new Set(App.draft.lineup.filter((l, k) => k !== i && l.pos).map(l => l.pos));
  openModal({
    title: `第 ${i + 1} 棒 守位`,
    body: () => `<div class="pgrid">${POS_LIST.map(p => `<button class="pbtn" ${taken.has(p) ? 'disabled' : ''} onclick="App._pos(${J(p)})">${esc(POS_ZH[p])}</button>`).join('')}</div>`,
    buttons: [{ label: '取消' }]
  });
  App._pos = p => { App.modals.pop(); renderModal(); App.draft.lineup[i].pos = p; render(); };
}
function clearRow(i) { App.draft.lineup[i] = { pid: null, pos: null }; render(); }
function removeReserve(pid) { App.draft.reserves = App.draft.reserves.filter(x => x !== pid); render(); }
function pickReserve() {
  const used = usedInDraft();
  pickPlayer('選擇預備球員（可連續點選）', App.boot.players.map(p => p.pid).filter(pid => !used.has(pid)), pid => {
    App.draft.reserves.push(pid); render(); pickReserve();
  });
}
function addPlayerDialog() {
  openModal({
    title: '新增球員',
    body: `<div class="form"><label>姓名<input id="np-name"></label><label>背號<input id="np-num" inputmode="numeric"></label></div>`,
    buttons: [{ label: '取消' }, {
      label: '新增', cls: 'primary', onClick: () => {
        const name = $('#np-name').value.trim(), num = $('#np-num').value.trim();
        if (!name) { toast('請輸入姓名'); return false; }
        gs('addPlayer', name, num).then(p => {
          App.boot.players.push(p); sortPlayers(); toast('已新增 ' + name);
          if (App.view === 'setup') render();
        }).catch(e => toast('新增失敗：' + e.message));
      }
    }]
  });
}
async function startGame() {
  const d = App.draft, errs = validateOurSetup();
  if (errs.length) { go('setup'); $('#setupErr').innerHTML = errs.map(esc).join('<br>'); return; }
  const firstEmpty = d.lineup.findIndex(l => !l.pid);
  const lineup = d.lineup.slice(0, firstEmpty < 0 ? 11 : firstEmpty);
  const oppJerseys = {};
  range(d.oppCount).forEach(i => { if (d.oppJerseys[i]) oppJerseys[i] = d.oppJerseys[i]; });

  // 未先發、也沒手動加入預備的在隊球員，自動列為預備（避免忘記填預備名單時，換代打沒有人可選）
  const reserveIds = d.reserves.slice(), inLineup = new Set(lineup.map(l => l.pid));
  App.boot.players.forEach(p => { if (!inLineup.has(p.pid) && !reserveIds.includes(p.pid)) reserveIds.push(p.pid); });
  const players = {};
  [...lineup.map(l => l.pid), ...reserveIds].forEach(pid => players[pid] = { name: P(pid).name, num: P(pid).num });
  const setup = {
    date: d.date, cup: d.cup.trim(), venue: d.venue || '', opp: d.opp.trim(), ourTeam: App.boot.ourTeam,
    weBatFirst: d.weBatFirst, oppCount: d.oppCount, oppJerseys, innings: 7,
    lineup: lineup.map(l => ({ pid: l.pid, pos: l.pos })),
    reserves: reserveIds.map(pid => ({ pid })), players
  };
  const btn = $('#startBtn'); btn.disabled = true; btn.textContent = '建立中…';
  try {
    const id = await gs('createGame', setup, deviceId());
    setup.gameId = id;
    lsSet(setupKey(id), setup); lsSet(evKey(id), []);
    App.game = { setup, events: [] };
    App.state = replay(setup, []);
    App.edit = null; resetUi();
    go('game');
  } catch (e) {
    btn.disabled = false; btn.textContent = '開始比賽';
    $('#setupErr').textContent = '建立失敗：' + e.message;
  }
}

/* ---------------- 載入比賽 ---------------- */
async function openGame(id) {
  $('#app').innerHTML = '<div class="loading">載入中…</div>';
  let server = null;
  try { server = await gs('getGame', id); } catch (e) { }
  const pending = qGet(id), localEv = lsGet(evKey(id), null), localSetup = lsGet(setupKey(id), null);
  const setup = server ? server.setup : localSetup;
  if (!setup) { toast('無法載入比賽'); return go('home'); }
  setup.gameId = id;
  if (server && server.device && server.device !== deviceId()) {
    const over = replay(server.setup, server.events).over;
    if (!over && !(await askClaim(id))) return;
    {
      try { await gs('claimGame', id, deviceId()); } catch (e) { toast('接手失敗：' + e.message); return go('home'); }
      // 接手後以伺服器上的紀錄為準，這支手機舊的未上傳紀錄捨棄
      qSet(id, []);
      if (App.locked) delete App.locked[id];
      pending.length = 0;
    }
  }
  const events = (pending.length && localEv) ? localEv : (server ? server.events : (localEv || []));
  lsSet(setupKey(id), setup); lsSet(evKey(id), events);
  App.game = { setup, events, importStatus: server ? server.importStatus : '', importSig: server ? server.importSig : '', placing: server ? server.placing : '' };
  App.state = replay(setup, events);
  App.edit = null; resetUi();
  go(App.state.over ? 'box' : 'game');
  flush(id);
}

function askClaim(id) {
  return new Promise(resolve => {
    openModal({
      title: '要由這支手機接手記錄嗎？', forced: true,
      body: `<p>這場比賽目前由<b>另一支手機</b>記錄。</p><p class="small">接手後，原本那支手機就不能再上傳紀錄（它還沒上傳的部分會被捨棄），由這支手機繼續記錄。</p>`,
      buttons: [{ label: '取消', onClick: () => { resolve(false); setTimeout(goHome, 0); } },
        { label: '👀 只觀看', onClick: () => { resolve(false); setTimeout(() => goLive(id), 0); } },
        { label: '✏️ 接手記錄', cls: 'primary', onClick: () => resolve(true) }]
    });
  });
}

/* ---------------- 比賽紀錄頁 ---------------- */
function resetUi() { App.ui = { result: null, rbi: 0, marks: {}, batter: 'safe', runs: 0, unearned: false, errPid: null, jersey: null }; }
function curS() { return App.edit ? App.edit.base : App.state; }

function renderGame() {
  const setup = App.game.setup, s = curS(), off = isOffense(s, setup), ed = App.edit;
  const title = ed ? (ed.insert ? `在第 ${ed.index + 1} 筆前插入` : `修正第 ${ed.index + 1} 筆`) : (setup.cup || '比賽紀錄');
  let html = `<div class="stickyhead"><div class="topbar"><button class="back" onclick="${ed ? 'cancelEdit()' : 'goHome()'}">‹</button>
    <div class="title">${esc(title)}</div>${ed ? '' : `<div id="sync">${syncLabel()}</div>`}</div>
  <div class="board">
    <div class="inn">${halfLabel(s)}</div>
    <div class="outs">${[0, 1, 2].map(k => `<i class="${k < s.outs ? 'on' : ''}"></i>`).join('')}</div>
    <div class="side ${off ? 'off' : 'def'}">${off ? '我方進攻' : '我方守備'}</div>
    <div class="sc"><span class="tm">${esc(setup.ourTeam)}</span><b>${totalRuns(s, 'our')}</b><span>:</span><b>${totalRuns(s, 'opp')}</b><span class="tm">${esc(setup.opp)}</span></div>
  </div></div><div class="page game">`;

  if (s.over && !ed) {
    return html + `<div class="ended"><h3>比賽已結束</h3><button class="btn primary" onclick="go('box')">查看紀錄表</button>
      <button class="btn" onclick="go('edit')">修正紀錄</button></div></div>`;
  }
  html += off ? offensePanel(s, setup) : defensePanel(s, setup);
  if (!ed) html += `<div class="tools bottom">${off ? '<button onclick="showLineup()">看攻守名單</button>' : ''}<button onclick="go('box')">紀錄表</button><button onclick="go('edit')">事件列表</button><button class="red" onclick="endGame()">結束比賽</button></div>`;
  html += '</div>';

  if (ed) html += `<div class="footer"><button onclick="cancelEdit()">取消</button><button class="save" onclick="${off ? 'saveOffense' : 'saveDefense'}()">儲存修正</button></div>`;
  else if (off) html += `<div class="footer"><button onclick="runnerEvent()">跑者事件</button><button onclick="undo()">復原</button><button class="save" onclick="saveOffense()">儲存</button></div>`;
  else html += `<div class="footer"><button onclick="runnerEvent()">跑者事件</button><button onclick="openDefense()">守備/換投</button><button onclick="undo()">復原</button><button class="save" onclick="saveDefense()">儲存</button></div>`;
  return html;
}

/* ----- 進攻 ----- */
/** 我方目前的攻守名單：代打、代跑、代守發生後，以最後上場的人為準 */
function showLineup() {
  const s = App.state, TAG = { '代打': '代打', '代跑': '代跑', '守備': '代守' };
  const rows = s.slots.map((x, i) => {
    const h = s.hist[i], last = h[h.length - 1], tag = TAG[last.role] || '';
    return `<tr class=\"${i === s.batIdx ? 'cur' : ''}\"><td>${i + 1}</td><td>${esc(POS_ZH[x.pos] || '')}</td>
      <td class=\"nm\">${esc(P(x.pid).name)}${tag ? `<small>${tag}</small>` : ''}</td><td>#${esc(P(x.pid).num)}</td></tr>`;
  }).join('');
  openModal({
    title: '我方攻守名單',
    body: `<table class=\"lutbl\"><tr><th>棒</th><th>守位</th><th class=\"nm\">姓名</th><th>背號</th></tr>${rows}</table>
      <p class=\"small muted\">底色為目前打者；代打、代跑後守位暫沿用原球員，守備調整後才會更新。</p>`,
    buttons: [{ label: '關閉', cls: 'primary' }]
  });
}
function previewOffense(s, u) {
  if (u.result === 'HR') return { runs: s.queue.length + 1, outs: 0 };
  let runs = 0, outs = 0;
  s.queue.forEach(q => { const m = u.marks[q.pid]; if (m === 'score') runs++; else if (m === 'out') outs++; });
  const r = u.result ? OUR_RES[u.result] : null;
  if (r) { if (r.out) outs++; else if (u.batter === 'scored') runs++; else if (u.batter === 'out') outs++; }
  return { runs, outs };
}
function offensePanel(s, setup) {
  const u = App.ui, N = s.slots.length, slot = s.batIdx, cur = s.slots[slot];
  const r = u.result ? OUR_RES[u.result] : null;
  const showBatter = r && !r.out && u.result !== 'HR';
  const bCls = { safe: '', scored: 'score', out: 'out' }[u.batter];
  const chips = s.queue.map(q => {
    const st = u.marks[q.pid] || 'stay';
    return `<button class="rchip ${st}" onclick="cycleMark(${J(q.pid)})"><small>第${q.slot + 1}棒</small>${esc(P(q.pid).name)}<em>${MARK_ZH[st]}</em></button>`;
  }).join('') + (showBatter ? `<button class="rchip batter ${bCls}" onclick="cycleBatter()"><small>打者</small>${esc(P(cur.pid).name)}<em>${BATTER_ZH[u.batter]}</em></button>` : '');
  const btn = code => `<button class="rbtn ${code === 'SF' ? 'b' : OUR_RES[code].area} ${u.result === code ? 'sel' : ''}" onclick="setResult('${code}')">${OUR_RES[code].zh}</button>`;
  const pv = previewOffense(s, u);
  return `<div class="gpanel off"><div class="g-bat card batter"><div class="binfo">
      <div class="bname"><span class="bslot">${slot + 1}棒</span>${esc(P(cur.pid).name)} <span class="bnum">#${esc(P(cur.pid).num)}</span> <span class="bpos">${esc(POS_ZH[cur.pos] || '')}</span></div>
      <div class="muted small">下三棒：${['先', '中', '後'].map((z, k) => esc(P(s.slots[(slot + 1 + k) % N].pid).name) + '(' + z + ')').join('、')}</div>
    </div>${App.edit ? '' : '<button class="btn sm" onclick="doPH()">代打</button>'}</div>
    <div class="g-run"><div class="sec">壘上跑者 <small>點擊切換 留壘／得分／出局</small></div>
    <div class="runners">${chips || '<span class="muted small">壘上無人</span>'}</div></div>
    <div class="g-a"><div class="sec">選手上壘</div><div class="grid">${['1B', '2B', '3B', 'HR', 'BB', 'ROE', 'SF', 'FC'].map(btn).join('')}</div></div>
    <div class="g-b"><div class="sec">選手出局</div><div class="grid">${['K', 'AO', 'GO', 'DP'].map(btn).join('')}</div></div>
    <div class="g-rbi"><div class="sec">打點 <small class="pv">本打席：得分 <b>${pv.runs}</b>　出局 <b>+${pv.outs}</b></small></div>
    <div class="grid5">${[0, 1, 2, 3, 4].map(n => `<button class="nbtn ${u.rbi === n ? 'sel' : ''}" onclick="setRbi(${n})">${n}</button>`).join('')}</div></div></div>`;
}
function setResult(code) {
  const u = App.ui, s = curS(), prev = u.result;
  if (code === 'FC' && !s.queue.length) return toast('壘上無人，不能選野手選擇');
  u.result = code;
  if (code === 'HR') {
    s.queue.forEach(q => u.marks[q.pid] = 'score');
    u.rbi = s.queue.length + 1; u.batter = 'scored';
  } else {
    if (prev === 'HR') { u.marks = {}; u.rbi = 0; }
    if (u.batter === 'scored') u.batter = 'safe';
    if (code === 'DP') { u.rbi = 0; if (s.queue.length) toast('請在壘上點選另一位出局的跑者'); }
    if (code === 'ROE') u.rbi = 0;
    if (code === 'FC' && !s.queue.some(q => u.marks[q.pid] === 'out')) toast('野手選擇：請在壘上點選出局的跑者');
  }
  render();
}
function setRbi(n) {
  const u = App.ui, s = curS();
  u.rbi = n;
  if (u.result !== 'HR') {
    s.queue.forEach(q => { if (u.marks[q.pid] === 'score') delete u.marks[q.pid]; });
    let left = n;
    s.queue.forEach(q => { if (left > 0 && u.marks[q.pid] !== 'out') { u.marks[q.pid] = 'score'; left--; } });
  }
  render();
}
function cycleMark(pid) {
  const u = App.ui, order = ['stay', 'score', 'out'];
  const cur = u.marks[pid] || 'stay';
  const nx = order[(order.indexOf(cur) + 1) % 3];
  if (nx === 'stay') delete u.marks[pid]; else u.marks[pid] = nx;
  render();
}
function cycleBatter() {
  const order = ['safe', 'out', 'scored'];
  App.ui.batter = order[(order.indexOf(App.ui.batter) + 1) % 3];
  render();
}
function saveOffense() {
  const u = App.ui, s = curS();
  if (!u.result) return toast('請選擇打擊結果');
  const scored = s.queue.filter(q => u.marks[q.pid] === 'score').map(q => q.pid);
  const outs = s.queue.filter(q => u.marks[q.pid] === 'out').map(q => q.pid);
  if (u.result === 'DP' && outs.length < 1) return toast('雙殺打請在壘上點選另一位出局跑者');
  if (u.result === 'FC' && outs.length < 1) return toast('野手選擇請在壘上點選出局的跑者');
  const pv = previewOffense(s, u);
  if (u.result === 'SF' && pv.runs < 1) return toast('高飛犧牲打需至少一位跑者得分');
  if (s.outs + pv.outs > 3) return toast('出局數會超過 3，請確認');
  const ev = { type: 'PA', result: u.result, rbi: u.rbi, scored, outs };
  if (!OUR_RES[u.result].out && u.result !== 'HR') ev.batter = u.batter;
  if (u.rbi > pv.runs) {
    confirmModal('確認打點', `打點 ${u.rbi} 大於本打席得分 ${pv.runs}，確定儲存？`, '儲存', () => commit(ev));
    return;
  }
  commit(ev);
}
function doPH() {
  const s = App.state, setup = App.game.setup, slot = s.batIdx;
  pickPlayer(`代打（第 ${slot + 1} 棒 ${P(s.slots[slot].pid).name}）`, availableFor(s, setup, slot),
    pid => commit({ type: 'SUB', kind: 'PH', slot, inPid: pid }), pid => reentryTag(s, pid));
}
function reentryTag(s, pid) { const st = s.status[pid]; return st && st.used ? '再上場' : ''; }

function runnerEvent() {
  const s = App.state, setup = App.game.setup;
  if (!isOffense(s, setup)) return oppRunnerEvent();
  if (!s.queue.length) return toast('壘上無跑者');
  openModal({
    title: '跑者事件（不換打者、不計打席）',
    body: () => s.queue.map(q => `<div class="rerow"><div><small class="muted">第${q.slot + 1}棒</small> ${esc(P(q.pid).name)}</div>
      <div class="rebtns"><button onclick="App._re(${J(q.pid)},'PR')">代跑</button>
      <button class="red" onclick="App._re(${J(q.pid)},'out')">出局</button>
      <button class="green" onclick="App._re(${J(q.pid)},'score')">得分</button></div></div>`).join(''),
    buttons: [{ label: '取消' }]
  });
  App._re = (pid, act) => {
    App.modals.pop(); renderModal();
    if (act === 'PR') {
      const q = s.queue.find(x => x.pid === pid);
      pickPlayer(`代跑（第 ${q.slot + 1} 棒 ${P(pid).name}）`, availableFor(s, setup, q.slot),
        inPid => commit({ type: 'SUB', kind: 'PR', outPid: pid, inPid }), p => reentryTag(s, p));
    } else {
      confirmModal('確認', `${P(pid).name} ${act === 'out' ? '出局' : '得分'}？`, '確定', () => commit({ type: 'RUNNER', action: act, pid }));
    }
  };
}

/* ----- 守備 ----- */
function defensePanel(s, setup) {
  const u = App.ui, idx = s.oppIdx, pp = curPitcher(s);
  const jersey = u.jersey != null ? u.jersey : (s.oppJersey[idx] || '');
  const fielders = s.slots.filter(x => x.pos && x.pos !== 'EP');
  const nx = (idx + 1) % s.oppCount;
  return `<div class="gpanel def"><div class="g-bat card batter"><div class="binfo">
      <div class="bname"><span class="bslot">對方</span>第 ${idx + 1} 棒 <span class="jrow">#<input class="jin" inputmode="numeric" value="${esc(jersey)}" oninput="App.ui.jersey=this.value" placeholder="背號"></span></div>
      <div class="muted small">下一棒：${nx + 1}棒${s.oppJersey[nx] ? ' #' + esc(s.oppJersey[nx]) : ''}　投手：${pp ? esc(P(pp).name) : '未指定'}　共 ${s.oppCount} 人${App.edit ? '' : ' <a onclick="changeOppCount()">調整</a>'}</div>
    </div></div>
    <div class="g-res"><div class="sec">結果</div>
    <div class="grid">${OPP_BTNS.map(c => `<button class="rbtn ${OPP_RES[c].outs ? 'b' : 'a'} ${u.result === c ? 'sel' : ''}" onclick="setOppResult('${c}')">${OPP_RES[c].btn || OPP_RES[c].zh}</button>`).join('')}</div></div>
    ${u.result === 'ROE' ? `<div class="g-err"><div class="sec">失誤的守備員</div><div class="chips">${fielders.map(f => `<button class="chip ${u.errPid === f.pid ? 'sel' : ''}" onclick="App.ui.errPid=${J(f.pid)};render()">${esc(POS_ABBR[f.pos])} ${esc(P(f.pid).name)}</button>`).join('')}</div></div>` : ''}
    <div class="g-runs"><div class="sec">本打席失分 <label class="chk"><input type="checkbox" ${u.unearned ? 'checked' : ''} onchange="App.ui.unearned=this.checked"> 非自責分</label></div>
    <div class="grid5">${[0, 1, 2, 3, 4].map(n => `<button class="nbtn ${u.runs === n ? 'sel' : ''}" onclick="App.ui.runs=${n};render()">${n}</button>`).join('')}</div></div></div>`;
}
function setOppResult(code) {
  const u = App.ui;
  u.result = code;
  if (code === 'HR' && u.runs < 1) u.runs = 1;
  render();
}
function saveDefense() {
  const u = App.ui, s = curS();
  if (!u.result) return toast('請選擇結果');
  const r = OPP_RES[u.result];
  if (s.outs + (r.outs || 0) > 3) return toast('出局數會超過 3，請確認');
  const jersey = String(u.jersey != null ? u.jersey : (s.oppJersey[s.oppIdx] || '')).trim();
  const ev = { type: 'OPP', result: u.result, runs: u.runs, unearned: !!(u.unearned && u.runs > 0), jersey };
  if (u.result === 'ROE') ev.errPid = u.errPid || null;
  commit(ev);
}
function changeOppCount() {
  openModal({
    title: '對方打擊人數', body: '<p class="muted small">改變後從下一位打者開始生效</p>',
    buttons: [9, 10, 11, 12].map(n => ({ label: n + ' 人', cls: App.state.oppCount === n ? 'primary' : '', onClick: () => { if (n !== App.state.oppCount) commit({ type: 'OPPCOUNT', n }); } }))
  });
}
function oppRunnerEvent() {
  openModal({
    title: '對方跑者事件（不換打者）',
    body: '<p class="muted small">用於不是打席造成的出局或得分</p>',
    buttons: [
      { label: '取消' },
      { label: '跑者出局', cls: 'red', onClick: () => commit({ type: 'OPPRUN', action: 'out' }) },
      { label: '得分(自責)', onClick: () => commit({ type: 'OPPRUN', action: 'run', unearned: false }) },
      { label: '得分(非自責)', onClick: () => commit({ type: 'OPPRUN', action: 'run', unearned: true }) }
    ]
  });
}
function openDefense(note) {
  const s = App.state, setup = App.game.setup;
  const draft = s.slots.map(x => ({ pid: x.pid, pos: x.pos }));
  let err = '';
  openModal({
    title: '守備調整／換投', forced: !!note,
    body: () => `${note ? `<div class="notice">${esc(note)}</div>` : ''}
      ${draft.map((d, i) => `<div class="drow"><span class="slot">${i + 1}</span>
        <div class="dname ${d.pid !== s.slots[i].pid ? 'chg' : ''}">${esc(P(d.pid).name)} <small class="muted">#${esc(P(d.pid).num)}</small></div>
        <select onchange="App._dpos(${i},this.value)">${POS_LIST.map(p => `<option value="${p}" ${d.pos === p ? 'selected' : ''}>${POS_ZH[p]}</option>`).join('')}</select>
        <button class="btn sm" onclick="App._dsub(${i})">換人</button></div>`).join('')}
      ${err ? `<div class="errbox">${esc(err)}</div>` : ''}`,
    buttons: [...(note ? [] : [{ label: '取消' }]), {
      label: '確認', cls: 'primary', onClick: () => {
        const e = validatePositions(draft);
        if (e.length) { err = e.join('、'); renderModal(); return false; }
        const changes = [];
        draft.forEach((d, i) => {
          const o = s.slots[i];
          if (d.pid !== o.pid) changes.push({ slot: i, inPid: d.pid, pos: d.pos });
          else if (d.pos !== o.pos) changes.push({ slot: i, pos: d.pos });
        });
        if (changes.length) commit({ type: 'DEFSET', changes });
      }
    }]
  });
  App._dpos = (i, v) => { draft[i].pos = v; };
  App._dsub = i => {
    const avail = availableFor(s, setup, i).filter(pid => !draft.some((d, k) => k !== i && d.pid === pid));
    pickPlayer(`第 ${i + 1} 棒 換人`, avail, pid => { draft[i].pid = pid; renderModal(); }, p => reentryTag(s, p));
  };
}

/* ----- 儲存 / 復原 / 結束 ----- */
function commit(ev) {
  if (App.edit) return commitEdit(ev);
  const g = App.game;
  g.events.push(ev);
  App.state = replay(g.setup, g.events);
  const i = g.events.length - 1, s = App.state, log = s.log[i];
  enqueue({ op: 'add', seq: i, ev, meta: metaFor(s, i) });
  resetUi();
  if (ev.type === 'END') { go('box'); return; }
  render();
  if (log.warn.length) toast('⚠ ' + log.warn.join('；'));
  if (s.halfChanged) {
    const off = isOffense(s, g.setup);
    openModal({
      title: '三出局，攻守交換', forced: true,
      body: `<p>進入 <b>${halfLabel(s)}</b>，${off ? '我方進攻' : '我方守備'}</p>`,
      buttons: [{ label: '復原上一筆', onClick: () => doUndo() }, { label: '確定', cls: 'primary', onClick: () => afterSwitch() }]
    });
  }
}
function afterSwitch() {
  const s = App.state, setup = App.game.setup;
  if (isOffense(s, setup)) return;
  const v = validatePositions(s.slots);
  if (s.needDefArrange || v.length) {
    openDefense(s.needDefArrange ? '上半局有代打／代跑，請確認守備位置' : '守備位置需要調整：' + v.join('、'));
  }
}
function undo() {
  const g = App.game;
  if (!g.events.length) return toast('沒有可復原的紀錄');
  const last = App.state.log[g.events.length - 1];
  confirmModal('復原上一筆', `${last.label} ${last.text || last.type}`, '復原', doUndo);
}
function doUndo() {
  const g = App.game;
  if (!g.events.length) return;
  g.events.pop();
  const seq = g.events.length;
  App.state = replay(g.setup, g.events);
  enqueue({ op: 'del', seq, meta: metaFor(App.state, seq - 1) });
  resetUi(); toast('已復原'); go('game');
}
function endGame() {
  const s = App.state, setup = App.game.setup;
  confirmModal('結束比賽', `目前比分 ${setup.ourTeam} ${totalRuns(s, 'our')} : ${totalRuns(s, 'opp')} ${setup.opp}，確定結束？`, '結束比賽', () => {
    chooseDecision(s, dec => commit({ type: 'END', decision: dec }));
  });
}
function chooseDecision(s, cb) {
  const our = totalRuns(s, 'our'), opp = totalRuns(s, 'opp');
  const type = our > opp ? 'W' : our < opp ? 'L' : 'T';
  const pitchers = s.pitOrder.filter(p => p !== '_none');
  openModal({
    title: `選擇${type === 'T' ? '和局' : DEC_ZH[type]}投手`, forced: true,
    body: () => `<p class="muted small">比分 ${our} : ${opp}${type === 'T' ? '，和局' : ''}</p>` + (pitchers.length
      ? `<div class="pgrid">${pitchers.map(pid => `<button class="pbtn" onclick="App._dec(${J(pid)})"><b>#${esc(P(pid).num)}</b>${esc(P(pid).name)}</button>`).join('')}</div>`
      : '<p class="muted">本場沒有投手紀錄</p>'),
    buttons: [{ label: '不記錄', onClick: () => cb(null) }]
  });
  App._dec = pid => { App.modals.pop(); renderModal(); cb({ type, pid }); };
}
function editDecision() {
  chooseDecision(App.state, dec => {
    const evs = App.game.events, i = evs.length - 1;
    if (evs[i] && evs[i].type === 'END') {
      evs[i] = Object.assign({}, evs[i], { decision: dec });
      resyncAll(); render();
    }
  });
}

/* ---------------- 賽後修正 ---------------- */
function renderEditList() {
  const g = App.game, s = App.state;
  return `<div class="topbar"><button class="back" onclick="go(App.state.over?'box':'game')">‹</button><div class="title">事件列表／修正</div><div id="sync">${syncLabel()}</div></div>
  <div class="page">
    <p class="muted small">修改、插入或刪除後，系統會從頭重新計算整場比賽。紅框代表該筆紀錄有邏輯問題。</p>
    ${g.events.length ? '' : '<p class="muted">尚無紀錄</p>'}
    ${g.events.map((ev, i) => {
    const l = s.log[i], editable = ev.type === 'PA' || ev.type === 'OPP';
    return `<div class="erow ${l.warn.length ? 'warn' : ''}"><div class="emain"><span class="eno">${i + 1}</span><span class="elabel">${esc(l.label)}</span>${esc(l.text)}
        ${l.warn.length ? `<div class="ewarn">⚠ ${esc(l.warn.join('；'))}</div>` : ''}</div>
        <div class="ebtns">${editable ? `<button onclick="startEdit(${i},false)">改</button>` : ''}<button onclick="startEdit(${i},true)">前插</button><button class="red" onclick="deleteAt(${i})">刪</button></div></div>`;
  }).join('')}
    ${s.over ? '' : `<button class="btn" onclick="go('game')">回到比賽紀錄</button>`}
  </div>`;
}
function startEdit(i, insert) {
  const g = App.game;
  App.edit = { index: i, insert, base: replay(g.setup, g.events.slice(0, i)) };
  resetUi();
  if (!insert) {
    const ev = g.events[i], u = App.ui;
    if (ev.type === 'PA') {
      u.result = ev.result; u.rbi = ev.rbi || 0;
      (ev.scored || []).forEach(p => u.marks[p] = 'score');
      (ev.outs || []).forEach(p => u.marks[p] = 'out');
      u.batter = ev.batter || (ev.result === 'HR' ? 'scored' : 'safe');
    } else if (ev.type === 'OPP') {
      u.result = ev.result; u.runs = ev.runs || 0; u.unearned = !!ev.unearned;
      u.errPid = ev.errPid || null; u.jersey = ev.jersey || '';
    }
  }
  go('game');
}
function commitEdit(ev) {
  const g = App.game, ed = App.edit;
  g.events.splice(ed.index, ed.insert ? 0 : 1, ev);
  App.edit = null; resetUi();
  resyncAll();
  go('edit');
}
function cancelEdit() { App.edit = null; resetUi(); go('edit'); }
function deleteAt(i) {
  const l = App.state.log[i];
  confirmModal('刪除紀錄', `第 ${i + 1} 筆：${l.label} ${l.text}`, '刪除', () => {
    App.game.events.splice(i, 1); resyncAll(); render();
  });
}
function resyncAll() {
  const g = App.game;
  App.state = replay(g.setup, g.events);
  const s = App.state;
  enqueue({ op: 'replace', events: g.events, metas: g.events.map((e, i) => metaFor(s, i, true)), meta: metaFor(s, g.events.length - 1) });
}

/* ---------------- 紀錄表 ---------------- */
const BAT_COLS = [['PA', '打席'], ['AB', '打數'], ['H', '安打'], ['BB', '保送'], ['R', '得分'], ['RBI', '打點'], ['1B', '1B'], ['2B', '2B'], ['3B', '3B'], ['HR', 'HR'], ['K', 'K'], ['SF', '犧飛'], ['AO', '高飛'], ['GO', '滾地'], ['DP', '雙殺打'], ['FC', '野選'], ['ROE', '失誤上壘'], ['E', '守備失誤']];

function posPath(arr) {
  const out = [];
  arr.forEach(p => { if (p && out[out.length - 1] !== p) out.push(p); });
  return out.map(p => POS_ABBR[p]).join('→');
}
function avg(b) { return b.AB ? (b.H / b.AB).toFixed(3).replace(/^0/, '') : '-'; }

function boxTables(setup, s) {
  const teams = setup.weBatFirst ? [['our', setup.ourTeam], ['opp', setup.opp]] : [['opp', setup.opp], ['our', setup.ourTeam]];
  const inn = Math.max(setup.innings || 7, s.runs.our.length, s.runs.opp.length);

  const line = `<div class="tblwrap"><table class="tbl"><tr><th class="tn">隊伍</th>${range(inn).map(k => `<th>${k + 1}</th>`).join('')}<th>R</th><th>H</th><th>E</th></tr>
    ${teams.map(([t, n]) => `<tr><td class="tn">${esc(n)}</td>${range(inn).map(k => `<td>${s.runs[t][k] == null ? '' : s.runs[t][k]}</td>`).join('')}
      <td><b>${totalRuns(s, t)}</b></td><td>${s.hits[t]}</td><td>${s.errs[t]}</td></tr>`).join('')}</table></div>`;

  // 打擊
  const tot = {}; BAT_COLS.forEach(([k]) => tot[k] = 0);
  let rows = '';
  s.hist.forEach((h, slot) => {
    const seen = [];
    h.forEach(e => {
      const x = seen.find(z => z.pid === e.pid);
      if (x) x.pos.push(...e.pos); else seen.push({ pid: e.pid, role: e.role, pos: e.pos.slice() });
    });
    seen.forEach((x, k) => {
      const b = s.bat[x.pid] || bat({ bat: {} }, x.pid);
      rows += `<tr class="${k ? 'sub' : ''}"><td>${k ? '' : slot + 1}</td><td>${esc(posPath(x.pos))}</td>
        <td class="nm">${esc(P(x.pid).name)}${x.role !== '先發' ? ` <small class="muted">${esc(x.role)}</small>` : ''}</td><td>${esc(P(x.pid).num)}</td>
        ${BAT_COLS.map(([c]) => `<td>${b[c] || ''}</td>`).join('')}<td>${avg(b)}</td></tr>`;
    });
  });
  Object.values(s.bat).forEach(b => BAT_COLS.forEach(([c]) => tot[c] += b[c] || 0));
  const batTbl = `<div class="tblwrap"><table class="tbl"><tr><th>棒次</th><th>守位</th><th class="nm">姓名</th><th>背號</th>${BAT_COLS.map(([, z]) => `<th>${z}</th>`).join('')}<th>打擊率</th></tr>
    ${rows}<tr class="total"><td colspan="4">合計</td>${BAT_COLS.map(([c]) => `<td>${tot[c]}</td>`).join('')}<td>${avg(tot)}</td></tr></table></div>`;

  // 投手
  const pitRows = s.pitOrder.map((pid, i) => {
    const p = s.pit[pid];
    return `<tr><td>${i ? '救援' : '先發'}</td><td class="nm">${esc(pid === '_none' ? '未指定' : P(pid).name)}</td><td>${esc(pid === '_none' ? '' : P(pid).num)}</td>
      <td>${fmtIP(p.outs)}</td><td>${p.BF}</td><td>${p.K}</td><td>${p.BB}</td><td>${p.H}</td><td>${p.HR}</td><td>${p.ER}</td><td>${p.UER}</td>
      <td>${s.decision && s.decision.pid === pid ? DEC_SHORT[s.decision.type] : ''}</td></tr>`;
  }).join('');
  const pitTbl = `<div class="tblwrap"><table class="tbl"><tr><th></th><th class="nm">投手</th><th>背號</th><th>局數</th><th>打者</th><th>三振</th><th>保送</th><th>被安打</th><th>被全壘打</th><th>自責分</th><th>非自責分</th><th>勝敗</th></tr>
    ${pitRows || '<tr><td colspan="12" class="muted">尚無資料</td></tr>'}</table></div>`;

  // 對方打者
  const oppKeys = Object.keys(s.oppBat).map(Number).sort((a, b) => a - b);
  const oppTbl = `<div class="tblwrap"><table class="tbl"><tr><th>棒次</th><th>背號</th><th>打席</th><th>安打</th><th>全壘打</th><th>保送</th><th>三振</th></tr>
    ${oppKeys.map(k => { const o = s.oppBat[k]; return `<tr><td>${k + 1}</td><td>${esc(o.jerseys.join('/'))}</td><td>${o.PA}</td><td>${o.H}</td><td>${o.HR}</td><td>${o.BB}</td><td>${o.K}</td></tr>`; }).join('') || '<tr><td colspan="7" class="muted">尚無資料</td></tr>'}</table></div>`;
  return { line, batTbl, pitTbl, oppTbl };
}

function renderBox() {
  const g = App.game, setup = g.setup, s = App.state;
  const { line, batTbl, pitTbl, oppTbl } = boxTables(setup, s);

  return `<div class="topbar"><button class="back" onclick="goHome()">‹</button><div class="title">紀錄表</div><div id="sync">${syncLabel()}</div></div>
  <div class="page">
    <div class="boxhead"><div class="bh1">${esc(setup.ourTeam)} ${totalRuns(s, 'our')} : ${totalRuns(s, 'opp')} ${esc(setup.opp)}</div>
      <div class="muted small">${esc(setup.date)}　${esc(setup.cup)}　我方${setup.weBatFirst ? '先攻' : '後攻'}　${s.over ? '已結束' : '進行中（' + halfLabel(s) + '）'}</div></div>
    ${s.over ? importPanel(s) : ''}
    ${s.over ? placingPanel() : ''}
    <div class="noprint" style="display:flex;gap:6px;flex-wrap:wrap">
      ${s.over ? '' : `<button class="btn sm" onclick="go('game')">回到比賽</button>`}
      <button class="btn sm" onclick="go('edit')">修正紀錄</button>
      <button class="btn sm" onclick="window.print()">列印</button>
    </div>
    <div class="sec">逐局比分</div>${line}
    <div class="sec">我方打擊 <small>殘壘 ${s.lob}</small></div>${batTbl}
    <div class="sec">我方投手</div>${pitTbl}
    <div class="sec">對方打者</div>${oppTbl}
    <button class="btn red noprint delgame" onclick="deleteGameNow()">刪除這場比賽</button>
  </div>`;
}

/* =========================================================
 * 年度成績：匯入 / 年度表 / 個人頁 / 期初資料
 * ========================================================= */
const f3 = v => v == null ? '-' : v.toFixed(3).replace(/^0/, '');
const f2 = v => v == null ? '-' : v.toFixed(2);
const BAT_SHOW = [['AVG', '打擊率'], ['OBP', '上壘率'], ['SLG', '長打率'], ['OPS', 'OPS'], ['G', '出賽'], ['PA', '打席'], ['AB', '打數'], ['H', '安打'], ['1B', '一安'], ['2B', '二安'], ['3B', '三安'], ['HR', '全壘打'], ['RBI', '打點'], ['R', '得分'], ['BB', '保送'], ['K', '三振']];
const PIT_SHOW = [['G', '出賽'], ['GS', '先發'], ['W', '勝'], ['L', '敗'], ['T', '和'], ['outs', '局數'], ['ERA', '防禦率'], ['BF', '面對打者'], ['K', '三振'], ['BB', '保送'], ['H', '被安打'], ['HR', '被全壘打'], ['ER', '自責分'], ['UER', '非自責分']];
const ASC_KEYS = ['ERA', 'BB', 'H', 'HR', 'ER', 'UER', 'L'];   // 越小越好的欄位預設由小排到大（投手）
function fmtStat(k, v) {
  if (['AVG', 'OBP', 'SLG', 'OPS'].includes(k)) return f3(v);
  if (k === 'ERA') return f2(v);
  if (k === 'outs') return fmtIP(v || 0);
  return v || 0;
}

/* ----- 匯入本次比賽成績 ----- */
function importPanel(s) {
  const g = App.game, sig = eventsSig(g.events);
  const dec = s.decision ? `${DEC_ZH[s.decision.type]}：${esc(P(s.decision.pid).name)}` : '未記錄勝敗投手';
  let act;
  if (g.importStatus === '已匯入' && g.importSig === sig) {
    act = `<span class="tag imp">已匯入年度成績 ✓</span><button class="btn sm" onclick="unimportNow()">取消匯入</button>`;
  } else if (g.importStatus === '已匯入') {
    act = `<span class="tag live">匯入後紀錄已變更</span><button class="btn sm primary" onclick="importNow()">重新匯入</button><button class="btn sm" onclick="unimportNow()">取消匯入</button>`;
  } else {
    act = `<button class="btn primary" onclick="importNow()">匯入本次比賽成績</button>`;
  }
  return `<div class="imppanel noprint"><div class="impdec">${dec} <a onclick="editDecision()">修改</a></div><div class="impact">${act}</div></div>`;
}
function importNow() {
  const g = App.game, s = App.state, setup = g.setup;
  const bad = s.log.filter(l => l.warn.length).length;
  if (bad) {
    openModal({ title: '無法匯入', body: `<p>事件列表中有 ${bad} 筆紀錄有問題（紅框），請先修正再匯入。</p>`, buttons: [{ label: '關閉' }, { label: '前往修正', cls: 'primary', onClick: () => go('edit') }] });
    return;
  }
  const season = seasonOf(setup.date);
  if (season == null) return toast('比賽日期格式有誤，無法判斷年度');
  const rows = gameStatRows(setup, s), sig = eventsSig(g.events);
  const batTbl = `<table class="tbl"><tr><th class="nm">打者</th><th>打席</th><th>打數</th><th>安打</th><th>HR</th><th>保送</th><th>得分</th><th>打點</th></tr>
    ${rows.bat.map(r => `<tr><td class="nm">${esc(r.name)}</td><td>${r.PA}</td><td>${r.AB}</td><td>${r.H}</td><td>${r.HR}</td><td>${r.BB}</td><td>${r.R}</td><td>${r.RBI}</td></tr>`).join('')}</table>`;
  const pitTbl = rows.pit.length ? `<table class="tbl" style="margin-top:8px"><tr><th class="nm">投手</th><th>局數</th><th>三振</th><th>保送</th><th>被安打</th><th>自責分</th><th>勝敗</th></tr>
    ${rows.pit.map(r => `<tr><td class="nm">${esc(r.name)}</td><td>${fmtIP(r.outs)}</td><td>${r.K}</td><td>${r.BB}</td><td>${r.H}</td><td>${r.ER}</td><td>${r.W ? '勝' : r.L ? '敗' : r.T ? '和' : ''}</td></tr>`).join('')}</table>` : '';
  openModal({
    title: '匯入本次比賽成績',
    body: `<p class="small">將加入 <b>${seasonLabel(season)}</b><br>${esc(setup.date)} vs ${esc(setup.opp)}</p><div class="tblwrap">${batTbl}</div>${pitTbl ? `<div class="tblwrap">${pitTbl}</div>` : ''}`,
    buttons: [{ label: '取消' }, {
      label: g.importStatus === '已匯入' ? '確認重新匯入' : '確認匯入', cls: 'primary', onClick: () => {
        toast('匯入中…');
        gs('importGame', setup.gameId, { season, date: setup.date, opp: setup.opp, bat: rows.bat, pit: rows.pit, sig })
          .then(() => { g.importStatus = '已匯入'; g.importSig = sig; toast('已匯入年度成績'); if (App.view === 'box') render(); })
          .catch(e => toast('匯入失敗：' + e.message));
      }
    }]
  });
}
function unimportNow() {
  const g = App.game;
  confirmModal('取消匯入', '這場比賽的成績會從年度成績中移除，確定？', '取消匯入', () => {
    gs('unimportGame', g.setup.gameId)
      .then(() => { g.importStatus = ''; g.importSig = ''; toast('已取消匯入'); if (App.view === 'box') render(); })
      .catch(e => toast('操作失敗：' + e.message));
  });
}

/* ----- 共用：載入年度資料 ----- */
App.sv = { season: currentSeason(), tab: 'bat', sort: null, desc: true, minPA: 0 };
async function loadSeason(season) {
  await swr('ss:' + season, 'getSeasonStats', [season], d => { d.season = season; App.sdata = d; }, ['season', 'player', 'opening']);
}
function seasonOptions(sel, past) {
  const set = new Set([currentSeason(), sel, ...((App.sdata && App.sdata.seasons) || [])]);
  for (let i = 1; i <= (past || 0); i++) set.add(currentSeason() - i);
  return [...set].sort((a, b) => b - a).map(y => `<option value="${y}" ${y === sel ? 'selected' : ''}>${seasonLabel(y)}</option>`).join('');
}
function tabs(cur, fn) {
  return `<div class="seg tabs"><button class="${cur === 'bat' ? 'on' : ''}" onclick="${fn}('bat')">打擊</button><button class="${cur === 'pit' ? 'on' : ''}" onclick="${fn}('pit')">投手</button></div>`;
}

/* ----- 年度成績頁 ----- */
async function goSeason(season) {
  App.game = null; App.edit = null; App.sv.mode = 'season';
  if (season) App.sv.season = season;
  if (!cacheGet('ss:' + App.sv.season)) $('#app').innerHTML = '<div class="loading">載入中…</div>';
  try { await loadSeason(App.sv.season); } catch (e) { toast('載入失敗：' + e.message); return go('home'); }
  go('season');
}
function svTab(t) { App.sv.tab = t; App.sv.sort = null; render(); }
function svSort(k) {
  const v = App.sv;
  if (v.sort === k) v.desc = !v.desc; else { v.sort = k; v.desc = !(k === 'NUM' || (v.tab === 'pit' && ASC_KEYS.includes(k))); }
  render();
}
function seasonTotals() {
  const d = App.sv.mode === 'career' ? App.cdata : App.sdata;
  return {
    bat: aggregate(d.bat, BAT_KEYS).map(batDerived),
    pit: aggregate(d.pit, PIT_KEYS).map(pitDerived)
  };
}
function renderSeason() {
  const v = App.sv, t = seasonTotals(), isBat = v.tab === 'bat';
  const cols = isBat ? [['NUM', '背號']].concat(BAT_SHOW) : PIT_SHOW;
  let rows = isBat ? t.bat.filter(a => a.PA >= (v.minPA || 0)) : t.pit;
  // 背號以數字排序；沒有背號的排在最後
  rows.forEach(a => { const n = parseInt((App.bootMap[a.pid] || {}).num, 10); a.NUM = isNaN(n) ? null : n; });
  const key = v.sort || (isBat ? 'AVG' : 'ERA');
  const desc = v.sort ? v.desc : isBat;
  rows = rows.slice().sort((a, b) => {
    const x = a[key], y = b[key];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return desc ? y - x : x - y;
  });
  const num = pid => App.bootMap[pid] ? '#' + App.bootMap[pid].num : '';
  const table = rows.length ? `<div class="tblwrap"><table class="tbl stat">
      <tr><th class="nm stick">選手</th>${cols.map(([k, z]) => `<th class="sortable ${k === key ? 'sorted' : ''}" onclick="svSort('${k}')">${z}${k === key ? (desc ? '▼' : '▲') : ''}</th>`).join('')}</tr>
      ${rows.map(a => `<tr onclick="goPlayer(${J(a.pid)})"><td class="nm stick">${esc(a.name)}${isBat ? '' : ` <small class="muted">${esc(num(a.pid))}</small>`}</td>${cols.map(([k]) => `<td>${k === 'NUM' ? esc((App.bootMap[a.pid] || {}).num || '') : fmtStat(k, a[k])}</td>`).join('')}</tr>`).join('')}
    </table></div>` : `<p class="muted">${v.mode === 'career' ? '還沒有任何成績資料。' : '這個年度還沒有資料。可以到「年度原始數據」輸入，或在比賽紀錄表按「匯入本次比賽成績」。'}</p>`;
  const career = v.mode === 'career';
  return `<div class="topbar"><button class="back" onclick="goHome()">‹</button><div class="title">${career ? '選手總成績' : '選手年度成績'}</div></div>
  <div class="page">
    ${career ? '<div class="muted small careernote">歷年所有年度加總（含年度原始數據、比賽匯入、手動補登）</div>' : `<select class="ysel" onchange="goSeason(+this.value)">${seasonOptions(v.season)}</select>`}
    <div class="row2">${tabs(v.tab, 'svTab')}
      ${isBat ? `<label class="minpa">最低打席 <input type="number" min="0" value="${v.minPA || 0}" onchange="App.sv.minPA=+this.value||0;render()"></label>` : ''}</div>
    ${table}
    <p class="muted small">點欄位標題排序，點選手看明細。防禦率以 7 局換算。</p>
  </div>`;
}

/* ----- 個人頁 ----- */
function goPlayer(pid) { App.pv = pid; go('player'); }
function renderPlayer() {
  if (App.sv.mode === 'career') return renderCareerPlayer();
  const pid = App.pv, d = App.sdata;
  const bRows = d.bat.filter(r => r.pid === pid), pRows = d.pit.filter(r => r.pid === pid);
  const sortRows = arr => arr.slice().sort((a, b) => (a.source === '期初' ? -1 : b.source === '期初' ? 1 : a.date < b.date ? -1 : 1));
  const name = (bRows[0] || pRows[0] || {}).name || (App.bootMap[pid] || {}).name || '?';
  const label = r => r.source === '期初' ? '<b>期初</b>' : `${esc(r.date.slice(5))} vs ${esc(r.opp)}${r.source === '手動' ? ' <span class="tag manual">手動</span>' : ''}`;
  const click = r => !r.gameId ? '' : r.source === '手動' ? ` class="click" onclick="editManual(${J(r.gameId)})"` : ` class="click" onclick="openGame(${J(r.gameId)})"`;
  let html = `<div class="topbar"><button class="back" onclick="go('season')">‹</button><div class="title">${esc(name)} ${App.bootMap[pid] ? '#' + esc(App.bootMap[pid].num) : ''}</div></div>
  <div class="page"><div class="muted small">${seasonLabel(d.season)}</div>`;
  if (bRows.length) {
    const tot = batDerived(aggregate(bRows, BAT_KEYS)[0]);
    const dc = [['PA', '打席'], ['AB', '打數'], ['H', '安打'], ['1B', '一安'], ['2B', '二安'], ['3B', '三安'], ['HR', '全壘打'], ['RBI', '打點'], ['R', '得分'], ['BB', '保送'], ['K', '三振']];
    html += `<div class="sec">打擊</div><div class="kpis">${[['AVG', '打擊率'], ['OBP', '上壘率'], ['SLG', '長打率'], ['OPS', 'OPS'], ['HR', '全壘打'], ['RBI', '打點']].map(([k, z]) => `<div class="kpi"><b>${fmtStat(k, tot[k])}</b><span>${z}</span></div>`).join('')}</div>
      <div class="tblwrap"><table class="tbl"><tr><th class="nm">場次</th>${dc.map(([, z]) => `<th>${z}</th>`).join('')}</tr>
      ${sortRows(bRows).map(r => `<tr${click(r)}><td class="nm">${label(r)}</td>${dc.map(([k]) => `<td>${r[k]}</td>`).join('')}</tr>`).join('')}
      <tr class="total"><td class="nm">合計（${tot.G} 場）</td>${dc.map(([k]) => `<td>${tot[k]}</td>`).join('')}</tr></table></div>`;
  }
  if (pRows.length) {
    const tot = pitDerived(aggregate(pRows, PIT_KEYS)[0]);
    const dc = [['outs', '局數'], ['BF', '打者'], ['K', '三振'], ['BB', '保送'], ['H', '被安打'], ['HR', '被全壘打'], ['ER', '自責分'], ['UER', '非自責分']];
    const wl = r => [r.W ? r.W + '勝' : '', r.L ? r.L + '敗' : '', r.T ? r.T + '和' : ''].join(' ').trim();
    html += `<div class="sec">投手</div><div class="kpis">${[['ERA', '防禦率'], ['outs', '局數'], ['K', '三振'], ['W', '勝'], ['L', '敗'], ['T', '和']].map(([k, z]) => `<div class="kpi"><b>${fmtStat(k, tot[k])}</b><span>${z}</span></div>`).join('')}</div>
      <div class="tblwrap"><table class="tbl"><tr><th class="nm">場次</th>${dc.map(([, z]) => `<th>${z}</th>`).join('')}<th>勝敗</th></tr>
      ${sortRows(pRows).map(r => `<tr${click(r)}><td class="nm">${label(r)}</td>${dc.map(([k]) => `<td>${fmtStat(k, r[k])}</td>`).join('')}<td>${wl(r)}</td></tr>`).join('')}
      <tr class="total"><td class="nm">合計（${tot.G} 場）</td>${dc.map(([k]) => `<td>${fmtStat(k, tot[k])}</td>`).join('')}<td>${wl(tot)}</td></tr></table></div>`;
  }
  if (!bRows.length && !pRows.length) html += '<p class="muted">這個年度沒有資料</p>';
  return html + `<p class="muted small">點比賽列可回到該場紀錄表。</p></div>`;
}

/* ----- 期初資料 ----- */
App.ov = { season: currentSeason(), tab: 'bat' };
const OPEN_BAT = [['G', '出賽'], ['PA', '打席'], ['AB', '打數'], ['1B', '一安'], ['2B', '二安'], ['3B', '三安'], ['HR', '全壘打'], ['BB', '保送'], ['K', '三振'], ['R', '得分'], ['RBI', '打點'], ['SF', '犧飛'], ['AO', '高飛'], ['GO', '滾地'], ['DP', '雙殺打'], ['FC', '野選'], ['ROE', '失誤上壘']];
const OPEN_PIT = [['G', '出賽'], ['GS', '先發'], ['IP', '局數'], ['BF', '面對打者'], ['K', '三振'], ['BB', '保送'], ['H', '被安打'], ['HR', '被全壘打'], ['ER', '自責分'], ['UER', '非自責分'], ['W', '勝'], ['L', '敗'], ['T', '和']];
async function goOpening(season) {
  App.game = null; App.edit = null;
  if (season) App.ov.season = season;
  if (!cacheGet('ss:' + App.ov.season)) $('#app').innerHTML = '<div class="loading">載入中…</div>';
  try {
    await Promise.all([loadSeason(App.ov.season), swr('th', 'getTeamHistory', [], d => { App.thist = d; }, 'opening')]);
  } catch (e) { toast('載入失敗：' + e.message); return go('home'); }
  go('opening');
}
function ovTab(t) { App.ov.tab = t; render(); }
function openingRow(kind, pid) {
  return (App.sdata[kind] || []).find(r => r.source === '期初' && r.pid === pid);
}
function renderOpening() {
  const v = App.ov, kind = v.tab;
  const tabs3 = `<div class="seg tabs">${[['bat', '打擊'], ['pit', '投手'], ['team', '球隊']].map(([k, z]) => `<button class="${kind === k ? 'on' : ''}" onclick="ovTab('${k}')">${z}</button>`).join('')}</div>`;
  if (kind === 'team') {
    return `<div class="topbar"><button class="back" onclick="goHome()">‹</button><div class="title">年度原始數據</div></div>
  <div class="page"><div class="row2">${tabs3}</div>${renderOpeningTeam()}</div>`;
  }
  const pids = App.boot.players.map(p => p.pid);
  (App.sdata[kind] || []).forEach(r => { if (r.source === '期初' && !pids.includes(r.pid)) pids.push(r.pid); });
  const nm = pid => (App.bootMap[pid] || {}).name || ((openingRow(kind, pid) || {}).name) || '?';
  const summary = pid => {
    const r = openingRow(kind, pid);
    if (!r) return '<span class="muted">未填</span>';
    return kind === 'bat'
      ? `${r.G} 場・${r.PA} 打席・${r.H} 安打・打擊率 ${f3(r.AB ? r.H / r.AB : null)}`
      : `${r.G} 場・${fmtIP(r.outs)} 局・${r.K} 三振・${r.W}勝${r.L}敗`;
  };
  return `<div class="topbar"><button class="back" onclick="goHome()">‹</button><div class="title">年度原始數據</div></div>
  <div class="page">
    <select class="ysel" onchange="goOpening(+this.value)">${seasonOptions(v.season, 10)}</select>
    <div class="row2">${tabs3}</div>
    <p class="muted small">輸入使用本系統前已累積的成績，會與匯入的比賽成績一起加總。每位選手每年度一筆，全部填 0 即刪除。</p>
    <div class="oplist">${pids.map(pid => `<div class="oprow" onclick="editOpening(${J(pid)})"><div><b>${esc(nm(pid))}</b> <small class="muted">${App.bootMap[pid] ? '#' + esc(App.bootMap[pid].num) : ''}</small><div class="small">${summary(pid)}</div></div><span class="muted">›</span></div>`).join('')}</div>
  </div>`;
}
function editOpening(pid) {
  const v = App.ov, kind = v.tab, r = openingRow(kind, pid) || {};
  const name = (App.bootMap[pid] || {}).name || r.name || '?';
  const fields = kind === 'bat' ? OPEN_BAT : OPEN_PIT;
  const val = k => k === 'IP' ? (r.outs ? fmtIP(r.outs) : '') : (r[k] || '');
  openModal({
    title: `${name}｜${v.season} 年度期初${kind === 'bat' ? '打擊' : '投手'}`,
    body: `<div class="opgrid">${fields.map(([k, z]) => `<label>${z}<input id="op_${k}" ${k === 'IP' ? 'inputmode="decimal" placeholder="例 12.2"' : 'type="number" inputmode="numeric" min="0"'} value="${esc(val(k))}"></label>`).join('')}</div>
      ${kind === 'bat' ? '<p class="muted small">安打 = 一安 + 二安 + 三安 + 全壘打，自動計算</p>' : '<p class="muted small">局數格式：12.2 代表 12 又 2/3 局</p>'}
      <div id="opErr" class="errbox"></div>`,
    buttons: [{ label: '取消' }, {
      label: '儲存', cls: 'primary', onClick: () => {
        const stats = {};
        for (const [k] of fields) {
          const raw = $('#op_' + k).value.trim();
          if (k === 'IP') {
            if (raw && !/^\d+(\.[012])?$/.test(raw)) { $('#opErr').textContent = '局數格式錯誤，小數只能是 .0 .1 .2'; return false; }
            const [a, b] = (raw || '0').split('.');
            stats.outs = (+a) * 3 + (+(b || 0));
          } else stats[k] = Math.max(0, parseInt(raw, 10) || 0);
        }
        if (kind === 'bat') {
          stats.H = stats['1B'] + stats['2B'] + stats['3B'] + stats.HR;
          if (stats.H > stats.AB) { $('#opErr').textContent = '安打數不能大於打數'; return false; }
          if (stats.AB > stats.PA) { $('#opErr').textContent = '打數不能大於打席'; return false; }
        }
        toast('儲存中…');
        gs('saveOpening', v.season, kind, pid, name, stats).then(() => {
          const list = App.sdata[kind];
          const i = list.findIndex(x => x.source === '期初' && x.pid === pid);
          if (i >= 0) list.splice(i, 1);
          const keys = kind === 'bat' ? BAT_KEYS : PIT_KEYS;
          if (keys.some(k => stats[k])) list.push(Object.assign({ season: v.season, source: '期初', gameId: '', date: '', opp: '', pid, name }, stats));
          cacheSet('ss:' + v.season, App.sdata);
          toast('已儲存');
          if (App.view === 'opening') render();
        }).catch(e => toast('儲存失敗：' + e.message));
      }
    }]
  });
}

/* =========================================================
 * 手動輸入資料（依紙本紀錄表補登整場成績）
 * ========================================================= */
// 欄位順序與紙本紀錄表相同
const MAN_BAT = [['PA', '打席'], ['AB', '打數'], ['1B', '1B'], ['2B', '2B'], ['3B', '3B'], ['HR', 'HR'], ['BB', '保送'], ['R', '得分'], ['RBI', '打點'], ['SF', '高飛犧牲打'], ['AO', '高飛接殺'], ['K', '三振'], ['GO', '滾地封殺'], ['DP', '雙殺打'], ['FC', '野手選擇'], ['ROE', '失誤上壘']];
const MAN_PIT = [['IP', '局數'], ['K', '三振'], ['BB', '保送'], ['H', '被安打'], ['ER', '自責分'], ['UER', '非自責分']];

async function goManual() {
  App.game = null; App.edit = null;
  if (!cacheGet('manual')) $('#app').innerHTML = '<div class="loading">載入中…</div>';
  try { await swr('manual', 'listManual', [], d => { App.mlist = d; }, 'manual'); } catch (e) { toast('載入失敗：' + e.message); return go('home'); }
  go('manual');
}
function renderManualList() {
  const l = App.mlist || [];
  return `<div class="topbar"><button class="back" onclick="goHome()">‹</button><div class="title">手動補登資料</div></div>
  <div class="page">
    <button class="btn primary big" onclick="newManual()">＋ 新增補登場次</button>
    <p class="muted small">依紙本紀錄表輸入整場成績，儲存後直接計入年度成績。<br>已在系統記錄並匯入的比賽，請勿再手動補登，以免重複計算。</p>
    <div class="sec">已補登場次</div>
    ${l.length ? l.map(g => `<div class="gitem" onclick="editManual(${J(g.gameId)})">
        <div><div class="gt">${esc(g.date)} ${esc(g.cup)}</div><div class="gs">vs ${esc(g.opp)}${g.our !== '' && g.oppScore !== '' ? `　<b>${g.our} : ${g.oppScore}</b>` : ''} ${placingBadge(g.placing)}</div></div>
        <div class="gr"><span class="tag manual">${g.season} 年度</span></div></div>`).join('') : '<p class="muted">尚無補登資料</p>'}
  </div>`;
}
function newManual() {
  App.me = { gameId: '', date: today(), cup: '', opp: '', first: true, bat: [], pit: [], our: '', oppScore: '', placing: '', line: { our: range(7).map(() => ''), opp: range(7).map(() => '') } };
  go('manualEdit');
}
async function editManual(id) {
  App.game = null;
  $('#app').innerHTML = '<div class="loading">載入中…</div>';
  let g;
  try { g = await gs('getManual', id); } catch (e) { toast('載入失敗：' + e.message); return goManual(); }
  App.me = {
    gameId: g.gameId, date: g.date, cup: g.cup, opp: g.opp, first: !(g.line && g.line.weBatFirst === false),
    our: g.our === '' ? '' : String(g.our), oppScore: g.oppScore === '' ? '' : String(g.oppScore), placing: g.placing || '',
    line: { our: range(7).map(k => g.line && g.line.our && g.line.our[k] != null ? String(g.line.our[k]) : ''), opp: range(7).map(k => g.line && g.line.opp && g.line.opp[k] != null ? String(g.line.opp[k]) : '') },
    bat: g.bat.map(r => { const o = { pid: r.pid, name: r.name }; MAN_BAT.forEach(([k]) => o[k] = r[k] || ''); return o; }),
    pit: g.pit.map(r => ({ pid: r.pid, name: r.name, role: r.GS ? '先發' : '救援', IP: r.outs ? fmtIP(r.outs) : '', K: r.K || '', BB: r.BB || '', H: r.H || '', ER: r.ER || '', UER: r.UER || '', dec: r.W ? 'W' : r.L ? 'L' : r.T ? 'T' : '' }))
  };
  go('manualEdit');
}
const meName = r => (App.bootMap[r.pid] || {}).name || r.name || '?';
const meNum = r => (App.bootMap[r.pid] || {}).num || '';
const num = v => Math.max(0, parseInt(v, 10) || 0);
function meHits(r) { return num(r['1B']) + num(r['2B']) + num(r['3B']) + num(r.HR); }

function renderManualEdit() {
  const m = App.me;
  const batRows = m.bat.map((r, i) => `<div class="mrow">
      <div class="mname"><button class="x" onclick="meDel('bat',${i})">✕</button><div><b>${esc(meName(r))}</b> <small class="muted">#${esc(meNum(r))}</small><div class="small muted">安打 <span id="mh${i}">${meHits(r)}</span></div></div></div>
      <div class="mfields bat">${MAN_BAT.map(([k, z]) => `<label><span>${z}</span><input class="mi" type="number" inputmode="numeric" min="0" value="${esc(r[k])}" oninput="meSet('bat',${i},'${k}',this.value)" onkeydown="meKey(event)"></label>`).join('')}</div>
    </div>`).join('');
  const pitRows = m.pit.map((r, i) => `<div class="mrow">
      <div class="mname"><button class="x" onclick="meDel('pit',${i})">✕</button><div><b>${esc(meName(r))}</b> <small class="muted">#${esc(meNum(r))}</small></div></div>
      <div class="mfields pit">
        <label><span>先發/救援</span><select onchange="meSet('pit',${i},'role',this.value)">${['先發', '救援'].map(v => `<option ${r.role === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        ${MAN_PIT.map(([k, z]) => `<label><span>${z}</span><input class="mi" ${k === 'IP' ? 'inputmode="decimal" placeholder="例 3.2"' : 'type="number" inputmode="numeric" min="0"'} value="${esc(r[k])}" oninput="meSet('pit',${i},'${k}',this.value)" onkeydown="meKey(event)"></label>`).join('')}
        <label><span>勝敗</span><select onchange="meSet('pit',${i},'dec',this.value)">${[['', '—'], ['W', '勝'], ['L', '敗'], ['T', '和']].map(([v, z]) => `<option value="${v}" ${r.dec === v ? 'selected' : ''}>${z}</option>`).join('')}</select></label>
      </div></div>`).join('');
  return `<div class="topbar"><button class="back" onclick="goManual()">‹</button><div class="title">${m.gameId ? '修改補登' : '新增補登'}</div></div>
  <div class="page">
    <div class="form mform">
      <label>日期<input type="date" value="${esc(m.date)}" onchange="App.me.date=this.value;render()"></label>
      <label>賽事<input value="${esc(m.cup)}" oninput="App.me.cup=this.value"></label>
      <label>對手<input value="${esc(m.opp)}" oninput="App.me.opp=this.value"></label>
    </div>
    <div class="muted small">${seasonOf(m.date) != null ? '計入 ' + seasonLabel(seasonOf(m.date)) : '請選擇日期'}</div>

    <div class="sec">比分 <small>填逐局得分會自動加總，總分也可以直接修改</small></div>
    <div class="row2"><span>我方</span><div class="seg">
      <button class=\"${m.first ? 'on' : ''}\" onclick=\"App.me.first=true;render()\">先攻</button>
      <button class=\"${!m.first ? 'on' : ''}\" onclick=\"App.me.first=false;render()\">後攻</button></div></div>
    <div class="tblwrap"><table class="tbl lsin"><tr><th class="tn"></th>${range(7).map(k => `<th>${k + 1}</th>`).join('')}<th>總分</th></tr>
      ${(m.first ? [['our', App.boot.ourTeam, 'our'], ['opp', m.opp || '對手', 'oppScore']] : [['opp', m.opp || '對手', 'oppScore'], ['our', App.boot.ourTeam, 'our']]).map(([t, n, tk]) => `<tr><td class="tn">${esc(n)}</td>
        ${range(7).map(k => `<td><input class="mi" type="number" inputmode="numeric" min="0" value="${esc(m.line[t][k])}" oninput="meLine('${t}',${k},this.value)" onkeydown="meKey(event)"></td>`).join('')}
        <td><input id="mt_${t}" class="mi tot" type="number" inputmode="numeric" min="0" value="${esc(m[tk])}" oninput="App.me.${tk}=this.value" onkeydown="meKey(event)"></td></tr>`).join('')}
    </table></div>
    <div class="row2"><span>盃賽成績</span><div class="seg">${[''].concat(PLACINGS).map(p => `<button class="${m.placing === p ? 'on' : ''}" onclick="App.me.placing=${J(p)};render()">${p ? PLACE_IC[p] + ' ' + p : '無'}</button>`).join('')}</div></div>

    <div class="sec">打者成績 <small>按 Enter 跳下一格</small></div>
    <div class="mhead bat"><span></span><div class="mfields bat">${MAN_BAT.map(([, z]) => `<span>${z}</span>`).join('')}</div></div>
    ${batRows || '<p class="muted small">尚未加入打者</p>'}
    <button class="btn ghost" onclick="meAdd('bat')">＋ 新增打者</button>

    <div class="sec">投手成績</div>
    <div class="mhead pit"><span></span><div class="mfields pit"><span>先發/救援</span>${MAN_PIT.map(([, z]) => `<span>${z}</span>`).join('')}<span>勝敗</span></div></div>
    ${pitRows || '<p class="muted small">尚未加入投手</p>'}
    <button class="btn ghost" onclick="meAdd('pit')">＋ 新增投手</button>

    <div id="meErr" class="errbox"></div>
    <button class="btn primary big" id="meSave" onclick="meSave()">儲存</button>
    ${m.gameId ? '<button class="btn red" onclick="meDelete()">刪除這場補登</button>' : ''}
  </div>`;
}
function meLine(t, k, v) {
  const m = App.me;
  m.line[t][k] = v;
  if (m.line[t].some(x => String(x).trim() !== '')) {
    const tk = t === 'our' ? 'our' : 'oppScore';
    m[tk] = String(m.line[t].reduce((a, x) => a + (parseInt(x, 10) || 0), 0));
    const el = $('#mt_' + t); if (el) el.value = m[tk];
  }
}
function meSet(kind, i, k, v) {
  App.me[kind][i][k] = v;
  if (kind === 'bat' && ['1B', '2B', '3B', 'HR'].includes(k)) { const el = $('#mh' + i); if (el) el.textContent = meHits(App.me.bat[i]); }
}
function meKey(e) {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const all = [...document.querySelectorAll('.mi')], i = all.indexOf(e.target);
  if (all[i + 1]) { all[i + 1].focus(); all[i + 1].select && all[i + 1].select(); } else e.target.blur();
}
function meDel(kind, i) { App.me[kind].splice(i, 1); render(); }
function meAdd(kind) {
  const used = new Set(App.me[kind].map(r => r.pid));
  pickPlayer(kind === 'bat' ? '新增打者' : '新增投手', App.boot.players.map(p => p.pid).filter(pid => !used.has(pid)), pid => {
    const r = { pid, name: P(pid).name };
    if (kind === 'bat') MAN_BAT.forEach(([k]) => r[k] = '');
    else Object.assign(r, { role: App.me.pit.length ? '救援' : '先發', IP: '', K: '', BB: '', H: '', ER: '', UER: '', dec: '' });
    App.me[kind].push(r);
    render();
  });
}
function meSave() {
  const m = App.me, err = t => { $('#meErr').textContent = t; };
  const season = seasonOf(m.date);
  if (season == null) return err('請選擇日期');
  if (!m.opp.trim()) return err('請輸入對手');
  if (!m.bat.length && !m.pit.length) return err('請至少輸入一位打者或投手');

  const bat = m.bat.map(r => {
    const o = { pid: r.pid, name: meName(r), G: 1 };
    MAN_BAT.forEach(([k]) => o[k] = num(r[k]));
    o.H = meHits(r);
    return o;
  });
  const pit = [];
  for (const r of m.pit) {
    const ip = String(r.IP || '').trim();
    if (ip && !/^\d+(\.[012])?$/.test(ip)) return err(`${meName(r)} 的局數格式錯誤，小數只能是 .0 .1 .2`);
    const [a, b] = (ip || '0').split('.');
    pit.push({ pid: r.pid, name: meName(r), G: 1, GS: r.role === '先發' ? 1 : 0, outs: (+a) * 3 + (+(b || 0)), BF: 0,
      K: num(r.K), BB: num(r.BB), H: num(r.H), HR: 0, ER: num(r.ER), UER: num(r.UER), W: r.dec === 'W' ? 1 : 0, L: r.dec === 'L' ? 1 : 0, T: r.dec === 'T' ? 1 : 0 });
  }

  // 只提醒、不阻擋
  const warns = [];
  if ((String(m.our).trim() === '') !== (String(m.oppScore).trim() === '')) warns.push('比分只填了一邊，這場不會計入球隊勝敗');
  bat.forEach(o => {
    if (o.AB > o.PA) warns.push(`${o.name}：打數 ${o.AB} 大於打席 ${o.PA}`);
    else if (o.AB + o.BB + o.SF !== o.PA) warns.push(`${o.name}：打數＋保送＋犧飛＝${o.AB + o.BB + o.SF}，與打席 ${o.PA} 不同`);
    if (o.H > o.AB) warns.push(`${o.name}：安打 ${o.H} 大於打數 ${o.AB}`);
  });
  const doSave = () => {
    const btn = $('#meSave'); if (btn) { btn.disabled = true; btn.textContent = '儲存中…'; }
    const cellv = v => String(v).trim() === '' ? null : num(v);
    const line = { our: m.line.our.map(cellv), opp: m.line.opp.map(cellv) };
    const hasLine = line.our.concat(line.opp).some(v => v != null);
    gs('saveManual', { gameId: m.gameId, date: m.date, cup: m.cup.trim(), opp: m.opp.trim(), season,
      our: String(m.our).trim() === '' ? '' : num(m.our), oppScore: String(m.oppScore).trim() === '' ? '' : num(m.oppScore),
      line: Object.assign(hasLine ? line : { our: [], opp: [] }, { weBatFirst: !!m.first }), placing: m.placing }, bat, pit)
      .then(() => { toast('已儲存並計入年度成績'); goManual(); })
      .catch(e => { if (btn) { btn.disabled = false; btn.textContent = '儲存'; } err('儲存失敗：' + e.message); });
  };
  if (warns.length) {
    openModal({ title: '數字有出入，仍要儲存？', body: `<ul class="small">${warns.map(w => `<li>${esc(w)}</li>`).join('')}</ul>`, buttons: [{ label: '回去修改' }, { label: '仍要儲存', cls: 'primary', onClick: doSave }] });
  } else doSave();
}
function meDelete() {
  const m = App.me;
  confirmModal('刪除補登', `${m.date} vs ${m.opp} 的補登成績會從年度成績中移除，確定？`, '刪除', () => {
    gs('deleteManual', m.gameId).then(() => { toast('已刪除'); goManual(); }).catch(e => toast('刪除失敗：' + e.message));
  });
}

/* =========================================================
 * 盃賽成績 / 刪除比賽
 * ========================================================= */
const PLACINGS = ['冠軍', '亞軍', '季軍'];
const PLACE_IC = { '冠軍': '🏆', '亞軍': '🥈', '季軍': '🥉' };
function placingBadge(p) { return p ? `<span class="tag place">${PLACE_IC[p] || ''}${esc(p)}</span>` : ''; }
function placingPanel() {
  const cur = App.game.placing || '';
  return `<div class="imppanel noprint plpanel"><span>盃賽成績</span>
    <div class="seg">${[''].concat(PLACINGS).map(p => `<button class="${cur === p ? 'on' : ''}" onclick="setPlacingNow(${J(p)})">${p ? PLACE_IC[p] + ' ' + p : '無'}</button>`).join('')}</div></div>`;
}
function setPlacingNow(p) {
  const g = App.game, prev = g.placing || '';
  if (p === prev) return;
  g.placing = p; render();
  gs('setPlacing', g.setup.gameId, p).then(() => toast(p ? '已標記為' + p : '已清除盃賽成績'))
    .catch(e => { g.placing = prev; render(); toast('儲存失敗：' + e.message); });
}
function deleteGameNow() {
  const g = App.game, s = App.state, setup = g.setup, id = setup.gameId;
  const imported = g.importStatus === '已匯入';
  openModal({
    title: '刪除這場比賽',
    body: `<p><b>${esc(setup.date)} vs ${esc(setup.opp)}</b>（${totalRuns(s, 'our')} : ${totalRuns(s, 'opp')}）</p>
      <p class="small">比賽紀錄會全部刪除，無法復原。</p>
      ${imported ? '<p class="small red"><b>這場已匯入年度成績，匯入的成績也會一起移除。</b></p>' : ''}
      <div class="form"><label>刪除密碼<input id="delpin" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></label></div>`,
    buttons: [{ label: '取消' }, {
      label: '確定刪除', cls: 'primary dangerbtn', onClick: () => {
        App.deleted = App.deleted || {}; App.deleted[id] = true;
        const pin = ($('#delpin') || {}).value || '';
        toast('刪除中…');
        gs('deleteGame', id, pin).then(() => {
          [qKey(id), evKey(id), setupKey(id)].forEach(lsDel); delete App.q[id];
          toast('已刪除'); goHome();
        }).catch(e => {
          delete App.deleted[id];
          if (String(e.message).indexOf('PIN') >= 0) { toast('刪除密碼錯誤'); deleteGameNow(); }
          else toast('刪除失敗：' + e.message);
        });
      }
    }]
  });
}

/* =========================================================
 * 球隊年度成績
 * ========================================================= */
App.tv = { season: currentSeason(), open: {} };
async function goTeam(season) {
  App.game = null; App.edit = null;
  if (season) { App.tv.season = season; App.tv.open = {}; }
  const y = App.tv.season;
  if (!cacheGet('ts:' + y)) $('#app').innerHTML = '<div class="loading">載入中…</div>';
  try {
    await swr('ts:' + y, 'getTeamSeason', [y], d => {
      const backfill = [];
      App.tdata = { season: y, seasons: d.seasons, hist: d.hist || null, games: d.games.map(g => teamGame(g, backfill)).filter(Boolean) };
      // 舊比賽沒有摘要：算好後回存，下次就不用再讀事件
      if (backfill.length) gs('saveSummaries', backfill).catch(() => { });
    }, 'team');
  } catch (e) { toast('載入失敗：' + e.message); return go('home'); }
  go('team');
}
/** 把系統比賽 / 手動補登整理成同一種格式 */
function teamGame(g, backfill) {
  const sum = a => (a || []).reduce((x, y) => x + (Number(y) || 0), 0);
  if (g.kind === 'game') {
    let m = g.summary, setup = null, s = null;
    if (!m) {
      if (!g.setup) return null;
      setup = g.setup; s = replay(setup, g.events || []);
      m = gameSummary(setup, s);
      if (backfill) backfill.push({ gameId: g.gameId, summary: m });
    }
    const row = t => ({ name: t === 'our' ? m.ourTeam : (m.opp || g.opp), runs: m.line[t], R: m.R[t], H: m.H[t], E: m.E[t] });
    return {
      kind: 'game', id: g.gameId, date: g.date, cup: g.cup, opp: g.opp, placing: g.placing,
      over: m.over, our: m.R.our, oppR: m.R.opp, inn: m.inn, label: m.label,
      rows: m.weBatFirst ? [row('our'), row('opp')] : [row('opp'), row('our')],
      setup, s
    };
  }
  const has = g.our !== '' && g.oppScore !== '';
  const line = g.line || { our: [], opp: [] };
  const inn = Math.max(7, (line.our || []).length, (line.opp || []).length);
  const cell = v => v === '' || v == null ? null : Number(v);
  return {
    kind: 'manual', id: g.gameId, date: g.date, cup: g.cup, opp: g.opp, placing: g.placing,
    over: has, our: has ? Number(g.our) : null, oppR: has ? Number(g.oppScore) : null, inn, label: has ? '' : '未填比分',
    rows: (line.weBatFirst === false ? (a, b) => [b, a] : (a, b) => [a, b])(
      { name: App.boot.ourTeam, runs: range(inn).map(k => cell((line.our || [])[k])), R: has ? Number(g.our) : '', H: sum(g.bat.map(r => r.H)), E: '-' },
      { name: g.opp, runs: range(inn).map(k => cell((line.opp || [])[k])), R: has ? Number(g.oppScore) : '', H: sum(g.pit.map(r => r.H)), E: '-' }
    ),
    bat: g.bat, pit: g.pit
  };
}
function teamResult(g) { return !g.over ? null : g.our > g.oppR ? 'W' : g.our < g.oppR ? 'L' : 'T'; }
function teamToggle(id) {
  App.tv.open[id] = !App.tv.open[id];
  render();
  const g = App.tdata.games.find(x => x.id === id);
  if (App.tv.open[id] && g && g.kind === 'game' && !g.s && !g.loading) {
    g.loading = true;
    const key = 'game:' + id;
    const use = d => { g.setup = d.setup; g.s = replay(d.setup, d.events); g.loading = false; };
    const hit = cacheGet(key);
    if (hit) { use(hit); render(); return; }
    gs('getGame', id).then(d => { cacheSet(key, { setup: d.setup, events: d.events }); use(d); if (App.view === 'team') render(); })
      .catch(e => { g.loading = false; toast('載入失敗：' + e.message); });
  }
}
function teamSeasonOptions(sel) {
  const set = new Set([currentSeason(), sel, ...((App.tdata && App.tdata.seasons) || [])]);
  return [...set].sort((a, b) => b - a).map(y => `<option value="${y}" ${y === sel ? 'selected' : ''}>${y} 年度</option>`).join('');
}
function renderTeam() {
  const d = App.tdata, v = App.tv;
  const games = d.games.slice().sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : (a.id < b.id ? 1 : -1));
  const cnt = { W: 0, L: 0, T: 0 }, pl = { '冠軍': 0, '亞軍': 0, '季軍': 0 };
  games.forEach(g => { const r = teamResult(g); if (r) cnt[r]++; if (g.placing in pl) pl[g.placing]++; });
  const h = d.hist;
  if (h) { cnt.W += h.W; cnt.L += h.L; cnt.T += h.T; pl['冠軍'] += h.champ; pl['亞軍'] += h.second; pl['季軍'] += h.third; }
  const RES = { W: ['勝', 'win'], L: ['敗', 'loss'], T: ['和', 'tie'] };
  const card = g => {
    const r = teamResult(g), open = !!v.open[g.id];
    const lt = `<table class="tbl lscore"><tr><th class="tn"></th>${range(g.inn).map(k => `<th>${k + 1}</th>`).join('')}<th class="rh">R</th><th>H</th><th>E</th></tr>
      ${g.rows.map(x => `<tr><td class="tn">${esc(x.name)}</td>${x.runs.map(c => `<td>${c == null ? '' : c}</td>`).join('')}<td class="rh"><b>${x.R}</b></td><td>${x.H}</td><td>${x.E}</td></tr>`).join('')}</table>`;
    let detail = '';
    if (open) {
      if (g.kind === 'game' && !g.s) {
        detail = '<p class="muted small">載入中…</p>';
      } else if (g.kind === 'game') {
        App.pctx = g.setup;
        const t = boxTables(g.setup, g.s);
        App.pctx = null;
        detail = `<div class="sec">我方打擊</div>${t.batTbl}<div class="sec">我方投手</div>${t.pitTbl}
          <button class="btn sm" onclick="event.stopPropagation();openGame(${J(g.id)})">開啟完整紀錄表 ›</button>`;
      } else {
        const bc = [['PA', '打席'], ['AB', '打數'], ['H', '安打'], ['1B', '1B'], ['2B', '2B'], ['3B', '3B'], ['HR', 'HR'], ['BB', '保送'], ['R', '得分'], ['RBI', '打點'], ['SF', '犧飛'], ['AO', '高飛'], ['K', '三振'], ['GO', '滾地'], ['DP', '雙殺打'], ['FC', '野選'], ['ROE', '失誤上壘']];
        const nm = r => (App.bootMap[r.pid] || {}).name || r.name, nb = r => (App.bootMap[r.pid] || {}).num || '';
        const bt = g.bat.length ? `<div class="tblwrap"><table class="tbl"><tr><th class="nm">姓名</th><th>背號</th>${bc.map(([, z]) => `<th>${z}</th>`).join('')}</tr>
          ${g.bat.map(r => `<tr><td class="nm">${esc(nm(r))}</td><td>${esc(nb(r))}</td>${bc.map(([k]) => `<td>${r[k] || ''}</td>`).join('')}</tr>`).join('')}</table></div>` : '<p class="muted small">無打擊資料</p>';
        const pt = g.pit.length ? `<div class="tblwrap"><table class="tbl"><tr><th></th><th class="nm">投手</th><th>背號</th><th>局數</th><th>三振</th><th>保送</th><th>被安打</th><th>自責分</th><th>非自責分</th><th>勝敗</th></tr>
          ${g.pit.map(r => `<tr><td>${r.GS ? '先發' : '救援'}</td><td class="nm">${esc(nm(r))}</td><td>${esc(nb(r))}</td><td>${fmtIP(r.outs)}</td><td>${r.K}</td><td>${r.BB}</td><td>${r.H}</td><td>${r.ER}</td><td>${r.UER}</td><td>${r.W ? '勝' : r.L ? '敗' : r.T ? '和' : ''}</td></tr>`).join('')}</table></div>` : '<p class="muted small">無投手資料</p>';
        detail = `<div class="sec">我方打擊</div>${bt}<div class="sec">我方投手</div>${pt}
          <button class="btn sm" onclick="event.stopPropagation();editManual(${J(g.id)})">編輯補登資料 ›</button>`;
      }
    }
    return `<div class="tcard ${open ? 'open' : ''}">
      <div class="thead" onclick="teamToggle(${J(g.id)})">
        <div class="tinfo"><b>${esc(g.date.slice(5).replace('-', '/'))}</b> <span>${esc(g.cup)}</span> <span class="muted">vs ${esc(g.opp)}</span>
          ${g.kind === 'manual' ? '<span class="tag manual">手動</span>' : ''}</div>
        <div class="tbadges">${r ? `<span class="res ${RES[r][1]}">${RES[r][0]}</span>` : `<span class="tag live">${esc(g.label)}</span>`}${placingBadge(g.placing)}<span class="chev">${open ? '▲' : '▼'}</span></div>
      </div>
      <div class="tblwrap lwrap" onclick="teamToggle(${J(g.id)})">${lt}</div>
      ${open ? `<div class="tdetail">${detail}</div>` : ''}
    </div>`;
  };
  return `<div class="stickyhead teamhead"><div class="topbar"><button class="back" onclick="goHome()">‹</button><div class="title">球隊年度成績</div>
      <select class="tysel" onchange="goTeam(+this.value)">${teamSeasonOptions(v.season)}</select></div>
    <div class="tsum">
      <div class="trec"><span class="tname">${esc(App.boot.ourTeam)}</span><b>${cnt.W}</b>勝<b>${cnt.L}</b>敗${cnt.T ? `<b>${cnt.T}</b>和` : ''}</div>
      <div class="tpl"><span>🏆 冠軍 <b>${pl['冠軍']}</b></span><span>🥈 亞軍 <b>${pl['亞軍']}</b></span><span>🥉 季軍 <b>${pl['季軍']}</b></span></div>
      ${h ? `<div class="thist">含過往戰績 ${h.W} 勝 ${h.L} 敗${h.T ? ' ' + h.T + ' 和' : ''}${h.champ + h.second + h.third ? `（冠${h.champ} 亞${h.second} 季${h.third}）` : ''}</div>` : ''}
    </div></div>
  <div class="page">
    ${games.length ? games.map(card).join('') : '<p class="muted">這個年度還沒有比賽</p>'}
    <p class="muted small">點比賽可展開打者、投手數據。勝敗只計入已結束的比賽與有填比分的補登場次。</p>
  </div>`;
}

/* =========================================================
 * 選手總成績（所有年度加總）
 * ========================================================= */
async function goCareer() {
  App.game = null; App.edit = null; App.sv.mode = 'career';
  if (!cacheGet('cs')) $('#app').innerHTML = '<div class="loading">載入中…</div>';
  try { await swr('cs', 'getCareerStats', [], d => { App.cdata = d; }, ['season', 'player']); }
  catch (e) { toast('載入失敗：' + e.message); return go('home'); }
  go('season');
}
async function goSeasonPlayer(y, pid) { await goSeason(y); goPlayer(pid); }
function renderCareerPlayer() {
  const pid = App.pv, d = App.cdata;
  const bRows = d.bat.filter(r => r.pid === pid).sort((a, b) => b.season - a.season);
  const pRows = d.pit.filter(r => r.pid === pid).sort((a, b) => b.season - a.season);
  const name = (bRows[0] || pRows[0] || {}).name || (App.bootMap[pid] || {}).name || '?';
  const row = r => ` class="click" onclick="goSeasonPlayer(${r.season},${J(pid)})"`;
  let html = `<div class="topbar"><button class="back" onclick="go('season')">‹</button><div class="title">${esc(name)} ${App.bootMap[pid] ? '#' + esc(App.bootMap[pid].num) : ''}</div></div>
  <div class="page"><div class="muted small">生涯總成績（${bRows.length || pRows.length} 個年度）</div>`;
  if (bRows.length) {
    const tot = batDerived(aggregate(bRows, BAT_KEYS)[0]);
    const dc = [['G', '出賽'], ['PA', '打席'], ['AB', '打數'], ['H', '安打'], ['1B', '一安'], ['2B', '二安'], ['3B', '三安'], ['HR', '全壘打'], ['RBI', '打點'], ['R', '得分'], ['BB', '保送'], ['K', '三振'], ['AVG', '打擊率'], ['OBP', '上壘率'], ['OPS', 'OPS']];
    html += `<div class="sec">打擊｜生涯總計</div><div class="kpis">${[['AVG', '打擊率'], ['OBP', '上壘率'], ['SLG', '長打率'], ['OPS', 'OPS'], ['HR', '全壘打'], ['RBI', '打點']].map(([k, z]) => `<div class="kpi"><b>${fmtStat(k, tot[k])}</b><span>${z}</span></div>`).join('')}</div>
      <div class="tblwrap"><table class="tbl"><tr><th class="nm">年度</th>${dc.map(([, z]) => `<th>${z}</th>`).join('')}</tr>
      <tr class="total"><td class="nm">生涯總計</td>${dc.map(([k]) => `<td>${fmtStat(k, tot[k])}</td>`).join('')}</tr>
      ${bRows.map(r => { const x = batDerived(Object.assign({}, r)); return `<tr${row(r)}><td class="nm">${r.season} 年度</td>${dc.map(([k]) => `<td>${fmtStat(k, x[k])}</td>`).join('')}</tr>`; }).join('')}
      </table></div>`;
  }
  if (pRows.length) {
    const tot = pitDerived(aggregate(pRows, PIT_KEYS)[0]);
    const dc = [['G', '出賽'], ['GS', '先發'], ['W', '勝'], ['L', '敗'], ['T', '和'], ['outs', '局數'], ['ERA', '防禦率'], ['BF', '打者'], ['K', '三振'], ['BB', '保送'], ['H', '被安打'], ['HR', '被全壘打'], ['ER', '自責分'], ['UER', '非自責分']];
    html += `<div class="sec">投手｜生涯總計</div><div class="kpis">${[['ERA', '防禦率'], ['outs', '局數'], ['K', '三振'], ['W', '勝'], ['L', '敗'], ['T', '和']].map(([k, z]) => `<div class="kpi"><b>${fmtStat(k, tot[k])}</b><span>${z}</span></div>`).join('')}</div>
      <div class="tblwrap"><table class="tbl"><tr><th class="nm">年度</th>${dc.map(([, z]) => `<th>${z}</th>`).join('')}</tr>
      <tr class="total"><td class="nm">生涯總計</td>${dc.map(([k]) => `<td>${fmtStat(k, tot[k])}</td>`).join('')}</tr>
      ${pRows.map(r => { const x = pitDerived(Object.assign({}, r)); return `<tr${row(r)}><td class="nm">${r.season} 年度</td>${dc.map(([k]) => `<td>${fmtStat(k, x[k])}</td>`).join('')}</tr>`; }).join('')}
      </table></div>`;
  }
  if (!bRows.length && !pRows.length) html += '<p class="muted">沒有資料</p>';
  return html + `<p class="muted small">點年度可查看該年度逐場明細。</p></div>`;
}

/* =========================================================
 * 球隊總成績（逐年度勝敗）
 * ========================================================= */
const pct = (w, l) => w + l ? (w / (w + l)).toFixed(3).replace(/^0/, '') : '-';
async function goTeamTotal() {
  App.game = null; App.edit = null;
  if (!cacheGet('tt')) $('#app').innerHTML = '<div class="loading">載入中…</div>';
  try { await swr('tt', 'getTeamTotals', [], d => { App.ttdata = d; }, 'teamTotal'); }
  catch (e) { toast('載入失敗：' + e.message); return go('home'); }
  go('teamTotal');
}
function renderTeamTotal() {
  const rows = App.ttdata || [];
  const t = { W: 0, L: 0, T: 0, champ: 0, second: 0, third: 0 };
  rows.forEach(r => Object.keys(t).forEach(k => t[k] += r[k]));
  return `<div class="stickyhead teamhead"><div class="topbar"><button class="back" onclick="goHome()">‹</button><div class="title">球隊總成績</div></div>
    <div class="tsum">
      <div class="trec"><span class="tname">${esc(App.boot.ourTeam)} 歷年</span><b>${t.W}</b>勝<b>${t.L}</b>敗${t.T ? `<b>${t.T}</b>和` : ''}<span class="tpct">勝率 ${pct(t.W, t.L)}</span></div>
      <div class="tpl"><span>🏆 冠軍 <b>${t.champ}</b></span><span>🥈 亞軍 <b>${t.second}</b></span><span>🥉 季軍 <b>${t.third}</b></span></div>
    </div></div>
  <div class="page">
    ${rows.length ? `<div class="tblwrap"><table class="tbl ttbl"><tr><th class="nm">年度</th><th>勝</th><th>敗</th><th>和</th><th>勝率</th><th>冠</th><th>亞</th><th>季</th></tr>
      ${rows.map(r => `<tr class="click" onclick="goTeam(${r.season})"><td class="nm">${r.season} 年度${r.hist ? ' <span class="tag hist">含過往</span>' : ''}</td>
        <td>${r.W}</td><td>${r.L}</td><td>${r.T}</td><td>${pct(r.W, r.L)}</td><td>${r.champ || ''}</td><td>${r.second || ''}</td><td>${r.third || ''}</td></tr>`).join('')}
      <tr class="total"><td class="nm">合計</td><td>${t.W}</td><td>${t.L}</td><td>${t.T}</td><td>${pct(t.W, t.L)}</td><td>${t.champ}</td><td>${t.second}</td><td>${t.third}</td></tr>
    </table></div>` : '<p class="muted">還沒有任何比賽紀錄</p>'}
    <p class="muted small">勝率 = 勝 ÷（勝 + 敗），和局不計。點年度可查看該年度逐場比賽。過往戰績在「年度原始數據 › 球隊」輸入。</p>
  </div>`;
}

/* ----- 年度原始數據：球隊過往戰績 ----- */
const HIST_F = [['W', '勝'], ['L', '敗'], ['T', '和'], ['champ', '冠軍'], ['second', '亞軍'], ['third', '季軍']];
function renderOpeningTeam() {
  const list = App.thist || [];
  return `<p class="muted small">輸入使用本系統前的球隊戰績，會加進球隊年度成績與球隊總成績。每個年度一筆，全部填 0 即刪除。</p>
    <button class="btn ghost" onclick="pickHistSeason()">＋ 新增年度戰績</button>
    <div class="oplist">${list.map(h => `<div class="oprow" onclick="editHist(${h.season})"><div><b>${h.season} 年度</b>
      <div class="small">${h.W} 勝 ${h.L} 敗${h.T ? ' ' + h.T + ' 和' : ''}${h.champ ? '　🏆' + h.champ : ''}${h.second ? '　🥈' + h.second : ''}${h.third ? '　🥉' + h.third : ''}${h.note ? '　<span class="muted">' + esc(h.note) + '</span>' : ''}</div></div><span class="muted">›</span></div>`).join('') || '<p class="muted small">尚未輸入過往戰績</p>'}</div>`;
}
function pickHistSeason() {
  const have = new Set((App.thist || []).map(h => h.season));
  const ys = range(31).map(i => currentSeason() - i);
  openModal({
    title: '選擇年度',
    body: `<div class="pgrid">${ys.map(y => `<button class="pbtn" onclick="App._hy(${y})">${y}${have.has(y) ? '<small>已有資料</small>' : ''}</button>`).join('')}</div>`,
    buttons: [{ label: '取消' }]
  });
  App._hy = y => { App.modals.pop(); renderModal(); editHist(y); };
}
function editHist(y) {
  const h = (App.thist || []).find(x => x.season === y) || {};
  openModal({
    title: `${y} 年度 過往戰績`,
    body: `<div class="opgrid">${HIST_F.map(([k, z]) => `<label>${z}<input id="th_${k}" type="number" inputmode="numeric" min="0" value="${h[k] || ''}"></label>`).join('')}</div>
      <div class="form" style="margin-top:8px"><label>備註<input id="th_note" value="${esc(h.note || '')}" placeholder="例：手寫紀錄表整理"></label></div>`,
    buttons: [{ label: '取消' }, {
      label: '儲存', cls: 'primary', onClick: () => {
        const v = { note: $('#th_note').value.trim() };
        HIST_F.forEach(([k]) => v[k] = Math.max(0, parseInt($('#th_' + k).value, 10) || 0));
        toast('儲存中…');
        gs('saveTeamHistory', y, v).then(() => {
          const list = (App.thist || []).filter(x => x.season !== y);
          if (HIST_F.some(([k]) => v[k]) || v.note) list.push(Object.assign({ season: y }, v));
          App.thist = list.sort((a, b) => b.season - a.season);
          cacheSet('th', App.thist);
          toast('已儲存'); if (App.view === 'opening') render();
        }).catch(e => toast('儲存失敗：' + e.message));
      }
    }]
  });
}

/* =========================================================
 * 記錄新賽事（賽程）
 * ========================================================= */
async function goSchedule() {
  App.game = null; App.edit = null;
  if (!cacheGet('sch')) $('#app').innerHTML = '<div class="loading">載入中…</div>';
  try { await swr('sch', 'getSchedule', [], d => { App.sch = d; }, 'schedule'); }
  catch (e) { toast('載入失敗：' + e.message); return go('home'); }
  go('schedule');
}
function renderSchedule() {
  const list = (App.sch || []).filter(x => x.date >= today());
  return `<div class="topbar"><button class="back" onclick="goHome()">‹</button><div class="title">記錄新賽事</div></div>
  <div class="page">
    <button class="btn primary big" onclick="editSchedule()">＋ 新增賽事</button>
    <p class="muted small">新增的賽事會顯示在首頁「即將到來的比賽」（最近 10 場），比賽日的隔天自動消失。點首頁的賽事可以直接開始記錄比賽。</p>
    <div class="sec">已排定的賽事</div>
    ${list.length ? list.map(x => `<div class="upitem sch">
        <div class="update"><b>${esc(mdw(x.date).split('（')[0])}</b><small>週${esc(mdw(x.date).split('（')[1].replace('）', ''))}</small></div>
        <div class="upmain"><div class="gt">${esc(x.cup || '未命名賽事')}</div><div class="gs">📍 ${esc(x.venue || '場地未定')}${x.time ? '　🕘 ' + esc(x.time) : ''}</div></div>
        <div class="schbtns"><button class="btn sm" onclick="editSchedule(${J(x.id)})">編輯</button><button class="btn sm red" onclick="delSchedule(${J(x.id)})">刪除</button></div>
      </div>`).join('') : '<p class="muted">目前沒有排定的賽事</p>'}
  </div>`;
}
function editSchedule(id) {
  const x = (App.sch || []).find(s => s.id === id) || { date: today(), time: '', venue: '', cup: '' };
  openModal({
    title: id ? '編輯賽事' : '新增賽事',
    body: `<div class="form">
      <label>日期<input id="sc_date" type="date" value="${esc(x.date)}"></label>
      <label>時間<input id="sc_time" type="time" value="${esc(x.time)}"></label>
      <label>場地<input id="sc_venue" value="${esc(x.venue)}" placeholder="例：迎風河濱球場"></label>
      <label>賽事名稱<input id="sc_cup" value="${esc(x.cup)}" placeholder="例：秋季聯賽"></label>
    </div><div id="scErr" class="errbox"></div>`,
    buttons: [{ label: '取消' }, {
      label: '儲存', cls: 'primary', onClick: () => {
        const v = { id: id || '', date: $('#sc_date').value, time: $('#sc_time').value, venue: $('#sc_venue').value.trim(), cup: $('#sc_cup').value.trim() };
        if (!v.date) { $('#scErr').textContent = '請選擇日期'; return false; }
        if (v.date < today()) { $('#scErr').textContent = '日期已經過了，不會顯示在首頁'; return false; }
        toast('儲存中…');
        gs('saveSchedule', v).then(newId => {
          v.id = newId;
          App.sch = (App.sch || []).filter(s => s.id !== newId).concat(v).sort((a, b) => (a.date + a.time) < (b.date + b.time) ? -1 : 1);
          cacheSet('sch', App.sch);
          toast('已儲存'); if (App.view === 'schedule') render();
        }).catch(e => toast('儲存失敗：' + e.message));
      }
    }]
  });
}
function delSchedule(id) {
  const x = (App.sch || []).find(s => s.id === id) || {};
  confirmModal('刪除賽事', `${x.date} ${x.time || ''} ${x.cup || ''}，確定刪除？`, '刪除', () => {
    gs('deleteSchedule', id).then(() => {
      App.sch = (App.sch || []).filter(s => s.id !== id); cacheSet('sch', App.sch);
      toast('已刪除'); if (App.view === 'schedule') render();
    }).catch(e => toast('刪除失敗：' + e.message));
  });
}

/* =========================================================
 * 觀看即時比賽（唯讀，每 15 秒自動更新）
 * ========================================================= */
const LIVE_MS = 15000;
function stopLive() { if (App.liveTimer) { clearInterval(App.liveTimer); App.liveTimer = null; } }
async function goLive(id) {
  App.game = null; App.edit = null;
  App.live = { id, data: null, at: null, full: false, err: '' };
  $('#app').innerHTML = '<div class="loading">載入中…</div>';
  await liveFetch();
  if (!App.live || App.live.id !== id) return;
  if (!App.live.data) { toast('載入失敗：' + App.live.err); return goHome(); }
  go('live');
  App.liveTimer = setInterval(() => { if (!document.hidden) liveFetch(); }, LIVE_MS);
}
async function liveFetch() {
  const L = App.live;
  if (!L || L.busy) return;
  L.busy = true;
  try {
    const d = await gs('getGame', L.id);
    const changed = !L.data || L.data.events.length !== d.events.length || JSON.stringify(L.data.events) !== JSON.stringify(d.events);
    L.data = { setup: d.setup, events: d.events };
    if (changed) L.s = replay(d.setup, d.events);
    L.at = new Date(); L.err = '';
    if (L.s.over) stopLive();
  } catch (e) { L.err = e.message || '連線失敗'; }
  L.busy = false;
  if (App.view === 'live' && !App.modals.length) render();
}
function renderLive() {
  const L = App.live, setup = L.data.setup, s = L.s, off = isOffense(s, setup);
  App.pctx = setup;
  const t = boxTables(setup, s);
  let now;
  if (s.over) {
    now = `<div class="lvnow over">比賽結束　${esc(setup.ourTeam)} ${totalRuns(s, 'our')} : ${totalRuns(s, 'opp')} ${esc(setup.opp)}</div>`;
  } else if (off) {
    const cur = s.slots[s.batIdx];
    now = `<div class="lvnow"><div><span class="bslot">打擊</span> 第 ${s.batIdx + 1} 棒 <b>${esc(P(cur.pid).name)}</b> <span class="muted">#${esc(P(cur.pid).num)}</span></div>
      <div class="small">壘上：${s.queue.length ? s.queue.map(q => `${esc(P(q.pid).name)}`).join('、') : '無人'}</div></div>`;
  } else {
    const pp = curPitcher(s), j = s.oppJersey[s.oppIdx];
    now = `<div class="lvnow"><div><span class="bslot">守備</span> 對方第 ${s.oppIdx + 1} 棒${j ? ' #' + esc(j) : ''}</div>
      <div class="small">我方投手：${pp ? esc(P(pp).name) : '未指定'}</div></div>`;
  }
  const log = s.log.map((l, i) => ({ l, i })).filter(x => x.l.text).slice(-10).reverse();
  const html = `<div class="stickyhead"><div class="topbar"><button class="back" onclick="goHome()">‹</button>
      <div class="title">即時比賽　vs ${esc(setup.opp)}</div><button class="btn sm lvref" onclick="liveFetch()">↻</button></div>
    <div class="board"><div class="inn">${s.over ? '結束' : halfLabel(s)}</div>
      <div class="outs">${[0, 1, 2].map(k => `<i class="${k < s.outs && !s.over ? 'on' : ''}"></i>`).join('')}</div>
      <div class="side ${off ? 'off' : 'def'}">${s.over ? '已結束' : off ? '我方進攻' : '我方守備'}</div>
      <div class="sc"><span class="tm">${esc(setup.ourTeam)}</span><b>${totalRuns(s, 'our')}</b><span>:</span><b>${totalRuns(s, 'opp')}</b><span class="tm">${esc(setup.opp)}</span></div></div></div>
  <div class="page">
    ${now}
    <div class="sec">逐局比分</div>${t.line}
    <div class="sec">最近紀錄</div>
    <div class="lvlog">${log.length ? log.map(x => `<div><span class="elabel">${esc(x.l.label)}</span>${esc(x.l.text)}</div>`).join('') : '<span class="muted small">尚無紀錄</span>'}</div>
    <button class="btn" onclick="App.live.full=!App.live.full;render()">${L.full ? '收起完整數據 ▲' : '查看完整數據 ▼'}</button>
    ${L.full ? `<div class="sec">我方打擊</div>${t.batTbl}<div class="sec">我方投手</div>${t.pitTbl}` : ''}
    <p class="muted small lvfoot">${L.err ? '<span class="red">更新失敗，稍後重試</span>　' : ''}最後更新 ${L.at ? L.at.toLocaleTimeString() : '-'}${s.over ? '' : `　每 ${LIVE_MS / 1000} 秒自動更新`}<br>此畫面僅供觀看，不會修改任何紀錄。</p>
  </div>`;
  App.pctx = null;
  return html;
}
