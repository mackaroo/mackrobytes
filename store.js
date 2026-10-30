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
  async del(coll, id) {
    const { error } = await sb.from("docs").delete().eq("coll", coll).eq("id", id);
    if (error) throw error;
  },
  async get(coll, id) {
    const { data, error } = await sb.from("docs").select("data").eq("coll", coll).eq("id", id).maybeSingle();
    if (error) throw error; return data ? data.data : null;
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

const PHOTOS = {
  urls: {}, pending: new Set(), timer: null, onReady: null,
  async upload(blob) {
    const path = new Date().toISOString().slice(0, 7) + "/" + crypto.randomUUID() + ".jpg";
    const { error } = await sb.storage.from(BUCKET).upload(path, blob, { contentType: "image/jpeg", upsert: false });
    if (error) throw error;
    this.urls[path] = URL.createObjectURL(blob);
    return path;
  },
  async remove(path) { if (path) await sb.storage.from(BUCKET).remove([path]); },
  // Synchronous for rendering: returns a cached URL, or a blank pixel while a signed URL is fetched in the background.
  src(path) {
    if (this.urls[path]) return this.urls[path];
    this.pending.add(path); clearTimeout(this.timer); this.timer = setTimeout(() => this.signPending(), 30);
    return "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
  },
  async signPending() {
    const paths = [...this.pending]; this.pending.clear(); if (!paths.length) return;
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(paths, 60 * 60 * 24 * 6);
    if (error || !data) return;
    data.forEach(d => { if (d.signedUrl) this.urls[d.path] = d.signedUrl; });
    if (this.onReady) this.onReady();
  },
  async url(path) {
    if (this.urls[path]) return this.urls[path];
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, 60 * 60 * 24 * 6);
    if (error) throw error; this.urls[path] = data.signedUrl; return data.signedUrl;
  }
};

