import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { config } from "../config";
import { Db } from "../db";

export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  scope?: string;
}

/** Where OAuth tokens live. Swap the implementation (KMS, Vault, ...) without touching callers. */
export interface TokenStore {
  save(siteId: string, tokens: StoredTokens): Promise<void>;
  load(siteId: string): Promise<StoredTokens | undefined>;
  remove(siteId: string): Promise<void>;
}

/** AES-256-GCM encrypted tokens persisted in the `oauth_tokens` table. Format: v1.<iv>.<tag>.<ciphertext> (base64url). */
export class EncryptedDbTokenStore implements TokenStore {
  constructor(private readonly db: Db, private readonly key: Buffer = config.tokenKey) {}

  private encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
  }

  private decrypt(blob: string): string {
    const [version, iv, tag, ct] = blob.split(".");
    if (version !== "v1" || !iv || !tag || !ct) throw new Error("Unrecognised token ciphertext format");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
  }

  async save(siteId: string, tokens: StoredTokens): Promise<void> {
    await this.db.run(
      `INSERT INTO oauth_tokens (site_id, ciphertext, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(site_id) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`,
      [siteId, this.encrypt(JSON.stringify(tokens)), new Date().toISOString()]
    );
  }

  async load(siteId: string): Promise<StoredTokens | undefined> {
    const row = await this.db.get<{ ciphertext: string }>(`SELECT ciphertext FROM oauth_tokens WHERE site_id = ?`, [siteId]);
    return row ? (JSON.parse(this.decrypt(row.ciphertext)) as StoredTokens) : undefined;
  }

  async remove(siteId: string): Promise<void> {
    await this.db.run(`DELETE FROM oauth_tokens WHERE site_id = ?`, [siteId]);
  }
}
