/* global Chart */
const $ = (s) => document.querySelector(s);
const state = { repo: 'all', range: 'all', bucket: 'week', measure: 'min', hidden: new Set() };
const charts = {};
let D; // dataset
let causeIndex;

const nf = new Intl.NumberFormat('en-US');
const fmt = (n) => (n == null || Number.isNaN(n) ? '–' : Math.abs(n) >= 10000 ? (n / 1000).toFixed(1) + 'k' : nf.format(Math.round(n)));
const fmt1 = (n) => (n == null || !isFinite(n) ? '–' : n >= 100 ? nf.format(Math.round(n)) : n.toFixed(1));
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 + '%' : '–');
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const causeColor = (key) => css(`--s${causeIndex[key] + 1}`);
const measureLabel = () => (state.measure === 'min' ? 'billed minutes' : 'runs');
const AVOIDABLE = new Set(['cascade', 'rerun', 'dup']);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/* ---------- data shaping ---------- */

function rangeStart() {
  if (state.range === 'all') return -Infinity;
  return Date.now() - Number(state.range) * 86400e3;
}

function filtered() {
  const t0 = rangeStart();
  const inRepo = (r) => state.repo === 'all' || r === state.repo;
  return {
    runs: D.runs.filter((r) => inRepo(r.repo) && r.t >= t0),
    prs: D.prs.filter((p) => inRepo(p.repo) && new Date(p.created).getTime() >= t0),
    bursts: D.bursts.filter((b) => inRepo(b.repo) && new Date(b.start).getTime() >= t0),
  };
}

/** What a run contributes to each cause under the current measure. */
function contrib(r) {
  const out = [];
  if (state.measure === 'min') {
    out.push([r.cause, r.min]);
    if (r.rerunMin) out.push(['rerun', r.rerunMin]);
  } else {
    out.push([r.cause, 1]);
    if (r.attempt > 1) out.push(['rerun', r.attempt - 1]);
  }
  return out;
}
const total = (r) => contrib(r).reduce((s, [, v]) => s + v, 0);

function bucketKey(t) {
  const d = new Date(t);
  if (state.bucket === 'month') return d.toISOString().slice(0, 7);
  if (state.bucket === 'day') return d.toISOString().slice(0, 10);
  const day = (d.getUTCDay() + 6) % 7; // Monday start
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
}
function nextBucket(key) {
  if (state.bucket === 'month') {
    const [y, m] = key.split('-').map(Number);
    return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
  }
  const d = new Date(key + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + (state.bucket === 'day' ? 1 : 7));
  return d.toISOString().slice(0, 10);
}
function bucketRange(times) {
  if (!times.length) return [];
  const lo = bucketKey(Math.min(...times));
  const hi = bucketKey(Math.max(...times));
  const keys = [];
  for (let k = lo; k <= hi && keys.length < 2000; k = nextBucket(k)) keys.push(k);
  return keys;
}

/* ---------- rendering helpers ---------- */

function chartDefaults() {
  Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  Chart.defaults.font.size = 12;
  Chart.defaults.color = css('--muted');
  Chart.defaults.borderColor = css('--grid');
  Chart.defaults.animation = false;
  Chart.defaults.maintainAspectRatio = false;
  Object.assign(Chart.defaults.plugins.tooltip, {
    backgroundColor: css('--surface'),
    titleColor: css('--ink'),
    bodyColor: css('--ink-2'),
    borderColor: css('--border'),
    borderWidth: 1,
    padding: 8,
    boxPadding: 4,
    usePointStyle: true,
  });
  Chart.defaults.plugins.legend.display = false;
}

function draw(id, config) {
  charts[id]?.destroy();
  const scales = config.options?.scales || {};
  for (const ax of Object.values(scales)) {
    ax.grid = { color: css('--grid'), drawTicks: false, ...(ax.grid || {}) };
    ax.border = { display: false, ...(ax.border || {}) };
    ax.ticks = { padding: 6, ...(ax.ticks || {}) };
  }
  if (scales.x) scales.x.grid.display = scales.x.grid.display ?? false;
  charts[id] = new Chart(document.getElementById(id), config);
}

