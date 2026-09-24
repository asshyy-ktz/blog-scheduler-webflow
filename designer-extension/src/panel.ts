// App Panel (vanilla TypeScript). Bundled by esbuild.config.mjs into dist/panel.js.

import {
  addLocalDays,
  formatLocalInput,
  isValidTimeZone,
  LocalDateTime,
  localDateKey,
  localToUtcIso,
  monthGridRange,
  parseLocalInput,
  utcIsoToLocal,
  weekRange,
} from "../../shared/time";
import {
  BulkRescheduleResult,
  DiscoveredCollection,
  FieldMap,
  MAPPING_KEYS,
  PipelineStatus,
  Post,
  PostResponse,
  PublishLogEntry,
  PublishRun,
  SiteConfig,
} from "../../shared/types";

interface Conn {
  api: string;
  site: string;
  token: string;
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

// --- State ---------------------------------------------------------------------------------------

let conn: Conn | null = null;
let config: SiteConfig | null = null;
let view: "month" | "week" = "month";
let anchor: LocalDateTime = { year: 2000, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
let dated: Post[] = [];
let undated: Post[] = [];
const selected = new Set<string>();
let editing: Post | null = null;
let collections: DiscoveredCollection[] = [];

// --- Connection & API ----------------------------------------------------------------------------

function loadConn(): Conn | null {
  const frag = new URLSearchParams(location.hash.replace(/^#/, ""));
  const site = frag.get("site");
  const token = frag.get("token");
  if (site && token) {
    const c = { api: location.origin, site, token };
    saveConn(c);
    history.replaceState(null, "", location.pathname);
    return c;
  }
  try {
    const raw = localStorage.getItem("blog-scheduler-conn");
    return raw ? (JSON.parse(raw) as Conn) : null;
  } catch {
    return null;
  }
}

function saveConn(c: Conn): void {
  try {
    localStorage.setItem("blog-scheduler-conn", JSON.stringify(c));
  } catch {
    // Storage can be blocked inside the Designer iframe; the connection then lasts for this session only.
  }
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!conn) throw new Error("Not connected");
  const res = await fetch(`${conn.api}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Site-Id": conn.site, "X-Panel-Token": conn.token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error || `Request failed (${res.status})`);
  return json as T;
}

function notify(message: string, isError = false): void {
  const n = $("notice");
  n.textContent = message;
  n.className = isError ? "notice error" : "notice";
  n.hidden = !message;
}

async function guarded(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    notify(err instanceof Error ? err.message : String(err), true);
  }
}

// --- Calendar ------------------------------------------------------------------------------------

const tz = (): string => config?.timezone || "UTC";

function currentRange() {
  return view === "month" ? monthGridRange(anchor.year, anchor.month, tz()) : weekRange(anchor, tz());
}

async function refreshCalendar(): Promise<void> {
  const range = currentRange();
  const data = await api<{ dated: Post[]; undated: Post[] }>("GET", `/posts?from=${encodeURIComponent(range.fromUtc)}&to=${encodeURIComponent(range.toUtc)}`);
  dated = data.dated;
  undated = data.undated;
  renderCalendar();
  const failures = await api<{ posts: Post[] }>("GET", "/failures");
  const pill = $("failure-count");
  pill.textContent = String(failures.posts.length);
  pill.hidden = failures.posts.length === 0;
}

function chipHtml(p: Post): string {
  const cls = p.publishState === "failed" ? "failed" : p.status;
  const time = p.scheduledAt ? formatLocalInput(utcIsoToLocal(p.scheduledAt, tz())).slice(11) : "";
  const draggable = p.status !== "published" ? 'draggable="true"' : "";
  return `<span class="chip ${cls}${selected.has(p.id) ? " selected" : ""}" ${draggable} data-id="${p.id}" title="${esc(p.title)} (${p.status})">${time ? time + " " : ""}${esc(p.title)}</span>`;
}

function renderCalendar(): void {
  const range = currentRange();
  const todayKey = localDateKey(utcIsoToLocal(new Date().toISOString(), tz()));
  const byDay = new Map<string, Post[]>();
  for (const p of dated) {
    const key = localDateKey(utcIsoToLocal((p.scheduledAt || p.publishedAt) as string, tz()));
    byDay.set(key, [...(byDay.get(key) ?? []), p]);
  }
  $("weekdays").innerHTML = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => `<div>${d}</div>`).join("");
  $("grid").innerHTML = range.days
    .map((d) => {
      const key = localDateKey(d);
      const other = view === "month" && d.month !== anchor.month ? " other" : "";
      const today = key === todayKey ? " today" : "";
      const posts = (byDay.get(key) ?? []).map(chipHtml).join("");
      return `<div class="day${other}${today}${view === "week" ? " week" : ""}" data-day="${key}"><span class="num">${d.day}</span>${posts}</div>`;
    })
    .join("");
  $("backlog").innerHTML = undated.length ? undated.map(chipHtml).join("") : '<p class="muted small">Nothing unscheduled.</p>';
  $("range-label").textContent =
    view === "month"
      ? new Date(Date.UTC(anchor.year, anchor.month - 1, 1)).toLocaleString(undefined, { month: "long", year: "numeric", timeZone: "UTC" })
      : `Week of ${localDateKey(range.days[0])}`;
  $("tz-label").textContent = tz();
  renderBulkBar();
}

function renderBulkBar(): void {
  $("bulk-bar").hidden = selected.size === 0;
  $("bulk-count").textContent = `${selected.size} selected`;
}

function findPost(id: string): Post | undefined {
  return [...dated, ...undated].find((p) => p.id === id);
}

/** Target UTC instant for dropping `post` on a day: keeps its local time of day, defaulting to 09:00. */
function dropTarget(post: Post, dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const existing = post.scheduledAt ? utcIsoToLocal(post.scheduledAt, tz()) : null;
  return localToUtcIso({ year: y, month: m, day: d, hour: existing?.hour ?? 9, minute: existing?.minute ?? 0, second: 0 }, tz());
}

function wireCalendar(): void {
  const root = document.querySelector(".calendar-layout") as HTMLElement;

  root.addEventListener("click", (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>(".chip");
    if (!chip) return;
    const post = findPost(chip.dataset.id as string);
    if (!post) return;
    if ((e as MouseEvent).shiftKey && post.status !== "published") {
      if (!selected.delete(post.id)) selected.add(post.id);
      renderCalendar();
    } else {
      openDialog(post);
    }
  });

  root.addEventListener("dragstart", (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>(".chip");
    if (!chip || !e.dataTransfer) return;
    e.dataTransfer.setData("text/plain", chip.dataset.id as string);
    e.dataTransfer.effectAllowed = "move";
  });
  root.addEventListener("dragover", (e) => {
    const day = (e.target as HTMLElement).closest<HTMLElement>(".day");
    if (!day) return;
    e.preventDefault();
    day.classList.add("over");
  });
  root.addEventListener("dragleave", (e) => (e.target as HTMLElement).closest(".day")?.classList.remove("over"));
  root.addEventListener("drop", (e) => {
    const day = (e.target as HTMLElement).closest<HTMLElement>(".day");
    if (!day) return;
    e.preventDefault();
    day.classList.remove("over");
    const post = findPost(e.dataTransfer?.getData("text/plain") ?? "");
    if (!post || post.status === "published") return;
    void guarded(async () => {
      const res = await api<PostResponse>("POST", `/posts/${post.id}/move`, { scheduledAt: dropTarget(post, day.dataset.day as string) });
      notify(res.syncError ? `Rescheduled locally, Webflow sync failed: ${res.syncError}` : "", !!res.syncError);
      await refreshCalendar();
    });
  });

  $("bulk-apply").addEventListener("click", () =>
    guarded(async () => {
      const days = Number(($("bulk-days") as HTMLInputElement).value);
      const res = await api<BulkRescheduleResult>("POST", "/posts/bulk-reschedule", { ids: [...selected], shiftDays: days });
      const bad = res.results.filter((r) => !r.ok);
      notify(bad.length ? `${bad.length} of ${res.results.length} failed: ${bad[0].error}` : `Rescheduled ${res.results.length} post(s)`, bad.length > 0);
      selected.clear();
      await refreshCalendar();
    })
  );
  $("bulk-clear").addEventListener("click", () => {
    selected.clear();
    renderCalendar();
  });

  const step = (dir: number) => {
    anchor = view === "month" ? { ...anchor, month: anchor.month + dir, day: 1 } : addLocalDays(anchor, dir * 7);
    if (anchor.month < 1) anchor = { ...anchor, month: 12, year: anchor.year - 1 };
    if (anchor.month > 12) anchor = { ...anchor, month: 1, year: anchor.year + 1 };
    void guarded(refreshCalendar);
  };
  $("prev").addEventListener("click", () => step(-1));
  $("next").addEventListener("click", () => step(1));
  $("today").addEventListener("click", () => {
    anchor = utcIsoToLocal(new Date().toISOString(), tz());
    void guarded(refreshCalendar);
  });
  $("view").addEventListener("change", (e) => {
    view = (e.target as HTMLSelectElement).value as "month" | "week";
    void guarded(refreshCalendar);
  });
  $("new-post").addEventListener("click", () => openDialog(null));
}

// --- Post dialog ---------------------------------------------------------------------------------

function openDialog(post: Post | null): void {
  editing = post;
  $("post-dialog-title").textContent = post ? "Edit post" : "New post";
  ($("f-title") as HTMLInputElement).value = post?.title ?? "";
  ($("f-slug") as HTMLInputElement).value = post?.slug ?? "";
  ($("f-author") as HTMLInputElement).value = post?.author ?? "";
  ($("f-status") as HTMLSelectElement).value = post?.status ?? "idea";
  ($("f-when") as HTMLInputElement).value = post?.scheduledAt ? formatLocalInput(utcIsoToLocal(post.scheduledAt, tz())) : "";
  ($("f-body") as HTMLTextAreaElement).value = post?.body ?? "";
  const published = post?.status === "published";
  for (const id of ["f-title", "f-slug", "f-author", "f-status", "f-when", "f-body"]) ($(id) as HTMLInputElement).disabled = published;
  $("f-save").hidden = published;
  $("f-publish-now").hidden = !post || published;
  $("f-delete").hidden = !post;
  ($("post-dialog") as HTMLDialogElement).showModal();
}

function readForm(): { title: string; slug: string; author: string; body: string; status: PipelineStatus; scheduledAt: string | null } {
  const when = ($("f-when") as HTMLInputElement).value;
  let scheduledAt: string | null = null;
  if (when) {
    const local = parseLocalInput(when);
    if (!local) throw new Error("Invalid publish date");
    scheduledAt = localToUtcIso(local, tz());
  }
  return {
    title: ($("f-title") as HTMLInputElement).value.trim(),
    slug: ($("f-slug") as HTMLInputElement).value.trim(),
    author: ($("f-author") as HTMLInputElement).value.trim(),
    body: ($("f-body") as HTMLTextAreaElement).value,
    status: ($("f-status") as HTMLSelectElement).value as PipelineStatus,
    scheduledAt,
  };
}

function wireDialog(): void {
  const dialog = $("post-dialog") as HTMLDialogElement;
  $("post-form").addEventListener("submit", (e) => {
    e.preventDefault();
    void guarded(async () => {
      const input = readForm();
      const res = editing ? await api<PostResponse>("PATCH", `/posts/${editing.id}`, input) : await api<PostResponse>("POST", "/posts", input);
      dialog.close();
      notify(res.syncError ? `Saved locally, Webflow sync failed: ${res.syncError}` : "", !!res.syncError);
      await refreshCalendar();
    });
  });
  $("f-cancel").addEventListener("click", () => dialog.close());
  $("f-delete").addEventListener("click", () =>
    guarded(async () => {
      if (!editing || !confirm("Delete this post? A linked Webflow draft will be archived.")) return;
      await api("DELETE", `/posts/${editing.id}`);
      dialog.close();
      await refreshCalendar();
    })
  );
  $("f-publish-now").addEventListener("click", () =>
    guarded(async () => {
      if (!editing || !confirm("Publish this post to the live site now?")) return;
      await api("POST", `/posts/${editing.id}/publish-now`);
      dialog.close();
      await refreshCalendar();
    })
  );
}

// --- Failures / log ------------------------------------------------------------------------------

async function renderFailures(): Promise<void> {
  const { posts } = await api<{ posts: Post[] }>("GET", "/failures");
  $("failures").innerHTML = posts.length
    ? posts
        .map(
          (p) => `<div class="card"><strong>${esc(p.title)}</strong> <span class="muted">after ${p.attempts} attempt(s)</span>
            <p>${esc(p.lastError ?? "Unknown error")}</p>
            <button class="btn primary" data-retry="${p.id}">Retry</button></div>`
        )
        .join("")
    : '<p class="muted">No failed publishes.</p>';
  document.querySelectorAll<HTMLElement>("[data-retry]").forEach((b) =>
    b.addEventListener("click", () =>
      guarded(async () => {
        await api("POST", `/posts/${b.dataset.retry}/retry`);
        await renderFailures();
        await refreshCalendar();
      })
    )
  );
}

async function renderLog(): Promise<void> {
  const [runs, log] = await Promise.all([api<{ runs: PublishRun[] }>("GET", "/publish-runs"), api<{ entries: PublishLogEntry[] }>("GET", "/publish-log?limit=200")]);
  $("runs").innerHTML =
    "<tr><th>Started</th><th>Trigger</th><th>Due</th><th>Published</th><th>Retry</th><th>Failed</th></tr>" +
    runs.runs.map((r) => `<tr><td>${esc(r.startedAt)}</td><td>${r.trigger}</td><td>${r.dueCount}</td><td>${r.published}</td><td>${r.retried}</td><td>${r.failed}</td></tr>`).join("");
  $("log").innerHTML =
    "<tr><th>Time</th><th>Post</th><th>Outcome</th><th>Attempt</th><th>Message</th></tr>" +
    log.entries.map((e) => `<tr><td>${esc(e.createdAt)}</td><td>${esc(e.title)}</td><td>${e.outcome}</td><td>${e.attempt}</td><td>${esc(e.message)}</td></tr>`).join("");
}

async function downloadCsv(): Promise<void> {
  if (!conn) return;
  const res = await fetch(`${conn.api}/api/publish-log.csv`, { headers: { "X-Site-Id": conn.site, "X-Panel-Token": conn.token } });
  if (!res.ok) throw new Error(`Export failed (${res.status})`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = "publish-log.csv";
  a.click();
  URL.revokeObjectURL(url);
}

// --- Settings ------------------------------------------------------------------------------------

function renderMapping(): void {
  const select = $("set-collection") as HTMLSelectElement;
  select.innerHTML = collections.map((c) => `<option value="${c.id}"${c.id === config?.collectionId ? " selected" : ""}>${esc(c.displayName)}${c.likelyBlog ? " (blog?)" : ""}</option>`).join("");
  const col = collections.find((c) => c.id === select.value);
  const current: FieldMap = col && col.id === config?.collectionId ? config.fieldMap : col?.suggestedMap ?? {};
  $("map-fields").innerHTML = col
    ? MAPPING_KEYS.map(
        (key) => `<label for="map-${key}">${key}</label><select id="map-${key}"><option value="">(not mapped)</option>${col.fields
          .map((f) => `<option value="${esc(f.slug)}"${current[key] === f.slug ? " selected" : ""}>${esc(f.displayName)} (${esc(f.type)})</option>`)
          .join("")}</select>`
      ).join("")
    : '<p class="muted">Load collections to choose a blog collection.</p>';
}

function wireSettings(): void {
  $("set-detect").addEventListener("click", () =>
    guarded(async () => {
      collections = (await api<{ collections: DiscoveredCollection[] }>("GET", "/collections")).collections;
      renderMapping();
    })
  );
  $("set-collection").addEventListener("change", renderMapping);
  $("set-save-map").addEventListener("click", () =>
    guarded(async () => {
      const collectionId = ($("set-collection") as HTMLSelectElement).value;
      const fieldMap: FieldMap = {};
      for (const key of MAPPING_KEYS) {
        const v = ($(`map-${key}`) as HTMLSelectElement | null)?.value;
        if (v) fieldMap[key] = v;
      }
      config = await api<SiteConfig>("PUT", "/mapping", { collectionId, fieldMap });
      notify("Mapping saved");
    })
  );
  $("set-save-tz").addEventListener("click", () =>
    guarded(async () => {
      const value = ($("set-tz") as HTMLInputElement).value.trim();
      if (!isValidTimeZone(value)) throw new Error("Enter a valid IANA timezone, e.g. Europe/Berlin");
      await api("PUT", "/config/timezone", { timezone: value });
      if (config) config.timezone = value;
      anchor = utcIsoToLocal(new Date().toISOString(), value);
      notify("Timezone saved");
      await refreshCalendar();
    })
  );
}

// --- Boot ----------------------------------------------------------------------------------------

function showTab(name: string): void {
  document.querySelectorAll<HTMLElement>(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll<HTMLElement>(".tab-body").forEach((s) => (s.hidden = s.id !== `tab-${name}`));
  notify("");
  if (name === "failures") void guarded(renderFailures);
  if (name === "log") void guarded(renderLog);
  if (name === "settings") {
    ($("set-tz") as HTMLInputElement).value = tz();
    renderMapping();
  }
}

async function start(): Promise<void> {
  $("connect-card").hidden = !!conn;
  $("main").hidden = !conn;
  if (!conn) return;
  await guarded(async () => {
    config = await api<SiteConfig>("GET", "/config");
    anchor = utcIsoToLocal(new Date().toISOString(), tz());
    if (config.needsReauth) notify("Webflow authorisation expired. Reinstall the app to reconnect.", true);
    else if (!config.collectionId) notify("Choose your blog collection under Settings to sync drafts to Webflow.");
    await refreshCalendar();
  });
}

function init(): void {
  const zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? ["UTC"];
  $("tz-list").innerHTML = zones.map((z) => `<option value="${z}"></option>`).join("");
  conn = loadConn();
  document.querySelectorAll<HTMLElement>(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab as string)));
  $("conn-save").addEventListener("click", () => {
    const apiBase = ($("conn-api") as HTMLInputElement).value.trim().replace(/\/$/, "");
    const site = ($("conn-site") as HTMLInputElement).value.trim();
    const token = ($("conn-token") as HTMLInputElement).value.trim();
    if (!apiBase || !site || !token) return;
    conn = { api: apiBase, site, token };
    saveConn(conn);
    void start();
  });
  $("log-refresh").addEventListener("click", () => guarded(renderLog));
  $("log-run").addEventListener("click", () =>
    guarded(async () => {
      await api("POST", "/scheduler/run");
      await renderLog();
      await refreshCalendar();
    })
  );
  $("log-csv").addEventListener("click", () => guarded(downloadCsv));
  wireCalendar();
  wireDialog();
  wireSettings();
  void start();
}

init();
