# why-actions

Explains where a GitHub org's Actions minutes go.

```
why-actions <org> [--days 365] [--offline] [--port N] [--no-open] [--json file]
```

It fetches workflow runs, per-job timings and PRs (with base-branch history) for every repo
in the org. It caches them in `~/.cache/why-actions/<org>/`, then opens a local page with:

- **Usage by cause over time**: every run gets one cause: stacked-PR cascade, re-run
  attempt, same commit again, PR new commits, PR first run, push, Copilot, or
  scheduled/manual/other.
- **Usage vs. PR count**: PRs opened per week and minutes per PR.
- **Repos**: PRs vs. minutes scatter and a sortable table. Click a repo to focus the page on it.
- **Same actions, again and again**: how many times each PR × workflow ran, and the PRs with the most runs.
- **Stacked-PR cascades**: bursts where one push re-ran CI across a stack of PRs.
- **Workflows**: minutes, minutes per run and failure rate.

The first run makes one API call per workflow run to get job timings. Later runs only
fetch what changed. Auth comes from `GITHUB_TOKEN`/`GH_TOKEN` or `gh auth token`.
Billed minutes are estimated from job durations: rounded up per job, ×2 Windows, ×10 macOS.
They are not read from the billing API, which needs `admin:org`.

Install: `npm link` in this directory.
