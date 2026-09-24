import { createHmac, timingSafeEqual } from "crypto";
import express, { Request, Response, Router } from "express";
import { config } from "../config";
import { asyncHandler } from "../http";
import { purgeInstall } from "../services/installations";
import { ItemChangedPayload, reconcileItemChanged } from "../services/reconcile";

const router = Router();
const MAX_SKEW_MS = 5 * 60_000;

// Signature covers the exact bytes received, so keep the raw body.
router.use(express.raw({ type: "*/*", limit: "1mb" }));

/** Webflow signs `${timestamp}:${rawBody}` with the app client secret (HMAC-SHA256, hex). */
function verifySignature(req: Request): boolean {
  const timestamp = req.header("x-webflow-timestamp");
  const signature = req.header("x-webflow-signature");
  if (!timestamp || !signature || !Buffer.isBuffer(req.body) || !config.clientSecret) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_SKEW_MS) return false;
  const expected = createHmac("sha256", config.clientSecret).update(`${timestamp}:`).update(req.body).digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function parse(req: Request, res: Response): Record<string, unknown> | undefined {
  if (!verifySignature(req)) {
    res.status(401).json({ error: "Invalid webhook signature" });
    return undefined;
  }
  try {
    return JSON.parse((req.body as Buffer).toString("utf8")) as Record<string, unknown>;
  } catch {
    res.status(400).json({ error: "Invalid JSON" });
    return undefined;
  }
}

router.post(
  "/collection-item-changed",
  asyncHandler(async (req, res) => {
    const event = parse(req, res);
    if (!event) return;
    const payload = (event.payload ?? event) as ItemChangedPayload;
    if (!payload || typeof payload.id !== "string") return void res.status(400).json({ error: "Missing item id" });
    const result = await reconcileItemChanged(payload);
    res.status(200).json({ ok: true, result });
  })
);

/**
 * App uninstall: purge the encrypted token, config, posts, runs and logs for the site.
 * Configure this URL as the app's uninstall notification endpoint in the Webflow app settings.
 */
router.post(
  "/app-uninstalled",
  asyncHandler(async (req, res) => {
    const event = parse(req, res);
    if (!event) return;
    const payload = (event.payload ?? event) as Record<string, unknown>;
    const siteId = [payload.siteId, payload.site_id, event.siteId].find((v): v is string => typeof v === "string" && v.length > 0);
    if (!siteId) return void res.status(400).json({ error: "Missing siteId" });
    await purgeInstall(siteId);
    res.status(200).json({ ok: true });
  })
);

export default router;
