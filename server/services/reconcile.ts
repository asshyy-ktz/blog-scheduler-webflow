import { randomUUID } from "crypto";
import { db } from "../db";
import { FieldMap } from "../../shared/types";
import { InstallationRow, findInstallByCollection, getActiveInstall } from "./installations";
import { PostRow, slugify } from "./posts";

/** Subset of the `collection_item_changed` webhook payload we consume. */
export interface ItemChangedPayload {
  id: string;
  siteId?: string;
  collectionId?: string;
  lastPublished?: string | null;
  lastUpdated?: string;
  isArchived?: boolean;
  isDraft?: boolean;
  fieldData?: Record<string, unknown>;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Applies a manual edit made in the Designer/Editor back onto the calendar. Idempotent, so the
 * echo of our own writes is a no-op. Returns what happened for logging/tests.
 */
export async function reconcileItemChanged(p: ItemChangedPayload): Promise<"updated" | "imported" | "ignored"> {
  let inst: InstallationRow | undefined;
  if (p.siteId) inst = await getActiveInstall(p.siteId);
  if (!inst && p.collectionId) inst = await findInstallByCollection(p.collectionId);
  if (!inst || !inst.collection_id) return "ignored";
  if (p.collectionId && p.collectionId !== inst.collection_id) return "ignored";

  const map = JSON.parse(inst.field_map || "{}") as FieldMap;
  const fd = p.fieldData ?? {};
  const title = map.title ? str(fd[map.title]) : undefined;
  const slug = map.slug ? str(fd[map.slug]) : undefined;
  const body = map.body ? str(fd[map.body]) : undefined;
  const author = map.author ? str(fd[map.author]) : undefined;
  const publishDateRaw = map.publishDate ? str(fd[map.publishDate]) : undefined;
  const publishDate = publishDateRaw && !Number.isNaN(Date.parse(publishDateRaw)) ? new Date(publishDateRaw).toISOString() : undefined;
  const now = new Date().toISOString();

  const row = await db.get<PostRow>(`SELECT * FROM posts WHERE site_id = ? AND item_id = ?`, [inst.site_id, p.id]);

  if (!row) {
    if (!title) return "ignored";
    const published = !!p.lastPublished && p.isDraft === false;
    await db.run(
      `INSERT INTO posts (id, site_id, item_id, title, slug, body, author, status, scheduled_at, published_at, is_archived, remote_updated_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        inst.site_id,
        p.id,
        title,
        slug || slugify(title),
        body ?? "",
        author ?? "",
        published ? "published" : "draft",
        published ? null : publishDate ?? null,
        published ? p.lastPublished ?? now : null,
        p.isArchived ? 1 : 0,
        p.lastUpdated ?? null,
        now,
        now,
      ]
    );
    return "imported";
  }

  // A post mid-publish is settled by the scheduler; reconciling now could race it.
  if (row.publish_state === "publishing") return "ignored";
  if (row.remote_updated_at && p.lastUpdated && Date.parse(p.lastUpdated) <= Date.parse(row.remote_updated_at)) return "ignored";

  const next = {
    title: title ?? row.title,
    slug: slug ?? row.slug,
    body: body ?? row.body,
    author: author ?? row.author,
    status: row.status,
    scheduled_at: row.scheduled_at,
    published_at: row.published_at,
    publish_state: row.publish_state,
    is_archived: p.isArchived ? 1 : 0,
  };

  if (row.status !== "published") {
    if (p.lastPublished && p.isDraft === false) {
      // Published manually in Webflow: the scheduled run must not publish it again.
      next.status = "published";
      next.published_at = p.lastPublished;
      next.publish_state = "idle";
    } else if (map.publishDate && publishDateRaw !== undefined && publishDate && publishDate !== row.scheduled_at) {
      next.scheduled_at = publishDate;
    } else if (map.publishDate && publishDateRaw === undefined && row.scheduled_at && row.status !== "scheduled") {
      // Date cleared in Webflow; only clear unscheduled drafts, a scheduled post keeps its slot.
      next.scheduled_at = null;
    }
  }

  await db.run(
    `UPDATE posts SET title = ?, slug = ?, body = ?, author = ?, status = ?, scheduled_at = ?, published_at = ?, publish_state = ?, is_archived = ?,
       remote_updated_at = ?, last_error = CASE WHEN ? = 'published' THEN NULL ELSE last_error END, updated_at = ? WHERE id = ?`,
    [next.title, next.slug, next.body, next.author, next.status, next.scheduled_at, next.published_at, next.publish_state, next.is_archived, p.lastUpdated ?? row.remote_updated_at, next.status, now, row.id]
  );
  return "updated";
}