function table(el, cols, rows, { onClick, sort, selected, limit = 200 } = {}) {
  const st = (el._sort ||= { key: sort || cols[1].key, dir: -1 });
  const sorted = rows.slice().sort((a, b) => {
    const va = a[st.key], vb = b[st.key];
    if (typeof va === 'string' || typeof vb === 'string') return String(va).localeCompare(String(vb)) * st.dir;
    return ((va ?? -Infinity) - (vb ?? -Infinity)) * st.dir;
  });
  if (!rows.length) {
    el.innerHTML = '<div class="empty">Nothing in this selection.</div>';
    return;
  }
  const head = cols
    .map((c) => `<th data-k="${c.key}" class="${c.left ? 'l' : ''}" title="${esc(c.help || '')}">${esc(c.label)}${st.key === c.key ? (st.dir < 0 ? ' ↓' : ' ↑') : ''}</th>`)
    .join('');
  const body = sorted
    .slice(0, limit)
    .map((r, i) => {
      const cls = [onClick ? 'click' : '', selected && selected(r) ? 'sel' : ''].join(' ');
      return `<tr class="${cls}" data-i="${i}">${cols
        .map((c) => `<td class="${c.cls || (c.left ? 'l' : '')}">${c.render ? c.render(r) : esc(c.fmt ? c.fmt(r[c.key]) : r[c.key])}</td>`)
        .join('')}</tr>`;
    })
    .join('');
  el.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  el.querySelectorAll('th').forEach((th) =>
    th.addEventListener('click', () => {
      const k = th.dataset.k;
      el._sort = { key: k, dir: st.key === k ? -st.dir : -1 };
      table(el, cols, rows, { onClick, sort, selected, limit });
    }),
  );
  if (onClick)
    el.querySelectorAll('tbody tr').forEach((tr) =>
      tr.addEventListener('click', (e) => {
        if (e.target.closest('a')) return;
        onClick(sorted[Number(tr.dataset.i)]);
      }),
    );
}

/* ---------- sections ---------- */

