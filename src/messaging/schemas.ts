import { z } from 'zod';

export const detectedMediaSchema = z.object({
  id: z.string().min(1).max(128),
  // -1 = sender tab unknown (content scripts don't know their tab id);
  // background overrides with sender.tab.id before storing.
  tabId: z.number().int().min(-1),
  url: z.string().url().max(8192),
  kind: z.enum(['video-direct', 'audio-direct', 'hls', 'dash', 'unknown']),
  source: z.enum(['dom', 'network', 'manifest-hint']),
  sources: z.array(z.enum(['dom', 'network', 'manifest-hint'])).max(3).optional(),
  fileExtension: z.string().nullable(),
  mimeType: z.string().nullable(),
  container: z.string().nullable(),
  codecs: z.string().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  durationSec: z.number().nullable(),
  hostname: z.string().nullable(),
  estimatedSizeBytes: z.number().nullable(),
  detectedAt: z.number(),
  title: z.string().nullable(),
});

export const diagReasonSchema = z.enum([
  'scan-summary',
  'blob-source-skipped',
  'unsafe-scheme-rejected',
  'non-media-filtered',
  'iframe-embed-noted',
  'network-observed',
  'network-classified',
  'no-host-access',
  'message-dropped-invalid',
]);

export const diagEventSchema = z.object({
  t: z.number(),
  tabId: z.number().int().min(-1),
  reason: diagReasonSchema,
  host: z.string().nullable(),
  detail: z.string().max(200),
  stats: z
    .object({
      videos: z.number().int().nonnegative(),
      blobOnly: z.number().int().nonnegative(),
      embeds: z.number().int().nonnegative(),
      items: z.number().int().nonnegative(),
    })
    .optional(),
});

export type ValidatedDiagEvent = z.infer<typeof diagEventSchema>;

export const messageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('MEDIA_DETECTED'),
    payload: z.object({ items: z.array(detectedMediaSchema).max(200) }),
  }),
  z.object({
    type: z.literal('GET_TAB_MEDIA'),
    payload: z.object({ tabId: z.number().int().nonnegative() }),
  }),
  z.object({
    type: z.literal('START_DIRECT_DOWNLOAD'),
    payload: z.object({
      mediaId: z.string().min(1),
      url: z.string().url().max(8192),
      filename: z.string().min(1).max(255),
    }),
  }),
  z.object({
    type: z.literal('CANCEL_DOWNLOAD'),
    payload: z.object({ queueId: z.string().min(1) }),
  }),
  z.object({
    type: z.literal('RETRY_DOWNLOAD'),
    payload: z.object({ queueId: z.string().min(1) }),
  }),
  z.object({
    type: z.literal('DIAG_EVENT'),
    payload: z.object({ events: z.array(diagEventSchema).max(20) }),
  }),
  z.object({
    type: z.literal('GET_DIAGNOSTICS'),
    payload: z.object({
      tabId: z.number().int().nonnegative(),
      host: z.string().max(253),
    }),
  }),
  z.object({
    type: z.literal('LIST_VARIANTS'),
    payload: z.object({
      manifestUrl: z.string().url().max(8192),
      kind: z.enum(['hls', 'dash']),
    }),
  }),
  z.object({
    type: z.literal('START_STREAM_DOWNLOAD'),
    payload: z.object({
      mediaId: z.string().min(1),
      manifestUrl: z.string().url().max(8192),
      kind: z.enum(['hls', 'dash']),
      variantId: z.string().min(1).max(64),
      filename: z.string().min(1).max(255),
    }),
  }),
  z.object({
    type: z.literal('OFFSCREEN_VARIANTS'),
    payload: z.object({
      manifestUrl: z.string().url().max(8192),
      kind: z.enum(['hls', 'dash']),
    }),
  }),
  z.object({
    type: z.literal('OFFSCREEN_EXEC'),
    payload: z.object({
      queueId: z.string().min(1),
      manifestUrl: z.string().url().max(8192),
      kind: z.enum(['hls', 'dash']),
      variantId: z.string().min(1).max(64),
    }),
  }),
  z.object({
    type: z.literal('OFFSCREEN_CANCEL'),
    payload: z.object({ queueId: z.string().min(1) }),
  }),
]);

export type ExtensionMessage = z.infer<typeof messageSchema>;

export function parseMessage(raw: unknown): ExtensionMessage | null {
  const res = messageSchema.safeParse(raw);
  return res.success ? res.data : null;
}
