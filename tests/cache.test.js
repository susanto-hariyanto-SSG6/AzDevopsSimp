/**
 * tests/cache.test.js
 * Tests for GHASResult.cache.js — IDB helpers, fresh(), strip helpers, public API
 *
 * @jest-environment node
 *
 * Uses node environment so fake-indexeddb/auto can set global.indexedDB freely
 * without jsdom interference. window is aliased to global.
 */
require('fake-indexeddb/auto');
const fs   = require('fs');
const path = require('path');

// In node env, alias window → global so cache.js's window.GHASResult references work
global.window = global;

const CACHE_SRC = fs.readFileSync(path.join(__dirname, '../GHASResult.cache.js'), 'utf8');
const TTL_MS    = 6 * 24 * 60 * 60 * 1000;  // must match GHASResult.cache.js

// Shared mock references — captured by the IIFE when cache.js is eval'd
let baseFetch;
let baseFetchWithHeaders;
let api;

beforeAll(() => {
  baseFetch             = jest.fn();
  baseFetchWithHeaders  = jest.fn();
  global.window.GHASResult = {
    fetchData:            baseFetch,
    fetchDataWithHeaders: baseFetchWithHeaders,
  };
  eval(CACHE_SRC); // eslint-disable-line no-eval
  api = global.window.GHASResult;
});

beforeEach(async () => {
  // Clear IDB cache so each test starts clean
  await api.clearCache();
});

