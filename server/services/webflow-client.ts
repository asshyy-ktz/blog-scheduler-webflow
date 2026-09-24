// Hand-rolled typed client for the Webflow Data API v2 (no SDK dependency).

import { config } from "../config";
import { db } from "../db";
import { CollectionField } from "../../shared/types";
import { sleep, TokenBucket } from "./rate-limiter";
import { EncryptedDbTokenStore, StoredTokens, TokenStore } from "./token-store";

export const API_BASE = "https://api.webflow.com/v2";
const OAUTH_TOKEN_URL = "https://api.webflow.com/oauth/access_token";
const MAX_429_RETRIES = 5;

export class WebflowApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`Webflow API error ${status}: ${JSON.stringify(body)}`);
  }
}

export interface WebflowSite {
  id: string;
  displayName?: string;
  shortName?: string;
}
export interface WebflowCollectionSummary {
  id: string;
  displayName: string;
  slug: string;
}
export interface WebflowCollection extends WebflowCollectionSummary {
  fields: CollectionField[];
}
export interface WebflowItem {
  id: string;
  cmsLocaleId?: string;
  lastPublished?: string | null;
  lastUpdated?: string;
  createdOn?: string;
  isArchived?: boolean;
  isDraft?: boolean;
  fieldData: Record<string, unknown>;
}
export interface PublishItemsResponse {
  publishedItemIds?: string[];
  errors?: string[];
}
export interface WebflowWebhook {
  id: string;
  triggerType: string;
  url: string;
}

export const tokenStore: TokenStore = new EncryptedDbTokenStore(db);

/** One bucket per site: Webflow limits requests per site token. */
const buckets = new Map<string, TokenBucket>();
function bucketFor(siteId: string): TokenBucket {
  let b = buckets.get(siteId);
  if (!b) {
    b = new TokenBucket(60, 60);
    buckets.set(siteId, b);
  }
  return b;
}

// --- OAuth helpers -----------------------------------------------------------------------------

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  scope?: string;
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, ...body }),
  });
  if (!res.ok) throw new WebflowApiError(res.status, await res.json().catch(() => ({})));
  return (await res.json()) as TokenResponse;
}

export async function exchangeCodeForToken(code: string): Promise<StoredTokens> {
  const t = await postToken({ code, grant_type: "authorization_code", redirect_uri: config.redirectUri });
  return { accessToken: t.access_token, refreshToken: t.refresh_token, scope: t.scope };
}

export async function refreshAccessToken(refreshToken: string): Promise<StoredTokens> {
  const t = await postToken({ refresh_token: refreshToken, grant_type: "refresh_token" });
  return { accessToken: t.access_token, refreshToken: t.refresh_token || refreshToken, scope: t.scope };
}

/** Lists the sites authorised for a freshly issued token (before any installation row exists). */
export async function listAuthorizedSites(accessToken: string): Promise<WebflowSite[]> {
  const res = await fetch(`${API_BASE}/sites`, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
  if (!res.ok) throw new WebflowApiError(res.status, await res.json().catch(() => ({})));
  return ((await res.json()) as { sites?: WebflowSite[] }).sites ?? [];
}

// --- Client ------------------------------------------------------------------------------------

export class WebflowClient {
  constructor(private readonly siteId: string, private readonly tokens: TokenStore = tokenStore) {}

  private async accessToken(): Promise<string> {
    const t = await this.tokens.load(this.siteId);
    if (!t) throw new Error(`No stored token for site ${this.siteId}`);
    return t.accessToken;
  }

  /** Exchanges the refresh token. Returns false (and flags the install) when re-authorisation is needed. */
  private async refresh(rejectedToken: string): Promise<boolean> {
    const current = await this.tokens.load(this.siteId);
    if (!current) return false;
    // Another in-flight request may have already refreshed.
    if (current.accessToken !== rejectedToken) return true;
    if (current.refreshToken) {
      try {
        await this.tokens.save(this.siteId, await refreshAccessToken(current.refreshToken));
        return true;
      } catch {
        // fall through
      }
    }
    await db.run(`UPDATE installations SET needs_reauth = 1 WHERE site_id = ?`, [this.siteId]);
    return false;
  }

  private async request<T>(method: string, urlPath: string, body?: unknown, opts: { idempotencyKey?: string } = {}): Promise<T> {
    let refreshed = false;
    let rateLimitRetries = 0;
    for (;;) {
      await bucketFor(this.siteId).acquire();
      const token = await this.accessToken();
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
      const res = await fetch(`${API_BASE}${urlPath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

      if (res.status === 401 && !refreshed) {
        refreshed = true;
        if (await this.refresh(token)) continue;
      }
      if (res.status === 429 && rateLimitRetries < MAX_429_RETRIES) {
        const retryAfter = Number(res.headers.get("Retry-After"));
        const expo = 1000 * 2 ** rateLimitRetries;
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.max(retryAfter * 1000, expo) : expo;
        bucketFor(this.siteId).penalize(waitMs);
        rateLimitRetries += 1;
        await sleep(waitMs);
        continue;
      }
      if (!res.ok) throw new WebflowApiError(res.status, await res.json().catch(() => ({})));
      if (res.status === 204) return undefined as unknown as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
  }

  listCollections(): Promise<{ collections: WebflowCollectionSummary[] }> {
    return this.request("GET", `/sites/${this.siteId}/collections`);
  }
  getCollection(collectionId: string): Promise<WebflowCollection> {
    return this.request("GET", `/collections/${collectionId}`);
  }
  listItems(collectionId: string, offset = 0, limit = 100): Promise<{ items: WebflowItem[]; pagination?: { total: number } }> {
    return this.request("GET", `/collections/${collectionId}/items?limit=${limit}&offset=${offset}`);
  }
  getItem(collectionId: string, itemId: string): Promise<WebflowItem> {
    return this.request("GET", `/collections/${collectionId}/items/${itemId}`);
  }
  /** Creates a staged (draft) item. */
  createDraftItem(collectionId: string, fieldData: Record<string, unknown>): Promise<WebflowItem> {
    return this.request("POST", `/collections/${collectionId}/items`, { isArchived: false, isDraft: true, fieldData });
  }
  updateItem(collectionId: string, itemId: string, patch: { isDraft?: boolean; isArchived?: boolean; fieldData?: Record<string, unknown> }): Promise<WebflowItem> {
    return this.request("PATCH", `/collections/${collectionId}/items/${itemId}`, patch);
  }
  /** Item-level publish. */
  publishItems(collectionId: string, itemIds: string[], idempotencyKey?: string): Promise<PublishItemsResponse> {
    return this.request("POST", `/collections/${collectionId}/items/publish`, { itemIds }, { idempotencyKey });
  }
  listWebhooks(): Promise<{ webhooks: WebflowWebhook[] }> {
    return this.request("GET", `/sites/${this.siteId}/webhooks`);
  }
  registerWebhook(triggerType: string, url: string): Promise<WebflowWebhook> {
    return this.request("POST", `/sites/${this.siteId}/webhooks`, { triggerType, url });
  }
  deleteWebhook(webhookId: string): Promise<void> {
    return this.request("DELETE", `/webhooks/${webhookId}`);
  }
}

export function clientFor(siteId: string): WebflowClient {
  return new WebflowClient(siteId);
}
