# Copilot Instructions — AzDevopsSimp

## Maintenance rule

**After every code change in this repo, update this file** to reflect what changed — new constants, new patterns, renamed files, new pages, changed API behaviour, etc. Keep this file as the single source of truth for future Copilot sessions.

---

## What this repo is

Pure client-side HTML/JS tool for managing and visualising **GitHub Advanced Security (GHAS) alerts** in an Azure DevOps organisation (`itbinus`). No build step, no server, no package manager — open files directly in a browser.

---

## Architecture

### Script load order is critical

Pages that use caching must register base fetch functions on `window.GHASResult` **before** `GHASResult.cache.js` loads. `cache.js` wraps those functions with IndexedDB caching:

```html
<script>
  window.GHASResult = {};
  window.GHASResult.fetchData = async (url, pat) => { /* raw fetch */ };
  window.GHASResult.fetchDataWithHeaders = async (url, pat) => { /* raw fetch + headers */ };
</script>
<script src="GHASResult.cache.js"></script>  <!-- wraps above with IDB cache -->
<script src="shared.js"></script>            <!-- uses window.GHASResult.fetchData -->
```

### Two shared modules

| File | Namespace | Role |
|---|---|---|
| `GHASResult.cache.js` | `window.GHASResult` | IndexedDB cache; wraps all API calls |
| `shared.js` | `window.GHASShared` | Committer-attribution helpers |

### Cluster config

`GHASCluster.json` is the single source of truth mapping clusters → projects → repos. `repos` can be a `string` or `string[]`:

```json
{ "name": "ProjectName", "repos": ["repo-a", "repo-b"] }
```

---

## Key Conventions

### Cache layer (`GHASResult.cache.js`)

- **TTL:** 6 days ± 20% jitter (`randomTtl()`) — avoids thundering herd on expiry
- **IDB database:** `GHASCache`, object store `entries`, keyPath `k`
- **Key format:** `ghas:<url>|u:<fnv1a-hash-of-pat>` — PAT is hashed, never stored raw
- `makeBaseKey()` strips `continuationToken` so all pages of the same request share one IDB key
- `appendCache()` merges paginated results, deduplicating by `alertId`
- `fresh(entry)` checks `entry.exp` (absolute expiry) first, falls back to `entry.ts + TTL_MS`
- Cached payloads have `__compactCache: true` and only store fields needed by the UI (`stripFinding()`)

### Pipeline delta / last-load tracking (`GHASResult.cache.js`)

Three new public functions enable "smart refresh" on `GHASDashboard`:

| Function | Signature | Behaviour |
|---|---|---|
| `setLastFullLoad(ts)` | `(number) → void` | Stores epoch ms under IDB key `ghas:meta:lastFullLoad` |
| `getLastFullLoad()` | `() → number\|null` | Returns stored epoch ms, or `null` |
| `fetchPipelineDelta(org, project, pat, repoNames)` | `(...) → [{repo, definitionName, buildNumber, result, finishTime}]` | Calls `/_apis/build/builds?minTime=<lastFullLoad>` (live, no IDB cache), paginates 500/page, returns only repos that match `repoNames` after sanitise |

**Key detail:** `fetchPipelineDelta` uses `baseJson` (the raw pre-wrap fetch), so pipeline API calls are never cached in IDB.  
**Pipeline project constant:** `GHAS_PIPELINE_PROJECT = 'Github_Advanced_Security_Research'` in `GHASDashboard.html`.

### Smart Load Live Data flow (`GHASDashboard.html`)

`loadLiveData()` is now **smart**:

- **First run** (no `lastFullLoad`): full load of all repos → sets `lastFullLoad` at end
- **Subsequent runs** (has `lastFullLoad`): calls `runPipelineDeltaCheck()` instead — only refreshes repos whose pipeline ran after `lastFullLoad`, then updates `lastFullLoad`

`runPipelineDeltaCheck(pat, setStatus)`:
1. Calls `fetchPipelineDelta` to get changed repos
2. For each: `clearCacheByPattern` + `getGhasResult` → updates `liveData`
3. Populates `deltaBuilds` Map (sanitizedRepo → `{buildNumber, result, finishTime}`)
4. Calls `render()` so badges appear

