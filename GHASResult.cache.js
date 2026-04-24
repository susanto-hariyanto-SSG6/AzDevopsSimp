(() => {
  window.GHASResult = window.GHASResult || {};
  const baseJson = window.GHASResult.fetchData;
  const baseJsonWithHeaders = window.GHASResult.fetchDataWithHeaders;

  if (typeof baseJson !== "function" || typeof baseJsonWithHeaders !== "function") return;

  const SS_PREFIX = "ghas:";
  const TTL_MS = 2 * 24 * 60 * 60 * 1000; // 2 days
  const TTL_JITTER_RATIO = 0.2; // +/-20%

  function randomTtl(baseTtl = TTL_MS) {
    const spread = Math.floor(baseTtl * TTL_JITTER_RATIO);
    const min = baseTtl - spread;
    const max = baseTtl + spread;
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
    }
    return (h >>> 0).toString(36);
  }

  function makeKey(url, pat) {
    return SS_PREFIX + url + "|u:" + hash(String(pat || ""));
  }

  function fresh(entry) {
    if (!entry) return false;

    // New format (preferred): absolute expiration timestamp
    if (typeof entry.exp === "number") {
      return Date.now() < entry.exp;
    }

    // Backward compatibility with old cached entries (ts + fixed TTL)
    return Date.now() - Number(entry.ts || 0) < TTL_MS;
  }

  function stripFinding(f) {
    const location = f?.physicalLocations?.[0] || f?.physicalLocation?.[0] || f?.physicalLocation || {};
    const tools = Array.isArray(f?.tools) ? f.tools.map(t => ({
      name: t?.name,
      rules: Array.isArray(t?.rules) ? t.rules.map(r => ({
        tag: r?.tag,
        tags: r?.tags,
        properties: r?.properties ? { tag: r.properties.tag, tags: r.properties.tags } : undefined
      })) : []
    })) : [];

    return {
      alertId: f?.alertId,
      title: f?.title,
      severity: f?.severity,
      state: f?.state,
      alertType: f?.alertType,
      physicalLocations: [location],
      tools
    };
  }

  function stripResponse(devopsData) {
    return {
      __compactCache: true, // key used to detect cache response
      value: Array.isArray(devopsData?.value) ? devopsData.value.map(stripFinding) : []
    };
  }

  function stripProjectsResponse(devopsData) {
    return {
      __compactCache: true,
      value: Array.isArray(devopsData?.value)
        ? devopsData.value.map(p => ({
            id: p?.id,
            name: p?.name,
            description: p?.description
          }))
        : []
    };
  }

  function stripByUrl(url, devopsData) {
    if (isAlertsUrl(url)) return stripResponse(devopsData);          // existing finding-strip
    if (isProjectsUrl(url)) return stripProjectsResponse(devopsData); // new project-strip
    return { __compactCache: true, ...(devopsData || {}) };           // fallback compact marker
  }

  function isAlertsUrl(url) {
    return /_apis\/alert\/repositories\/.+\/alerts/i.test(url);
  }

  function isProjectsUrl(url) {
    return /\/_apis\/projects(\?|$)/i.test(url);
  }

  function getCache(key) {
    try {
      const raw = sessionStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function setCache(key, payload) {
    try {
      const now = Date.now();
      sessionStorage.setItem(
        key,
        JSON.stringify({
          ts: now,
          exp: now + randomTtl(),
          payload
        })
      );
    } catch {}
  }

  window.GHASResult.fetchData = async (url, pat) => {
    const key = makeKey(url, pat);
    const hit = getCache(key);
    if (fresh(hit)) return hit.payload; // compact shape with __compactCache

    const full = await baseJson(url, pat);      // full DevOps shape
    const compact = stripByUrl(url, full);        // strip before save
    setCache(key, compact);
    return full;                                // full shape when fresh from network
  };

  window.GHASResult.fetchDataWithHeaders = async (url, pat) => {
    const key = makeKey(url, pat);
    const hit = getCache(key);

    if (fresh(hit)) {
      const payload = hit.payload || {};
      return {
        data: { __compactCache: true, ...payload }, // force marker on hit
        headers: { get: () => null },
        __fromCache: true
      };
    }

    const network = await baseJsonWithHeaders(url, pat);
    const compact = stripByUrl(url, network.data);
    setCache(key, compact);

    return {
      data: network.data,
      headers: network.headers,
      __fromCache: false
    };
  };

  window.GHASResult.clearCache = async () => {
    try {
      const keys = [];
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k && k.startsWith(SS_PREFIX)) keys.push(k);
      }
      keys.forEach(k => sessionStorage.removeItem(k));
      return true;
    } catch {
      return false;
    }
  };

  console.log("[GHAS cache] enabled: sessionStorage");
})();