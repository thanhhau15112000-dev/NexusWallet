import type { IntentEnvelope, ModelContext } from '@nexus/shared';

function allowlistBlock(ctx: ModelContext): string {
  const recipients = ctx.recipients.length
    ? ctx.recipients.map((r) => `- ${r.label} = ${r.address}`).join('\n')
    : '- (empty)';
  const mints = ctx.mints.length
    ? ctx.mints.map((m) => `- ${m.label} = ${m.address}`).join('\n')
    : '- (empty)';
  return `Known recipient labels:\n${recipients}\n\nKnown token mints:\n${mints}`;
}

export const INTENT_SYSTEM = `You classify wallet requests for a Solana devnet agent.
Return JSON only, matching exactly:
{"goal":string,"operation":"transfer_sol"|"transfer_spl"|"get_balance"|"unknown",
 "entities":{"recipient"?:string,"amount"?:number,"asset"?:string},
 "riskNotes":string[],"confidence":number,"requiresHuman":boolean}

Rules:
- "amount" is the numeric quantity specified by the user, in the unit specified.
- "recipient" is copied verbatim from the user (a label or a base58 address).
- Set requiresHuman true when the request is vague, conditional, or unusually large.
- Never invent a recipient the user did not mention.
- You never sign, never build transactions and never see private keys.`;

export function intentUserPrompt(prompt: string, ctx: ModelContext): string {
  return `${allowlistBlock(ctx)}

Agent: ${ctx.agentId} on Solana ${ctx.cluster}.

User request:
"""
${prompt}
"""

Return the JSON envelope.`;
}

export const PLAN_SYSTEM = `You turn a parsed intent into ONE action for a Solana devnet agent.
Return JSON only, matching exactly:
{"action":<Action>,"rationale":string,"confidence":number}

Action is exactly one of:
{"type":"get_balance"}
{"type":"transfer_sol","recipient":string,"amountSol":number,"memo"?:string}
{"type":"transfer_spl","recipient":string,"mint":string,"amount":number,"memo"?:string}
{"type":"request_manual_approval","reason":string}

Rules:
- Output no other keys, no instructions, no program ids, no serialized transactions.
- "recipient" must be a label from the allowlist or a base58 address the user gave.
- "amountSol" is in whole SOL, not lamports.
- Do not decide whether the action is permitted. A separate policy engine does that.
- If the request is not one of the four actions, use request_manual_approval.`;

export function planUserPrompt(intent: IntentEnvelope, ctx: ModelContext): string {
  return `${allowlistBlock(ctx)}

Parsed intent:
${JSON.stringify(intent, null, 2)}

Return the JSON action plan.`;
}
