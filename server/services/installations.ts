import { randomBytes } from "crypto";
import { db } from "../db";
import { FieldMap, SiteConfig } from "../../shared/types";
import { tokenStore } from "./webflow-client";

export interface InstallationRow {
  site_id: string;
  timezone: string;
  collection_id: string | null;
  field_map: string;
  panel_token: string;
  needs_reauth: number;
  webhook_ids: string;
  installed_at: string;
  uninstalled_at: string | null;
}

export async function getActiveInstall(siteId: string): Promise<InstallationRow | undefined> {
  return db.get<InstallationRow>(`SELECT * FROM installations WHERE site_id = ? AND uninstalled_at IS NULL`, [siteId]);
}

export async function listActiveInstalls(): Promise<InstallationRow[]> {
  return db.all<InstallationRow>(`SELECT * FROM installations WHERE uninstalled_at IS NULL AND needs_reauth = 0`);
}

export async function findInstallByCollection(collectionId: string): Promise<InstallationRow | undefined> {
  return db.get<InstallationRow>(`SELECT * FROM installations WHERE collection_id = ? AND uninstalled_at IS NULL`, [collectionId]);
}

/** Creates the installation (keeping the existing panel token/config on reinstall). Returns the panel token. */
export async function upsertInstall(siteId: string): Promise<string> {
  await db.run(
    `INSERT INTO installations (site_id, panel_token, installed_at) VALUES (?, ?, ?)
     ON CONFLICT(site_id) DO UPDATE SET uninstalled_at = NULL, needs_reauth = 0`,
    [siteId, randomBytes(24).toString("base64url"), new Date().toISOString()]
  );
  const row = await db.get<{ panel_token: string }>(`SELECT panel_token FROM installations WHERE site_id = ?`, [siteId]);
  return row!.panel_token;
}

export function toSiteConfig(row: InstallationRow): SiteConfig {
  return {
    siteId: row.site_id,
    timezone: row.timezone,
    collectionId: row.collection_id,
    fieldMap: JSON.parse(row.field_map || "{}") as FieldMap,
    needsReauth: row.needs_reauth === 1,
  };
}

/** Uninstall cleanup: deletes the encrypted token and (via ON DELETE CASCADE) config, posts, runs and logs. */
export async function purgeInstall(siteId: string): Promise<void> {
  await tokenStore.remove(siteId);
  await db.run(`DELETE FROM installations WHERE site_id = ?`, [siteId]);
}
