/**
 * shared.js — shared committer-attribution helpers for GHAS pages.
 * Depends on: window.GHASResult.fetchData (registered by cache.js before this loads)
 * Exports:    window.GHASShared.{ findClosestCommitter, attributeFixedFindings, getCommitsForRepo }
 */
(function () {
    const ORG = 'itbinus';

    /**
     * Find the commit whose date is closest to the given fixedDate.
     * @param {string} fixedDate  ISO date string
     * @param {Array}  commits    Azure DevOps commit objects
     * @returns {object|null}
     */
    function findClosestCommitter(fixedDate, commits) {
        if (!commits?.length || !fixedDate) return null;
        const target = new Date(fixedDate).getTime();
        if (isNaN(target)) return null;

        // Prefer the latest commit whose date is <= fixedDate (the commit that caused the fix).
        // Fall back to the absolute-closest commit when all commits post-date the fixedDate
        // (e.g. clock skew or delayed scanning).
        let best = null, bestT = -Infinity;
        let fallback = null, fallbackDiff = Infinity;
        for (const commit of commits) {
            const t = new Date(commit.author?.date || commit.committer?.date).getTime();
            if (isNaN(t)) continue;
            if (t <= target) {
                if (t > bestT) { bestT = t; best = commit; }
            } else {
                const diff = t - target;
                if (diff < fallbackDiff) { fallbackDiff = diff; fallback = commit; }
            }
        }
        return best ?? fallback;
    }

    /**
     * Given a list of fixed findings and commits, return attribution by committer name.
     * @param {Array} fixedFindings  findings where state==='fixed' or fixedDate is set
     * @param {Array} commits        commit list from getCommitsForRepo
     * @returns {{ [name]: { critical, high, medium, low, latestDate } }}
     */
    function attributeFixedFindings(fixedFindings, commits) {
        const knownSev = ['critical', 'high', 'medium', 'low'];
        const byCommitter = {};
        for (const f of fixedFindings) {
            const fState = String(f?.state || '').toLowerCase();
            if (fState !== 'fixed' && fState !== 'dismissed') continue; // skip reopened/active
            const closest = findClosestCommitter(f.fixedDate, commits);
            const name = closest?.author?.name || closest?.committer?.name || 'Unknown';
            const sev = String(f?.severity || '').toLowerCase();
            const fd = f.fixedDate ? new Date(f.fixedDate) : null;
            if (!byCommitter[name]) byCommitter[name] = { critical: 0, high: 0, medium: 0, low: 0, latestDate: null };
            if (knownSev.includes(sev)) byCommitter[name][sev]++;
            if (fd && !isNaN(fd) && (!byCommitter[name].latestDate || fd > byCommitter[name].latestDate))
                byCommitter[name].latestDate = fd;
        }
        return byCommitter;
    }

    /**
     * Fetch commits for a repo, trying prod → production → master → default branch.
     * @param {string} org         Azure DevOps organisation
     * @param {string} projectName ADO project name
     * @param {string} repoName    repository name
     * @param {string} pat         Personal Access Token
     * @returns {{ value: Array, branch: string|null }}
     */
    async function getCommitsForRepo(org, projectName, repoName, pat) {
        try {
            const fetchData = window.GHASResult?.fetchData;
            if (typeof fetchData !== 'function') {
                console.warn('[shared.js] window.GHASResult.fetchData not available');
                return { value: [], branch: null };
            }

            const base = `https://dev.azure.com/${org}/${encodeURIComponent(projectName)}` +
                         `/_apis/git/repositories/${encodeURIComponent(repoName)}`;
            const refsUrl = `${base}/refs?filter=heads/&api-version=7.1-preview.1`;

            let actualBranches = [];
            try {
                const refsData = await fetchData(refsUrl, pat);
                actualBranches = (refsData?.value || []).map(r => r.name.replace('refs/heads/', ''));
            } catch {}

            for (const priority of ['prod', 'production', 'master']) {
                const branch = actualBranches.find(b => b.toLowerCase() === priority) ?? priority;
                try {
                    const params = new URLSearchParams({
                        'api-version': '7.1-preview.1',
                        'searchCriteria.itemVersion.versionType': 'Branch',
                        'searchCriteria.itemVersion.version': branch
                    });
                    const data = await fetchData(`${base}/commits?${params}`, pat);
                    const commits = Array.isArray(data?.value) ? data.value : [];
                    if (commits.length > 0) return { value: commits, branch };
                } catch {}
            }

            // Fallback: default branch
            const fallback = await fetchData(`${base}/commits?api-version=7.1-preview.1`, pat);
            return { value: Array.isArray(fallback?.value) ? fallback.value : [], branch: null };
        } catch {
            return { value: [], branch: null };
        }
    }

    /**
     * Get the Monday of the week containing `date`.
     */
    function getWeekStart(date) {
        const d = new Date(date);
        d.setHours(0, 0, 0, 0);
        const day = d.getDay(); // 0=Sun
        d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
        return d;
    }

    /**
     * Format a week as "19-25 Mei 26" or "28 Apr-4 Mei 26".
     */
    function formatWeekLabel(weekStart) {
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 6);
        const loc = 'id-ID';
        const endStr = weekEnd.toLocaleDateString(loc, { day: 'numeric', month: 'short', year: '2-digit' });
        if (weekStart.getMonth() === weekEnd.getMonth()) {
            return `${weekStart.getDate()}-${endStr}`;
        }
        const startStr = weekStart.toLocaleDateString(loc, { day: 'numeric', month: 'short' });
        return `${startStr}-${endStr}`;
    }

    /**
     * Like attributeFixedFindings but buckets by week.
     * Returns { [name]: { weeks: [{weekStart,label,critical,high,medium,low}×4], older:{label,...} } }
     * weeks[0] = current week, weeks[3] = 3 weeks ago. "older" = everything before that.
     */
    function attributeFixedFindingsByWeek(fixedFindings, commits) {
        const knownSev = ['critical', 'high', 'medium', 'low'];
        const currentWeekStart = getWeekStart(new Date());
        // Build 4 absolute week starts (Mon): 0=this week, 1=last, 2=2ago, 3=3ago
        const weekStarts = Array.from({ length: 4 }, (_, i) => {
            const d = new Date(currentWeekStart);
            d.setDate(d.getDate() - i * 7);
            return d;
        });
        const olderLabel = `< ${weekStarts[3].toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: '2-digit' })}`;

        const byCommitter = {};
        const zeroBuckets = () => ({
            weeks: weekStarts.map(ws => ({ weekStart: ws, label: formatWeekLabel(ws), critical: 0, high: 0, medium: 0, low: 0 })),
            older: { label: olderLabel, critical: 0, high: 0, medium: 0, low: 0 }
        });

        for (const f of fixedFindings) {
            const fState = String(f?.state || '').toLowerCase();
            if (fState !== 'fixed' && fState !== 'dismissed') continue; // skip reopened/active
            const closest = findClosestCommitter(f.fixedDate, commits);
            const name = closest?.author?.name || closest?.committer?.name || 'Unknown';
            const sev = String(f?.severity || '').toLowerCase();
            if (!knownSev.includes(sev)) continue;
            const fd = f.fixedDate ? new Date(f.fixedDate) : null;

            if (!byCommitter[name]) byCommitter[name] = zeroBuckets();

            // No fixedDate → can't determine week, fall into older bucket
            if (!fd || isNaN(fd)) {
                byCommitter[name].older[sev]++;
                continue;
            }

            const fdTime = fd.getTime();
            let placed = false;
            for (let i = 0; i < 4; i++) {
                const ws = weekStarts[i].getTime();
                const we = ws + 7 * 24 * 60 * 60 * 1000;
                if (fdTime >= ws && fdTime < we) {
                    byCommitter[name].weeks[i][sev]++;
                    placed = true;
                    break;
                }
            }
            if (!placed) byCommitter[name].older[sev]++;
        }
        return byCommitter;
    }

    /**
     * Attribute a single finding with programmer name, commit date, and the commit's
     * message/id/url — this is the "how it was fixed" detail (the commit message is
     * the only place that documents what change resolved the finding).
     * @param {object} finding  finding with fixedDate
     * @param {Array}  commits  commit list from getCommitsForRepo (raw ADO commit objects)
     * @param {object} [repoRef] optional { org, projectName, repoName } to build a web commit URL
     * @returns {{ name, date, message, commitId, commitUrl }|null}  attribution object or null
     */
    function attributeFinding(finding, commits, repoRef) {
      if (!finding || !finding.fixedDate || !commits?.length) return null;
      const closest = findClosestCommitter(finding.fixedDate, commits);
      if (!closest) return null;
      const commitId = closest?.commitId || null;
      let commitUrl = closest?.remoteUrl || null;
      if (!commitUrl && commitId && repoRef?.org && repoRef?.projectName && repoRef?.repoName) {
        commitUrl = `https://dev.azure.com/${repoRef.org}/${encodeURIComponent(repoRef.projectName)}` +
                    `/_git/${encodeURIComponent(repoRef.repoName)}/commit/${commitId}`;
      }
      return {
        name: closest?.author?.name || closest?.committer?.name || 'Unknown',
        date: closest?.author?.date || closest?.committer?.date || null,
        message: closest?.comment || null,
        commitId,
        commitUrl
      };
    }

    /**
     * Enrich findings with attribution from commits (for cache pre-computation).
     * Only attributes findings that don't already have attribution and are fixed/dismissed.
     * @param {Array}  findings      array of findings (with fixedDate)
     * @param {string} org           Azure DevOps organisation
     * @param {string} projectName   ADO project name
     * @param {string} repoName      repository name
     * @param {string} pat           Personal Access Token
     * @returns {Array}  enriched findings with attribution added
     */
    async function enrichCacheWithAttribution(findings, org, projectName, repoName, pat) {
      if (!Array.isArray(findings) || findings.length === 0) return findings;
      
      try {
        const { value: commits } = await getCommitsForRepo(org, projectName, repoName, pat);
        if (!commits?.length) return findings; // No commits, return as-is
        
        const repoRef = { org, projectName, repoName };
        for (const f of findings) {
          // Only attribute if: no existing attribution, is fixed/dismissed, has fixedDate
          if (!f.attribution) {
            const state = String(f?.state || '').toLowerCase();
            if ((state === 'fixed' || state === 'dismissed') && f.fixedDate) {
              f.attribution = attributeFinding(f, commits, repoRef);
            }
          }
        }
        
        return findings;
      } catch (e) {
        console.warn('[shared.js] enrichCacheWithAttribution error:', e);
        return findings; // Return as-is on error
      }
    }

    window.GHASShared = { findClosestCommitter, attributeFixedFindings, getCommitsForRepo,
                          attributeFixedFindingsByWeek, attributeFinding, enrichCacheWithAttribution };
})();
