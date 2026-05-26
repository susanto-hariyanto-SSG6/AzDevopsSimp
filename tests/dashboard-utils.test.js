/**
 * tests/dashboard-utils.test.js
 * Tests for pure utility functions defined in GHASDashboard.html's <script> block.
 *
 * These functions are small, pure, and critical for correct UI output.
 * They are defined here as standalone mirrors of the source — any change to
 * the originals in GHASDashboard.html must be reflected here too.
 */

// ── Functions mirrored from GHASDashboard.html ────────────────────────────────
// Keep in sync with the <script> block in GHASDashboard.html

const isResolved = f => {
  const s = String(f?.state || '').toLowerCase();
  return s === 'fixed' || s === 'dismissed';
};

const sanitize = n => String(n).replace(/[\s_@#$%^&*!]/g, '-');

function rateColor(pct) {
  if (pct >= 40) return '#27ae60';
  if (pct >= 20) return '#f39c12';
  return '#e74c3c';
}

function ratePill(pct) {
  const cls = pct >= 40 ? 'rate-good' : (pct >= 20 ? 'rate-mid' : 'rate-low');
  return `<span class="rate-pill ${cls}">${pct.toFixed(0)}%</span>`;
}

function fixRate(active, fixed) {
  const total = active + fixed;
  return total > 0 ? (fixed / total * 100) : 0;
}

// ── isResolved ────────────────────────────────────────────────────────────────
describe('isResolved', () => {
  test.each([
    ['fixed',     true],
    ['FIXED',     true],
    ['dismissed', true],
    ['DISMISSED', true],
    ['active',    false],
    ['reopened',  false],
    ['',          false],
  ])('state "%s" → %s', (state, expected) => {
    expect(isResolved({ state })).toBe(expected);
  });

  test('handles null/undefined state gracefully', () => {
    expect(isResolved({})).toBe(false);
    expect(isResolved({ state: null })).toBe(false);
    expect(isResolved(null)).toBe(false);
  });
});

// ── fixRate ───────────────────────────────────────────────────────────────────
describe('fixRate', () => {
  test('returns 0 when both active and fixed are 0', () => {
    expect(fixRate(0, 0)).toBe(0);
  });

  test('returns 100 when all findings are fixed', () => {
    expect(fixRate(0, 10)).toBe(100);
  });

  test('returns 0 when nothing is fixed', () => {
    expect(fixRate(10, 0)).toBe(0);
  });

  test('calculates percentage correctly', () => {
    expect(fixRate(3, 1)).toBeCloseTo(25);   // 1 / (3+1)
    expect(fixRate(1, 3)).toBeCloseTo(75);   // 3 / (1+3)
    expect(fixRate(3, 3)).toBeCloseTo(50);
  });
});

// ── sanitize ──────────────────────────────────────────────────────────────────
describe('sanitize', () => {
  test('replaces spaces with dashes', () => {
    expect(sanitize('My Repo')).toBe('My-Repo');
  });

  test('replaces underscores with dashes', () => {
    expect(sanitize('My_Repo')).toBe('My-Repo');
  });

  test('replaces all special chars: @ # $ % ^ & * !', () => {
    expect(sanitize('r@#$%^&*!')).toBe('r--------');
  });

  test('leaves alphanumeric and hyphens unchanged', () => {
    expect(sanitize('SSG5-C1-BSQWebAPI')).toBe('SSG5-C1-BSQWebAPI');
  });

  test('handles empty string', () => {
    expect(sanitize('')).toBe('');
  });
});

// ── rateColor ─────────────────────────────────────────────────────────────────
describe('rateColor', () => {
  test.each([
    [0,   '#e74c3c'],
    [19,  '#e74c3c'],
    [20,  '#f39c12'],
    [39,  '#f39c12'],
    [40,  '#27ae60'],
    [100, '#27ae60'],
  ])('%i% → %s', (pct, color) => {
    expect(rateColor(pct)).toBe(color);
  });
});

// ── ratePill ──────────────────────────────────────────────────────────────────
describe('ratePill', () => {
  test('uses rate-good class for ≥40%', () => {
    expect(ratePill(40)).toContain('rate-good');
    expect(ratePill(100)).toContain('rate-good');
  });

  test('uses rate-mid class for 20–39%', () => {
    expect(ratePill(20)).toContain('rate-mid');
    expect(ratePill(39)).toContain('rate-mid');
  });

  test('uses rate-low class for <20%', () => {
    expect(ratePill(0)).toContain('rate-low');
    expect(ratePill(19)).toContain('rate-low');
  });

  test('renders percentage rounded to integer', () => {
    expect(ratePill(33.7)).toContain('34%');
    expect(ratePill(0)).toContain('0%');
  });
});
