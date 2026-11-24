// Turns raw runs/jobs/PRs into a per-run dataset where every run has a "cause".
// The browser does all aggregation so filters stay interactive.

export const CAUSES = [
  { key: 'cascade', label: 'Stacked-PR cascade', help: 'A push to one PR in a stack re-ran CI on the PRs stacked with it.' },
  { key: 'rerun', label: 'Re-run attempt', help: 'Minutes from attempt 2+ of a run (manual or automatic retry).' },
  { key: 'dup', label: 'Same commit again', help: 'The same workflow already ran on this exact commit (e.g. push + pull_request).' },
  { key: 'pr_push', label: 'PR: new commits', help: 'A follow-up push to an open PR.' },
  { key: 'pr_open', label: 'PR: first run', help: 'The first run of this workflow for a PR.' },
  { key: 'push', label: 'Push (no PR)', help: 'Merges / pushes to the default branch, or branch pushes with no open PR.' },
  { key: 'copilot', label: 'Copilot / agents', help: 'GitHub "dynamic" workflows: Copilot code review and Copilot agent runs.' },
  { key: 'other', label: 'Scheduled, manual & other', help: 'schedule, workflow_dispatch, comment/review/issue triggers and other events.' },
];

const PR_EVENTS = new Set(['pull_request', 'pull_request_target']);
// Events whose run is "about" a specific commit; re-testing the same SHA under these is duplicate work.
const COMMIT_EVENTS = new Set(['push', 'pull_request', 'pull_request_target', 'merge_group']);
const BURST_GAP_MS = 120e3;

function runnerMultiplier(labels = []) {
  const l = labels.join(' ').toLowerCase();
  if (l.includes('self-hosted')) return 0;
  if (l.includes('macos')) return 10;
  if (l.includes('windows')) return 2;
  return 1;
}

function jobMinutes(job) {
  if (!job.started_at || !job.completed_at) return { raw: 0, billed: 0 };
  const ms = new Date(job.completed_at) - new Date(job.started_at);
  if (!(ms > 0)) return { raw: 0, billed: 0 };
  const raw = ms / 60000;
  return { raw, billed: Math.ceil(raw) * runnerMultiplier(job.labels) };
}

function buildPrIndex(repo) {
  const prs = Object.values(repo.prs);
  const byHead = new Map();
  for (const pr of prs) {
    if (!byHead.has(pr.head)) byHead.set(pr.head, []);
    byHead.get(pr.head).push(pr);
  }
  const alive = (pr, t) => {
    const start = new Date(pr.created_at).getTime() - 5 * 60e3;
    const end = pr.closed_at ? new Date(pr.closed_at).getTime() + 5 * 60e3 : Infinity;
    return t >= start && t <= end;
  };
  const findByHead = (head, t) => (byHead.get(head) || []).find((pr) => alive(pr, t)) || null;

  // A PR is stacked on another when (any of) its base refs is the other PR's head branch.
  const parent = new Map();
  for (const pr of prs) {
    const t = new Date(pr.created_at).getTime();
    for (const base of pr.bases || [pr.base]) {
      if (base === repo.defaultBranch) continue;
      const cands = (byHead.get(base) || []).filter((p) => p.number !== pr.number);
      const p = cands.find((c) => alive(c, t)) || cands[0];
      if (p) {
        parent.set(pr.number, p.number);
        break;
      }
    }
  }
  const depthCache = new Map();
  const depth = (n, seen = new Set()) => {
    if (depthCache.has(n)) return depthCache.get(n);
    if (seen.has(n) || !parent.has(n)) return 0;
    seen.add(n);
    const d = 1 + depth(parent.get(n), seen);
    depthCache.set(n, d);
    return d;
  };
  const root = (n, seen = new Set()) => {
    while (parent.has(n) && !seen.has(n)) {
      seen.add(n);
      n = parent.get(n);
    }
    return n;
  };
  const stackSize = new Map();
  for (const pr of prs) {
    const r = root(pr.number);
    stackSize.set(r, (stackSize.get(r) || 0) + 1);
  }
  return { prs, findByHead, parent, depth, root, stackSize };
}

