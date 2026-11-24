import { execFileSync } from 'node:child_process';

const API = 'https://api.github.com';

export function getToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('No GitHub token. Set GITHUB_TOKEN or run `gh auth login`.');
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createClient(token, { log = () => {} } = {}) {
  let remaining = Infinity;
  let resetAt = 0;
  let calls = 0;

  async function request(url, init = {}, attempt = 0) {
    if (remaining < 25 && Date.now() < resetAt) {
      const wait = resetAt - Date.now() + 1000;
      log(`rate limit low (${remaining}); waiting ${Math.ceil(wait / 1000)}s`);
      await sleep(wait);
    }
    calls++;
    const res = await fetch(url.startsWith('http') ? url : API + url, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'why-actions',
        ...(init.headers || {}),
      },
    });
    const rem = res.headers.get('x-ratelimit-remaining');
    const reset = res.headers.get('x-ratelimit-reset');
    if (rem != null) remaining = Number(rem);
    if (reset != null) resetAt = Number(reset) * 1000;

    if ((res.status === 403 || res.status === 429) && attempt < 5) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const wait = retryAfter
        ? retryAfter * 1000
        : remaining === 0
          ? Math.max(resetAt - Date.now(), 0) + 1000
          : 2 ** attempt * 5000;
      log(`HTTP ${res.status} on ${url}; retrying in ${Math.ceil(wait / 1000)}s`);
      await sleep(wait);
      return request(url, init, attempt + 1);
    }
    if (res.status >= 500 && attempt < 3) {
      await sleep(2 ** attempt * 1000);
      return request(url, init, attempt + 1);
    }
    if (!res.ok) {
      const body = await res.text();
      const err = new Error(`GitHub ${res.status} ${url}: ${body.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return { json: await res.json(), headers: res.headers };
  }

  async function get(path) {
    return (await request(path)).json;
  }

  /** Follow Link: rel="next" pages. `pick` extracts the array from each page. */
  async function paginate(path, pick = (j) => j, { stop } = {}) {
    const out = [];
    let url = path;
    while (url) {
      const { json, headers } = await request(url);
      const items = pick(json);
      out.push(...items);
      if (stop && stop(items)) break;
      const link = headers.get('link') || '';
      const m = link.match(/<([^>]+)>;\s*rel="next"/);
      url = m ? m[1] : null;
    }
    return out;
  }

  async function graphql(query, variables) {
    const { json } = await request('/graphql', {
      method: 'POST',
      body: JSON.stringify({ query, variables }),
      headers: { 'content-type': 'application/json' },
    });
    if (json.errors) throw new Error('GraphQL: ' + JSON.stringify(json.errors).slice(0, 300));
    return json.data;
  }

  return {
    get,
    paginate,
    graphql,
    stats: () => ({ calls, remaining }),
  };
}

/** Run async fn over items with bounded concurrency. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}
