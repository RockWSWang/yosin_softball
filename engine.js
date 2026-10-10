/* =========================================================
 * 比賽引擎：由「事件清單」重播出完整比賽狀態與統計
 * 純邏輯，不碰畫面；復原 / 修正都靠重播
 * ========================================================= */

const POS_LIST = ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'FR', 'EP'];
const FIELD_POS = POS_LIST.slice(0, 10);
const POS_ZH = { P: '投手', C: '捕手', '1B': '一壘手', '2B': '二壘手', '3B': '三壘手', SS: '游擊手', LF: '左外野手', CF: '中外野手', RF: '右外野手', FR: '自由手', EP: 'EP' };
const POS_ABBR = { P: '投', C: '捕', '1B': '一', '2B': '二', '3B': '三', SS: '游', LF: '左', CF: '中', RF: '右', FR: '自', EP: 'EP' };

// 我方打擊結果：ab=計打數 hit=安打 out=打者出局
const OUR_RES = {
  '1B': { zh: '一壘安打', area: 'a', ab: 1, hit: 1 },
  '2B': { zh: '二壘安打', area: 'a', ab: 1, hit: 1 },
  '3B': { zh: '三壘安打', area: 'a', ab: 1, hit: 1 },
  'HR': { zh: '全壘打', area: 'a', ab: 1, hit: 1 },
  'BB': { zh: '四壞保送', area: 'a', ab: 0 },
  'SF': { zh: '高飛犧牲打', area: 'a', ab: 0, out: 1 },
  'FC': { zh: '野手選擇', area: 'b', ab: 1 },
  'ROE': { zh: '失誤上壘', area: 'a', ab: 1 },
  'AO': { zh: '高飛球接殺', area: 'b', ab: 1, out: 1 },
  'GO': { zh: '滾地球封殺', area: 'b', ab: 1, out: 1 },
  'K': { zh: '三振出局', area: 'b', ab: 1, out: 1 },
  'DP': { zh: '雙殺打', area: 'b', ab: 1, out: 1 }
};

// 對方打擊結果（我方守備時）
// btn = 按鈕文字；OUT / SPOUT 為舊版代碼，保留讓舊紀錄可以重播
const OPP_RES = {
  K: { zh: '三振', outs: 1 },
  AO: { zh: '接殺', outs: 1 },
  GO: { zh: '封殺', outs: 1 },
  DP: { zh: '雙殺', outs: 2 },
  H: { zh: '安打', hit: 1 },
  HR: { zh: '全壘打', hit: 1 },
  BB: { zh: '保送' },
  ROE: { zh: '失誤上壘', btn: '失誤' },
  OUT: { zh: '出局', outs: 1 },
  SPOUT: { zh: '特殊守備出局', outs: 1 }
};
// 守備畫面按鈕順序（上排出局、下排上壘）
const OPP_BTNS = ['K', 'AO', 'GO', 'DP', 'H', 'HR', 'BB', 'ROE'];

function pname(setup, pid) {
  if (pid === '_none') return '未指定';
  const p = setup.players[pid];
  return p ? p.name : '?';
}

function validatePositions(slots) {
  const errs = [], cnt = {};
  slots.forEach(x => { if (!x.pos) errs.push('有球員未設定守位'); else cnt[x.pos] = (cnt[x.pos] || 0) + 1; });
  FIELD_POS.forEach(p => {
    if (!cnt[p]) errs.push('缺少' + POS_ZH[p]);
    else if (cnt[p] > 1) errs.push(POS_ZH[p] + '重複');
  });
  const ep = cnt.EP || 0;
  if (slots.length === 11 && ep !== 1) errs.push('11 人打擊需要 1 位 EP');
  if (slots.length === 10 && ep) errs.push('10 人打擊不可有 EP');
  return [...new Set(errs)];
}

