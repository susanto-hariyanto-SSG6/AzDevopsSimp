/**
 * tests/fixing-activity.test.js
 * Unit tests for the fixing-activity component
 * 
 * @jest-environment node
 */

const fs = require('fs');
const path = require('path');

// Load the component
const componentSrc = fs.readFileSync(
  path.join(__dirname, '../fragments/fixing-activity.js'),
  'utf8'
);

// Setup mock environment
global.window = global;
global.console = {
  log: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
};

// Load component
eval(componentSrc); // eslint-disable-line no-eval

describe('FixingActivity Component', () => {
  
  // Helper: Create mock findings
  const mockFinding = (overrides = {}) => ({
    alertId: 'alert-1',
    title: 'SQL Injection',
    severity: 'critical',
    state: 'fixed',
    alertType: 'code_scanning',
    fixedDate: '2026-06-04T10:30:00Z',
    ...overrides,
  });

  // Helper: Create cache entry with repo name in key
  const mockCacheEntry = (findings, repoName = 'repo-a') => ({
    key: `ghas:https://advsec.dev.azure.com/itbinus/1f663eb2-dd63-4b51-b000-f0949e3c8ab0/_apis/alert/repositories/${repoName}/alerts|u:hash1`,
    data: { payload: { value: findings } },
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('getFixedFindingsWithProgrammers', () => {
    test('extracts fixed findings from cache entries', async () => {
      const findings = [
        mockFinding({ fixedDate: '2026-06-04T10:00:00Z' }),
        mockFinding({ state: 'active', fixedDate: null }), // Not fixed
        mockFinding({ fixedDate: '2026-06-03T15:30:00Z' }),
      ];
      
      const result = await window.FixingActivity.getFixedFindingsWithProgrammers([
        mockCacheEntry(findings),
      ]);
      
      expect(result).toHaveLength(2);
      expect(result[0].fixId).toBe('alert-1');
      expect(result[0].fixedDate).toBe('2026-06-04T10:00:00Z');
    });

    test('treats dismissed as fixed', async () => {
      const findings = [
        mockFinding({ state: 'dismissed' }),
      ];
      
      const result = await window.FixingActivity.getFixedFindingsWithProgrammers([
        mockCacheEntry(findings),
      ]);
      
      expect(result).toHaveLength(1);
    });

    test('skips findings without fixedDate', async () => {
      const findings = [
        mockFinding({ fixedDate: null }),
        mockFinding({ fixedDate: undefined }),
        mockFinding({ fixedDate: '2026-06-04T10:00:00Z' }),
      ];
      
      const result = await window.FixingActivity.getFixedFindingsWithProgrammers([
        mockCacheEntry(findings),
      ]);
      
      expect(result).toHaveLength(1);
    });

    test('handles multiple cache entries', async () => {
      const result = await window.FixingActivity.getFixedFindingsWithProgrammers([
        mockCacheEntry([mockFinding({ alertId: 'a1' })]),
        mockCacheEntry([mockFinding({ alertId: 'a2' }), mockFinding({ alertId: 'a3' })]),
      ]);
      
      expect(result).toHaveLength(3);
      expect(result.map(f => f.fixId)).toEqual(['a1', 'a2', 'a3']);
    });

    test('handles empty cache gracefully', async () => {
      const result = await window.FixingActivity.getFixedFindingsWithProgrammers([]);
      expect(result).toEqual([]);
    });

    test('handles cache entry without payload gracefully', async () => {
      const result = await window.FixingActivity.getFixedFindingsWithProgrammers([
        { key: 'key1', data: {} },
      ]);
      expect(result).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('aggregateDailyActivity', () => {
    test('aggregates fixes by date', () => {
      const findings = [
        mockFinding({ fixedDate: '2026-06-04T10:00:00Z', severity: 'critical' }),
        mockFinding({ fixedDate: '2026-06-04T15:00:00Z', severity: 'high' }),
        mockFinding({ fixedDate: '2026-06-03T10:00:00Z', severity: 'medium' }),
      ];
      
      const result = window.FixingActivity.aggregateDailyActivity(findings);
      
      expect(result['2026-06-04'].total).toBe(2);
      expect(result['2026-06-03'].total).toBe(1);
    });

    test('counts fixes by severity', () => {
      const findings = [
        mockFinding({ fixedDate: '2026-06-04T10:00:00Z', severity: 'critical' }),
        mockFinding({ fixedDate: '2026-06-04T11:00:00Z', severity: 'high' }),
        mockFinding({ fixedDate: '2026-06-04T12:00:00Z', severity: 'high' }),
        mockFinding({ fixedDate: '2026-06-04T13:00:00Z', severity: 'medium' }),
        mockFinding({ fixedDate: '2026-06-04T14:00:00Z', severity: 'low' }),
      ];
      
      const result = window.FixingActivity.aggregateDailyActivity(findings);
      const dayData = result['2026-06-04'];
      
      expect(dayData.bySeverity.c).toBe(1); // critical
      expect(dayData.bySeverity.h).toBe(2); // high
      expect(dayData.bySeverity.m).toBe(1); // medium
      expect(dayData.bySeverity.l).toBe(1); // low
    });

    test('counts fixes by programmer', () => {
      const findings = [
        mockFinding({ fixedDate: '2026-06-04T10:00:00Z', programmer: 'Alice' }),
        mockFinding({ fixedDate: '2026-06-04T11:00:00Z', programmer: 'Bob' }),
        mockFinding({ fixedDate: '2026-06-04T12:00:00Z', programmer: 'Alice' }),
      ];
      
      const result = window.FixingActivity.aggregateDailyActivity(findings);
      const dayData = result['2026-06-04'];
      
      expect(dayData.byProgrammer['Alice']).toBe(2);
      expect(dayData.byProgrammer['Bob']).toBe(1);
    });

    test('handles missing programmer gracefully', () => {
      const findings = [
        mockFinding({ fixedDate: '2026-06-04T10:00:00Z', programmer: undefined }),
      ];
      
      const result = window.FixingActivity.aggregateDailyActivity(findings);
      expect(result['2026-06-04'].byProgrammer['Unknown']).toBe(1);
    });

    test('handles case-insensitive severity', () => {
      const findings = [
        mockFinding({ fixedDate: '2026-06-04T10:00:00Z', severity: 'CRITICAL' }),
        mockFinding({ fixedDate: '2026-06-04T11:00:00Z', severity: 'High' }),
      ];
      
      const result = window.FixingActivity.aggregateDailyActivity(findings);
      expect(result['2026-06-04'].bySeverity.c).toBe(1);
      expect(result['2026-06-04'].bySeverity.h).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('sortDates', () => {
    test('sorts dates in descending order (most recent first)', () => {
      const daily = {
        '2026-06-01': { total: 1 },
        '2026-06-04': { total: 3 },
        '2026-06-02': { total: 2 },
      };
      
      const result = window.FixingActivity.sortDates(daily);
      
      expect(result[0][0]).toBe('2026-06-04');
      expect(result[1][0]).toBe('2026-06-02');
      expect(result[2][0]).toBe('2026-06-01');
    });

    test('handles single date', () => {
      const daily = { '2026-06-04': { total: 1 } };
      const result = window.FixingActivity.sortDates(daily);
      expect(result).toHaveLength(1);
    });

    test('handles empty object', () => {
      const result = window.FixingActivity.sortDates({});
      expect(result).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('formatDate', () => {
    test('formats ISO date to readable format', () => {
      const result = window.FixingActivity.formatDate('2026-06-04');
      expect(result).toMatch(/Jun 04, 2026/);
    });

    test('handles various date formats', () => {
      const result1 = window.FixingActivity.formatDate('2026-01-05');
      const result2 = window.FixingActivity.formatDate('2026-12-25');
      
      expect(result1).toContain('2026');
      expect(result2).toContain('2026');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('renderDailyActivityRows', () => {
    test('renders HTML rows from daily activity data', () => {
      const daily = {
        '2026-06-04': {
          total: 3,
          bySeverity: { c: 1, h: 1, m: 1, l: 0 },
          byProgrammer: { Alice: 2, Bob: 1 },
        },
      };
      
      const html = window.FixingActivity.renderDailyActivityRows(daily);
      
      expect(html).toContain('2026-06-04');
      expect(html).toContain('<tr>');
      expect(html).toContain('<td class="total">3</td>');
      expect(html).toContain('<td class="severity-c">1</td>');
    });

    test('includes programmer names in badges', () => {
      const daily = {
        '2026-06-04': {
          total: 2,
          bySeverity: { c: 0, h: 0, m: 0, l: 0 },
          byProgrammer: { Alice: 2 },
        },
      };
      
      const html = window.FixingActivity.renderDailyActivityRows(daily, { showProgrammers: true });
      
      expect(html).toContain('programmer-badge');
      expect(html).toContain('Alice');
    });

    test('respects maxDays limit', () => {
      const daily = {
        '2026-06-01': { total: 1, bySeverity: { c: 0, h: 0, m: 0, l: 0 }, byProgrammer: {} },
        '2026-06-02': { total: 1, bySeverity: { c: 0, h: 0, m: 0, l: 0 }, byProgrammer: {} },
        '2026-06-03': { total: 1, bySeverity: { c: 0, h: 0, m: 0, l: 0 }, byProgrammer: {} },
        '2026-06-04': { total: 1, bySeverity: { c: 0, h: 0, m: 0, l: 0 }, byProgrammer: {} },
      };
      
      const html = window.FixingActivity.renderDailyActivityRows(daily, { maxDays: 2 });
      const rows = (html.match(/<tr>/g) || []).length;
      
      expect(rows).toBe(2);
    });

    test('excludes programmers when showProgrammers=false', () => {
      const daily = {
        '2026-06-04': {
          total: 1,
          bySeverity: { c: 0, h: 0, m: 0, l: 0 },
          byProgrammer: { Alice: 1 },
        },
      };
      
      const html = window.FixingActivity.renderDailyActivityRows(daily, { showProgrammers: false });
      
      expect(html).not.toContain('programmer-badge');
      expect(html).not.toContain('Alice');
    });

    test('handles empty daily data gracefully', () => {
      const html = window.FixingActivity.renderDailyActivityRows({});
      expect(html).toBe('');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('groupFindingsByCluster', () => {
    test('groups findings by matching repo to cluster config', () => {
      const findings = [
        mockFinding({ repoName: 'SSG6-AI-Admin' }),
        mockFinding({ repoName: 'SSG6-C3-API' }),
        mockFinding({ repoName: 'OTHER-REPO' }),
      ];
      
      const clusterConfig = {
        clusters: [
          { name: 'Cluster A', repos: ['SSG6-AI-Admin', 'SSG6-C3-API'] },
          { name: 'Cluster B', repos: 'SSG7-Core' },
        ],
      };
      
      // Need to add repoName to findings
      findings[0].repoName = 'SSG6-AI-Admin';
      findings[1].repoName = 'SSG6-C3-API';
      findings[2].repoName = 'OTHER-REPO';
      
      const result = window.FixingActivity.groupFindingsByCluster(findings, clusterConfig);
      
      expect(result['Cluster A']).toHaveLength(2);
      expect(result['Unassigned']).toHaveLength(1);
    });

    test('handles missing cluster config gracefully', () => {
      const findings = [mockFinding()];
      findings[0].repoName = 'repo-a';
      
      const result = window.FixingActivity.groupFindingsByCluster(findings, {});
      
      expect(result).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('buildPivotTable', () => {
    test('builds pivot table with dates as rows and programmers as columns', () => {
      const findings = [
        mockFinding({ fixedDate: '2026-06-04T10:00:00Z', severity: 'critical', programmer: 'Alice' }),
        mockFinding({ fixedDate: '2026-06-04T11:00:00Z', severity: 'high', programmer: 'Bob' }),
        mockFinding({ fixedDate: '2026-06-03T10:00:00Z', severity: 'medium', programmer: 'Alice' }),
      ];
      
      const result = window.FixingActivity.buildPivotTable(findings);
      
      expect(result.dates).toEqual(['2026-06-04', '2026-06-03']);
      expect(result.programmers).toEqual(['Alice', 'Bob']);
      expect(result.pivot['2026-06-04']['Alice'].c).toBe(1);
      expect(result.pivot['2026-06-04']['Bob'].h).toBe(1);
    });

    test('counts severity breakdown per programmer per date', () => {
      const findings = [
        mockFinding({ fixedDate: '2026-06-04T10:00:00Z', severity: 'critical', programmer: 'Alice' }),
        mockFinding({ fixedDate: '2026-06-04T11:00:00Z', severity: 'critical', programmer: 'Alice' }),
        mockFinding({ fixedDate: '2026-06-04T12:00:00Z', severity: 'high', programmer: 'Alice' }),
      ];
      
      const result = window.FixingActivity.buildPivotTable(findings);
      
      expect(result.pivot['2026-06-04']['Alice'].c).toBe(2);
      expect(result.pivot['2026-06-04']['Alice'].h).toBe(1);
    });

    test('handles Unknown programmer', () => {
      const findings = [
        mockFinding({ fixedDate: '2026-06-04T10:00:00Z', severity: 'high', programmer: undefined }),
      ];
      
      const result = window.FixingActivity.buildPivotTable(findings);
      
      expect(result.programmers).toContain('Unknown');
      expect(result.pivot['2026-06-04']['Unknown'].h).toBe(1);
    });

    test('sorts dates descending (most recent first)', () => {
      const findings = [
        mockFinding({ fixedDate: '2026-06-01T10:00:00Z', programmer: 'Alice' }),
        mockFinding({ fixedDate: '2026-06-05T10:00:00Z', programmer: 'Alice' }),
        mockFinding({ fixedDate: '2026-06-03T10:00:00Z', programmer: 'Alice' }),
      ];
      
      const result = window.FixingActivity.buildPivotTable(findings);
      
      expect(result.dates[0]).toBe('2026-06-05');
      expect(result.dates[1]).toBe('2026-06-03');
      expect(result.dates[2]).toBe('2026-06-01');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('buildDailyTotals', () => {
    test('builds combined daily totals across all clusters', () => {
      const findings1 = [
        mockFinding({ fixedDate: '2026-06-04T10:00:00Z' }),
        mockFinding({ fixedDate: '2026-06-04T11:00:00Z' }),
        mockFinding({ fixedDate: '2026-06-03T10:00:00Z' }),
      ];
      
      const findings2 = [
        mockFinding({ fixedDate: '2026-06-04T10:00:00Z' }),
        mockFinding({ fixedDate: '2026-06-02T10:00:00Z' }),
      ];
      
      const byCluster = {
        'Cluster A': findings1,
        'Cluster B': findings2,
      };
      
      const result = window.FixingActivity.buildDailyTotals(byCluster);
      
      expect(result.dates).toEqual(['2026-06-02', '2026-06-03', '2026-06-04']);
      expect(result.clusters['Cluster A']).toEqual([0, 1, 2]);
      expect(result.clusters['Cluster B']).toEqual([1, 0, 1]);
    });

    test('sorts dates ascending for chart x-axis', () => {
      const findings = [
        mockFinding({ fixedDate: '2026-06-05T10:00:00Z' }),
        mockFinding({ fixedDate: '2026-06-01T10:00:00Z' }),
        mockFinding({ fixedDate: '2026-06-03T10:00:00Z' }),
      ];
      
      const byCluster = { 'Cluster A': findings };
      const result = window.FixingActivity.buildDailyTotals(byCluster);
      
      expect(result.dates[0]).toBe('2026-06-01');
      expect(result.dates[2]).toBe('2026-06-05');
    });

    test('fills zeros for missing dates in clusters', () => {
      const findings1 = [
        mockFinding({ fixedDate: '2026-06-01T10:00:00Z' }),
      ];
      
      const findings2 = [
        mockFinding({ fixedDate: '2026-06-02T10:00:00Z' }),
        mockFinding({ fixedDate: '2026-06-03T10:00:00Z' }),
      ];
      
      const byCluster = {
        'Cluster A': findings1,
        'Cluster B': findings2,
      };
      
      const result = window.FixingActivity.buildDailyTotals(byCluster);
      
      // Cluster A has [1, 0, 0] and Cluster B has [0, 1, 1]
      expect(result.clusters['Cluster A']).toEqual([1, 0, 0]);
      expect(result.clusters['Cluster B']).toEqual([0, 1, 1]);
    });

    test('handles empty cluster', () => {
      const byCluster = {
        'Cluster A': [],
      };
      
      const result = window.FixingActivity.buildDailyTotals(byCluster);
      
      expect(result.dates).toEqual([]);
      expect(result.clusters['Cluster A']).toEqual([]);
    });

    test('handles multiple clusters independently', () => {
      const findings1 = [
        mockFinding({ fixedDate: '2026-06-04T10:00:00Z' }),
        mockFinding({ fixedDate: '2026-06-04T11:00:00Z' }),
      ];
      
      const findings2 = [
        mockFinding({ fixedDate: '2026-06-04T10:00:00Z' }),
      ];
      
      const byCluster = {
        'Cluster A': findings1,
        'Cluster B': findings2,
      };
      
      const result = window.FixingActivity.buildDailyTotals(byCluster);
      
      expect(result.clusters['Cluster A'][0]).toBe(2);
      expect(result.clusters['Cluster B'][0]).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('renderCombinedLineChart', () => {
    test('creates canvas element in container', () => {
      const container = document.createElement('div');
      const dates = ['2026-06-01', '2026-06-02', '2026-06-03'];
      const clusters = {
        'Cluster A': [1, 2, 3],
        'Cluster B': [2, 1, 3],
      };
      
      window.FixingActivity.renderCombinedLineChart(container, dates, clusters);
      
      expect(container.querySelector('canvas')).not.toBeNull();
    });

    test('creates chart title', () => {
      const container = document.createElement('div');
      const dates = ['2026-06-01'];
      const clusters = { 'Cluster A': [1] };
      
      window.FixingActivity.renderCombinedLineChart(container, dates, clusters);
      
      const title = container.querySelector('h3');
      expect(title).not.toBeNull();
      expect(title.textContent).toContain('Daily Fixing Activity Across All Clusters');
    });

    test('handles multiple clusters with different colors', () => {
      const container = document.createElement('div');
      const dates = ['2026-06-01', '2026-06-02'];
      const clusters = {
        'Cluster A': [1, 2],
        'Cluster B': [2, 1],
        'Cluster C': [3, 3],
      };
      
      window.FixingActivity.renderCombinedLineChart(container, dates, clusters);
      
      const canvas = container.querySelector('canvas');
      expect(canvas).not.toBeNull();
    });

    test('handles no data gracefully', () => {
      const container = document.createElement('div');
      
      window.FixingActivity.renderCombinedLineChart(container, [], {});
      
      // Should not throw and container should be updated
      expect(container).toBeDefined();
    });

    test('handles single cluster', () => {
      const container = document.createElement('div');
      const dates = ['2026-06-01', '2026-06-02'];
      const clusters = { 'Cluster A': [5, 3] };
      
      window.FixingActivity.renderCombinedLineChart(container, dates, clusters);
      
      const canvas = container.querySelector('canvas');
      expect(canvas).not.toBeNull();
    });
  });
    test('renders HTML table with programmer columns', () => {
      const pivotData = {
        dates: ['2026-06-04', '2026-06-03'],
        programmers: ['Alice', 'Bob'],
        pivot: {
          '2026-06-04': {
            Alice: { c: 1, h: 0, m: 0, l: 0 },
            Bob: { c: 0, h: 1, m: 0, l: 0 },
          },
          '2026-06-03': {
            Alice: { c: 0, h: 0, m: 1, l: 0 },
            Bob: { c: 0, h: 0, m: 0, l: 0 },
          },
        },
      };
      
      const html = window.FixingActivity.renderPivotTable('Cluster A', pivotData);
      
      expect(html).toContain('Cluster A');
      expect(html).toContain('pivot-table');
      expect(html).toContain('Alice');
      expect(html).toContain('Bob');
      expect(html).toContain('C:1');
      expect(html).toContain('H:1');
    });

    test('includes date cells with totals', () => {
      const pivotData = {
        dates: ['2026-06-04'],
        programmers: ['Alice', 'Bob'],
        pivot: {
          '2026-06-04': {
            Alice: { c: 1, h: 1, m: 0, l: 0 },
            Bob: { c: 0, h: 1, m: 1, l: 1 },
          },
        },
      };
      
      const html = window.FixingActivity.renderPivotTable('Cluster A', pivotData);
      
      expect(html).toContain('<td class="total">4</td>');
    });

    test('respects maxDays option', () => {
      const pivotData = {
        dates: ['2026-06-05', '2026-06-04', '2026-06-03'],
        programmers: ['Alice'],
        pivot: {
          '2026-06-05': { Alice: { c: 1, h: 0, m: 0, l: 0 } },
          '2026-06-04': { Alice: { c: 1, h: 0, m: 0, l: 0 } },
          '2026-06-03': { Alice: { c: 1, h: 0, m: 0, l: 0 } },
        },
      };
      
      const html = window.FixingActivity.renderPivotTable('Cluster A', pivotData, { maxDays: 2 });
      const rows = (html.match(/<tr>/g) || []).length;
      
      expect(rows).toBe(3); // 1 header + 2 data rows
    });
  });
    test('complete pipeline from cache to rendered rows', async () => {
      const cacheEntries = [
        mockCacheEntry([
          mockFinding({
            fixedDate: '2026-06-04T10:00:00Z',
            severity: 'critical',
            programmer: 'Alice',
          }),
          mockFinding({
            fixedDate: '2026-06-04T11:00:00Z',
            severity: 'high',
            programmer: 'Bob',
          }),
          mockFinding({
            fixedDate: '2026-06-03T10:00:00Z',
            severity: 'medium',
            programmer: 'Alice',
          }),
        ]),
      ];
      
      const fixed = await window.FixingActivity.getFixedFindingsWithProgrammers(cacheEntries);
      expect(fixed).toHaveLength(3);
      
      const daily = window.FixingActivity.aggregateDailyActivity(fixed);
      expect(Object.keys(daily)).toHaveLength(2);
      expect(daily['2026-06-04'].total).toBe(2);
      
      const sorted = window.FixingActivity.sortDates(daily);
      expect(sorted[0][0]).toBe('2026-06-04'); // Most recent first
      
      const html = window.FixingActivity.renderDailyActivityRows(daily);
      expect(html).toContain('2026-06-04');
      expect(html).toContain('<td class="total">2</td>');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('Edge cases', () => {
    test('handles findings with minimal data', async () => {
      const sparse = [{ state: 'fixed', fixedDate: '2026-06-04T10:00:00Z' }];
      const result = await window.FixingActivity.getFixedFindingsWithProgrammers([
        mockCacheEntry(sparse),
      ]);
      
      expect(result).toHaveLength(1);
      expect(result[0].fixId).toBe('unknown');
      expect(result[0].title).toBe('Unknown');
    });

    test('handles large number of fixes in single day', () => {
      const findings = [];
      for (let i = 0; i < 100; i++) {
        findings.push(
          mockFinding({
            fixedDate: '2026-06-04T10:00:00Z',
            alertId: `alert-${i}`,
          })
        );
      }
      
      const daily = window.FixingActivity.aggregateDailyActivity(findings);
      expect(daily['2026-06-04'].total).toBe(100);
    });

    test('handles timestamp edge cases', () => {
      const findings = [
        mockFinding({ fixedDate: '2026-06-04T00:00:00Z' }), // Midnight
        mockFinding({ fixedDate: '2026-06-04T23:59:59Z' }), // Just before midnight
      ];
      
      const daily = window.FixingActivity.aggregateDailyActivity(findings);
      expect(daily['2026-06-04'].total).toBe(2);
    });
  });
});
