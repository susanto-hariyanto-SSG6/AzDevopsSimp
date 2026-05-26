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
        req.onsuccess = e => res(e.target.result?.v ?? null);
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
    return {
      alertId: f?.alertId, title: f?.title, severity: f?.severity,
      state: f?.state, alertType: f?.alertType,
      lastSeenDate: f?.lastSeenDate ?? null, fixedDate: f?.fixedDate ?? null,
      physicalLocations: [location], tools
    };
  }

  function stripByUrl(url, data) {
    if (/_apis\/alert\/repositories\/.+\/alerts/i.test(url))
      return { __compactCache: true, value: Array.isArray(data?.value) ? data.value.map(stripFinding) : [] };
    if (/\/_apis\/projects(\?|$)/i.test(url))
      return { __compactCache: true, value: Array.isArray(data?.value)
        ? data.value.map(p => ({ id: p?.id, name: p?.name, description: p?.description })) : [] };
    return { __compactCache: true, ...(data || {}) };
  }

  // ── Append / merge pages into IDB ─────────────────────────────────────────
  async function appendCache(key, newItems) {
    try {
      const now  = Date.now();
      const hit  = await idbGet(key);
      const existing = (hit?.payload?.value && Array.isArray(hit.payload.value)) ? hit.payload.value : [];
      const seen = new Set(existing.map(f => String(f?.alertId ?? '')));
      for (const item of newItems) {
        const id = String(item?.alertId ?? '');
        if (id && !seen.has(id)) { seen.add(id); existing.push(item); }
      }
      await idbSet(key, { ts: now, exp: now + randomTtl(), payload: { value: existing } });
    } catch {}
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  window.GHASResult.fetchData = async (url, pat) => {
    const key = makeKey(url, pat);
    const hit = await idbGet(key);
    if (fresh(hit)) return hit.payload;
    const full = await baseJson(url, pat);
    const now  = Date.now();
    await idbSet(key, { ts: now, exp: now + randomTtl(), payload: stripByUrl(url, full) });
    return full;
  };

  window.GHASResult.fetchDataWithHeaders = async (url, pat) => {
    const baseKey       = makeBaseKey(url, pat);
    const isContinuation = new URL(url).searchParams.has('continuationToken');

    if (!isContinuation) {
      const hit = await idbGet(baseKey);
      if (fresh(hit))
        return { data: { __compactCache: true, value: hit.payload?.value ?? [] }, headers: { get: () => null }, __fromCache: true };
    }

    const network = await baseJsonWithHeaders(url, pat);
    await appendCache(baseKey, Array.isArray(stripByUrl(url, network.data)?.value) ? stripByUrl(url, network.data).value : []);
    return { data: network.data, headers: network.headers, __fromCache: false };
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
    const all = await idbGetAll();
    return all
      .filter(e => String(e.k).startsWith(KEY_PFX))
      .map(e => ({ key: e.k, data: e.v }));
  };

  console.log('[GHAS cache] enabled: IndexedDB (shared across tabs)');
})();
