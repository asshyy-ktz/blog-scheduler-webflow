import { createHash, randomUUID } from "crypto";
import { config } from "../config";
import { db } from "../db";
import { getActiveInstall, InstallationRow, listActiveInstalls } from "./installations";
import { PostRow, syncDraft } from "./posts";
import { clientFor, WebflowApiError } from "./webflow-client";

type Trigger = "poll" | "manual" | "recovery";

interface RunCounters {
  runId: string;
  due: number;
  published: number;
  retried: number;
  failed: number;
}

/** 30s, 60s, 120s ... capped at 30 minutes. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 30 * 60_000);
}

function idempotencyKey(post: PostRow, attempt: number): string {
  return createHash("sha256").update(`${post.id}|${post.scheduled_at}|${attempt}`).digest("hex");
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  start(): void {
    if (this.timer) return;
    void this.recoverInterrupted().finally(() => {
      this.timer = setInterval(() => void this.runOnce("poll"), config.pollMs);
      void this.runOnce("poll");
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One polling pass over every active site (or just `siteId`). Overlapping passes are skipped. */
  async runOnce(trigger: Trigger, siteId?: string): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const installs = siteId ? [await getActiveInstall(siteId)].filter((i): i is InstallationRow => !!i) : await listActiveInstalls();
      for (const inst of installs) {
        try {
          await this.runSite(inst, trigger);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`[scheduler] site ${inst.site_id} failed`, err);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async runSite(inst: InstallationRow, trigger: Trigger): Promise<void> {
    if (!inst.collection_id) return;
    const nowIso = new Date().toISOString();
    const due = await db.all<PostRow>(
      `SELECT * FROM posts WHERE site_id = ? AND status = 'scheduled' AND is_archived = 0
         AND publish_state IN ('idle','retrying') AND scheduled_at <= ?
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY scheduled_at LIMIT 100`,
      [inst.site_id, nowIso, nowIso]
    );
    if (due.length === 0) return;

    const run: RunCounters = { runId: randomUUID(), due: due.length, published: 0, retried: 0, failed: 0 };
    await db.run(`INSERT INTO publish_runs (id, site_id, trigger, started_at, due_count) VALUES (?, ?, ?, ?, ?)`, [run.runId, inst.site_id, trigger, nowIso, due.length]);
    for (const post of due) await this.publishOne(inst, post, run);
    await db.run(`UPDATE publish_runs SET finished_at = ?, published = ?, retried = ?, failed = ? WHERE id = ?`, [new Date().toISOString(), run.published, run.retried, run.failed, run.runId]);
  }

  private async publishOne(inst: InstallationRow, post: PostRow, run: RunCounters): Promise<void> {
    const attempt = post.attempts + 1;
    const key = idempotencyKey(post, attempt);

    // Atomic claim: only one worker can move the post into 'publishing' for this attempt.
    const claim = await db.run(
      `UPDATE posts SET publish_state = 'publishing', attempts = ?, idempotency_key = ?, claimed_at = ?, next_attempt_at = NULL
       WHERE id = ? AND status = 'scheduled' AND publish_state IN ('idle','retrying') AND attempts = ?`,
      [attempt, key, new Date().toISOString(), post.id, post.attempts]
    );
    if (claim.changes === 0) return;

    try {
      const collectionId = inst.collection_id!;
      let itemId = post.item_id;
      if (!itemId) {
        const err = await syncDraft(inst.site_id, post.id);
        if (err) throw new Error(`Could not create draft: ${err}`);
        itemId = (await db.get<{ item_id: string | null }>(`SELECT item_id FROM posts WHERE id = ?`, [post.id]))?.item_id ?? null;
        if (!itemId) throw new Error("Draft item was not created");
      }
      const client = clientFor(inst.site_id);
      // Staged drafts are skipped by the publish endpoint, so clear the flag first.
      await client.updateItem(collectionId, itemId, { isDraft: false });
      const res = await client.publishItems(collectionId, [itemId], key);
      if (res.errors && res.errors.length > 0) throw new Error(res.errors.join("; "));
      if (res.publishedItemIds && !res.publishedItemIds.includes(itemId)) throw new Error("Webflow did not report the item as published");
      await this.markPublished(inst, post, attempt, key, run, "published", "Published via item-level publish");
    } catch (err) {
      await this.markFailure(inst, post, attempt, key, run, err);
    }
  }

  private async markPublished(inst: InstallationRow, post: PostRow, attempt: number, key: string, run: RunCounters, outcome: "published" | "recovered", message: string): Promise<void> {
    const now = new Date().toISOString();
    await db.run(
      `UPDATE posts SET status = 'published', published_at = ?, publish_state = 'idle', next_attempt_at = NULL, last_error = NULL, updated_at = ? WHERE id = ?`,
      [now, now, post.id]
    );
    await this.log(run.runId, inst.site_id, post, outcome, attempt, key, message);
    run.published += 1;
  }

  private async markFailure(inst: InstallationRow, post: PostRow, attempt: number, key: string, run: RunCounters, err: unknown): Promise<void> {
    const message = (err instanceof WebflowApiError ? `HTTP ${err.status}: ${JSON.stringify(err.body)}` : err instanceof Error ? err.message : String(err)).slice(0, 500);
    // 4xx other than 408/429 will not fix themselves by retrying.
    const permanent = err instanceof WebflowApiError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429 && err.status !== 401;
    const exhausted = permanent || attempt >= config.maxAttempts;
    const now = new Date();
    if (exhausted) {
      await db.run(`UPDATE posts SET publish_state = 'failed', last_error = ?, next_attempt_at = NULL, updated_at = ? WHERE id = ?`, [message, now.toISOString(), post.id]);
      run.failed += 1;
    } else {
      await db.run(`UPDATE posts SET publish_state = 'retrying', last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?`, [
        message,
        new Date(now.getTime() + backoffMs(attempt)).toISOString(),
        now.toISOString(),
        post.id,
      ]);
      run.retried += 1;
    }
    await this.log(run.runId, inst.site_id, post, exhausted ? "failed" : "retry", attempt, key, message);
  }

  private async log(runId: string, siteId: string, post: PostRow, outcome: "published" | "recovered" | "retry" | "failed", attempt: number, key: string, message: string): Promise<void> {
    try {
      await db.run(
        `INSERT INTO publish_log (run_id, site_id, post_id, item_id, title, outcome, attempt, idempotency_key, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [runId, siteId, post.id, post.item_id, post.title, outcome, attempt, key, message, new Date().toISOString()]
      );
    } catch {
      // Unique index on (idempotency_key) for success outcomes: this attempt was already recorded.
    }
  }

  /**
   * Crash recovery. A post left in 'publishing' means the process died mid-attempt. Ask Webflow
   * whether the item went live after the claim: if so record it as recovered (never re-publish);
   * otherwise return it to the retry queue.
   */
  async recoverInterrupted(): Promise<void> {
    const stuck = await db.all<PostRow>(`SELECT * FROM posts WHERE publish_state = 'publishing'`);
    if (stuck.length === 0) return;
    const bySite = new Map<string, PostRow[]>();
    for (const p of stuck) bySite.set(p.site_id, [...(bySite.get(p.site_id) ?? []), p]);

    for (const [siteId, posts] of bySite) {
      const inst = await getActiveInstall(siteId);
      const runId = randomUUID();
      const run: RunCounters = { runId, due: posts.length, published: 0, retried: 0, failed: 0 };
      await db.run(`INSERT INTO publish_runs (id, site_id, trigger, started_at, due_count) VALUES (?, ?, 'recovery', ?, ?)`, [runId, siteId, new Date().toISOString(), posts.length]);
      for (const post of posts) {
        const key = post.idempotency_key ?? idempotencyKey(post, post.attempts);
        let livePublished = false;
        try {
          if (inst?.collection_id && post.item_id) {
            const item = await clientFor(siteId).getItem(inst.collection_id, post.item_id);
            livePublished = !!item.lastPublished && !!post.claimed_at && Date.parse(item.lastPublished) >= Date.parse(post.claimed_at) - 1000 && item.isDraft === false;
          }
        } catch {
          livePublished = false;
        }
        if (inst && livePublished) {
          await this.markPublished(inst, post, post.attempts, key, run, "recovered", "Item was already live after an interrupted run; not republished");
        } else {
          await db.run(`UPDATE posts SET publish_state = 'retrying', next_attempt_at = ?, last_error = ? WHERE id = ?`, [
            new Date(Date.now() + backoffMs(post.attempts)).toISOString(),
            "Interrupted by a server restart",
            post.id,
          ]);
          run.retried += 1;
          await this.log(runId, siteId, post, "retry", post.attempts, key, "Interrupted by a server restart; queued for retry");
        }
      }
      await db.run(`UPDATE publish_runs SET finished_at = ?, published = ?, retried = ? WHERE id = ?`, [new Date().toISOString(), run.published, run.retried, runId]);
    }
  }
}

export const scheduler = new Scheduler();