// ── IDB sanity (runs before all other tests) ──────────────────────────────────
test('IDB sanity: open DB and put/get', async () => {
  const db = await new Promise((res, rej) => {
    const req = indexedDB.open('SanityDB', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('s', { keyPath: 'k' });
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
  await new Promise((res, rej) => {
    const req = db.transaction('s', 'readwrite').objectStore('s').put({ k: 'x', v: 'y' });
    req.onsuccess = () => res();
    req.onerror   = e => rej(e.target.error);
  });
  const r = await new Promise((res, rej) => {
    const req = db.transaction('s', 'readonly').objectStore('s').get('x');
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
  expect(r).toEqual({ k: 'x', v: 'y' });
}, 15000);

// ── Cache freshness ───────────────────────────────────────────────────────────
describe('cache freshness', () => {
  test('cache hit: returns stored payload without calling network', async () => {
    baseFetch.mockResolvedValue({ value: [{ alertId: 1 }] });
    const url = 'https://dev.azure.com/itbinus/proj/_apis/alert/repositories/repo/alerts';

    await api.fetchData(url, 'pat');
    expect(baseFetch).toHaveBeenCalledTimes(1);

    // Second call → cache hit → network NOT called again
    await api.fetchData(url, 'pat');
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });

  test('cache miss after TTL expiry: calls network again', async () => {
    baseFetch.mockResolvedValue({ value: [] });
    const url = 'https://dev.azure.com/itbinus/proj/_apis/alert/repositories/repo-ttl/alerts';

    await api.fetchData(url, 'pat');
    expect(baseFetch).toHaveBeenCalledTimes(1);

    // Advance time past TTL
    jest.useFakeTimers();
    jest.setSystemTime(Date.now() + TTL_MS * 1.5);

    baseFetch.mockResolvedValue({ value: [] });
    await api.fetchData(url, 'pat');
    expect(baseFetch).toHaveBeenCalledTimes(2);

    jest.useRealTimers();
  });

  test('different PATs produce independent cache entries', async () => {
    baseFetch.mockResolvedValue({ value: [] });
    const url = 'https://dev.azure.com/itbinus/proj/_apis/alert/repositories/repo-pats/alerts';

    await api.fetchData(url, 'pat-A');
    await api.fetchData(url, 'pat-B'); // different PAT → different key → cache miss
    expect(baseFetch).toHaveBeenCalledTimes(2);
  });
});

// ── stripByUrl — compact storage format ──────────────────────────────────────
describe('stripByUrl (via fetchData storage)', () => {
  test('alert URL: strips extra fields, keeps minimal finding fields', async () => {
    const fatFinding = {
      alertId: 42, title: 'SQL Injection', severity: 'critical', state: 'active',
      alertType: 'code', lastSeenDate: '2024-01-01', fixedDate: null,
      physicalLocations: [{ artifactLocation: { uri: 'src/foo.cs' }, region: { startLine: 10 } }],
      tools: [{ name: 'CodeQL', rules: [{ tag: 'sql', properties: { tag: 'injection' } }] }],
      extraField: 'should be stripped',
    };
    baseFetch.mockResolvedValue({ value: [fatFinding] });
    const url = 'https://dev.azure.com/itbinus/proj/_apis/alert/repositories/repoS/alerts';

    await api.fetchData(url, 'pat');
    const entries = await api.getAllCacheEntries();
    expect(entries.length).toBeGreaterThan(0);

    const payload = entries[0].data.payload;
    expect(payload.__compactCache).toBe(true);
    expect(payload.value[0]).not.toHaveProperty('extraField');
    expect(payload.value[0]).toHaveProperty('alertId', 42);
    expect(payload.value[0]).toHaveProperty('severity', 'critical');
  });

  test('projects URL: only keeps id, name, description', async () => {
    const fatProject = { id: 'p1', name: 'MyProject', description: 'desc', owner: 'strip-me', extra: true };
    baseFetch.mockResolvedValue({ value: [fatProject] });
    const url = 'https://dev.azure.com/itbinus/_apis/projects';

    await api.fetchData(url, 'pat');
    const entries = await api.getAllCacheEntries();
    const saved = entries[0].data.payload.value[0];
    expect(saved).toEqual({ id: 'p1', name: 'MyProject', description: 'desc' });
  });
});

// ── fetchDataWithHeaders — pagination merge ───────────────────────────────────
describe('fetchDataWithHeaders', () => {
  const ALERT_URL = 'https://dev.azure.com/itbinus/proj/_apis/alert/repositories/repoP/alerts';
  const mkHeaders = (token = null) => ({ get: () => token });

  test('non-continuation call on empty cache: hits network, stores result', async () => {
    baseFetchWithHeaders.mockResolvedValue({
      data: { value: [{ alertId: 1, severity: 'high', state: 'active' }] },
      headers: mkHeaders(),
    });

    const result = await api.fetchDataWithHeaders(ALERT_URL, 'pat');
    expect(result.__fromCache).toBe(false);
    expect(baseFetchWithHeaders).toHaveBeenCalledTimes(1);
  });

  test('non-continuation call with fresh cache: returns from cache, skips network', async () => {
    baseFetchWithHeaders.mockResolvedValue({
      data: { value: [{ alertId: 1, severity: 'high', state: 'active' }] },
      headers: mkHeaders(),
    });

    await api.fetchDataWithHeaders(ALERT_URL, 'pat2');         // prime
    const result = await api.fetchDataWithHeaders(ALERT_URL, 'pat2'); // cache hit
    expect(result.__fromCache).toBe(true);
    expect(baseFetchWithHeaders).toHaveBeenCalledTimes(1);
  });

  test('continuation token call always hits network', async () => {
    baseFetchWithHeaders.mockResolvedValue({
      data: { value: [{ alertId: 2, severity: 'low', state: 'fixed' }] },
      headers: mkHeaders(),
    });

    const result = await api.fetchDataWithHeaders(ALERT_URL + '?continuationToken=abc', 'pat');
    expect(result.__fromCache).toBe(false);
    expect(baseFetchWithHeaders).toHaveBeenCalledTimes(1);
  });

  test('appendCache deduplicates by alertId across pages', async () => {
    baseFetchWithHeaders
      .mockResolvedValueOnce({
        data: { value: [{ alertId: 1, severity: 'high', state: 'active' }, { alertId: 2, severity: 'low', state: 'fixed' }] },
        headers: mkHeaders('tok2'),
      })
      .mockResolvedValueOnce({
        data: { value: [{ alertId: 2, severity: 'low', state: 'fixed' }, { alertId: 3, severity: 'critical', state: 'active' }] },
        headers: mkHeaders(),
      });

    await api.fetchDataWithHeaders(ALERT_URL, 'pat-dedup');
    await api.fetchDataWithHeaders(ALERT_URL + '?continuationToken=tok2', 'pat-dedup');

    const cached = await api.fetchDataWithHeaders(ALERT_URL, 'pat-dedup');
    expect(cached.__fromCache).toBe(true);
    expect(cached.data.value).toHaveLength(3);
  });
});

// ── clearCache ────────────────────────────────────────────────────────────────
describe('clearCache', () => {
  test('removes all ghas: entries', async () => {
    baseFetch.mockResolvedValue({ value: [] });
    const url = 'https://dev.azure.com/itbinus/proj/_apis/alert/repositories/repoC/alerts';

    await api.fetchData(url, 'pat');
    let entries = await api.getAllCacheEntries();
    expect(entries.length).toBeGreaterThan(0);

    await api.clearCache();
    entries = await api.getAllCacheEntries();
    expect(entries).toHaveLength(0);
  });
});

// ── clearCacheByPattern ───────────────────────────────────────────────────────
describe('clearCacheByPattern', () => {
  test('removes only entries whose key contains the pattern', async () => {
    baseFetch.mockResolvedValue({ value: [] });
    const keep = 'https://dev.azure.com/itbinus/proj/_apis/alert/repositories/repo-keep/alerts';
    const del  = 'https://dev.azure.com/itbinus/proj/_apis/alert/repositories/repo-del/alerts';

    await api.fetchData(keep, 'pat');
    await api.fetchData(del, 'pat');

    await api.clearCacheByPattern('repo-del');

    const entries = await api.getAllCacheEntries();
    expect(entries.every(e => !e.key.includes('repo-del'))).toBe(true);
    expect(entries.some(e => e.key.includes('repo-keep'))).toBe(true);
  });
});

// ── updateCacheWithAttribution ────────────────────────────────────────────────
describe('updateCacheWithAttribution', () => {
  const ALERT_URL_WITH_PARAMS =
    'https://dev.azure.com/itbinus/proj/_apis/alert/repositories/repo-attr/alerts?api-version=7.1-preview.1&%24top=100';

  test('returns false when key does not exist in cache', async () => {
    const result = await api.updateCacheWithAttribution('ghas:nonexistent-key|u:abc', []);
    expect(result).toBe(false);
  });

  test('updates attribution on matching finding, preserves ts/exp', async () => {
    baseFetchWithHeaders.mockResolvedValue({
      data: { value: [{ alertId: 10, severity: 'high', state: 'fixed', fixedDate: '2024-06-10T00:00:00Z' }] },
      headers: { get: () => null },
    });

    await api.fetchDataWithHeaders(ALERT_URL_WITH_PARAMS, 'pat-attr');

    const entriesBefore = await api.getAllCacheEntries();
    const keyBefore = entriesBefore[0].key;
    const tsBefore  = entriesBefore[0].data.ts;
    const expBefore = entriesBefore[0].data.exp;

    const enriched = [{ alertId: 10, attribution: { name: 'Dev1', date: '2024-06-09T00:00:00Z' } }];
    const success = await api.updateCacheWithAttribution(keyBefore, enriched);
    expect(success).toBe(true);

    const entriesAfter = await api.getAllCacheEntries();
    const updated = entriesAfter.find(e => e.key === keyBefore);
    expect(updated.data.payload.value[0].attribution).toEqual({ name: 'Dev1', date: '2024-06-09T00:00:00Z' });
    // Timestamps must not change
    expect(updated.data.ts).toBe(tsBefore);
    expect(updated.data.exp).toBe(expBefore);
  });

  test('does not write non-null attribution over null when re-fetching (stripByUrl preservation)', async () => {
    const ALERT_URL2 =
      'https://dev.azure.com/itbinus/proj/_apis/alert/repositories/repo-preserve/alerts?api-version=7.1-preview.1&%24top=100';

    // First fetch — no attribution
    baseFetchWithHeaders.mockResolvedValue({
      data: { value: [{ alertId: 20, severity: 'critical', state: 'fixed', fixedDate: '2024-06-10T00:00:00Z' }] },
      headers: { get: () => null },
    });
    await api.fetchDataWithHeaders(ALERT_URL2, 'pat-pres');

    // Write attribution into cache
    const entries = await api.getAllCacheEntries();
    const key = entries.find(e => e.key.includes('repo-preserve'))?.key;
    await api.updateCacheWithAttribution(key, [{ alertId: 20, attribution: { name: 'Dev2', date: '2024-06-09T00:00:00Z' } }]);

    // Second fetch (re-fetch from network) — API returns finding with no attribution
    baseFetchWithHeaders.mockResolvedValue({
      data: { value: [{ alertId: 20, severity: 'critical', state: 'fixed', fixedDate: '2024-06-10T00:00:00Z' }] },
      headers: { get: () => null },
    });
    // Force cache miss by advancing time past TTL
    jest.useFakeTimers();
    jest.setSystemTime(Date.now() + TTL_MS * 1.5);
    await api.fetchDataWithHeaders(ALERT_URL2, 'pat-pres');
    jest.useRealTimers();

    // Attribution must have been preserved from the pre-refetch cache
    const entriesAfter = await api.getAllCacheEntries();
    const after = entriesAfter.find(e => e.key.includes('repo-preserve'));
    expect(after.data.payload.value[0].attribution).toEqual({ name: 'Dev2', date: '2024-06-09T00:00:00Z' });
  });
});
