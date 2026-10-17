/** Versioned wire types. No Node, database, React, or native dependencies. */
export interface Town {
  id: string;
  label: string;
}
export interface Catalog {
  apiVersion: 1;
  defaultTown: string;
  towns: Town[];
}
export type BrowseView = 'transcripts' | 'meetings' | 'activity';
export interface EventSummary {
  id: string;
  town: string;
  title: string;
  body: string;
  type: string;
  typeLabel: string;
  date: string;
  source: string;
  excerpt: string | null;
  matchingPassage: boolean;
  url: string;
}
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  nextPage: number | null;
  sampleData: boolean;
}
export interface EventPage extends Page<EventSummary> {
  boards: { value: string; n: number }[];
}
export interface TranscriptSegment {
  startSeconds: number;
  endSeconds: number;
  speakerLabel: string;
  text: string;
}
export interface MatterSummary {
  id: string;
  town: string;
  label: string;
  kind: string;
  status: string | null;
  eventCount: number;
  lastAt: string | null;
}
export interface EventDetail extends EventSummary {
  sampleData: boolean;
  summary: string | null;
  documentUrl: string | null;
  text: string | null;
  transcript: { videoUrl: string; origin: 'publisher-auto'; segments: TranscriptSegment[] } | null;
  matters: MatterSummary[];
}
export interface MatterDetail extends MatterSummary {
  sampleData: boolean;
  events: (EventSummary & { stage: string; evidence: string | null })[];
}
export interface Session {
  name: string;
  email: string;
}
export interface LoginResponse {
  token: string;
}
export interface Following {
  items: MatterSummary[];
}
export interface ApiError {
  error: string;
}
