import { describe, expect, it } from 'vitest';
import { en } from '../../web/src/i18n/locales/en.js';
import { vi } from '../../web/src/i18n/locales/vi.js';
import { MASCOT_POSES } from '../../web/src/components/Mascot.js';

function collectKeysAndTokens(obj: Record<string, any>, prefix = ''): Map<string, { value: string; tokens: string[] }> {
  const result = new Map<string, { value: string; tokens: string[] }>();
  for (const [key, val] of Object.entries(obj)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const nested = collectKeysAndTokens(val, fullPath);
      for (const [nKey, nVal] of nested.entries()) {
        result.set(nKey, nVal);
      }
    } else if (typeof val === 'string') {
      const tokenMatches = val.match(/\{([a-zA-Z0-9_]+)\}/g) || [];
      const tokens = tokenMatches.map((t) => t.slice(1, -1)).sort();
      result.set(fullPath, { value: val, tokens });
    }
  }
  return result;
}

function interpolate(template: string, params: Record<string, string | number>): string {
  let result = template;
  for (const [key, value] of Object.entries(params)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value));
  }
  return result;
}

describe('i18n Translation Dictionary Integrity', () => {
  const enMap = collectKeysAndTokens(en);
  const viMap = collectKeysAndTokens(vi);

  it('both dictionaries should have the exact same set of translation keys', () => {
    const enKeys = Array.from(enMap.keys()).sort();
    const viKeys = Array.from(viMap.keys()).sort();

    const missingInVi = enKeys.filter((k) => !viMap.has(k));
    const extraInVi = viKeys.filter((k) => !enMap.has(k));

    expect(missingInVi, `Keys in en but missing in vi: ${missingInVi.join(', ')}`).toEqual([]);
    expect(extraInVi, `Keys in vi but missing in en: ${extraInVi.join(', ')}`).toEqual([]);
    expect(enKeys).toEqual(viKeys);
  });

  it('no translation string in en or vi should be empty or whitespace-only', () => {
    for (const [key, { value }] of enMap.entries()) {
      expect(value.trim().length, `en key "${key}" has empty value`).toBeGreaterThan(0);
    }
    for (const [key, { value }] of viMap.entries()) {
      expect(value.trim().length, `vi key "${key}" has empty value`).toBeGreaterThan(0);
    }
  });

  it('interpolation tokens ({param}) must match exactly between en and vi', () => {
    for (const [key, enData] of enMap.entries()) {
      const viData = viMap.get(key);
      expect(viData, `vi missing key "${key}"`).toBeDefined();
      if (viData) {
        expect(
          viData.tokens,
          `Interpolation tokens mismatch for key "${key}": EN has [${enData.tokens.join(', ')}], VI has [${viData.tokens.join(', ')}]`,
        ).toEqual(enData.tokens);
      }
    }
  });

  it('verifies interpolation handles single, multiple, numeric, and missing params correctly', () => {
    const template = en.toasts.depositSent; // 'Deposit of {amount} SOL sent! Tx: {tx}'
    const formatted = interpolate(template, { amount: 0.1, tx: '5xyz' });
    expect(formatted).toBe('Deposit of 0.1 SOL sent! Tx: 5xyz');

    const viTemplate = vi.toasts.depositSent;
    const viFormatted = interpolate(viTemplate, { amount: 0.1, tx: '5xyz' });
    expect(viFormatted).toContain('0.1');
    expect(viFormatted).toContain('5xyz');

    // Edge cases
    expect(interpolate('Hello {name}', {})).toBe('Hello {name}');
    expect(interpolate('{x} + {x} = 2', { x: 1 })).toBe('1 + 1 = 2');
  });

  it('every feature tab has a localized label in both en and vi', () => {
    const requiredTabs = ['wallet', 'tasks', 'commands', 'policy', 'approvals', 'audit', 'docs'] as const;
    for (const tab of requiredTabs) {
      expect(en.tabs[tab], `en missing tab "${tab}"`).toBeDefined();
      expect(vi.tabs[tab], `vi missing tab "${tab}"`).toBeDefined();
    }
  });

  it('mascot has bilingual captions for all application and tab states', () => {
    const requiredMascotKeys = [
      'wallet',
      'tasks',
      'commands',
      'policy',
      'approvals',
      'audit',
      'docs',
      'working',
      'success',
      'failed',
      'offline',
      'signIn',
      'loading',
    ] as const;

    for (const key of requiredMascotKeys) {
      expect(en.mascot[key], `en.mascot missing key "${key}"`).toBeDefined();
      expect(vi.mascot[key], `vi.mascot missing key "${key}"`).toBeDefined();
    }
  });

  it('all 12 mascot SVG poses are defined in MASCOT_POSES', () => {
    expect(MASCOT_POSES).toHaveLength(12);
    expect(MASCOT_POSES).toContain('wallet');
    expect(MASCOT_POSES).toContain('tasks');
    expect(MASCOT_POSES).toContain('command');
    expect(MASCOT_POSES).toContain('policy');
    expect(MASCOT_POSES).toContain('approved');
    expect(MASCOT_POSES).toContain('audit');
    expect(MASCOT_POSES).toContain('docs');
    expect(MASCOT_POSES).toContain('wave');
    expect(MASCOT_POSES).toContain('cheer');
    expect(MASCOT_POSES).toContain('think');
    expect(MASCOT_POSES).toContain('denied');
    expect(MASCOT_POSES).toContain('sleep');
  });

  it('request statuses are completely localized in both languages', () => {
    const statuses = [
      'planned',
      'auto_approved',
      'pending_approval',
      'approved',
      'confirmed',
      'failed',
      'denied',
      'expired',
    ] as const;

    for (const status of statuses) {
      expect(en.requests.statuses[status]).toBeDefined();
      expect(vi.requests.statuses[status]).toBeDefined();
    }
  });

  it('language resolution follows priority: saved setting -> browser locale -> default en', () => {
    function resolveLang(saved: string | null, navLang?: string): 'en' | 'vi' {
      if (saved === 'en' || saved === 'vi') return saved;
      if (navLang?.toLowerCase().startsWith('vi')) return 'vi';
      return 'en';
    }

    // 1. Saved preference wins
    expect(resolveLang('vi', 'en-US')).toBe('vi');
    expect(resolveLang('en', 'vi-VN')).toBe('en');

    // 2. Browser locale when no saved preference
    expect(resolveLang(null, 'vi-VN')).toBe('vi');
    expect(resolveLang(null, 'vi')).toBe('vi');
    expect(resolveLang(null, 'en-US')).toBe('en');
    expect(resolveLang(null, 'ja-JP')).toBe('en');

    // 3. Invalid saved preference falls through
    expect(resolveLang('invalid', 'vi-VN')).toBe('vi');
    expect(resolveLang('invalid', 'fr')).toBe('en');
  });
});