**CI build badge** (shown in `fillRepoRow` for repos in `deltaBuilds`):
- Rendered as `⎇ #<buildNumber>` before the refresh button
- CSS class `.ci-build-tag.ci-succeeded` / `.ci-failed` / `.ci-partiallySucceeded`
- `deltaBuilds` is a module-level `Map` — persists for the page session

### Alert states

`dismissed` is treated identically to `fixed` (resolved) everywhere:

```js
const isResolved = f => { const s = String(f?.state||'').toLowerCase(); return s === 'fixed' || s === 'dismissed'; };
```

Never treat only `fixed` as resolved — always include `dismissed`.

### Fix rate colouring (Dashboard)

| Threshold | Colour |
|---|---|
| ≥ 40% | Green `#27ae60` |
| ≥ 20% | Orange `#f39c12` |
| < 20% | Red `#e74c3c` |

### Repo name sanitisation

Special characters are normalised before comparison:

```js
const sanitize = n => String(n).replace(/[\s_@#$%^&*!]/g, '-');
```

Always use `sanitize()` when comparing repo names from the cluster config against API response names.

### Committer attribution (`shared.js`)

- `getCommitsForRepo()` tries branches in order: `prod` → `production` → `master` → API default
- Attribution matches a finding's `fixedDate` to the **temporally closest commit**
- Weekly buckets: index `0` = current week, `3` = 3 weeks ago; anything older → `older` bucket
- Week labels use `id-ID` locale (Indonesian)

### Multiple IDB entries per repo

The same repo can have multiple IDB keys (one per distinct PAT hash). When scanning all entries (e.g. in `loadFromCache()` or `getFixedFindingsFromCache()`), always pick the entry with the **highest `ts`** (freshest):

```js
if (!freshestByRepo[repoName] || entryTs > freshestByRepo[repoName].ts) {
    freshestByRepo[repoName] = { ts: entryTs, findings: entry.payload.value };
}
```

---

## Azure DevOps API

- **Base URL:** `https://dev.azure.com/itbinus/{project}/_apis/...`
- **Auth:** `Basic base64(':' + PAT)`
- **API version:** `7.1-preview.1` (used consistently throughout)
- **Pagination:** `continuationToken` query param; handled by `fetchDataWithHeaders`

Key endpoints:

```
/_apis/alert/repositories/{repo}/alerts         ← GHAS findings
/_apis/git/repositories/{repo}/commits          ← commit list for attribution
/_apis/git/repositories/{repo}/refs?filter=heads/  ← branch list
/_apis/projects                                 ← project list
```

---

## Page Roles

| File | Role |
|---|---|
| `GHASDashboard.html` | Main view — cluster cards, fix rates, programmer attribution table |
| `GHASResult.html` | Per-project finding list with per-repo committer table |
| `GHASReport.html` | Full findings table with modal drill-down |
| `GHASExport.html` | CSV export — reads **only from cache**, no live API calls |
| `GHAStrigger.html` | CI/CD pipeline trigger form — no cache/shared dependency |

---

## Hardcoded values to be aware of

```js
const organization    = 'itbinus';                               // GHASDashboard, shared.js
const GHAS_PROJECT_ID = '1f663eb2-dd63-4b51-b000-f0949e3c8ab0'; // GHASDashboard
```

---

## Known Bugs Fixed

### `GHASResult.html` — repo link used project GUID instead of project name