function renderKpis({ runs, prs, bursts }) {
  let min = 0, runCount = 0, avoid = 0, cascade = 0, rerun = 0;
  for (const r of runs) {
    min += r.min + r.rerunMin;
    runCount += r.attempt;
    if (AVOIDABLE.has(r.cause)) avoid += r.min;
    avoid += r.rerunMin;
    rerun += r.rerunMin;
    if (r.cause === 'cascade') cascade += r.min;
  }
  const prWithRuns = new Set(runs.filter((r) => r.pr != null).map((r) => r.repo + '#' + r.pr)).size;
  const k = [
    ['Billed minutes', fmt(min), `${fmt(runs.reduce((s, r) => s + r.rawMin, 0))} raw runner minutes`],
    ['Runs (incl. re-runs)', fmt(runCount), `${fmt(runs.length)} distinct runs`],
    ['PRs opened', fmt(prs.length), `${fmt(prWithRuns)} PRs had runs`],
    ['Minutes per PR opened', fmt1(prs.length ? min / prs.length : NaN), 'all usage ÷ PRs opened'],
    ['Avoidable share', pct(avoid, min), `${fmt(avoid)} min: cascades, re-runs, duplicate commits`],
    ['Cascade minutes', fmt(cascade), `${pct(cascade, min)} of usage, ${fmt(bursts.length)} bursts`],
  ];
  $('#kpis').innerHTML = k
    .map(([l, v, d]) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="d">${d}</div></div>`)
    .join('');
}

function renderCauseTime(runs, keys) {
  const series = Object.fromEntries(D.causes.map((c) => [c.key, Object.fromEntries(keys.map((k) => [k, 0]))]));
  for (const r of runs) {
    const k = bucketKey(r.t);
    for (const [c, v] of contrib(r)) series[c][k] += v;
  }
  draw('c-cause-time', {
    type: 'bar',
    data: {
      labels: keys,
      datasets: D.causes.map((c) => ({
        label: c.label,
        data: keys.map((k) => series[c.key][k]),
        backgroundColor: causeColor(c.key),
        borderColor: css('--surface'),
        borderWidth: { top: 1, bottom: 0, left: 0, right: 0 },
        borderSkipped: false,
        hidden: state.hidden.has(c.key),
        stack: 's',
        categoryPercentage: 0.85,
        barPercentage: 0.95,
      })),
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { stacked: true },
        y: { stacked: true, title: { display: true, text: measureLabel() } },
      },
      plugins: {
        tooltip: {
          itemSort: (a, b) => b.raw - a.raw,
          filter: (i) => i.raw > 0,
          callbacks: {
            label: (i) => ` ${i.dataset.label}: ${fmt(i.raw)}`,
            footer: (items) => `Total: ${fmt(items.reduce((s, i) => s + i.raw, 0))}`,
          },
        },
      },
    },
  });
  $('#cause-legend').innerHTML = D.causes
    .map(
      (c) =>
        `<button data-k="${c.key}" class="${state.hidden.has(c.key) ? 'off' : ''}" title="${esc(c.help)}"><span class="sw" style="background:${causeColor(c.key)}"></span>${esc(c.label)}</button>`,
    )
    .join('');
  $('#cause-legend').querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      const k = b.dataset.k;
      state.hidden.has(k) ? state.hidden.delete(k) : state.hidden.add(k);
      render();
    }),
  );
  return series;
}

function renderCauseTable(runs) {
  const tot = Object.fromEntries(D.causes.map((c) => [c.key, 0]));
  for (const r of runs) for (const [c, v] of contrib(r)) tot[c] += v;
  const sum = Object.values(tot).reduce((a, b) => a + b, 0);
  const max = Math.max(...Object.values(tot), 1);
  const rows = D.causes.map((c) => ({ ...c, v: tot[c.key], share: sum ? tot[c.key] / sum : 0 }));
  table(
    $('#cause-table'),
    [
      {
        key: 'label', label: 'Cause', left: true,
        render: (r) => `<span class="sw" style="background:${causeColor(r.key)}"></span> <span title="${esc(r.help)}">${esc(r.label)}</span>${AVOIDABLE.has(r.key) ? ' <span class="tag">avoidable</span>' : ''}`,
      },
      { key: 'v', label: measureLabel(), render: (r) => `<span class="bar" style="width:${(r.v / max) * 80}px;background:${causeColor(r.key)}"></span>${fmt(r.v)}` },
      { key: 'share', label: 'Share', fmt: (v) => (v * 100).toFixed(1) + '%' },
    ],
    rows,
    { sort: 'v' },
  );
}

function renderAvoidable(series, keys) {
  const data = keys.map((k) => {
    let all = 0, av = 0;
    for (const c of D.causes) {
      all += series[c.key][k];
      if (AVOIDABLE.has(c.key)) av += series[c.key][k];
    }
    return all ? (av / all) * 100 : null;
  });
  draw('c-avoidable', {
    type: 'line',
    data: { labels: keys, datasets: [{ label: 'Avoidable share', data, borderColor: css('--s1'), backgroundColor: css('--s1'), borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, spanGaps: true, tension: 0.2 }] },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: { x: {}, y: { min: 0, max: 100, ticks: { callback: (v) => v + '%' } } },
      plugins: { tooltip: { callbacks: { label: (i) => ` Avoidable: ${i.raw?.toFixed(1)}%` } } },
    },
  });
}

function renderPrCharts(runs, prs, keys) {
  const opened = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const p of prs) {
    const k = bucketKey(new Date(p.created).getTime());
    if (k in opened) opened[k]++;
  }
  const usage = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const r of runs) usage[bucketKey(r.t)] += total(r);
  draw('c-prs', {
    type: 'bar',
    data: { labels: keys, datasets: [{ label: 'PRs opened', data: keys.map((k) => opened[k]), backgroundColor: css('--s1'), borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: 'bottom' }] },
    options: { scales: { x: {}, y: { title: { display: true, text: 'PRs opened' }, ticks: { precision: 0 } } } },
  });
  draw('c-per-pr', {
    type: 'line',
    data: {
      labels: keys,
      datasets: [{
        label: `${measureLabel()} per PR`,
        data: keys.map((k) => (opened[k] ? usage[k] / opened[k] : null)),
        borderColor: css('--s2'), backgroundColor: css('--s2'), borderWidth: 2, pointRadius: 3, pointHoverRadius: 5, spanGaps: false,
      }],
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: { x: {}, y: { beginAtZero: true, title: { display: true, text: `${measureLabel()} per PR opened` } } },
      plugins: { tooltip: { callbacks: { label: (i) => ` ${fmt1(i.raw)} ${measureLabel()} per PR (${opened[i.label]} PRs, ${fmt(usage[i.label])} total)` } } },
    },
  });
}

function repoRows() {
  const t0 = rangeStart();
  const by = new Map();
  for (const r of D.runs) {
    if (r.t < t0) continue;
    if (!by.has(r.repo)) by.set(r.repo, { repo: r.repo, min: 0, runs: 0, prs: 0, cascade: 0, rerun: 0, dup: 0, prRuns: 0 });
    const o = by.get(r.repo);
    o.min += r.min + r.rerunMin;
    o.runs += r.attempt;
    o.rerun += r.rerunMin;
    if (r.cause === 'cascade') o.cascade += r.min;
    if (r.cause === 'dup') o.dup += r.min;
    if (r.pr != null) o.prRuns += r.attempt;
  }
  for (const p of D.prs) {
    if (new Date(p.created).getTime() < t0) continue;
    by.get(p.repo) && by.get(p.repo).prs++;
  }
  const priv = Object.fromEntries(D.repos.map((r) => [r.name, r.private]));
  return [...by.values()].map((o) => ({
    ...o,
    private: priv[o.repo],
    perPr: o.prs ? o.min / o.prs : null,
    runsPerPr: o.prs ? o.prRuns / o.prs : null,
    cascadePct: o.min ? o.cascade / o.min : 0,
    rerunPct: o.min ? o.rerun / o.min : 0,
    dupPct: o.min ? o.dup / o.min : 0,
  }));
}

function renderRepos() {
  const rows = repoRows();
  const sel = (r) => r.repo === state.repo;
  draw('c-repo-scatter', {
    type: 'scatter',
    data: {
      datasets: [{
        label: 'Repos',
        data: rows.map((r) => ({ x: r.prs, y: r.min, repo: r.repo })),
        backgroundColor: rows.map((r) => (state.repo === 'all' || sel(r) ? css('--s1') : css('--axis'))),
        borderColor: css('--surface'),
        borderWidth: 2,
        pointRadius: rows.map((r) => (sel(r) ? 8 : 6)),
        pointHoverRadius: 9,
      }],
    },
    options: {
      onClick: (_e, els) => els[0] && selectRepo(rows[els[0].index].repo),
      scales: {
        x: { type: 'linear', beginAtZero: true, title: { display: true, text: 'PRs opened' }, grid: { display: true } },
        y: { beginAtZero: true, title: { display: true, text: 'billed minutes' } },
      },
      plugins: { tooltip: { callbacks: { label: (i) => ` ${i.raw.repo}: ${fmt(i.raw.y)} min, ${i.raw.x} PRs` } } },
    },
  });
  const max = Math.max(...rows.map((r) => r.min), 1);
  table(
    $('#repo-table'),
    [
      { key: 'repo', label: 'Repo', left: true, render: (r) => `${esc(r.repo)}${r.private ? '' : ' <span class="tag" title="Public repos are not billed">public</span>'}` },
      { key: 'min', label: 'Billed min', render: (r) => `<span class="bar" style="width:${(r.min / max) * 60}px;background:var(--s1)"></span>${fmt(r.min)}` },
      { key: 'runs', label: 'Runs', fmt },
      { key: 'prs', label: 'PRs', fmt },
      { key: 'perPr', label: 'Min/PR', fmt: fmt1 },
      { key: 'runsPerPr', label: 'Runs/PR', fmt: fmt1, help: 'PR-attributed runs ÷ PRs opened' },
      { key: 'cascadePct', label: 'Cascade', fmt: (v) => (v * 100).toFixed(0) + '%' },
      { key: 'rerunPct', label: 'Re-run', fmt: (v) => (v * 100).toFixed(0) + '%' },
      { key: 'dupPct', label: 'Dup', fmt: (v) => (v * 100).toFixed(0) + '%' },
    ],
    rows,
    { sort: 'min', onClick: (r) => selectRepo(r.repo), selected: sel },
  );
}

function prRows(runs) {
  const meta = new Map(D.prs.map((p) => [p.repo + '#' + p.number, p]));
  const by = new Map();
  for (const r of runs) {
    if (r.pr == null) continue;
    const key = r.repo + '#' + r.pr;
    if (!by.has(key)) by.set(key, { key, repo: r.repo, number: r.pr, runs: 0, min: 0, cascade: 0, reruns: 0, dup: 0, shas: new Set(), perWf: new Map() });
    const o = by.get(key);
    o.runs += r.attempt;
    o.min += r.min + r.rerunMin;
    o.reruns += r.attempt - 1;
    if (r.cause === 'cascade') o.cascade++;
    if (r.cause === 'dup') o.dup++;
    o.shas.add(r.sha);
    o.perWf.set(r.wf, (o.perWf.get(r.wf) || 0) + r.attempt);
  }
  return [...by.values()].map((o) => {
    const p = meta.get(o.key) || {};
    return {
      ...o,
      title: p.title || '',
      url: p.url,
      author: p.author,
      state: p.merged ? 'merged' : (p.state || '').toLowerCase(),
      stack: p.stackSize > 1 ? `${p.depth + 1} of ${p.stackSize}` : '',
      stackSize: p.stackSize || 1,
      commits: o.shas.size,
      maxWf: Math.max(...o.perWf.values()),
      forcePushes: p.forcePushes,
    };
  });
}

function renderRepeat(runs) {
  const BUCKETS = [[1, 1], [2, 2], [3, 3], [4, 5], [6, 10], [11, 20], [21, 50], [51, Infinity]];
  const label = ([a, b]) => (a === b ? `${a}` : b === Infinity ? `${a}+` : `${a}–${b}`);
  const pairs = new Map();
  for (const r of runs) {
    if (r.pr == null) continue;
    const k = r.repo + '#' + r.pr + '\0' + r.wf;
    const o = pairs.get(k) || { n: 0, v: 0 };
    o.n += r.attempt;
    o.v += total(r);
    pairs.set(k, o);
  }
  const agg = BUCKETS.map(() => ({ pairs: 0, v: 0 }));
  let all = 0;
  for (const o of pairs.values()) {
    const i = BUCKETS.findIndex(([a, b]) => o.n >= a && o.n <= b);
    agg[i].pairs++;
    agg[i].v += o.v;
    all += o.v;
  }
  draw('c-repeat', {
    type: 'bar',
    data: {
      labels: BUCKETS.map(label),
      datasets: [{ label: measureLabel(), data: agg.map((a) => a.v), backgroundColor: css('--s1'), borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: 'bottom' }],
    },
    options: {
      scales: { x: { title: { display: true, text: 'runs of the same workflow on one PR' } }, y: { title: { display: true, text: measureLabel() } } },
      plugins: { tooltip: { callbacks: { label: (i) => ` ${fmt(i.raw)} ${measureLabel()} (${pct(i.raw, all)}) from ${agg[i.dataIndex].pairs} PR×workflow pairs` } } },
    },
  });
  const counts = [...pairs.values()].map((o) => o.n).sort((a, b) => a - b);
  const median = counts.length ? counts[Math.floor(counts.length / 2)] : 0;
  const p90 = counts.length ? counts[Math.floor(counts.length * 0.9)] : 0;
  const over5 = [...pairs.values()].filter((o) => o.n > 5).reduce((s, o) => s + o.v, 0);
  $('#repeat-stats').innerHTML = `<div class="kpis small">
    <div class="kpi"><div class="l">Median runs per PR × workflow</div><div class="v">${median}</div></div>
    <div class="kpi"><div class="l">90th percentile</div><div class="v">${p90}</div></div>
    <div class="kpi"><div class="l">Max</div><div class="v">${counts.at(-1) ?? 0}</div></div>
    <div class="kpi"><div class="l">Usage from pairs with 6+ runs</div><div class="v">${pct(over5, all)}</div><div class="d">${fmt(over5)} ${measureLabel()}</div></div>
  </div>`;

  table(
    $('#pr-table'),
    [
      { key: 'number', label: 'PR', left: true, render: (r) => `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.repo)}#${r.number}</a>` },
      { key: 'title', label: 'Title', left: true, cls: 'title', render: (r) => `<span title="${esc(r.title)}">${esc(r.title)}</span>` },
      { key: 'author', label: 'Author', left: true },
      { key: 'state', label: 'State', left: true },
      { key: 'stackSize', label: 'Stack', render: (r) => r.stack || '<span class="muted">–</span>', help: 'Position in stack, bottom = 1' },
      { key: 'runs', label: 'Runs', fmt },
      { key: 'maxWf', label: 'Max/workflow', fmt, help: 'Most runs of a single workflow on this PR' },
      { key: 'commits', label: 'Commits run', fmt, help: 'Distinct SHAs CI ran on' },
      { key: 'cascade', label: 'Cascade runs', fmt },
      { key: 'reruns', label: 'Re-runs', fmt },
      { key: 'min', label: 'Billed min', fmt },
    ],
    prRows(runs),
    { sort: 'runs', limit: 100 },
  );
}

