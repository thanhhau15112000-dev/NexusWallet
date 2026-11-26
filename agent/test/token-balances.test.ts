import { describe, expect, it, vi } from 'vitest';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { Connection } from '@solana/web3.js';
import { getTokenBalances } from '../src/chain.js';

const OWNER = '6VPd7LHbx96D2QiSsAo5JrEdRQUdW1PGk3bUNYhVECAz';

function account(mint: string, amount: string, uiAmountString: string, decimals = 6) {
  return { account: { data: { parsed: { info: { mint, tokenAmount: { amount, decimals, uiAmountString } } } } } };
}

describe('getTokenBalances', () => {
  it('returns non-zero balances from both token programs', async () => {
    const getParsedTokenAccountsByOwner = vi.fn(async (_owner: unknown, filter: { programId: { equals: (o: unknown) => boolean } }) => ({
      context: { slot: 1 },
      value: filter.programId.equals(TOKEN_PROGRAM_ID)
        ? [account('MintClassic', '5000000', '5'), account('MintEmpty', '0', '0')]
        : filter.programId.equals(TOKEN_2022_PROGRAM_ID)
          ? [account('Mint2022', '1500', '1.5', 3)]
          : [],
    }));
    const balances = await getTokenBalances({ getParsedTokenAccountsByOwner } as unknown as Connection, OWNER);
    expect(balances).toEqual([
      { mint: 'MintClassic', amount: '5', decimals: 6 },
      { mint: 'Mint2022', amount: '1.5', decimals: 3 },
    ]);
    expect(getParsedTokenAccountsByOwner).toHaveBeenCalledTimes(2);
  });
});
