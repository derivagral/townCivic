import { z } from 'zod';

/** Source-local labels only. No inference of identities, attendance, or voice matching. */
export const transcriptSchema = z.object({
  version: z.literal(1),
  origin: z.literal('publisher-auto'),
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  meetingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  segments: z
    .array(
      z
        .object({
          startSeconds: z.number().int().nonnegative(),
          endSeconds: z.number().int().nonnegative(),
          speakerLabel: z.string(),
          text: z.string().min(1),
        })
        .refine((s) => s.endSeconds >= s.startSeconds),
    )
    .min(1),
});

export type TranscriptArtifact = z.infer<typeof transcriptSchema>;

export function transcriptFromRaw(raw: string): TranscriptArtifact | null {
  try {
    const result = transcriptSchema.safeParse(JSON.parse(raw)?.transcript);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function transcriptVideoUrl(videoId: string, startSeconds?: number): string {
  const url = new URL('https://www.youtube.com/watch');
  url.searchParams.set('v', videoId);
  if (startSeconds !== undefined) url.searchParams.set('t', `${startSeconds}s`);
  return url.toString();
}

export function formatTimestamp(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}
