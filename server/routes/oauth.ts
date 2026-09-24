import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { Router } from "express";
import { config } from "../config";
import { db } from "../db";
import { asyncHandler } from "../http";
import { upsertInstall } from "../services/installations";
import { clientFor, exchangeCodeForToken, listAuthorizedSites, tokenStore } from "../services/webflow-client";

const router = Router();
const STATE_TTL_MS = 10 * 60_000;

/** Stateless CSRF state: nonce.timestamp.hmac, verified on callback. */
function makeState(): string {
  const payload = `${randomBytes(12).toString("base64url")}.${Date.now()}`;
  const sig = createHmac("sha256", config.tokenKey).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifyState(state: string): boolean {
  const parts = state.split(".");
  if (parts.length !== 3) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = createHmac("sha256", config.tokenKey).update(payload).digest();
  const given = Buffer.from(parts[2], "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  return Date.now() - Number(parts[1]) < STATE_TTL_MS;
}

router.get("/authorize", (_req, res) => {
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: config.redirectUri,
    scope: config.scopes,
    state: makeState(),
  });
  res.redirect(`https://webflow.com/oauth/authorize?${params.toString()}`);
});

router.get(
  "/callback",
  asyncHandler(async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : undefined;
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (!code) return void res.status(400).send("Missing authorization code");
    if (!verifyState(state)) return void res.status(400).send("Invalid or expired state; restart the install");

    const tokens = await exchangeCodeForToken(code);
    const sites = await listAuthorizedSites(tokens.accessToken);
    if (sites.length === 0) return void res.status(502).send("No site was authorised for this installation");

    let firstSite: { id: string; panelToken: string } | undefined;
    for (const site of sites) {
      const panelToken = await upsertInstall(site.id);
      await tokenStore.save(site.id, tokens);
      await registerWebhooks(site.id);
      firstSite ??= { id: site.id, panelToken };
    }
    // Credentials travel in the URL fragment so they never reach server logs or Referer headers.
    res.redirect(`/designer-extension/index.html#site=${encodeURIComponent(firstSite!.id)}&token=${encodeURIComponent(firstSite!.panelToken)}`);
  })
);

/** Registers collection_item_changed once per install; an existing registration is reused. */
async function registerWebhooks(siteId: string): Promise<void> {
  const client = clientFor(siteId);
  const url = `${config.appUrl}/webhooks/collection-item-changed`;
  try {
    const existing = await client.listWebhooks();
    const found = existing.webhooks?.find((w) => w.triggerType === "collection_item_changed" && w.url === url);
    const hook = found ?? (await client.registerWebhook("collection_item_changed", url));
    await db.run(`UPDATE installations SET webhook_ids = ? WHERE site_id = ?`, [JSON.stringify([hook.id]), siteId]);
  } catch (err) {
    // Non-fatal: the calendar still works; reconciliation is off until the webhook is registered.
    // eslint-disable-next-line no-console
    console.error(`[oauth] webhook registration failed for ${siteId}`, err);
  }
}

export default router;