function initState(setup) {
  const s = {
    inning: 1, half: 'top', outs: 0, over: false,
    runs: { our: [], opp: [] }, hits: { our: 0, opp: 0 }, errs: { our: 0, opp: 0 }, lob: 0,
    slots: setup.lineup.map(l => ({ pid: l.pid, pos: l.pos })),
    hist: setup.lineup.map(l => [{ pid: l.pid, role: '先發', pos: [l.pos] }]),
    batIdx: 0, queue: [],
    oppIdx: 0, oppCount: setup.oppCount || 10, oppJersey: Object.assign({}, setup.oppJerseys || {}), oppBat: {},
    status: {}, bat: {}, pit: {}, pitOrder: [],
    subsThisHalf: false, needDefArrange: false, halfChanged: false,
    log: []
  };
  setup.lineup.forEach((l, i) => {
    s.status[l.pid] = { starter: true, origSlot: i, inGame: true, reentered: false, used: true };
  });
  (setup.reserves || []).forEach(r => {
    const pid = r.pid || r;
    if (!s.status[pid]) s.status[pid] = { starter: false, origSlot: -1, inGame: false, reentered: false, used: false };
  });
  startHalf(s, setup);
  return s;
}

function isOffense(s, setup) { return (s.half === 'top') === !!setup.weBatFirst; }
function halfLabel(s) { return s.inning + '局' + (s.half === 'top' ? '上' : '下'); }
function totalRuns(s, t) { return s.runs[t].reduce((a, b) => a + (b || 0), 0); }
function curPitcher(s) { const x = s.slots.find(z => z.pos === 'P'); return x ? x.pid : null; }

function startHalf(s, setup) {
  const t = isOffense(s, setup) ? 'our' : 'opp';
  if (s.runs[t][s.inning - 1] == null) s.runs[t][s.inning - 1] = 0;
}
function addRuns(s, team, n) {
  const a = s.runs[team];
  a[s.inning - 1] = (a[s.inning - 1] || 0) + n;
}
function bat(s, pid) {
  return s.bat[pid] || (s.bat[pid] = { PA: 0, AB: 0, BB: 0, R: 0, RBI: 0, H: 0, '1B': 0, '2B': 0, '3B': 0, HR: 0, K: 0, SF: 0, AO: 0, GO: 0, DP: 0, FC: 0, ROE: 0, E: 0 });
}
function pit(s, pid) {
  if (!s.pit[pid]) { s.pit[pid] = { outs: 0, BF: 0, K: 0, BB: 0, H: 0, HR: 0, ER: 0, UER: 0, W: 0, L: 0, T: 0 }; s.pitOrder.push(pid); }
  return s.pit[pid];
}

/** 可上場的球員（代打 / 代跑 / 守備替補）：未上場過，或先發且可回原棒次再上場一次 */
function availableFor(s, setup, slot) {
  return Object.keys(setup.players).filter(pid => {
    const st = s.status[pid];
    if (!st) return true;
    if (st.inGame) return false;
    if (!st.used) return true;
    return st.starter && !st.reentered && st.origSlot === slot;
  });
}

function doSub(s, setup, slot, inPid, role, pos, warn) {
  const outPid = s.slots[slot].pid;
  const st = s.status[inPid] || (s.status[inPid] = { starter: false, origSlot: -1, inGame: false, reentered: false, used: false });
  if (st.inGame) warn.push(pname(setup, inPid) + ' 已在場上');
  else if (st.used) {
    if (st.starter && !st.reentered && st.origSlot === slot) st.reentered = true;
    else warn.push(pname(setup, inPid) + ' 不符合再上場規定');
  }
  st.inGame = true; st.used = true;
  if (s.status[outPid]) s.status[outPid].inGame = false;
  s.slots[slot] = { pid: inPid, pos: pos };
  s.hist[slot].push({ pid: inPid, role: role, pos: [pos] });
}

function checkHalf(s, setup, warn) {
  if (s.outs < 3) return;
  if (s.outs > 3) warn.push('出局數超過 3');
  if (isOffense(s, setup)) {
    s.lob += s.queue.length;
    s.queue = [];
    s.needDefArrange = s.subsThisHalf;
    s.subsThisHalf = false;
  }
  s.outs = 0;
  if (s.half === 'top') s.half = 'bot';
  else { s.half = 'top'; s.inning++; }
  s.halfChanged = true;
  startHalf(s, setup);
}

