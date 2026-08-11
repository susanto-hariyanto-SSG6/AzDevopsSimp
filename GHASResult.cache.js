(() => {
  window.GHASResult = window.GHASResult || {};
  const baseJson            = window.GHASResult.fetchData;
  const baseJsonWithHeaders = window.GHASResult.fetchDataWithHeaders;
  if (typeof baseJson !== 'function' || typeof baseJsonWithHeaders !== 'function') return;

  const DB_NAME = 'GHASCache';
  const STORE   = 'entries';
  const KEY_PFX = 'ghas:';
  const TTL_MS  = 6 * 24 * 60 * 60 * 1000;  // 6 days
  const JITTER  = 0.2;                        // ±20%

  // ── IndexedDB helpers ──────────────────────────────────────────────────────
  let _db = null;
  function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore(STORE, { keyPath: 'k' });
      req.onsuccess  = e => { _db = e.target.result; resolve(_db); };
      req.onerror    = e => reject(e.target.error);
    });
  }

  async function idbGet(key) {
    try {
      const db = await openDB();
      return await new Promise((res, rej) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
        req.onsuccess = e => {
          const result = e.target.result?.v ?? null;
          if (result) console.log('[idbGet]', key.substring(0, 40), '...found, exp:', result.exp, 'now:', Date.now(), 'fresh:', Date.now() < (result.exp || Infinity));
          res(result);
        };
        req.onerror   = e => rej(e.target.error);
      });
    } catch { return null; }
  }

  async function idbSet(key, value) {
    try {
      const db = await openDB();
      await new Promise((res, rej) => {
        const req = db.transaction(STORE, 'readwrite').objectStore(STORE).put({ k: key, v: value });
        req.onsuccess = () => res();
        req.onerror   = e => rej(e.target.error);
      });
    } catch {}
  }

  async function idbDel(key) {
    try {
      const db = await openDB();
      await new Promise((res, rej) => {
        const req = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key);
        req.onsuccess = () => res();
        req.onerror   = e => rej(e.target.error);
      });
    } catch {}
  }

  async function idbGetAll() {
    try {
      const db = await openDB();
      return await new Promise((res, rej) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
        req.onsuccess = e => res(e.target.result ?? []);
        req.onerror   = e => rej(e.target.error);
      });
    } catch { return []; }
  }

  // ── Utility ────────────────────────────────────────────────────────────────
  function randomTtl() {
    const spread = Math.floor(TTL_MS * JITTER);
    return TTL_MS - spread + Math.floor(Math.random() * spread * 2);
  }

  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
    }
    return (h >>> 0).toString(36);
  }

  function makeKey(url, pat) { return KEY_PFX + url + '|u:' + hash(String(pat || '')); }

  function makeBaseKey(url, pat) {
    const u = new URL(url);
    u.searchParams.delete('continuationToken');
    return makeKey(u.toString(), pat);
  }

  function fresh(entry) {
    if (!entry) return false;
    if (typeof entry.exp === 'number') return Date.now() < entry.exp;
    return Date.now() - Number(entry.ts || 0) < TTL_MS;
  }

  // ── Strip helpers (compact storage) ───────────────────────────────────────
  function stripFinding(f) {
    const location = f?.physicalLocations?.[0] || f?.physicalLocation?.[0] || f?.physicalLocation || {};
    const tools = Array.isArray(f?.tools) ? f.tools.map(t => ({
      name: t?.name,
      rules: Array.isArray(t?.rules) ? t.rules.map(r => ({
        tag: r?.tag, tags: r?.tags,
        properties: r?.properties ? { tag: r.properties.tag, tags: r.properties.tags } : undefined
      })) : []
    })) : [];

    // For dependency findings, only the "component" logicalLocation is the actual
    // vulnerable package (e.g. "NuGet system.drawing.common 5.0.0") — the
    // "rootDependency" entries are just the dependency chain, not needed for display.
    const logicalLocations = Array.isArray(f?.logicalLocations)
      ? f.logicalLocations
          .filter(l => l?.kind === 'component')
          .map(l => ({ fullyQualifiedName: l.fullyQualifiedName, kind: l.kind }))
      : [];

    const result = {
      alertId: f?.alertId, title: f?.title, severity: f?.severity,
      state: f?.state, alertType: f?.alertType,
      lastSeenDate: f?.lastSeenDate ?? null, fixedDate: f?.fixedDate ?? null,
      physicalLocations: [location], logicalLocations, tools,
      attribution: f?.attribution ?? null
    };
     
    return result;
  }

  async function stripByUrl(url, data, existingCached) {
    if (/_apis\/alert\/repositories\/.+\/alerts/i.test(url)) {

      const stripped = Array.isArray(data?.value) ? data.value.map(f => {
        console.log('[stripByUrl] Stripping finding:', {
          alertId: f?.alertId,
          originalState: f?.state,
          originalSeverity: f?.severity,
          hasFixedDate: !!f?.fixedDate,
          hasTools: Array.isArray(f?.tools)
        });
        return stripFinding(f);
      }) : [];
      
      // Preserve non-null attribution from existing cache — don't overwrite with null,
      // which would erase attribution that was previously computed and stored.
      if (existingCached?.payload?.value && Array.isArray(existingCached.payload.value)) {
        const attributionMap = new Map(existingCached.payload.value.map(f => [String(f?.alertId ?? ''), f?.attribution]));
        for (const finding of stripped) {
          const cached = attributionMap.get(String(finding.alertId ?? ''));
          if (cached != null) finding.attribution = cached;
        }
      }
      
      const result = { __compactCache: true, value: stripped };
      return result;
    }
    if (/\/_apis\/projects(\?|$)/i.test(url)) {
      return { __compactCache: true, value: Array.isArray(data?.value)
        ? data.value.map(p => ({ id: p?.id, name: p?.name, description: p?.description })) : [] };
    }
    return { __compactCache: true, ...(data || {}) };
  }

  // ── Append / merge pages into IDB ─────────────────────────────────────────
  async function appendCache(key, newItems) {
    try {
      const now  = Date.now();
      const hit  = await idbGet(key);
      const existing = (hit?.payload?.value && Array.isArray(hit.payload.value)) ? hit.payload.value : [];
      const byId = new Map(existing.map(f => [String(f?.alertId ?? ''), f]));
      let addedCount = 0, updatedCount = 0;

      for (const item of newItems) {
        const id = String(item?.alertId ?? '');
        if (!id) continue;
        const prev = byId.get(id);

        if (!prev) {
          byId.set(id, item);
          addedCount++;
          continue;
        }

        // Merge: always refresh with the freshly-fetched fields (state, fixedDate, etc.) so a
        // finding that has changed state since it was first cached (e.g. reopened after being
        // fixed, or newly fixed) is reflected — appendCache used to be add-only and would keep
        // a stale "fixed" state forever once cached, wrongly counting a reopened finding as fixed.
        const newState = String(item.state || '').toLowerCase();
        const stillResolved = newState === 'fixed' || newState === 'dismissed';
        // Preserve previously-computed attribution only while the finding remains fixed/dismissed;
        // clear it if the finding reopened (active again) so it's never shown as "already fixed".
        item.attribution = stillResolved ? (item.attribution ?? prev.attribution ?? null) : null;

        if (String(prev.state || '').toLowerCase() !== newState) updatedCount++;
        byId.set(id, item);
      }

      await idbSet(key, { ts: now, exp: now + randomTtl(), payload: { value: Array.from(byId.values()) } });
    } catch (e) {
      console.error('[appendCache] Error:', e.message);
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  window.GHASResult.fetchData = async (url, pat) => {
    const key = makeKey(url, pat);
    const hit = await idbGet(key);
    if (fresh(hit)) return hit.payload;
    const full = await baseJson(url, pat);
    const now  = Date.now();
    const stripped = await stripByUrl(url, full, hit);
    await idbSet(key, { ts: now, exp: now + randomTtl(), payload: stripped });
    return full;
  };

  window.GHASResult.fetchDataWithHeaders = async (url, pat) => {
    const baseKey       = makeBaseKey(url, pat);
    const isContinuation = new URL(url).searchParams.has('continuationToken');

    if (!isContinuation) {
      const hit = await idbGet(baseKey);
      if (fresh(hit)) {
        return { data: { __compactCache: true, value: hit.payload?.value ?? [] }, headers: { get: () => null }, __fromCache: true };
      }
    }

    const network = await baseJsonWithHeaders(url, pat);
    const existing = !isContinuation ? await idbGet(baseKey) : null;
    const stripped = await stripByUrl(url, network.data, existing);
    await appendCache(baseKey, Array.isArray(stripped?.value) ? stripped.value : []);
    return { data: network.data, headers: network.headers, __fromCache: false };
  };

  // Update cache findings with attribution data
  window.GHASResult.updateCacheWithAttribution = async (key, enrichedFindings) => {
    try {
      const hit = await idbGet(key);
      if (!hit) return false;
      const payload = hit.payload || { value: [] };
      
      // Create attribution map from enriched findings
      const attributionMap = new Map(enrichedFindings.map(f => [String(f?.alertId ?? ''), f?.attribution]));
      
      // Update existing cache entries with attribution
      if (Array.isArray(payload.value)) {
        for (const finding of payload.value) {
          const id = String(finding?.alertId ?? '');
          if (attributionMap.has(id)) {
            finding.attribution = attributionMap.get(id);
          }
        }
      }
      
      // CRITICAL: Preserve original timestamps (don't create new ts!)
      await idbSet(key, { ts: hit.ts, exp: hit.exp, payload });
      return true;
    } catch (e) { 
      console.error('[cache] updateCacheWithAttribution failed:', e);
      return false; 
    }
  };

  window.GHASResult.clearCache = async () => {
    try {
      const all = await idbGetAll();
      await Promise.all(all.filter(e => String(e.k).startsWith(KEY_PFX)).map(e => idbDel(e.k)));
      return true;
    } catch { return false; }
  };

  window.GHASResult.clearCacheByPattern = async (pattern) => {
    try {
      const all = await idbGetAll();
      await Promise.all(all.filter(e => String(e.k).startsWith(KEY_PFX) && String(e.k).includes(pattern)).map(e => idbDel(e.k)));
      return true;
    } catch { return false; }
  };

  // Used by GHASDashboard to scan all cached findings
  window.GHASResult.getAllCacheEntries = async () => {
    try {
      const all = await idbGetAll();
      const result = [];
      
      for (const entry of all) {
        // Skip non-GHAS entries
        if (!String(entry.k).startsWith(KEY_PFX)) continue;
        
        // Ensure entry.v exists
        if (!entry.v) {
          console.warn('[getAllCacheEntries] Skipping entry with no value:', entry.k);
          continue;
        }
        
        // Validate payload exists (don't filter by freshness here - let caller decide)
        if (!entry.v?.payload) {
          console.warn('[getAllCacheEntries] Skipping entry with no payload:', entry.k);
          continue;
        }
        
        result.push({ key: entry.k, data: entry.v });
      }
      
      return result;
    } catch (e) {
      console.error('[getAllCacheEntries] Error:', e);
      return [];
    }
  };


  // ── Pipeline delta / last-load timestamp ────────────────────────────────
  const META_LAST_LOAD_KEY = 'ghas:meta:lastFullLoad';

  window.GHASResult.setLastFullLoad = async (ts) => {
    await idbSet(META_LAST_LOAD_KEY, { ts: Number(ts) });
  };

  window.GHASResult.getLastFullLoad = async () => {
    const hit = await idbGet(META_LAST_LOAD_KEY);
    return (hit && typeof hit.ts === 'number') ? hit.ts : null;
  };

  // Returns [{repo (sanitized), definitionName, buildNumber, result, finishTime}, ...]
  // for repos in repoNames whose pipeline completed after the last full load.
  // Always fetches live — bypasses IDB cache intentionally.
  window.GHASResult.fetchPipelineDelta = async (org, project, pat, repoNames) => {
    const lastLoad = await window.GHASResult.getLastFullLoad();
    if (!lastLoad) return [];

    const sanFn = n => String(n).replace(/[\s_@#$%^&*!]/g, '-').toLowerCase();
    const repoSet = new Set(repoNames.map(sanFn));
    const since = new Date(lastLoad).toISOString();
    const allBuilds = [];
    let skip = 0;
    const top = 500;

    while (true) {
      const url = `https://dev.azure.com/${org}/${encodeURIComponent(project)}/_apis/build/builds`
        + `?api-version=7.1&$top=${top}&$skip=${skip}&minTime=${since}&statusFilter=completed&queryOrder=finishTimeDescending`;
      const data = await baseJson(url, pat);
      if (!Array.isArray(data?.value) || data.value.length === 0) break;
      allBuilds.push(...data.value);
      if (data.value.length < top) break;
      skip += top;
    }

    // Keep the latest completed build per repo (matched against repoNames)
    const byRepo = new Map();
    for (const build of allBuilds) {
      const defName = String(build?.definition?.name ?? '');
      const key = sanFn(defName);
      if (!repoSet.has(key)) continue;
      const prev = byRepo.get(key);
      const bTime = new Date(build.finishTime || 0);
      if (!prev || bTime > new Date(prev.finishTime || 0)) {
        byRepo.set(key, {
          repo: key,
          definitionName: defName,
          buildNumber: String(build.buildNumber ?? ''),
          result: String(build.result ?? ''),
          finishTime: String(build.finishTime ?? '')
        });
      }
    }
    return Array.from(byRepo.values());
  };

})();
