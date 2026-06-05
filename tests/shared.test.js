/**
 * tests/shared.test.js
 * Tests for shared.js — findClosestCommitter, attributeFixedFindings, attributeFixedFindingsByWeek
 *
 * Strategy: eval shared.js inside jsdom so window.GHASShared is populated exactly
 * as it would be in the browser.
 */
const fs = require('fs');
const path = require('path');

// ── Load shared.js into jsdom window ──────────────────────────────────────────
beforeAll(() => {
  // shared.js calls window.GHASResult.fetchData — stub it so the IIFE doesn't throw
  global.window.GHASResult = { fetchData: jest.fn() };
  const src = fs.readFileSync(path.join(__dirname, '../shared.js'), 'utf8');
  eval(src); // eslint-disable-line no-eval
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeCommit(dateISO, authorName = 'Alice') {
  return { author: { name: authorName, date: dateISO }, commitId: dateISO };
}

function makeFinding(state, severity, fixedDate) {
  return { state, severity, fixedDate: fixedDate ?? null };
}

// ── findClosestCommitter ──────────────────────────────────────────────────────
describe('findClosestCommitter', () => {

  test('returns null when commits is empty', () => {
    expect(window.GHASShared.findClosestCommitter('2024-01-01', [])).toBeNull();
  });

  test('returns null when fixedDate is falsy', () => {
    const commits = [makeCommit('2024-01-01')];
    expect(window.GHASShared.findClosestCommitter(null, commits)).toBeNull();
    expect(window.GHASShared.findClosestCommitter('', commits)).toBeNull();
  });

  test('returns null when fixedDate is not a valid date', () => {
    const commits = [makeCommit('2024-01-01')];
    expect(window.GHASShared.findClosestCommitter('not-a-date', commits)).toBeNull();
  });

  test('returns exact match commit', () => {
    const commits = [makeCommit('2024-06-01T10:00:00Z', 'Bob')];
    const result = window.GHASShared.findClosestCommitter('2024-06-01T10:00:00Z', commits);
    expect(result.author.name).toBe('Bob');
  });

  test('returns closest commit, not just first', () => {
    const commits = [
      makeCommit('2024-01-01T00:00:00Z', 'Far'),
      makeCommit('2024-06-15T00:00:00Z', 'Close'),
      makeCommit('2024-12-31T00:00:00Z', 'AlsoFar'),
    ];
    const result = window.GHASShared.findClosestCommitter('2024-06-16T00:00:00Z', commits);
    expect(result.author.name).toBe('Close');
  });

  test('prefers the latest commit BEFORE fixedDate over a closer commit AFTER it', () => {
    // fixedDate = Jun 10. Jun 9 is 1 day before; Jun 11 is 1 day after.
    // Must pick Jun 9 (last commit before the fix), not Jun 11.
    const commits = [
      makeCommit('2024-06-09T00:00:00Z', 'BeforeFix'),
      makeCommit('2024-06-11T00:00:00Z', 'AfterFix'),
    ];
    const result = window.GHASShared.findClosestCommitter('2024-06-10T00:00:00Z', commits);
    expect(result.author.name).toBe('BeforeFix');
  });

  test('picks latest of multiple commits before fixedDate', () => {
    const commits = [
      makeCommit('2024-06-01T00:00:00Z', 'OlderBefore'),
      makeCommit('2024-06-08T00:00:00Z', 'LatestBefore'),
      makeCommit('2024-06-15T00:00:00Z', 'After'),
    ];
    const result = window.GHASShared.findClosestCommitter('2024-06-10T00:00:00Z', commits);
    expect(result.author.name).toBe('LatestBefore');
  });

  test('falls back to closest future commit when all commits post-date fixedDate', () => {
    const commits = [
      makeCommit('2024-06-15T00:00:00Z', 'FutureClose'),
      makeCommit('2024-12-31T00:00:00Z', 'FutureFar'),
    ];
    const result = window.GHASShared.findClosestCommitter('2024-06-10T00:00:00Z', commits);
    expect(result.author.name).toBe('FutureClose');
  });

  test('falls back to committer.date when author.date is absent', () => {
    const commit = { committer: { name: 'Carol', date: '2024-06-01T00:00:00Z' } };
    const result = window.GHASShared.findClosestCommitter('2024-06-01T00:00:00Z', [commit]);
    expect(result.committer.name).toBe('Carol');
  });

  test('skips commits with invalid dates', () => {
    const commits = [
      { author: { name: 'Bad', date: 'garbage' } },
      makeCommit('2024-06-01T00:00:00Z', 'Good'),
    ];
    const result = window.GHASShared.findClosestCommitter('2024-06-01T00:00:00Z', commits);
    expect(result.author.name).toBe('Good');
  });
});

// ── attributeFixedFindings ────────────────────────────────────────────────────
describe('attributeFixedFindings', () => {
  const commits = [makeCommit('2024-06-10T00:00:00Z', 'Dev1')];

  test('returns empty object when no findings', () => {
    expect(window.GHASShared.attributeFixedFindings([], commits)).toEqual({});
  });

  test('counts fixed findings by severity', () => {
    const findings = [
      makeFinding('fixed', 'critical', '2024-06-10T00:00:00Z'),
      makeFinding('fixed', 'high',     '2024-06-10T00:00:00Z'),
      makeFinding('fixed', 'critical', '2024-06-10T00:00:00Z'),
    ];
    const result = window.GHASShared.attributeFixedFindings(findings, commits);
    expect(result['Dev1'].critical).toBe(2);
    expect(result['Dev1'].high).toBe(1);
    expect(result['Dev1'].medium).toBe(0);
  });

  test('counts dismissed findings (treated same as fixed)', () => {
    const findings = [makeFinding('dismissed', 'high', '2024-06-10T00:00:00Z')];
    const result = window.GHASShared.attributeFixedFindings(findings, commits);
    expect(result['Dev1'].high).toBe(1);
  });

  test('skips active and reopened findings', () => {
    const findings = [
      makeFinding('active',   'critical', '2024-06-10T00:00:00Z'),
      makeFinding('reopened', 'critical', '2024-06-10T00:00:00Z'),
    ];
    const result = window.GHASShared.attributeFixedFindings(findings, commits);
    expect(result).toEqual({});
  });

  test('uses "Unknown" when no matching commit', () => {
    const findings = [makeFinding('fixed', 'low', '2024-06-10T00:00:00Z')];
    const result = window.GHASShared.attributeFixedFindings(findings, []);
    expect(result['Unknown'].low).toBe(1);
  });

  test('ignores unknown severity values — no severity bucket incremented', () => {
    const findings = [makeFinding('fixed', 'extreme', '2024-06-10T00:00:00Z')];
    const result = window.GHASShared.attributeFixedFindings(findings, commits);
    // latestDate IS set regardless of severity (correct behaviour)
    // but no severity buckets should be incremented
    expect(result['Dev1'].critical).toBe(0);
    expect(result['Dev1'].high).toBe(0);
    expect(result['Dev1'].medium).toBe(0);
    expect(result['Dev1'].low).toBe(0);
  });

  test('tracks latestDate correctly', () => {
    const findings = [
      makeFinding('fixed', 'high', '2024-06-01T00:00:00Z'),
      makeFinding('fixed', 'low',  '2024-06-15T00:00:00Z'),
    ];
    const commits2 = [makeCommit('2024-06-01T00:00:00Z', 'Dev1'), makeCommit('2024-06-15T00:00:00Z', 'Dev1')];
    const result = window.GHASShared.attributeFixedFindings(findings, commits2);
    expect(result['Dev1'].latestDate).toEqual(new Date('2024-06-15T00:00:00Z'));
  });
});

// ── attributeFixedFindingsByWeek ──────────────────────────────────────────────
describe('attributeFixedFindingsByWeek', () => {
  // Pin "now" to a known Monday so week buckets are deterministic
  const MONDAY = new Date('2024-06-17T00:00:00Z'); // a Monday

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(MONDAY);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function thisWeekDate() { return '2024-06-17T12:00:00Z'; }  // same week as MONDAY
  function olderDate()    { return '2024-01-01T00:00:00Z'; }  // well before 4-week window

  const commits = [
    makeCommit(thisWeekDate(), 'Dev1'),
    makeCommit(olderDate(),    'Dev2'),
  ];

  test('returns empty object for empty findings', () => {
    expect(window.GHASShared.attributeFixedFindingsByWeek([], commits)).toEqual({});
  });

  test('places current-week finding into weeks[0]', () => {
    const findings = [makeFinding('fixed', 'critical', thisWeekDate())];
    const result = window.GHASShared.attributeFixedFindingsByWeek(findings, commits);
    expect(result['Dev1'].weeks[0].critical).toBe(1);
  });

  test('places old finding into older bucket', () => {
    const findings = [makeFinding('fixed', 'high', olderDate())];
    const result = window.GHASShared.attributeFixedFindingsByWeek(findings, commits);
    expect(result['Dev2'].older.high).toBe(1);
  });

  test('finding with no fixedDate goes to older bucket', () => {
    const findings = [{ state: 'fixed', severity: 'medium', fixedDate: null }];
    const result = window.GHASShared.attributeFixedFindingsByWeek(findings, commits);
    // No commit match → "Unknown", and null fixedDate → older
    expect(result['Unknown'].older.medium).toBe(1);
  });

  test('skips active findings', () => {
    const findings = [makeFinding('active', 'critical', thisWeekDate())];
    const result = window.GHASShared.attributeFixedFindingsByWeek(findings, commits);
    expect(result).toEqual({});
  });

  test('initialises all 4 week buckets with zero counts', () => {
    const findings = [makeFinding('fixed', 'low', thisWeekDate())];
    const result = window.GHASShared.attributeFixedFindingsByWeek(findings, commits);
    expect(result['Dev1'].weeks).toHaveLength(4);
    result['Dev1'].weeks.forEach(w => {
      expect(w).toMatchObject({ critical: expect.any(Number), high: expect.any(Number), medium: expect.any(Number), low: expect.any(Number) });
    });
  });
});
