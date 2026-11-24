import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mapLimit } from './github.js';

export function cacheDir(org) {
  const base = process.env.WHY_ACTIONS_CACHE || path.join(os.homedir(), '.cache', 'why-actions');
  return path.join(base, org);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

const DAY = 86400e3;
// Runs older than this when last fetched are treated as settled and not re-listed.
const RELIST_OVERLAP = 7 * DAY;

function slimRun(r) {
  return {
    id: r.id,
    name: r.name,
    path: r.path,
    workflow_id: r.workflow_id,
    event: r.event,
    head_branch: r.head_branch,
    head_sha: r.head_sha,
    head_repo: r.head_repository?.full_name ?? null,
    run_attempt: r.run_attempt,
    run_number: r.run_number,
    prs: (r.pull_requests || []).map((p) => p.number),
    status: r.status,
    conclusion: r.conclusion,
    created_at: r.created_at,
    run_started_at: r.run_started_at,
    updated_at: r.updated_at,
    actor: r.actor?.login ?? null,
    triggering_actor: r.triggering_actor?.login ?? null,
    title: r.display_title,
    url: r.html_url,
  };
}

function slimJob(j) {
  return {
    id: j.id,
    name: j.name,
    attempt: j.run_attempt,
    status: j.status,
    conclusion: j.conclusion,
    started_at: j.started_at,
    completed_at: j.completed_at,
    labels: j.labels,
    runner_group: j.runner_group_name ?? null,
  };
}

/** List runs created in [from, to], splitting windows that exceed the API's 1000-result cap. */
async function listRunsWindow(gh, fullName, from, to) {
  const q = `created=${from.toISOString()}..${to.toISOString()}`;
  const first = await gh.get(`/repos/${fullName}/actions/runs?per_page=100&${q}`);
  if (first.total_count === 0) return [];
  if (first.total_count > 1000 && to - from > 3600e3) {
    const mid = new Date((from.getTime() + to.getTime()) / 2);
    const a = await listRunsWindow(gh, fullName, from, mid);
    const b = await listRunsWindow(gh, fullName, new Date(mid.getTime() + 1000), to);
    return a.concat(b);
  }
  const rest =
    first.total_count > 100
      ? await gh.paginate(`/repos/${fullName}/actions/runs?per_page=100&page=2&${q}`, (j) => j.workflow_runs)
      : [];
  return first.workflow_runs.concat(rest);
}

const PR_QUERY = `
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    pullRequests(first: 100, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title url state isDraft
        createdAt updatedAt closedAt mergedAt
        headRefName baseRefName
        author { login }
        commits { totalCount }
        baseChanges: timelineItems(first: 20, itemTypes: [BASE_REF_CHANGED_EVENT]) {
          nodes { ... on BaseRefChangedEvent { createdAt previousRefName currentRefName } }
        }
        forcePushes: timelineItems(itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT]) { totalCount }
      }
    }
  }
}`;

async function fetchPRs(gh, org, repo, sinceIso, prior) {
  const prs = { ...(prior.prs || {}) };
  let defaultBranch = prior.defaultBranch || null;
  const stopBefore = prior.fetchedAt ? new Date(new Date(prior.fetchedAt).getTime() - DAY) : null;
  let cursor = null;
  for (;;) {
    const data = await gh.graphql(PR_QUERY, { owner: org, name: repo, cursor });
    const repoData = data.repository;
    defaultBranch = repoData.defaultBranchRef?.name ?? defaultBranch;
    const conn = repoData.pullRequests;
    let done = false;
    for (const n of conn.nodes) {
      const updated = new Date(n.updatedAt);
      if (stopBefore && updated < stopBefore) {
        done = true;
        break;
      }
      if (updated < new Date(sinceIso)) {
        done = true;
        break;
      }
      prs[n.number] = {
        number: n.number,
        title: n.title,
        url: n.url,
        state: n.state,
        draft: n.isDraft,
        created_at: n.createdAt,
        closed_at: n.closedAt,
        merged_at: n.mergedAt,
        head: n.headRefName,
        base: n.baseRefName,
        bases: [
          ...new Set([
            n.baseRefName,
            ...n.baseChanges.nodes.flatMap((e) => [e.previousRefName, e.currentRefName]).filter(Boolean),
          ]),
        ],
        author: n.author?.login ?? null,
        commits: n.commits.totalCount,
        force_pushes: n.forcePushes.totalCount,
      };
    }
    if (done || !conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return { prs, defaultBranch };
}

async function fetchJobs(gh, fullName, run, dir) {
  const file = path.join(dir, 'jobs', `${run.id}.json`);
  const cached = readJson(file, null);
  if (cached && cached.status === 'completed' && cached.attempt >= run.run_attempt) return cached;
  let jobs;
  try {
    jobs = await gh.paginate(
      `/repos/${fullName}/actions/runs/${run.id}/jobs?per_page=100&filter=all`,
      (j) => j.jobs,
    );
  } catch (e) {
    if (e.status === 404) jobs = [];
    else throw e;
  }
  const entry = { attempt: run.run_attempt, status: run.status, jobs: jobs.map(slimJob) };
  writeJson(file, entry);
  return entry;
}

/**
 * Collect runs, jobs and PRs for every repo in the org, using an on-disk cache.
 * Returns { org, since, fetchedAt, repos: [{ name, defaultBranch, runs, prs, jobs }] }
 */
export async function collect(gh, org, { days, offline, log }) {
  const root = cacheDir(org);
  const now = new Date();
  const since = new Date(now.getTime() - days * DAY);
  const meta = readJson(path.join(root, 'meta.json'), {});

  let repoList;
  if (offline) {
    repoList = meta.repos || [];
  } else {
    log(`listing repos in ${org}…`);
    const repos = await gh.paginate(`/orgs/${org}/repos?per_page=100&type=all`);
    repoList = repos.map((r) => ({ name: r.name, archived: r.archived, pushed_at: r.pushed_at, private: r.private }));
  }

  const results = await mapLimit(repoList, 6, async (repo) => {
    const fullName = `${org}/${repo.name}`;
    const dir = path.join(root, repo.name);
    const runsFile = path.join(dir, 'runs.json');
    const prsFile = path.join(dir, 'prs.json');
    const priorRuns = readJson(runsFile, { runs: {}, fetchedAt: null });
    const priorPrs = readJson(prsFile, { prs: {}, fetchedAt: null });

    let runsById = priorRuns.runs || {};
    let prData = { prs: priorPrs.prs || {}, defaultBranch: priorPrs.defaultBranch };

    if (!offline) {
      const listFrom =
        priorRuns.fetchedAt && new Date(priorRuns.since) <= since
          ? new Date(Math.max(since, new Date(priorRuns.fetchedAt) - RELIST_OVERLAP))
          : since;
      const probe = await gh.get(`/repos/${fullName}/actions/runs?per_page=1`);
      if (probe.total_count > 0) {
        const fresh = await listRunsWindow(gh, fullName, listFrom, now);
        for (const r of fresh) runsById[r.id] = slimRun(r);
        // Anything still not completed gets refreshed individually.
        const pending = Object.values(runsById).filter(
          (r) => r.status !== 'completed' && new Date(r.created_at) < listFrom,
        );
        for (const r of pending) {
          try {
            runsById[r.id] = slimRun(await gh.get(`/repos/${fullName}/actions/runs/${r.id}`));
          } catch (e) {
            if (e.status === 404) delete runsById[r.id];
            else throw e;
          }
        }
        writeJson(runsFile, {
          since: priorRuns.since && new Date(priorRuns.since) < since ? priorRuns.since : since.toISOString(),
          fetchedAt: now.toISOString(),
          runs: runsById,
        });
      }
      const runCount = Object.keys(runsById).length;
      if (runCount > 0) {
        prData = await fetchPRs(gh, org, repo.name, since.toISOString(), priorPrs);
        writeJson(prsFile, { ...prData, fetchedAt: now.toISOString() });
      }
    }

    const runs = Object.values(runsById).filter((r) => new Date(r.created_at) >= since);
    if (runs.length) log(`${repo.name}: ${runs.length} runs, ${Object.keys(prData.prs).length} PRs`);
    return { name: repo.name, archived: repo.archived, private: repo.private, defaultBranch: prData.defaultBranch || 'main', runs, prs: prData.prs };
  });

  const active = results.filter((r) => r.runs.length > 0);

  // Jobs: one API call per run, cached forever once the run is complete.
  const allRuns = active.flatMap((repo) => repo.runs.map((run) => ({ repo, run })));
  let done = 0;
  const jobsTotal = allRuns.length;
  log(`fetching job timings for ${jobsTotal} runs (cached runs are free)…`);
  const jobsByRepo = new Map(active.map((r) => [r.name, {}]));
  await mapLimit(allRuns, offline ? 64 : 12, async ({ repo, run }) => {
    const dir = path.join(root, repo.name);
    let entry;
    if (offline) entry = readJson(path.join(dir, 'jobs', `${run.id}.json`), { jobs: [] });
    else entry = await fetchJobs(gh, `${org}/${repo.name}`, run, dir);
    jobsByRepo.get(repo.name)[run.id] = entry.jobs;
    done++;
    if (!offline && (done % 250 === 0 || done === jobsTotal)) log(`  jobs ${done}/${jobsTotal}`);
  });

  writeJson(path.join(root, 'meta.json'), {
    repos: repoList,
    fetchedAt: offline ? meta.fetchedAt : now.toISOString(),
  });

  return {
    org,
    since: since.toISOString(),
    fetchedAt: offline ? meta.fetchedAt : now.toISOString(),
    repos: active.map((r) => ({ ...r, jobs: jobsByRepo.get(r.name) })),
  };
}