function applyEvent(s, setup, ev) {
  const warn = [];
  s.halfChanged = false; s.needDefArrange = false;
  const label = halfLabel(s);
  let text = '';
  const N = s.slots.length;
  if (s.over && ev.type !== 'END') warn.push('比賽結束後的紀錄');

  switch (ev.type) {
    case 'PA': {
      if (!isOffense(s, setup)) warn.push('不是我方進攻');
      const slot = s.batIdx, pid = s.slots[slot].pid, r = OUR_RES[ev.result];
      if (!r) { warn.push('未知結果 ' + ev.result); break; }
      const b = bat(s, pid);
      b.PA++; if (r.ab) b.AB++;
      if (r.hit) { b.H++; s.hits.our++; }
      b[ev.result]++;
      if (ev.result === 'ROE') s.errs.opp++;
      const rbi = ev.rbi || 0; b.RBI += rbi;

      let outs = 0, runs = 0;
      const scoredNames = [], outNames = [];
      const scored = ev.result === 'HR' ? s.queue.map(q => q.pid) : (ev.scored || []);
      scored.forEach(id => {
        const k = s.queue.findIndex(q => q.pid === id);
        if (k < 0) { warn.push(pname(setup, id) + ' 不在壘上'); return; }
        s.queue.splice(k, 1); bat(s, id).R++; runs++; scoredNames.push(pname(setup, id));
      });
      (ev.outs || []).forEach(id => {
        const k = s.queue.findIndex(q => q.pid === id);
        if (k < 0) { warn.push(pname(setup, id) + ' 不在壘上'); return; }
        s.queue.splice(k, 1); outs++; outNames.push(pname(setup, id));
      });
      const bState = r.out ? 'out' : (ev.result === 'HR' ? 'scored' : (ev.batter || 'safe'));
      if (bState === 'out') outs++;
      else if (bState === 'scored') { b.R++; runs++; if (ev.result !== 'HR') scoredNames.push(pname(setup, pid)); }
      else s.queue.push({ pid: pid, slot: slot });

      if (ev.result === 'DP' && !(ev.outs || []).length) warn.push('雙殺打未指定另一位出局跑者');
      if (ev.result === 'FC' && !(ev.outs || []).length) warn.push('野手選擇未指定出局跑者');
      if (ev.result === 'SF' && runs < 1) warn.push('高飛犧牲打但無人得分');
      if (s.queue.length > 3) warn.push('壘上超過 3 人');

      s.outs += outs;
      if (runs) addRuns(s, 'our', runs);
      text = `第${slot + 1}棒 ${pname(setup, pid)} ${r.zh}` + (rbi ? ` 打點${rbi}` : '')
        + (scoredNames.length ? `（得分：${scoredNames.join('、')}）` : '')
        + (outNames.length ? `（跑者出局：${outNames.join('、')}）` : '')
        + (bState === 'out' && !r.out ? '（打者跑壘出局）' : '');
      s.batIdx = (slot + 1) % N;
      checkHalf(s, setup, warn);
      break;
    }

    case 'OPP': {
      if (isOffense(s, setup)) warn.push('不是我方守備');
      const r = OPP_RES[ev.result];
      if (!r) { warn.push('未知結果 ' + ev.result); break; }
      const idx = s.oppIdx;
      const pp = curPitcher(s);
      if (!pp) warn.push('目前沒有投手');
      const p = pit(s, pp || '_none');
      const ob = s.oppBat[idx] || (s.oppBat[idx] = { PA: 0, H: 0, HR: 0, BB: 0, K: 0, jerseys: [] });
      p.BF++; ob.PA++;
      if (r.hit) { p.H++; ob.H++; s.hits.opp++; }
      if (ev.result === 'HR') { p.HR++; ob.HR++; }
      if (ev.result === 'K') { p.K++; ob.K++; }
      if (ev.result === 'BB') { p.BB++; ob.BB++; }
      if (ev.jersey) { s.oppJersey[idx] = ev.jersey; if (!ob.jerseys.includes(ev.jersey)) ob.jerseys.push(ev.jersey); }
      const runs = ev.runs || 0;
      if (runs) { addRuns(s, 'opp', runs); if (ev.unearned) p.UER += runs; else p.ER += runs; }
      if (ev.result === 'ROE') { s.errs.our++; if (ev.errPid) bat(s, ev.errPid).E++; }
      p.outs += r.outs || 0;
      s.outs += r.outs || 0;
      text = `對方第${idx + 1}棒${ev.jersey ? ' #' + ev.jersey : ''} ${r.zh}`
        + (runs ? ` 失${runs}分${ev.unearned ? '（非自責）' : ''}` : '')
        + (ev.result === 'ROE' && ev.errPid ? `（${pname(setup, ev.errPid)} 失誤）` : '');
      s.oppIdx = (idx + 1) % s.oppCount;
      checkHalf(s, setup, warn);
      break;
    }

    case 'RUNNER': {
      const k = s.queue.findIndex(q => q.pid === ev.pid);
      if (k < 0) { warn.push(pname(setup, ev.pid) + ' 不在壘上'); break; }
      const q = s.queue.splice(k, 1)[0];
      if (ev.action === 'out') { s.outs++; text = `跑者 第${q.slot + 1}棒 ${pname(setup, ev.pid)} 出局`; }
      else { bat(s, ev.pid).R++; addRuns(s, 'our', 1); text = `跑者 第${q.slot + 1}棒 ${pname(setup, ev.pid)} 得分`; }
      checkHalf(s, setup, warn);
      break;
    }

    case 'OPPRUN': {
      const p = pit(s, curPitcher(s) || '_none');
      if (ev.action === 'out') { s.outs++; p.outs++; text = '對方跑者出局'; }
      else {
        addRuns(s, 'opp', 1);
        if (ev.unearned) p.UER++; else p.ER++;
        text = '對方跑者得分' + (ev.unearned ? '（非自責）' : '');
      }
      checkHalf(s, setup, warn);
      break;
    }

    case 'SUB': {
      if (ev.kind === 'PH') {
        if (ev.slot !== s.batIdx) warn.push('代打棒次與目前打者不符');
        const old = s.slots[ev.slot].pid;
        doSub(s, setup, ev.slot, ev.inPid, '代打', s.slots[ev.slot].pos, warn);
        s.subsThisHalf = true;
        text = `代打：第${ev.slot + 1}棒 ${pname(setup, old)} → ${pname(setup, ev.inPid)}`;
      } else {
        const q = s.queue.find(x => x.pid === ev.outPid);
        if (!q) { warn.push(pname(setup, ev.outPid) + ' 不在壘上'); break; }
        doSub(s, setup, q.slot, ev.inPid, '代跑', s.slots[q.slot].pos, warn);
        q.pid = ev.inPid;
        s.subsThisHalf = true;
        text = `代跑：第${q.slot + 1}棒 ${pname(setup, ev.outPid)} → ${pname(setup, ev.inPid)}`;
      }
      break;
    }

    case 'DEFSET': {
      const before = curPitcher(s), parts = [];
      (ev.changes || []).forEach(c => {
        const cur = s.slots[c.slot];
        if (c.inPid && c.inPid !== cur.pid) {
          const old = cur.pid;
          doSub(s, setup, c.slot, c.inPid, '守備', c.pos, warn);
          parts.push(`第${c.slot + 1}棒 ${pname(setup, old)}→${pname(setup, c.inPid)}（${POS_ZH[c.pos]}）`);
        } else if (c.pos && c.pos !== cur.pos) {
          cur.pos = c.pos;
          const h = s.hist[c.slot];
          h[h.length - 1].pos.push(c.pos);
          parts.push(`${pname(setup, cur.pid)} 改守${POS_ZH[c.pos]}`);
        }
      });
      const v = validatePositions(s.slots);
      if (v.length) warn.push(...v);
      const after = curPitcher(s);
      text = '守備調整：' + parts.join('；') + (after && after !== before ? `（換投：${pname(setup, after)}）` : '');
      break;
    }

    case 'OPPCOUNT': {
      s.oppCount = ev.n;
      if (s.oppIdx >= ev.n) s.oppIdx = 0;
      text = `對方打擊人數改為 ${ev.n} 人`;
      break;
    }

    case 'END': {
      s.over = true;
      s.decision = ev.decision || null;
      if (s.decision && s.decision.pid) pit(s, s.decision.pid)[s.decision.type]++;
      text = '比賽結束' + (s.decision ? `（${DEC_ZH[s.decision.type]}：${pname(setup, s.decision.pid)}）` : '');
      break;
    }

    default:
      warn.push('未知事件 ' + ev.type);
  }

  s.log.push({ label: label, text: text, warn: warn, type: ev.type });
}

