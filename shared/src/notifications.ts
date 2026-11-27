import { z } from 'zod';

export const TelegramNotificationEventsSchema = z.object({
  pendingApproval: z.boolean().default(true),
});

export type TelegramNotificationEvents = z.infer<typeof TelegramNotificationEventsSchema>;

export const TelegramNotificationSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  chatId: z.string().min(1).nullable().default(null),
  username: z.string().min(1).nullable().default(null),
  linkedAt: z.string().nullable().default(null),
  lastError: z.string().nullable().default(null),
  events: TelegramNotificationEventsSchema.default({ pendingApproval: true }),
});

export type TelegramNotificationSettings = z.infer<typeof TelegramNotificationSettingsSchema>;

export const NotificationSettingsSchema = z.object({
  telegram: TelegramNotificationSettingsSchema.default({}),
});

export type NotificationSettings = z.infer<typeof NotificationSettingsSchema>;

export function defaultNotificationSettings(): NotificationSettings {
  return NotificationSettingsSchema.parse({});
}
