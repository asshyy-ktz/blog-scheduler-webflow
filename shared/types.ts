// Types shared by the server and the Designer Extension.

export const PIPELINE = ["idea", "draft", "review", "scheduled", "published"] as const;
export type PipelineStatus = (typeof PIPELINE)[number];

export type PublishState = "idle" | "publishing" | "retrying" | "failed";

export const MAPPING_KEYS = ["title", "slug", "body", "author", "publishDate"] as const;
export type MappingKey = (typeof MAPPING_KEYS)[number];
/** Logical field -> CMS field slug. */
export type FieldMap = Partial<Record<MappingKey, string>>;

export interface Post {
  id: string;
  itemId: string | null;
  title: string;
  slug: string;
  body: string;
  author: string;
  status: PipelineStatus;
  /** UTC ISO-8601 */
  scheduledAt: string | null;
  publishedAt: string | null;
  publishState: PublishState;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PostInput {
  title?: string;
  slug?: string;
  body?: string;
  author?: string;
  status?: PipelineStatus;
  scheduledAt?: string | null;
}

export interface PostResponse {
  post: Post;
  /** Present when the local save succeeded but syncing the draft to Webflow failed. */
  syncError?: string;
}

export interface SiteConfig {
  siteId: string;
  timezone: string;
  collectionId: string | null;
  fieldMap: FieldMap;
  needsReauth: boolean;
}

export interface CollectionField {
  id: string;
  slug: string;
  displayName: string;
  type: string;
}

export interface DiscoveredCollection {
  id: string;
  displayName: string;
  slug: string;
  fields: CollectionField[];
  /** Heuristic: looks like a blog collection. */
  likelyBlog: boolean;
  suggestedMap: FieldMap;
}

export interface BulkRescheduleRequest {
  moves?: Array<{ id: string; scheduledAt: string }>;
  ids?: string[];
  /** Whole local calendar days to shift `ids` by (DST-safe). */
  shiftDays?: number;
}

export interface BulkRescheduleResult {
  results: Array<{ id: string; ok: boolean; error?: string; post?: Post }>;
}

export interface PublishRun {
  id: string;
  trigger: "poll" | "manual" | "recovery";
  startedAt: string;
  finishedAt: string | null;
  dueCount: number;
  published: number;
  retried: number;
  failed: number;
}

export interface PublishLogEntry {
  id: number;
  runId: string;
  postId: string;
  itemId: string | null;
  title: string;
  outcome: "published" | "recovered" | "retry" | "failed";
  attempt: number;
  message: string;
  createdAt: string;
}