function replay(setup, events) {
  const s = initState(setup);
  events.forEach(e => applyEvent(s, setup, e));
  return s;
}

function fmtIP(outs) { return Math.floor(outs / 3) + '.' + (outs % 3); }

/* =========================================================
 * 年度成績
 * ========================================================= */
const DEC_ZH = { W: '勝投', L: '敗投', T: '和局' };
const DEC_SHORT = { W: '勝', L: '敗', T: '和' };
const BAT_KEYS = ['G', 'PA', 'AB', 'H', '1B', '2B', '3B', 'HR', 'BB', 'K', 'R', 'RBI', 'SF', 'AO', 'GO', 'DP', 'FC', 'ROE'];
const PIT_KEYS = ['G', 'GS', 'outs', 'BF', 'K', 'BB', 'H', 'HR', 'ER', 'UER', 'W', 'L', 'T'];

/** 年度 = 8/1 ~ 隔年 7/31，以開始年份命名 */
function seasonOf(dateStr) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{1,2})/);
  if (!m) return null;
  return +m[2] >= 8 ? +m[1] : +m[1] - 1;
}
function currentSeason() {
  const d = new Date();
  return d.getMonth() + 1 >= 8 ? d.getFullYear() : d.getFullYear() - 1;
}
function seasonLabel(y) { return `${y} 年度（${y}/8 ~ ${y + 1}/7）`; }

