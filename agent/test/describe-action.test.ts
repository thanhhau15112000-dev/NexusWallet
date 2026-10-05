import { describe, expect, it } from 'vitest';
import type { PaymentRequest } from '@nexus/shared';
import { describeAction } from '../../web/src/components/RequestList.js';
import { en } from '../../web/src/i18n/locales/en.js';
import { vi } from '../../web/src/i18n/locales/vi.js';

const withAction = (action: unknown) => ({ plan: { action } }) as unknown as PaymentRequest;

describe('describeAction labels', () => {
  it('takes the balance and manual-approval wording from the dictionary', () => {
    expect(describeAction(withAction({ type: 'get_balance' }), en.requests.actions)).toBe('Balance');
    expect(describeAction(withAction({ type: 'request_manual_approval' }), en.requests.actions)).toBe('Manual approval');
    expect(describeAction(withAction({ type: 'get_balance' }), vi.requests.actions)).toBe('Số dư');
    expect(describeAction(withAction({ type: 'request_manual_approval' }), vi.requests.actions)).toBe('Duyệt thủ công');
  });

  it('does not use the labels for transfers or a missing plan', () => {
    const labels = { balance: 'B', manualApproval: 'M' };
    expect(describeAction({ plan: null } as unknown as PaymentRequest, labels)).toBe('-');
    expect(
      describeAction(withAction({ type: 'transfer_sol', amountSol: 0.5, recipient: 'treasury' }), labels),
    ).toBe('0.5 SOL → treasury');
  });
});