export function analyze(raw) {
  const outRuns = [];
  const outPrs = [];
  const bursts = [];

  for (const repo of raw.repos) {
    const idx = buildPrIndex(repo);
    const prByNum = new Map(idx.prs.map((p) => [p.number, p]));

    const runs = repo.runs
      .map((r) => {
        const t = new Date(r.created_at).getTime();
        let pr = r.prs[0] ?? null;
        if (pr == null && r.head_branch && r.head_branch !== repo.defaultBranch) {
          if (PR_EVENTS.has(r.event) || r.event === 'push') pr = idx.findByHead(r.head_branch, t)?.number ?? null;
        }
        let min = 0, rerunMin = 0, rawMin = 0, jobs = 0;
        for (const j of repo.jobs[r.id] || []) {
          const m = jobMinutes(j);
          rawMin += m.raw;
          if ((j.attempt || 1) > 1) rerunMin += m.billed;
          else min += m.billed;
          jobs++;
        }
        return {
          repo: repo.name,
          id: r.id,
          wf: r.name || r.path,
          event: r.event,
          branch: r.head_branch,
          sha: r.head_sha,
          attempt: r.run_attempt || 1,
          t,
          created: r.created_at,
          status: r.status,
          conclusion: r.conclusion,
          actor: r.triggering_actor || r.actor,
          pr,
          url: r.url,
          title: r.title,
          min,
          rerunMin,
          rawMin: Math.round(rawMin * 10) / 10,
          jobs,
          cause: null,
          burst: null,
        };
      })
      .sort((a, b) => a.t - b.t);

    // 1. Same workflow, same commit, already ran.
    const seenSha = new Set();
    for (const r of runs) {
      if (!COMMIT_EVENTS.has(r.event)) continue;
      const k = r.wf + '\0' + r.sha;
      if (seenSha.has(k)) r.cause = 'dup';
      else seenSha.add(k);
    }

    // 2. Bursts: one actor touching several PRs' CI within a couple of minutes.
    const byActor = new Map();
    for (const r of runs) {
      if (r.pr == null || !(PR_EVENTS.has(r.event) || r.event === 'push')) continue;
      if (!byActor.has(r.actor)) byActor.set(r.actor, []);
      byActor.get(r.actor).push(r);
    }
    for (const [actor, list] of byActor) {
      let cur = [];
      const flush = () => {
        const prSet = [...new Set(cur.map((r) => r.pr))];
        if (prSet.length >= 2) {
          // Group the burst's PRs by stack. Within a stack, the lowest PR is the origin and
          // the rest are cascades. PRs with no stack-mate in the burst are independent pushes,
          // unless nothing is linked and 3+ PRs moved at once (stack tooling that retargets to main).
          const groups = new Map();
          for (const n of prSet) {
            const rt = idx.root(n);
            if (!groups.has(rt)) groups.set(rt, []);
            groups.get(rt).push(n);
          }
          const byDepth = (a, b) => idx.depth(a) - idx.depth(b) || a - b;
          const linked = [...groups.values()].some((g) => g.length >= 2);
          const cascadePrs = new Set();
          const origins = [];
          if (linked) {
            for (const g of groups.values()) {
              if (g.length < 2) continue;
              g.sort(byDepth);
              origins.push(g[0]);
              g.slice(1).forEach((n) => cascadePrs.add(n));
            }
          } else if (prSet.length >= 3) {
            const g = prSet.slice().sort((a, b) => a - b);
            origins.push(g[0]);
            g.slice(1).forEach((n) => cascadePrs.add(n));
          }
          if (cascadePrs.size) {
            const id = bursts.length;
            let minutes = 0, cascadeRuns = 0;
            for (const r of cur) {
              r.burst = id;
              minutes += r.min + r.rerunMin;
              if (cascadePrs.has(r.pr) && r.cause == null) {
                r.cause = 'cascade';
                cascadeRuns++;
              }
            }
            bursts.push({
              id,
              repo: repo.name,
              actor,
              start: cur[0].created,
              end: cur[cur.length - 1].created,
              prs: prSet.sort(byDepth),
              origins,
              cascadePrs: [...cascadePrs],
              linked,
              runs: cur.length,
              cascadeRuns,
              minutes,
            });
          }
        }
        cur = [];
      };
      for (const r of list) {
        if (cur.length && r.t - cur[cur.length - 1].t > BURST_GAP_MS) flush();
        cur.push(r);
      }
      flush();
    }

    // 3. Everything else by event.
    const firstForPr = new Set();
    for (const r of runs) {
      const prKey = r.pr != null ? r.wf + '\0' + r.pr : null;
      const isFirst = prKey && !firstForPr.has(prKey);
      if (prKey) firstForPr.add(prKey);
      if (r.cause) continue;
      if (PR_EVENTS.has(r.event)) r.cause = isFirst ? 'pr_open' : 'pr_push';
      else if (r.event === 'push') {
        if (r.branch !== repo.defaultBranch && r.pr != null) r.cause = isFirst ? 'pr_open' : 'pr_push';
        else r.cause = 'push';
      } else if (r.event === 'dynamic') r.cause = 'copilot';
      else r.cause = 'other';
    }

    outRuns.push(...runs);

    for (const pr of idx.prs) {
      if (pr.created_at < raw.since) continue;
      outPrs.push({
        repo: repo.name,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        author: pr.author,
        state: pr.state,
        created: pr.created_at,
        merged: pr.merged_at,
        closed: pr.closed_at,
        commits: pr.commits,
        forcePushes: pr.force_pushes,
        parent: idx.parent.get(pr.number) ?? null,
        depth: idx.depth(pr.number),
        stackRoot: idx.root(pr.number),
        stackSize: idx.stackSize.get(idx.root(pr.number)) || 1,
      });
    }
  }

  return {
    org: raw.org,
    since: raw.since,
    fetchedAt: raw.fetchedAt,
    causes: CAUSES,
    repos: raw.repos.map((r) => ({ name: r.name, private: r.private, defaultBranch: r.defaultBranch })),
    runs: outRuns,
    prs: outPrs,
    bursts,
  };
}
