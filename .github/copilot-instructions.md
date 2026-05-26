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

- **TTL:** 2 days ± 20% jitter (`randomTtl()`) — avoids thundering herd on expiry
- **IDB database:** `GHASCache`, object store `entries`, keyPath `k`
- **Key format:** `ghas:<url>|u:<fnv1a-hash-of-pat>` — PAT is hashed, never stored raw
- `makeBaseKey()` strips `continuationToken` so all pages of the same request share one IDB key
- `appendCache()` merges paginated results, deduplicating by `alertId`
- `fresh(entry)` checks `entry.exp` (absolute expiry) first, falls back to `entry.ts + TTL_MS`
- Cached payloads have `__compactCache: true` and only store fields needed by the UI (`stripFinding()`)

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
