import { db, SqlParam } from "../db";
import { PublishLogEntry, PublishRun } from "../../shared/types";

interface RunRow {
  id: string;
  trigger: PublishRun["trigger"];
  started_at: string;
  finished_at: string | null;
  due_count: number;
  published: number;
  retried: number;
  failed: number;
}
interface LogRow {
  id: number;
  run_id: string;
  post_id: string;
  item_id: string | null;
  title: string;
  outcome: PublishLogEntry["outcome"];
  attempt: number;
  message: string;
  created_at: string;
}

export async function listRuns(siteId: string, limit = 50): Promise<PublishRun[]> {
  const rows = await db.all<RunRow>(`SELECT * FROM publish_runs WHERE site_id = ? ORDER BY started_at DESC LIMIT ?`, [siteId, Math.min(Math.max(limit, 1), 200)]);
  return rows.map((r) => ({
    id: r.id,
    trigger: r.trigger,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    dueCount: r.due_count,
    published: r.published,
    retried: r.retried,
    failed: r.failed,
  }));
}

export async function listLog(siteId: string, runId?: string, limit = 500): Promise<PublishLogEntry[]> {
  const params: SqlParam[] = [siteId];
  let where = "site_id = ?";
  if (runId) {
    where += " AND run_id = ?";
    params.push(runId);
  }
  params.push(Math.min(Math.max(limit, 1), 5000));
  const rows = await db.all<LogRow>(`SELECT * FROM publish_log WHERE ${where} ORDER BY id DESC LIMIT ?`, params);
  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    postId: r.post_id,
    itemId: r.item_id,
    title: r.title,
    outcome: r.outcome,
    attempt: r.attempt,
    message: r.message,
    createdAt: r.created_at,
  }));
}

/** Neutralises spreadsheet formula injection and quotes per RFC 4180. */
function csvCell(value: string | number | null): string {
  let s = value === null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function exportLogCsv(siteId: string, runId?: string): Promise<string> {
  const entries = await listLog(siteId, runId, 5000);
  const header = ["timestamp", "run_id", "post_id", "item_id", "title", "outcome", "attempt", "message"];
  const lines = [header.join(",")];
  for (const e of entries) {
    lines.push([e.createdAt, e.runId, e.postId, e.itemId, e.title, e.outcome, e.attempt, e.message].map(csvCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