/** 一場比賽 → 年度明細列（有上場就算出賽） */
function gameStatRows(setup, s) {
  const bat = [], seen = new Set();
  s.hist.forEach(h => h.forEach(e => {
    if (seen.has(e.pid)) return;
    seen.add(e.pid);
    const b = s.bat[e.pid] || {}, r = { pid: e.pid, name: pname(setup, e.pid) };
    BAT_KEYS.forEach(k => r[k] = k === 'G' ? 1 : (b[k] || 0));
    bat.push(r);
  }));
  const pitchers = s.pitOrder.filter(pid => pid !== '_none');
  const pit = pitchers.map(pid => {
    const p = s.pit[pid], r = { pid, name: pname(setup, pid) };
    PIT_KEYS.forEach(k => r[k] = k === 'G' ? 1 : k === 'GS' ? (pid === pitchers[0] ? 1 : 0) : (p[k] || 0));
    return r;
  });
  return { bat, pit };
}

/** 事件內容指紋：匯入後紀錄有沒有被修改 */
function eventsSig(events) {
  const str = JSON.stringify(events);
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return events.length + '-' + (h >>> 0).toString(36);
}

/** 加總與衍生數據 */
function aggregate(rows, keys) {
  const m = {};
  rows.forEach(r => {
    const a = m[r.pid] || (m[r.pid] = { pid: r.pid, name: r.name });
    if (r.name) a.name = r.name;
    keys.forEach(k => a[k] = (a[k] || 0) + (Number(r[k]) || 0));
  });
  return Object.values(m);
}
function batDerived(a) {
  a.TB = a['1B'] + 2 * a['2B'] + 3 * a['3B'] + 4 * a.HR;
  a.AVG = a.AB ? a.H / a.AB : null;
  const d = a.AB + a.BB + a.SF;
  a.OBP = d ? (a.H + a.BB) / d : null;
  a.SLG = a.AB ? a.TB / a.AB : null;
  a.OPS = a.OBP != null && a.SLG != null ? a.OBP + a.SLG : null;
  return a;
}
function pitDerived(a) {
  a.ERA = a.outs ? a.ER * 7 / (a.outs / 3) : null;   // 慢壘 7 局換算
  return a;
}
