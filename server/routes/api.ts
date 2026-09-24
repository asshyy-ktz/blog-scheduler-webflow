import { timingSafeEqual } from "crypto";
import { NextFunction, Request, Response, Router } from "express";
import { db } from "../db";
import { asyncHandler, HttpError } from "../http";
import { isValidTimeZone } from "../../shared/time";
import { BulkRescheduleRequest, FieldMap } from "../../shared/types";
import { getActiveInstall, toSiteConfig } from "../services/installations";
import { discoverCollections, saveMapping } from "../services/mapping";
import { bulkReschedule, createPost, deletePost, listFailures, listPosts, markPublishNow, movePost, parsePostInput, retryPost, updatePost } from "../services/posts";
import { exportLogCsv, listLog, listRuns } from "../services/publish-log";
import { scheduler } from "../services/scheduler";

const router = Router();

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// The App Panel is served from a Webflow-hosted origin, so allow cross-origin calls carrying our headers.
router.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Site-Id, X-Panel-Token");
  if (req.method === "OPTIONS") return void res.sendStatus(204);
  next();
});

/** Authenticates the panel with the per-site token issued at install time. */
router.use(
  asyncHandler(async (req, _res, next) => {
    const siteId = req.header("x-site-id");
    const token = req.header("x-panel-token");
    if (!siteId || !token) throw new HttpError(401, "Missing X-Site-Id / X-Panel-Token");
    const inst = await getActiveInstall(siteId);
    if (!inst || !safeEqual(inst.panel_token, token)) throw new HttpError(401, "Invalid credentials");
    ctx(req).siteId = siteId;
    next();
  })
);

function ctx(req: Request): { siteId: string } {
  return ((req as Request & { ctx?: { siteId: string } }).ctx ??= { siteId: "" });
}
const site = (req: Request): string => ctx(req).siteId;

router.get(
  "/config",
  asyncHandler(async (req, res) => {
    const inst = await getActiveInstall(site(req));
    res.json(toSiteConfig(inst!));
  })
);

router.put(
  "/config/timezone",
  asyncHandler(async (req, res) => {
    const tz = req.body?.timezone;
    if (!isValidTimeZone(tz)) throw new HttpError(400, "timezone must be a valid IANA zone, e.g. America/New_York");
    await db.run(`UPDATE installations SET timezone = ? WHERE site_id = ?`, [tz, site(req)]);
    res.json({ timezone: tz });
  })
);

router.get(
  "/collections",
  asyncHandler(async (req, res) => {
    res.json({ collections: await discoverCollections(site(req)) });
  })
);

router.put(
  "/mapping",
  asyncHandler(async (req, res) => {
    const { collectionId, fieldMap } = req.body ?? {};
    if (typeof collectionId !== "string" || !collectionId) throw new HttpError(400, "collectionId required");
    if (!fieldMap || typeof fieldMap !== "object") throw new HttpError(400, "fieldMap required");
    await saveMapping(site(req), collectionId, fieldMap as FieldMap);
    res.json(toSiteConfig((await getActiveInstall(site(req)))!));
  })
);

router.get(
  "/posts",
  asyncHandler(async (req, res) => {
    const from = typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    if ((from && Number.isNaN(Date.parse(from))) || (to && Number.isNaN(Date.parse(to)))) throw new HttpError(400, "from/to must be ISO-8601");
    res.json(await listPosts(site(req), from, to));
  })
);

router.post(
  "/posts",
  asyncHandler(async (req, res) => {
    const out = await createPost(site(req), parsePostInput(req.body));
    res.status(201).json(out);
  })
);

// Registered before /posts/:id so "bulk-reschedule" is not read as an id.
router.post(
  "/posts/bulk-reschedule",
  asyncHandler(async (req, res) => {
    res.json(await bulkReschedule(site(req), (req.body ?? {}) as BulkRescheduleRequest));
  })
);

router.patch(
  "/posts/:id",
  asyncHandler(async (req, res) => {
    res.json(await updatePost(site(req), req.params.id, parsePostInput(req.body)));
  })
);

router.delete(
  "/posts/:id",
  asyncHandler(async (req, res) => {
    await deletePost(site(req), req.params.id);
    res.status(204).end();
  })
);

router.post(
  "/posts/:id/move",
  asyncHandler(async (req, res) => {
    if (typeof req.body?.scheduledAt !== "string") throw new HttpError(400, "scheduledAt required");
    res.json(await movePost(site(req), req.params.id, req.body.scheduledAt));
  })
);

router.post(
  "/posts/:id/publish-now",
  asyncHandler(async (req, res) => {
    const post = await markPublishNow(site(req), req.params.id);
    await scheduler.runOnce("manual", site(req));
    res.json({ post });
  })
);

router.post(
  "/posts/:id/retry",
  asyncHandler(async (req, res) => {
    const post = await retryPost(site(req), req.params.id);
    await scheduler.runOnce("manual", site(req));
    res.json({ post });
  })
);

router.get(
  "/failures",
  asyncHandler(async (req, res) => {
    res.json({ posts: await listFailures(site(req)) });
  })
);

router.post(
  "/scheduler/run",
  asyncHandler(async (req, res) => {
    await scheduler.runOnce("manual", site(req));
    res.json({ runs: await listRuns(site(req), 1) });
  })
);

router.get(
  "/publish-runs",
  asyncHandler(async (req, res) => {
    res.json({ runs: await listRuns(site(req), Number(req.query.limit) || 50) });
  })
);

router.get(
  "/publish-log",
  asyncHandler(async (req, res) => {
    const runId = typeof req.query.runId === "string" ? req.query.runId : undefined;
    res.json({ entries: await listLog(site(req), runId, Number(req.query.limit) || 500) });
  })
);

router.get(
  "/publish-log.csv",
  asyncHandler(async (req, res) => {
    const runId = typeof req.query.runId === "string" ? req.query.runId : undefined;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="publish-log.csv"');
    res.send(await exportLogCsv(site(req), runId));
  })
);

export default router;
