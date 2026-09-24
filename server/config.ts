import "dotenv/config";
import { createHash } from "crypto";

export const SCOPES = ["cms:read", "cms:write", "sites:read", "sites:write"] as const;

export const config = {
  port: Number(process.env.PORT || 3000),
  appUrl: (process.env.APP_PUBLIC_URL || "http://localhost:3000").replace(/\/$/, ""),
  clientId: process.env.WEBFLOW_CLIENT_ID || "",
  clientSecret: process.env.WEBFLOW_CLIENT_SECRET || "",
  redirectUri: process.env.WEBFLOW_REDIRECT_URI || "http://localhost:3000/oauth/callback",
  scopes: SCOPES.join(" "),
  /** 32-byte AES key derived from the configured passphrase. */
  tokenKey: createHash("sha256").update(process.env.TOKEN_ENCRYPTION_KEY || "dev-only-insecure-key").digest(),
  pollMs: Math.max(1000, Number(process.env.SCHEDULER_POLL_MS || 30000)),
  maxAttempts: Math.max(1, Number(process.env.PUBLISH_MAX_ATTEMPTS || 5)),
  databasePath: process.env.DATABASE_PATH || "",
};