`renderPipelineLink()` was called with `repo.ghasid` (a GUID) as `projectId`, and the link was built as:
```js
`https://dev.azure.com/itbinus/${projectId}/_build?view=folders`
```
This produced broken URLs like `.../0779418d-fcf9-4ef1-d642-08de8e82072f/_build`. Fixed to:
```js
repoLink.href = `https://dev.azure.com/itbinus/${repo.projectName || projectId}/_build?view=folders`;
```
`repo.projectName` is always populated from `allrepojson`. The `|| projectId` fallback is kept for safety.

### Cache TTL constant mismatch (tests only)

`tests/cache.test.js` had `TTL_MS = 2 days` but `GHASResult.cache.js` uses `TTL_MS = 6 days`. The TTL-expiry test was silently passing with a wrong expectation. Fixed: test constant aligned to 6 days.

### Attribution enrichment never written to cache — cache key mismatch (`GHASResult.html`)

The enrichment block constructed the cache key from `alertUrl` (no query params):
```js
const cacheKey = 'ghas:' + new URL(alertUrl).toString() + '|u:' + hash(pat);
```
But `appendCache` / `makeBaseKey` stores findings under a key that **includes** `?api-version=7.2-preview.1&%24top=100` (from the URL passed to `fetchDataWithHeaders`). The keys never matched so `idbGet()` returned `null` and `updateCacheWithAttribution` returned `false` immediately, silently discarding every enrichment.

Fixed by rebuilding the key with the same params `getGhasResult` uses:
```js
const cacheParams = new URLSearchParams({'api-version': '7.2-preview.1', '$top': String(top)});
const canonicalUrl = new URL(`${alertUrl}?${cacheParams.toString()}`);
canonicalUrl.searchParams.delete('continuationToken');
const cacheKey = 'ghas:' + canonicalUrl.toString() + '|u:' + hash(String(currentPat || ''));
```

### `findClosestCommitter` matched commits after the fixedDate (`shared.js`)

The original `Math.abs(target - t)` could attribute a finding to a commit that was pushed **after** the fix was detected (impossible causal relationship). Fixed to prefer the **latest commit whose date ≤ fixedDate**, falling back to the nearest future commit only when all commits post-date the fixedDate (e.g. clock skew or delayed scanning):
```js
// prefer latest commit <= fixedDate; fallback to nearest future commit
```

### `stripByUrl` overwrote cached attribution with `null` on re-fetch (`GHASResult.cache.js`)

When findings were re-fetched from the network the attribution restoration loop wrote `finding.attribution = null` for any alertId found in the old cache even when that old entry had `attribution: null`. A previously computed non-null attribution would be overwritten with `null` if a re-fetch occurred between enrichment and the next read. Fixed to only restore non-null attributions (`if (cached != null)`).

### `attributeFinding` discarded commit message/id/url (`shared.js`)

`findClosestCommitter` already returns the **full raw ADO commit object** (which includes `comment` — the commit message — plus `commitId` and `remoteUrl`), but `attributeFinding()` only kept `{ name, date }`. This meant the app had no way to answer "how was this finding fixed?" even though the data was one property away. Fixed:
```js
function attributeFinding(finding, commits, repoRef) {
  // ...
  return { name, date, message: closest?.comment ?? null, commitId, commitUrl };
}
```
`commitUrl` is built as `https://dev.azure.com/{org}/{projectName}/_git/{repoName}/commit/{commitId}` when the commit object itself has no `remoteUrl`. `enrichCacheWithAttribution(findings, org, projectName, repoName, pat)` now passes a `repoRef = { org, projectName, repoName }` through to `attributeFinding`. **Note:** only newly-enriched findings get `message`/`commitId`/`commitUrl` — existing cached attributions (`{name, date}` only) are not retroactively upgraded unless that repo's cache entry is cleared and refetched.

---

## GHASDashboard — Fixing-progress chart: date filter + JSON export

### New UI controls (`GHASDashboard.html`)

A control bar (`#fixingActivityControls`) sits above `#fixingActivityContainer`:
- `#fixingStartDate` / `#fixingEndDate` — native `<input type="date">`, filter on `fixedDate`
- **Apply Filter** → `applyFixingActivityFilter()` — reads the two inputs into module-level `fixingDateRange`, re-renders the chart via `loadFixingActivityFragment()`
- **Clear** → `clearFixingActivityFilter()` — resets inputs and `fixingDateRange`, re-renders unfiltered
- **⬇ Export Findings JSON** → `exportFixingFindingsJSON()` — downloads a JSON file of fixed findings scoped to the current `fixingDateRange` (or all data if unset)

`loadFixingActivityFragment()` now forwards `fixingDateRange.{startDate,endDate}` into `FixingActivity.renderDailyActivity(container, { startDate, endDate, ... })`.

### `fragments/fixing-activity.js` additions

