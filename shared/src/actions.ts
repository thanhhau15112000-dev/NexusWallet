import { z } from 'zod';

export const ActionGetResponseSchema = z.object({
  icon: z.string().url(),
  title: z.string().min(1).max(200),
  description: z.string().max(1000),
  label: z.string().max(50),
  disabled: z.boolean().optional().default(false),
  links: z
    .object({
      actions: z
        .array(
          z.object({
            label: z.string(),
            href: z.string(),
            parameters: z
              .array(
                z.object({
                  name: z.string(),
                  label: z.string().optional(),
                  required: z.boolean().optional(),
                }),
              )
              .optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  error: z.object({ message: z.string() }).optional(),
});
export type ActionGetResponse = z.infer<typeof ActionGetResponseSchema>;

export const ActionPostResponseSchema = z.object({
  transaction: z.string().min(1),
  message: z.string().optional(),
});
export type ActionPostResponse = z.infer<typeof ActionPostResponseSchema>;

export type ActionInspectionResult = {
  actionMetadata: ActionGetResponse;
  transactionBase64: string;
  simulatedSolOutflowLamports: number;
  detectedRecipients: string[];
  detectedMints: string[];
  simulationLogs: string[];
};

export type ActionExecutionResult =
  | {
      status: 'completed';
      signature: string;
      actionMetadata: ActionGetResponse;
      solOutflowLamports: number;
    }
  | {
      status: 'pending_approval';
      code: 'ACTION_APPROVAL_REQUIRED';
      message: string;
      remediation: string;
      approvalUrl: string;
      requestId: string;
      actionMetadata: ActionGetResponse;
      solOutflowLamports: number;
    }
  | {
      status: 'denied';
      code: string;
      message: string;
      remediation?: string;
      details?: Record<string, unknown>;
    };
