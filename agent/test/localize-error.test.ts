import { describe, expect, it } from 'vitest';
import { localizeError } from '../../web/src/components/RequestList.js';
import { en } from '../../web/src/i18n/locales/en.js';
import { vi } from '../../web/src/i18n/locales/vi.js';

const interpolate = (template: string, params: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(params[key] ?? `{${key}}`));

describe('localizeError for a transaction limit', () => {
  const sol = {
    code: 'AMOUNT_EXCEEDS_TRANSACTION_LIMIT',
    message: 'amount 0.5 SOL exceeds the per-transaction limit of 0.1 SOL',
    details: { requestedSol: 0.5, requestedLamports: 500_000_000, limitSol: 0.1, limitLamports: 100_000_000 },
  };
  const token = {
    code: 'AMOUNT_EXCEEDS_TRANSACTION_LIMIT',
    message: 'amount 3 exceeds the per-transaction limit of 2 for mint usdc',
    details: { mint: 'Mint111', mintLabel: 'usdc', requestedAmount: 3, limitAmount: 2 },
  };

  it('states the amount and the limit of a SOL transfer', () => {
    expect(localizeError(sol, en.requests.errors, interpolate)).toBe(
      'Amount 0.5 SOL exceeds the per-transaction limit of 0.1 SOL; owner approval is required.',
    );
    expect(localizeError(sol, vi.requests.errors, interpolate)).toBe(
      'Số tiền 0.5 SOL vượt hạn mức mỗi giao dịch 0.1 SOL, cần chủ ví duyệt.',
    );
  });

  it('states the amount and the limit of a token transfer in its label', () => {
    expect(localizeError(token, en.requests.errors, interpolate)).toBe(
      'Amount 3 usdc exceeds the per-transaction limit of 2 usdc; owner approval is required.',
    );
    expect(localizeError(token, vi.requests.errors, interpolate)).toBe(
      'Số tiền 3 usdc vượt hạn mức mỗi giao dịch 2 usdc, cần chủ ví duyệt.',
    );
  });

  it('keeps the raw reason when the details predate the limit fields', () => {
    expect(localizeError({ ...sol, details: undefined }, vi.requests.errors, interpolate)).toBe(sol.message);
  });
});