function renderCascades(runs, bursts, keys, prs) {
  let cMin = 0, cRuns = 0;
  const per = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const r of runs)
    if (r.cause === 'cascade') {
      cMin += r.min;
      cRuns++;
      per[bucketKey(r.t)] += state.measure === 'min' ? r.min : 1;
    }
  const stacks = new Map();
  for (const p of prs) {
    if (p.stackSize > 1) stacks.set(p.repo + '#' + p.stackRoot, p.stackSize);
  }
  const sizes = [...stacks.values()];
  const linked = bursts.filter((b) => b.linked).length;
  $('#cascade-kpis').innerHTML = [
    ['Cascade runs', fmt(cRuns)],
    ['Cascade minutes', fmt(cMin)],
    ['Bursts', `${fmt(bursts.length)}`, `${linked} linked by base branch`],
    ['Avg runs per burst', fmt1(bursts.length ? bursts.reduce((s, b) => s + b.runs, 0) / bursts.length : NaN)],
    ['PR stacks (2+ PRs)', fmt(sizes.length), sizes.length ? `largest ${Math.max(...sizes)} PRs` : ''],
  ]
    .map(([l, v, d]) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div>${d ? `<div class="d">${d}</div>` : ''}</div>`)
    .join('');
  draw('c-cascade-time', {
    type: 'bar',
    data: { labels: keys, datasets: [{ label: 'Cascade', data: keys.map((k) => per[k]), backgroundColor: causeColor('cascade'), borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: 'bottom' }] },
    options: {
      scales: { x: {}, y: { title: { display: true, text: `cascade ${measureLabel()}` } } },
      plugins: { tooltip: { callbacks: { label: (i) => ` Cascade: ${fmt(i.raw)} ${measureLabel()}` } } },
    },
  });
  const prUrl = new Map(D.prs.map((p) => [p.repo + '#' + p.number, p.url]));
  table(
    $('#burst-table'),
    [
      { key: 'start', label: 'When', left: true, render: (b) => esc(new Date(b.start).toLocaleString()) },
      { key: 'repo', label: 'Repo', left: true },
      { key: 'actor', label: 'Actor', left: true },
      { key: 'n', label: 'PRs', fmt },
      {
        key: 'prs', label: 'PRs (bold = origin)', left: true, cls: 'title',
        render: (b) => b.prs.map((n) => `<a href="${esc(prUrl.get(b.repo + '#' + n) || '#')}" target="_blank" rel="noopener">${b.origins.includes(n) ? '<b>#' + n + '</b>' : '#' + n}</a>`).join(' '),
      },
      { key: 'linked', label: 'Evidence', left: true, render: (b) => (b.linked ? 'base-branch stack' : '<span class="muted">3+ PRs at once</span>') },
      { key: 'runs', label: 'Runs', fmt },
      { key: 'cascadeRuns', label: 'Cascade runs', fmt },
      { key: 'minutes', label: 'Billed min', fmt },
    ],
    bursts.map((b) => ({ ...b, n: b.prs.length })),
    { sort: 'runs', limit: 100 },
  );
}

function renderWorkflows(runs) {
  const by = new Map();
  for (const r of runs) {
    const k = r.repo + '\0' + r.wf;
    const o = by.get(k) || { repo: r.repo, wf: r.wf, runs: 0, min: 0, fail: 0, done: 0, cascade: 0, prRuns: 0 };
    o.runs += r.attempt;
    o.min += r.min + r.rerunMin;
    if (r.status === 'completed' && r.conclusion !== 'skipped' && r.conclusion !== 'cancelled') {
      o.done++;
      if (r.conclusion === 'failure') o.fail++;
    }
    if (r.cause === 'cascade') o.cascade += r.min;
    by.set(k, o);
  }
  const rows = [...by.values()].map((o) => ({ ...o, avg: o.runs ? o.min / o.runs : 0, failRate: o.done ? o.fail / o.done : 0, cascadePct: o.min ? o.cascade / o.min : 0 }));
  table(
    $('#wf-table'),
    [
      { key: 'wf', label: 'Workflow', left: true },
      { key: 'repo', label: 'Repo', left: true },
      { key: 'runs', label: 'Runs', fmt },
      { key: 'min', label: 'Billed min', fmt },
      { key: 'avg', label: 'Min/run', fmt: fmt1 },
      { key: 'failRate', label: 'Failure rate', fmt: (v) => (v * 100).toFixed(0) + '%' },
      { key: 'cascadePct', label: 'Cascade', fmt: (v) => (v * 100).toFixed(0) + '%' },
    ],
    rows,
    { sort: 'min' },
  );
}

/* ---------- wiring ---------- */

function selectRepo(name) {
  state.repo = state.repo === name ? 'all' : name;
  $('#f-repo').value = state.repo;
  render();
  if (state.repo !== 'all') window.scrollTo({ top: 0, behavior: 'smooth' });
}

function render() {
  chartDefaults();
  const f = filtered();
  // The x-axis spans the runs; PRs opened before the first run would only stretch it.
  const keys = bucketRange(f.runs.length ? [...f.runs.map((r) => r.t), Date.now()] : []);
  renderKpis(f);
  const series = renderCauseTime(f.runs, keys);
  renderCauseTable(f.runs);
  renderAvoidable(series, keys);
  renderPrCharts(f.runs, f.prs, keys);
  renderRepos();
  renderRepeat(f.runs);
  renderCascades(f.runs, f.bursts, keys, f.prs);
  renderWorkflows(f.runs);
  const url = new URL(location);
  for (const k of ['repo', 'range', 'bucket', 'measure']) url.searchParams.set(k, state[k]);
  history.replaceState(null, '', url);
}

async function main() {
  D = await (await fetch('data.json')).json();
  causeIndex = Object.fromEntries(D.causes.map((c, i) => [c.key, i]));
  $('#org').textContent = D.org;
  document.title = `Why Actions: ${D.org}`;
  $('#sub').textContent = `${nf.format(D.runs.length)} runs across ${D.repos.length} repos since ${new Date(D.since).toLocaleDateString()} · data fetched ${new Date(D.fetchedAt).toLocaleString()}`;

  const usage = new Map();
  for (const r of D.runs) usage.set(r.repo, (usage.get(r.repo) || 0) + r.min + r.rerunMin);
  const repos = [...usage.keys()].sort((a, b) => usage.get(b) - usage.get(a));
  $('#f-repo').innerHTML = `<option value="all">All repos (org)</option>` + repos.map((r) => `<option value="${esc(r)}">${esc(r)} · ${fmt(usage.get(r))} min</option>`).join('');

  const params = new URLSearchParams(location.search);
  for (const k of ['repo', 'range', 'bucket', 'measure']) {
    const v = params.get(k);
    const el = $(`#f-${k}`);
    if (v && [...el.options].some((o) => o.value === v)) state[k] = v;
    el.value = state[k];
    el.addEventListener('change', () => {
      state[k] = el.value;
      render();
    });
  }
  render();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);
}

main().catch((e) => {
  document.querySelector('main').innerHTML = `<div class="card empty">Failed to load data: ${esc(e.message)}</div>`;
});