| Function | Purpose |
|---|---|
| `extractCveCwe(finding)` | Scans `finding.tools[].rules[].tag/tags` (and top-level `tags`) for `CVE-YYYY-NNNNN` / `CWE-NNN` patterns — same regex approach as `GHASResult.html`'s `getPrimarySecurityTagFromRules` |
| `filterByDateRange(findings, startDate, endDate)` | Filters to an inclusive `[startDate 00:00Z, endDate 23:59:59Z]` window, matched against `fixedDate`, falling back to `lastSeenDate` for active findings that have no `fixedDate`; either bound may be `null` |
| `buildRepoInfoMap(clusterConfig)` | Returns `sanitizedRepoName -> { project, cluster }` from `GHASCluster.json`, for enriching exports with project/cluster names |
| `getAllFindingsWithProgrammers(cacheEntries)` | Like `getFixedFindingsWithProgrammers` but returns **every** finding regardless of `state` (open/active, fixed, dismissed) |
| `exportFindingsJSON(cacheEntries, clusterConfig, startDate, endDate)` | Builds the full export dataset from `getAllFindingsWithProgrammers` (all statuses, not just fixed/dismissed): `{ findingsId, project, cluster, repo, title, severity, alertType, cve, cwe, status, fixedDate, lastSeenDate, attribution }`, date-filtered |

`getFixedFindingsWithProgrammers()` (used only by the chart, which is about *fixing* activity) and `getAllFindingsWithProgrammers()` (used by export, so users get open + fixed + dismissed findings) both carry `lastSeenDate`, `status` (the finding's `state`), `cve`, `cwe`, and the **full** `attribution` object (not just `.name`) so the export has everything needed for offline "who fixed what, and how" analysis. Active findings have `fixedDate: null` and typically `attribution: null` (nothing to attribute yet).

The exported JSON download is named `ghas-fixing-findings[_<start>_to_<end>].json` and wrapped with `{ exportedAt, startDate, endDate, count, findings }`.

---

## GHASResult — cross-repo "same case" hover insight

Hovering over any finding's `<a class="findings ...">` tag in `GHASResult.html` shows a tooltip with the **distinct programmers and projects** where the same case (matched by CVE, falling back to CWE, falling back to `alertType+title`) was previously fixed/dismissed **anywhere in the shared cache** — not just the current repo.

**Zero new API calls**: the whole feature reads only `window.GHASResult.getAllCacheEntries()` (the same IndexedDB `GHASCache` store shared across `GHASDashboard.html`, `GHASResult.html`, etc.), so if you first ran "Load Live Data" on `GHASDashboard`, `GHASResult.html` immediately benefits from that cache without refetching anything.

New helpers in `GHASResult.html` (module-level, defined right after `let currentPat = ''`):

| Function | Purpose |
|---|---|
| `getRepoProjectMap()` | Lazily parses the embedded `allrepojson` into `sanitizedRepoName -> projectName`, memoized in `__repoProjectMapCache` |
| `getFindingCaseKey(finding, taxonomy)` | Case-identity key: `CVE:<sorted cves>` \| `CWE:<sorted cwes>` \| `TITLE:<alertType>\|<title>` (in that priority order) |
| `buildCaseIndex(forceRefresh)` | Scans **every** cached `.../repositories/{repo}/alerts` entry (regardless of which page cached it), keeps only `fixed`/`dismissed` findings, and builds `Map<caseKey, {programmers:Set, projects:Set, repos:Set, count}>`. Memoized in `__caseIndexCache` — only rebuilt when `invalidateCaseIndex()` is called |
| `invalidateCaseIndex()` | Called once at the end of each successful `loadFindingsIntoCell()` (right after `findingsCell.dataset.loaded = '1'`) since that repo's cache (findings + attribution) just changed |
| `attachCaseInsightHover(tagEl, finding, taxonomy)` | Wires `mouseenter`/`mousemove`/`mouseleave` on a finding's tag to lazily build/reuse the index and render the tooltip via `showCaseTooltip()` |

The tooltip (`#caseInsightTooltip`, a single reused fixed-position `div`) shows: **Fixed by** (distinct programmer names), **Seen in projects** (distinct project names), and an occurrence/repo count — or "No matching fixed/dismissed case found in loaded cache" if the index has nothing for that case yet (e.g. that repo/project hasn't been loaded into cache by any page).

