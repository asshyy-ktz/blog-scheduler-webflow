import { db } from "../db";
import { HttpError } from "../http";
import { CollectionField, DiscoveredCollection, FieldMap, MAPPING_KEYS, MappingKey } from "../../shared/types";
import { clientFor } from "./webflow-client";

const BLOG_HINT = /blog|post|article|news|stor(y|ies)/i;

const FIELD_HINTS: Record<MappingKey, { slugs: RegExp; types: string[] }> = {
  title: { slugs: /^name$/, types: ["PlainText"] },
  slug: { slugs: /^slug$/, types: ["PlainText"] },
  body: { slugs: /(^|-)(post-)?(body|content)$|rich-text/, types: ["RichText"] },
  author: { slugs: /author|writer|byline/, types: ["PlainText", "Reference"] },
  publishDate: { slugs: /(publish|post|date)/, types: ["DateTime"] },
};

export function suggestMapping(fields: CollectionField[]): FieldMap {
  const map: FieldMap = {};
  for (const key of MAPPING_KEYS) {
    const hint = FIELD_HINTS[key];
    const match =
      fields.find((f) => hint.slugs.test(f.slug) && hint.types.includes(f.type)) ??
      (key === "body" ? fields.find((f) => f.type === "RichText") : undefined) ??
      (key === "publishDate" ? fields.find((f) => f.type === "DateTime") : undefined);
    if (match) map[key] = match.slug;
  }
  return map;
}

/** Lists the site's collections with their fields and a heuristic blog/mapping suggestion. */
export async function discoverCollections(siteId: string): Promise<DiscoveredCollection[]> {
  const client = clientFor(siteId);
  const { collections } = await client.listCollections();
  const out: DiscoveredCollection[] = [];
  for (const c of collections) {
    const full = await client.getCollection(c.id);
    out.push({
      id: full.id,
      displayName: full.displayName,
      slug: full.slug,
      fields: full.fields.map((f) => ({ id: f.id, slug: f.slug, displayName: f.displayName, type: f.type })),
      likelyBlog: BLOG_HINT.test(full.slug) || BLOG_HINT.test(full.displayName),
      suggestedMap: suggestMapping(full.fields),
    });
  }
  return out.sort((a, b) => Number(b.likelyBlog) - Number(a.likelyBlog) || a.displayName.localeCompare(b.displayName));
}

/** Validates the mapping against the live collection schema and stores it for the site. */
export async function saveMapping(siteId: string, collectionId: string, fieldMap: FieldMap): Promise<void> {
  if (!fieldMap.title) throw new HttpError(400, "A title field mapping is required");
  const collection = await clientFor(siteId).getCollection(collectionId);
  const slugs = new Set(collection.fields.map((f) => f.slug));
  const clean: FieldMap = {};
  for (const key of MAPPING_KEYS) {
    const slug = fieldMap[key];
    if (slug === undefined || slug === "") continue;
    if (typeof slug !== "string" || !slugs.has(slug)) throw new HttpError(400, `Field "${String(slug)}" (${key}) does not exist in collection ${collection.displayName}`);
    clean[key] = slug;
  }
  const byMapped = new Set<string>();
  for (const slug of Object.values(clean)) {
    if (byMapped.has(slug)) throw new HttpError(400, `Field "${slug}" is mapped more than once`);
    byMapped.add(slug);
  }
  await db.run(`UPDATE installations SET collection_id = ?, field_map = ? WHERE site_id = ?`, [collectionId, JSON.stringify(clean), siteId]);
}
