"use strict";
/* Supabase-backed storage: JSON documents in public.docs (coll, id, data) with live sync, and photos in a private bucket.
   Exposes STORE (documents), PHOTOS (files) and AUTH. */
const sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const BUCKET = "photos";

const AUTH = {
  async session() { const { data } = await sb.auth.getSession(); return data.session; },
  async signIn(email, password) { const { error } = await sb.auth.signInWithPassword({ email, password }); if (error) throw error; },
  async signOut() { await sb.auth.signOut(); location.reload(); }
};

const STORE = {
  async put(coll, id, data) {
    const { error } = await sb.from("docs").upsert({ coll, id, data, updated_at: new Date().toISOString() });
    if (error) throw error;
  },
  // The saved copy right now (null if there is none), so a save can merge into it instead of overwriting another device's changes.
  async get(coll, id) {
    const { data, error } = await sb.from("docs").select("data").eq("coll", coll).eq("id", id).maybeSingle();
    if (error) throw error; return data ? data.data : null;
  },
  // Create only: fails with { code: "23505" } if the id is already taken (e.g. the same SKU added on another device).
  async insert(coll, id, data) {
    const { error } = await sb.from("docs").insert({ coll, id, data, updated_at: new Date().toISOString() });
    if (error) throw error;
  },
  async del(coll, id) {
    const { error } = await sb.from("docs").delete().eq("coll", coll).eq("id", id);
    if (error) throw error;
  },
  // Calls onChange(map of id -> data) now and after every change from any device.
  watch(coll, onChange, onError) {
    const map = {};
    const load = async () => {
      const rows = []; let from = 0;
      for (;;) {
        const { data, error } = await sb.from("docs").select("id,data").eq("coll", coll).range(from, from + 999);
        if (error) throw error; rows.push(...data); if (data.length < 1000) break; from += 1000;
      }
      for (const k of Object.keys(map)) delete map[k];
      rows.forEach(r => map[r.id] = r.data); onChange({ ...map });
    };
    sb.channel("docs-" + coll)
      .on("postgres_changes", { event: "*", schema: "public", table: "docs", filter: "coll=eq." + coll }, p => {
        if (p.eventType === "DELETE") delete map[p.old.id]; else map[p.new.id] = p.new.data;
        onChange({ ...map });
      })
      .subscribe(st => { if (st === "SUBSCRIBED") load().catch(onError); else if (st === "CHANNEL_ERROR" || st === "TIMED_OUT") onError && onError(st); });
    // Phones pause background tabs; reload when the app comes back so nothing is missed.
    document.addEventListener("visibilitychange", () => { if (!document.hidden) load().catch(onError); });
  }
};

// Signed links last 6 days; re-sign after 5 so an app left open for days never shows expired (blank) photos.
const SIGN_SECS = 60 * 60 * 24 * 6, SIGN_REUSE_MS = 1000 * 60 * 60 * 24 * 5, SIGN_RETRY_MS = 1000 * 60 * 5;
const PHOTOS = {
  urls: {}, failed: {}, pending: new Set(), timer: null, onReady: null, warned: false,
  async upload(blob) {
    const path = new Date().toISOString().slice(0, 7) + "/" + crypto.randomUUID() + ".jpg";
    const { error } = await sb.storage.from(BUCKET).upload(path, blob, { contentType: "image/jpeg", upsert: false });
    if (error) throw error;
    this.urls[path] = { u: URL.createObjectURL(blob), exp: Infinity };
    return path;
  },
  async remove(path) { if (!path) return; const { error } = await sb.storage.from(BUCKET).remove([path]); if (error) throw error; },
  cached(path) { const c = this.urls[path]; return c && c.exp > Date.now() ? c.u : null; },
  // Synchronous for rendering: returns a cached URL, or a blank pixel while a signed URL is fetched in the background.
  // A photo that failed to sign waits SIGN_RETRY_MS before trying again, so a missing file can't cause a re-render loop.
  src(path) {
    const c = this.urls[path]; if (c && c.exp > Date.now()) return c.u;
    if (!(this.failed[path] > Date.now())) { this.pending.add(path); clearTimeout(this.timer); this.timer = setTimeout(() => this.signPending(), 30); }
    // Past the re-sign point but still valid for another day: keep showing it while the new link loads.
    return c ? c.u : "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
  },
  async signPending() {
    const paths = [...this.pending]; this.pending.clear(); if (!paths.length) return;
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(paths, SIGN_SECS);
    const exp = Date.now() + SIGN_REUSE_MS; let got = 0;
    if (error || !data) { console.error("Photo links failed", error); paths.forEach(p => this.failed[p] = Date.now() + SIGN_RETRY_MS); }
    else data.forEach(d => { if (d.signedUrl) { this.urls[d.path] = { u: d.signedUrl, exp }; delete this.failed[d.path]; got++; } else { console.error("Photo link failed", d.path, d.error); this.failed[d.path] = Date.now() + SIGN_RETRY_MS; } });
    if (got < paths.length && !this.warned) { this.warned = true; toast("Some photos couldn't load. They'll retry in a few minutes."); }
    if (got && this.onReady) this.onReady();
  },
  async url(path) {
    const u = this.cached(path); if (u) return u;
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, SIGN_SECS);
    if (error) throw error; this.urls[path] = { u: data.signedUrl, exp: Date.now() + SIGN_REUSE_MS }; return data.signedUrl;
  }
};
// Coming back to an app left open: redraw so any photo whose link is near expiry gets a fresh one.
document.addEventListener("visibilitychange", () => { if (!document.hidden && PHOTOS.onReady) PHOTOS.onReady(); });

