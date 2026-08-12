/**
 * fragments/case-insight.js
 * Shared "same case" cross-repo comparison helpers, used by both GHASResult.html
 * (per-finding hover) and GHASDashboard.html (cumulative-count cell hover + pie).
 *
 * A "case" = a distinct vulnerability, identified primarily by CVE, falling back to
 * CWE, then to alertType+title. For dependency findings, the affected component
 * (from logicalLocations[kind="component"]) is folded into the key so the same
 * CVE/CWE showing up in a different package isn't treated as the same case.
 *
 * Everything here is pure / DOM-light (only the tooltip helpers touch the DOM) and
 * reads exclusively from already-cached findings (window.GHASResult.getAllCacheEntries()
 * elsewhere) — no network calls originate from this file.
 *
 * Dependencies: none (framework-agnostic). Exposes window.CaseInsight.
 */
(() => {
  window.CaseInsight = window.CaseInsight || {};

  const isResolved = f => {
    const s = String(f?.state || '').toLowerCase();
    return s === 'fixed' || s === 'dismissed';
  };

  /**
   * Extract CVE/CWE tags from a (possibly stripped/cached) finding's tool rule tags.
   * @returns {{primary:string, cve:string[], cwe:string[], rawTags:Array}}
   */
  function getPrimarySecurityTagFromRules(finding) {
    const cve = [];
    const cwe = [];
    const seenCve = new Set();
    const seenCwe = new Set();
    const rawTags = [];

    const pushTags = (v) => {
      if (!v) return;
      if (Array.isArray(v)) rawTags.push(...v);
      else rawTags.push(v);
    };

    // 1) Preferred shape: finding.tools[].rules[].tag / tags
    if (Array.isArray(finding?.tools)) {
      for (const tool of finding.tools) {
        if (!Array.isArray(tool?.rules)) continue;
        for (const rule of tool.rules) {
          pushTags(rule?.tag);
          pushTags(rule?.tags);
          pushTags(rule?.properties?.tag);
          pushTags(rule?.properties?.tags);
        }
      }
    }

    // 2) Existing/fallback shapes
    if (Array.isArray(finding?.rules)) {
      for (const rule of finding.rules) {
        pushTags(rule?.tag);
        pushTags(rule?.tags);
        pushTags(rule?.properties?.tag);
        pushTags(rule?.properties?.tags);
      }
    }
    if (finding?.rule && typeof finding.rule === 'object') {
      pushTags(finding.rule?.tag);
      pushTags(finding.rule?.tags);
      pushTags(finding.rule?.properties?.tag);
      pushTags(finding.rule?.properties?.tags);
    }

    // 3) Last fallback
    pushTags(finding?.tags);
    pushTags(finding?.properties?.tags);

    for (const t of rawTags) {
      const text = typeof t === 'string'
        ? t
        : (t?.name || t?.id || t?.value || JSON.stringify(t) || '');

      if (!text) continue;
      const up = text.toUpperCase();

      // supports CVE-2024-1234, CVE_2024_1234, CVE:2024:1234, etc.
      const cveMatches = up.match(/CVE[-_:\s]?(\d{4})[-_:\s]?(\d{4,7})/g) || [];
      const cweMatches = up.match(/CWE[-_:\s]?(\d{1,5})/g) || [];

      for (const m of cveMatches) {
        const n = m.match(/(\d{4}).*?(\d{4,7})/);
        if (!n) continue;
        const id = `CVE-${n[1]}-${n[2]}`;
        if (!seenCve.has(id)) { seenCve.add(id); cve.push(id); }
      }

      for (const m of cweMatches) {
        const n = m.match(/(\d{1,5})/);
        if (!n) continue;
        const id = `CWE-${n[1]}`;
        if (!seenCwe.has(id)) { seenCwe.add(id); cwe.push(id); }
      }
    }

    const primary = cve[0] || cwe[0] || '';
    return { primary, cve, cwe, rawTags };
  }

  /**
   * For dependency findings, the vulnerable package (logicalLocations entries with
   * kind "component", e.g. "NuGet system.drawing.common 5.0.0") disambiguates cases
   * that otherwise share the same CVE/CWE but live in different packages.
   * @returns {string} sorted, de-duplicated, comma-joined component names (or '')
   */
  function getFindingComponentKey(finding) {
    const components = (finding?.logicalLocations || [])
      .filter(l => l?.kind === 'component')
      .map(l => l.fullyQualifiedName)
      .filter(Boolean);
    return components.length ? Array.from(new Set(components)).sort().join(',') : '';
  }

  /**
   * Identify "the same case" primarily by CVE, falling back to CWE, then to
   * alertType+title when neither taxonomy tag is available. For dependency findings,
   * the affected component is appended so the same CVE/CWE in a different package
   * isn't treated as the same case (more accurate cross-repo comparison).
   * @param {Object} finding
   * @param {{cve:string[], cwe:string[]}} [taxonomy] - pass a precomputed result of
   *   getPrimarySecurityTagFromRules(finding) to avoid recomputation; otherwise derived.
   */
  function getFindingCaseKey(finding, taxonomy) {
    const tax = taxonomy || getPrimarySecurityTagFromRules(finding);
    const componentKey = getFindingComponentKey(finding);
    const componentSuffix = componentKey ? `|COMP:${componentKey}` : '';
    if (tax?.cve?.length) return 'CVE:' + Array.from(tax.cve).sort().join(',') + componentSuffix;
    if (tax?.cwe?.length) return 'CWE:' + Array.from(tax.cwe).sort().join(',') + componentSuffix;
    const type = finding?.alertType || '';
    const title = String(finding?.title || '').trim().toLowerCase();
    return title ? `TITLE:${type}|${title}${componentSuffix}` : null;
  }

  /**
   * Build the cross-repo index of fixed/dismissed cases from a set of cache entries.
   * Pure function — callers own memoization/invalidation (each page's cache lifecycle
   * differs slightly).
   * @param {Array} entries - from window.GHASResult.getAllCacheEntries()
   * @param {Map<string,string>} repoProjectMap - sanitizedRepoName -> projectName
   * @returns {Map<string, {programmers:Set, projects:Set, repos:Set, count:number}>}
   */
  function buildCaseIndex(entries, repoProjectMap) {
    const index = new Map();
    const projectMap = repoProjectMap || new Map();

    for (const entry of (entries || [])) {
      const key = entry.key || '';
      const urlMatch = key.match(/\/repositories\/([^/]+)\/alerts/i);
      if (!urlMatch) continue; // only GHAS alert entries, skip project lists / commits / etc.
      const sanitizedRepo = urlMatch[1];
      const projectName = projectMap.get(sanitizedRepo) || null;

      const findings = entry.data?.payload?.value;
      if (!Array.isArray(findings)) continue;

      for (const f of findings) {
        if (!isResolved(f)) continue; // only "occurred and fixed" cases

        const taxonomy = getPrimarySecurityTagFromRules(f);
        const caseKey = getFindingCaseKey(f, taxonomy);
        if (!caseKey) continue;

        if (!index.has(caseKey)) {
          index.set(caseKey, { programmers: new Set(), projects: new Set(), repos: new Set(), count: 0 });
        }
        const bucket = index.get(caseKey);
        const programmer = f?.attribution?.name;
        if (programmer) bucket.programmers.add(programmer);
        if (projectName) bucket.projects.add(projectName);
        bucket.repos.add(sanitizedRepo);
        bucket.count++;
      }
    }
    return index;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ── Generic reusable hover tooltip (single reused fixed-position div per id) ──
  const __tooltipEls = new Map();
  function getTooltipEl(id) {
    if (__tooltipEls.has(id)) return __tooltipEls.get(id);
    const el = document.createElement('div');
    el.id = id;
    el.style.cssText = 'position:fixed;z-index:9999;display:none;max-width:360px;' +
      'background:#1e2a38;color:#f0f0f0;font-size:10pt;padding:8px 10px;border-radius:6px;' +
      'box-shadow:0 4px 12px rgba(0,0,0,0.28);pointer-events:none;line-height:1.5;';
    document.body.appendChild(el);
    __tooltipEls.set(id, el);
    return el;
  }

  function showTooltip(id, x, y, html) {
    const el = getTooltipEl(id);
    el.innerHTML = html;
    el.style.display = 'block';
    el.style.left = (x + 12) + 'px';
    el.style.top = (y + 12) + 'px';
    requestAnimationFrame(() => {
      const rect = el.getBoundingClientRect();
      if (rect.right > window.innerWidth) el.style.left = Math.max(0, window.innerWidth - rect.width - 12) + 'px';
      if (rect.bottom > window.innerHeight) el.style.top = Math.max(0, window.innerHeight - rect.height - 12) + 'px';
    });
  }

  function hideTooltip(id) {
    const el = __tooltipEls.get(id);
    if (el) el.style.display = 'none';
  }

  window.CaseInsight.isResolved = isResolved;
  window.CaseInsight.getPrimarySecurityTagFromRules = getPrimarySecurityTagFromRules;
  window.CaseInsight.getFindingComponentKey = getFindingComponentKey;
  window.CaseInsight.getFindingCaseKey = getFindingCaseKey;
  window.CaseInsight.buildCaseIndex = buildCaseIndex;
  window.CaseInsight.escapeHtml = escapeHtml;
  window.CaseInsight.getTooltipEl = getTooltipEl;
  window.CaseInsight.showTooltip = showTooltip;
  window.CaseInsight.hideTooltip = hideTooltip;
})();
