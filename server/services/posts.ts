import { randomUUID } from "crypto";
import { db, SqlParam } from "../db";
import { HttpError } from "../http";
import { BulkRescheduleRequest, BulkRescheduleResult, FieldMap, PIPELINE, PipelineStatus, Post, PostInput, PostResponse, PublishState } from "../../shared/types";
import { isValidTimeZone, shiftUtcIsoByLocalDays } from "../../shared/time";
import { getActiveInstall, InstallationRow } from "./installations";
import { clientFor } from "./webflow-client";

export interface PostRow {
  id: string;
  site_id: string;
  item_id: string | null;
  title: string;
  slug: string;
  body: string;
  author: string;
  status: PipelineStatus;
  scheduled_at: string | null;
  published_at: string | null;
  publish_state: PublishState;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  idempotency_key: string | null;
  claimed_at: string | null;
  is_archived: number;
  remote_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

export function toPost(r: PostRow): Post {
  return {
    id: r.id,
    itemId: r.item_id,
    title: r.title,
    slug: r.slug,
    body: r.body,
    author: r.author,
    status: r.status,
    scheduledAt: r.scheduled_at,
    publishedAt: r.published_at,
    publishState: r.publish_state,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    lastError: r.last_error,
    isArchived: r.is_archived === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

function normalizeIso(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new HttpError(400, `${field} must be an ISO-8601 timestamp`);
  return new Date(value).toISOString();
}

export function parsePostInput(body: unknown): PostInput {
  if (!body || typeof body !== "object") throw new HttpError(400, "JSON body required");
  const b = body as Record<string, unknown>;
  const out: PostInput = {};
  for (const key of ["title", "slug", "body", "author"] as const) {
    if (b[key] === undefined) continue;
    if (typeof b[key] !== "string") throw new HttpError(400, `${key} must be a string`);
    out[key] = key === "body" ? (b[key] as string) : (b[key] as string).trim();
  }
  if (out.title !== undefined && !out.title) throw new HttpError(400, "title cannot be empty");
  if (b.status !== undefined) {
    if (!PIPELINE.includes(b.status as PipelineStatus)) throw new HttpError(400, `status must be one of ${PIPELINE.join(", ")}`);
    out.status = b.status as PipelineStatus;
  }
  if (b.scheduledAt !== undefined) out.scheduledAt = normalizeIso(b.scheduledAt, "scheduledAt");
  return out;
}

async function requireInstall(siteId: string): Promise<InstallationRow> {
  const inst = await getActiveInstall(siteId);
  if (!inst) throw new HttpError(404, "Site is not installed");
  return inst;
}

export async function getPostRow(siteId: string, id: string): Promise<PostRow> {
  const row = await db.get<PostRow>(`SELECT * FROM posts WHERE id = ? AND site_id = ?`, [id, siteId]);
  if (!row) throw new HttpError(404, "Post not found");
  return row;
}

export async function getPost(siteId: string, id: string): Promise<Post> {
  return toPost(await getPostRow(siteId, id));
}

/** Posts whose scheduled/published date falls in [fromUtc, toUtc), plus undated posts for the backlog lane. */
export async function listPosts(siteId: string, fromUtc?: string, toUtc?: string): Promise<{ dated: Post[]; undated: Post[] }> {
  const params: SqlParam[] = [siteId];
  let range = "";
  if (fromUtc && toUtc) {
    range = ` AND COALESCE(scheduled_at, published_at) >= ? AND COALESCE(scheduled_at, published_at) < ?`;
    params.push(fromUtc, toUtc);
  }
  const dated = await db.all<PostRow>(
    `SELECT * FROM posts WHERE site_id = ? AND is_archived = 0 AND COALESCE(scheduled_at, published_at) IS NOT NULL${range} ORDER BY COALESCE(scheduled_at, published_at)`,
    params
  );
  const undated = await db.all<PostRow>(`SELECT * FROM posts WHERE site_id = ? AND is_archived = 0 AND scheduled_at IS NULL AND published_at IS NULL ORDER BY created_at DESC`, [siteId]);
  return { dated: dated.map(toPost), undated: undated.map(toPost) };
}

function assertConsistent(status: PipelineStatus, scheduledAt: string | null): void {
  if (status === "scheduled" && !scheduledAt) throw new HttpError(400, "A scheduled post needs a scheduledAt date");
}

// --- Webflow draft sync ------------------------------------------------------------------------

export function buildFieldData(post: Pick<PostRow, "title" | "slug" | "body" | "author" | "scheduled_at">, map: FieldMap): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (map.title) data[map.title] = post.title;
  if (map.slug) data[map.slug] = post.slug || slugify(post.title);
  if (map.body && post.body) data[map.body] = post.body;
  if (map.author && post.author) data[map.author] = post.author;
  if (map.publishDate && post.scheduled_at) data[map.publishDate] = post.scheduled_at;
  return data;
}

/**
 * Creates or updates the staged Webflow item (isDraft: true) for a post. Ideas stay local-only and
 * published posts are never touched. Returns an error string instead of throwing so the local save stands.
 */
export async function syncDraft(siteId: string, postId: string): Promise<string | undefined> {
  const inst = await requireInstall(siteId);
  const row = await getPostRow(siteId, postId);
  if (row.status === "idea" || row.status === "published") return undefined;
  if (!inst.collection_id) return "No blog collection mapped yet; saved locally only";
  const map = JSON.parse(inst.field_map || "{}") as FieldMap;
  if (!map.title) return "No title field mapped; saved locally only";
  try {
    const client = clientFor(siteId);
    const fieldData = buildFieldData(row, map);
    let itemId = row.item_id;
    let remoteUpdated: string | null = row.remote_updated_at;
    if (itemId) {
      const item = await client.updateItem(inst.collection_id, itemId, { isDraft: true, fieldData });
      remoteUpdated = item.lastUpdated ?? remoteUpdated;
    } else {
      const item = await client.createDraftItem(inst.collection_id, fieldData);
      itemId = item.id;
      remoteUpdated = item.lastUpdated ?? null;
    }
    await db.run(`UPDATE posts SET item_id = ?, slug = ?, remote_updated_at = ?, last_error = NULL WHERE id = ?`, [itemId, String(fieldData[map.slug ?? ""] ?? row.slug), remoteUpdated, postId]);
    return undefined;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.run(`UPDATE posts SET last_error = ? WHERE id = ?`, [message.slice(0, 500), postId]);
    return message;
  }
}

async function respond(siteId: string, id: string, syncError?: string): Promise<PostResponse> {
  const post = await getPost(siteId, id);
  return syncError ? { post, syncError } : { post };
}

// --- CRUD --------------------------------------------------------------------------------------

export async function createPost(siteId: string, input: PostInput): Promise<PostResponse> {
  await requireInstall(siteId);
  if (!input.title) throw new HttpError(400, "title is required");
  const status = input.status ?? "idea";
  if (status === "published") throw new HttpError(400, "Posts become published only through the scheduler or Webflow");
  const scheduledAt = input.scheduledAt ?? null;
  assertConsistent(status, scheduledAt);
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO posts (id, site_id, title, slug, body, author, status, scheduled_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, siteId, input.title, input.slug || slugify(input.title), input.body ?? "", input.author ?? "", status, scheduledAt, now, now]
  );
  return respond(siteId, id, await syncDraft(siteId, id));
}

export async function updatePost(siteId: string, id: string, input: PostInput): Promise<PostResponse> {
  const row = await getPostRow(siteId, id);
  if (row.status === "published") throw new HttpError(409, "Published posts are edited in Webflow");
  if (input.status === "published") throw new HttpError(400, "Posts become published only through the scheduler or Webflow");
  const next = {
    title: input.title ?? row.title,
    slug: input.slug ?? row.slug,
    body: input.body ?? row.body,
    author: input.author ?? row.author,
    status: input.status ?? row.status,
    scheduled_at: input.scheduledAt !== undefined ? input.scheduledAt : row.scheduled_at,
  };
  assertConsistent(next.status, next.scheduled_at);
  const scheduleChanged = next.status !== row.status || next.scheduled_at !== row.scheduled_at;
  // Any change to what/when resets retry bookkeeping so a fixed post gets a clean run.
  await db.run(
    `UPDATE posts SET title = ?, slug = ?, body = ?, author = ?, status = ?, scheduled_at = ?,
       publish_state = CASE WHEN ? = 1 AND publish_state != 'publishing' THEN 'idle' ELSE publish_state END,
       attempts = CASE WHEN ? = 1 AND publish_state != 'publishing' THEN 0 ELSE attempts END,
       next_attempt_at = CASE WHEN ? = 1 THEN NULL ELSE next_attempt_at END,
       updated_at = ? WHERE id = ?`,
    [next.title, next.slug, next.body, next.author, next.status, next.scheduled_at, scheduleChanged ? 1 : 0, scheduleChanged ? 1 : 0, scheduleChanged ? 1 : 0, new Date().toISOString(), id]
  );
  return respond(siteId, id, await syncDraft(siteId, id));
}

export async function deletePost(siteId: string, id: string): Promise<void> {
  const row = await getPostRow(siteId, id);
  if (row.publish_state === "publishing") throw new HttpError(409, "Post is being published right now");
  const inst = await requireInstall(siteId);
  // Unpublished remote drafts are archived (recoverable) rather than destroyed.
  if (row.item_id && row.status !== "published" && inst.collection_id) {
    try {
      await clientFor(siteId).updateItem(inst.collection_id, row.item_id, { isArchived: true });
    } catch {
      // The local record is removed regardless; the orphaned draft can be cleaned up in Webflow.
    }
  }
  await db.run(`DELETE FROM posts WHERE id = ?`, [id]);
}

export async function movePost(siteId: string, id: string, scheduledAt: string): Promise<PostResponse> {
  const row = await getPostRow(siteId, id);
  if (row.status === "published") throw new HttpError(409, "Published posts cannot be rescheduled");
  return updatePost(siteId, id, { scheduledAt: normalizeIso(scheduledAt, "scheduledAt") });
}

export async function bulkReschedule(siteId: string, req: BulkRescheduleRequest): Promise<BulkRescheduleResult> {
  const inst = await requireInstall(siteId);
  if (!isValidTimeZone(inst.timezone)) throw new HttpError(500, "Invalid site timezone");
  const results: BulkRescheduleResult["results"] = [];
  const jobs: Array<{ id: string; scheduledAt: string | (() => Promise<string>) }> = [];

  for (const m of req.moves ?? []) {
    if (!m || typeof m.id !== "string") throw new HttpError(400, "moves[].id required");
    jobs.push({ id: m.id, scheduledAt: normalizeIso(m.scheduledAt, "moves[].scheduledAt") as string });
  }
  if (req.ids && req.ids.length > 0) {
    const days = Number(req.shiftDays);
    if (!Number.isInteger(days) || Math.abs(days) > 365) throw new HttpError(400, "shiftDays must be an integer between -365 and 365");
    for (const id of req.ids) {
      jobs.push({
        id,
        scheduledAt: async () => {
          const row = await getPostRow(siteId, id);
          if (!row.scheduled_at) throw new HttpError(400, "Post has no date to shift");
          return shiftUtcIsoByLocalDays(row.scheduled_at, days, inst.timezone);
        },
      });
    }
  }
  if (jobs.length === 0) throw new HttpError(400, "Provide moves[] or ids[] with shiftDays");
  if (jobs.length > 200) throw new HttpError(400, "At most 200 posts per bulk operation");

  for (const job of jobs) {
    try {
      const at = typeof job.scheduledAt === "string" ? job.scheduledAt : await job.scheduledAt();
      const res = await movePost(siteId, job.id, at);
      results.push({ id: job.id, ok: !res.syncError, error: res.syncError, post: res.post });
    } catch (err) {
      results.push({ id: job.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { results };
}

/** Puts a failed post back in the queue with a clean retry budget. */
export async function retryPost(siteId: string, id: string): Promise<Post> {
  const row = await getPostRow(siteId, id);
  if (row.publish_state !== "failed") throw new HttpError(409, "Post is not in the failure list");
  await db.run(`UPDATE posts SET publish_state = 'idle', attempts = 0, next_attempt_at = NULL, last_error = NULL, updated_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
  return getPost(siteId, id);
}

/** Makes a post due right now; the caller triggers a scheduler run. */
export async function markPublishNow(siteId: string, id: string): Promise<Post> {
  const row = await getPostRow(siteId, id);
  if (row.status === "published") throw new HttpError(409, "Already published");
  if (row.publish_state === "publishing") throw new HttpError(409, "Publish already in progress");
  await db.run(
    `UPDATE posts SET status = 'scheduled', scheduled_at = ?, publish_state = 'idle', attempts = 0, next_attempt_at = NULL, last_error = NULL, updated_at = ? WHERE id = ?`,
    [new Date().toISOString(), new Date().toISOString(), id]
  );
  return getPost(siteId, id);
}

export async function listFailures(siteId: string): Promise<Post[]> {
  const rows = await db.all<PostRow>(`SELECT * FROM posts WHERE site_id = ? AND publish_state = 'failed' ORDER BY updated_at DESC`, [siteId]);
  return rows.map(toPost);
}
