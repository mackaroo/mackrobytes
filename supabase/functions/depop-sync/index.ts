// MackroBytes Depop sync: a Supabase Edge Function. Paste this whole file into
// Supabase → Edge Functions → depop-sync, with "Verify JWT" OFF (Google's sign-in callback carries no Supabase login;
// every route below checks its own secret instead). No secrets live in this file: they are function secrets.
//
// Depop has no seller API for small shops, so this reads two things you already have, and never writes to Depop:
//   1. Gmail (read-only): Depop's sale emails (old "…sale confirmation for @buyer." and new "You’ve made a sale on Depop! …for @buyer") → Listed → Sold within ~15 minutes, matched by title + price.
//   2. Selling Hub pages, read by a scheduled Claude task in your own Chrome and posted here as JSON
//      → Sold / Shipped / Listed / Ended by exact SKU.
//
// Routes
//   GET  ?connect=<SYNC_SECRET>     → Google sign-in to approve Gmail read-only access (one time)
//   GET  ?code=…&state=…            → Google sends you back here; the refresh token is saved privately
//   POST x-sync-secret, empty body  → read Gmail
//   POST x-cron-token, empty body   → read Gmail (the 15-minute cron job; the token is made inside the database)
//   POST x-sync-secret, {"browser"} → apply a Selling Hub read (the scheduled Chrome task)
//   POST Authorization: Bearer <signed-in user token> → read Gmail now (the app's "Sync Depop" button)
//   Add ?dry=1 to see what would change without saving anything.
//
// Written in plain JavaScript syntax (valid TypeScript) so it can be tested with Node.

const env = (k) => Deno.env.get(k) || "";
const SB = () => env("SUPABASE_URL");
const firstKey = (k) => { try { return Object.values(JSON.parse(env(k) || "{}"))[0] || ""; } catch (_) { return ""; } };
const SERVICE = () => env("SUPABASE_SERVICE_ROLE_KEY") || firstKey("SUPABASE_SECRET_KEYS");
const ANON = () => env("SUPABASE_ANON_KEY") || firstKey("SUPABASE_PUBLISHABLE_KEYS");
const keyHeaders = (key) => ({ apikey: key, ...(key.startsWith("eyJ") ? { Authorization: "Bearer " + key } : {}) });
const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const REDIRECT = () => env("GOOGLE_REDIRECT_URI") || SB() + "/functions/v1/depop-sync";
// The Selling Hub read covers older sales; email only needs to catch new ones quickly.
const FIRST_RUN_DAYS = 3;
const OVERLAP_MS = 60 * 60 * 1000;
const SEEN_KEEP_MS = 120 * 24 * 3600 * 1000;
const OLD_STATUS = { tolist: "prep", unlisted: "prep", photos: "prep", ready: "prep", dropoff: "shipped" };
const statusOf = (it) => OLD_STATUS[it.status] || it.status;
const SOLD = ["sold", "shipped"];
const platformsOf = (it) => (it.platforms && it.platforms.length ? it.platforms : it.platform ? [it.platform] : []);
const onDepop = (it) => platformsOf(it).includes("depop");
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, x-sync-secret, x-cron-token", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const text = (body, status = 200) => new Response(body, { status, headers: { ...cors, "Content-Type": "text/plain; charset=utf-8" } });
const json = (body, status = 200) => new Response(JSON.stringify(body, null, 2), { status, headers: { ...cors, "Content-Type": "application/json" } });
const cents = (n) => Math.round(Number(n) * 100) / 100;
const money = (s) => cents(String(s).replace(/[^0-9.]/g, ""));

/* ---------- Supabase (REST, service role) ---------- */
async function sb(path, init = {}) {
  if (!SERVICE()) throw new Error("The function has no Supabase secret key in its environment.");
  const r = await fetch(SB() + "/rest/v1/" + path, { ...init, headers: { ...keyHeaders(SERVICE()), "Content-Type": "application/json", ...(init.headers || {}) } });
  if (!r.ok) throw new Error("Supabase " + r.status + " on " + path.split("?")[0] + ": " + (await r.text()).slice(0, 300));
  const body = await r.text();
  return body ? JSON.parse(body) : null;
}
const getDoc = async (coll, id) => { const rows = await sb(`docs?coll=eq.${encodeURIComponent(coll)}&id=eq.${encodeURIComponent(id)}&select=data`); return rows.length ? rows[0].data : null; };
const getColl = async (coll) => (await sb(`docs?coll=eq.${encodeURIComponent(coll)}&select=id,data`)).map((r) => r.data);
const putDoc = (coll, id, data) => sb("docs", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ coll, id, data, updated_at: new Date().toISOString() }) });
async function patchDoc(coll, id, patch) { const cur = await getDoc(coll, id); if (!cur) throw new Error(`${coll}/${id} is gone`); await putDoc(coll, id, { ...cur, ...patch, updatedAt: Date.now() }); }
const getKv = async (key) => { const rows = await sb(`private_kv?key=eq.${encodeURIComponent(key)}&select=value`); return rows.length ? rows[0].value : null; };
const putKv = (key, value) => sb("private_kv", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }) });

/* ---------- shared helpers ---------- */
function splitPayout(payout, amounts) {
  const c = amounts.map((a) => Math.round((a || 0) * 100)), sum = c.reduce((a, x) => a + x, 0), total = Math.round(payout * 100);
  // No prices to split by: even shares.
  const w = sum ? c : amounts.map(() => 1), wsum = sum || amounts.length;
  const shares = w.map((x) => Math.floor((x * total) / wsum)); shares[0] += total - shares.reduce((a, x) => a + x, 0);
  return shares.map((x) => x / 100);
}
function dayMs(y, m, d) { return Date.UTC(y, m - 1, d, 17); }
function soldAtMs(ms) {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: env("SHOP_TIME_ZONE") || "America/New_York" }).format(new Date(ms)).split("-").map(Number);
  return dayMs(y, m, d);
}
// Listed date from Depop's card: "Listed on" if shown, else "Last updated on" (the listing can't be newer than that).
// Never the sync time, never before the item was added, never in the future.
function depopListedAt(a, it, now) {
  const on = a.listedOn || a.updatedOn;
  if (!on) return now;
  const [mo, d, y] = on.split("/").map(Number);
  return Math.min(now, Math.max(dayMs(y, mo, d), it.createdAt || 0));
}
const norm = (s) => String(s || "").toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const soldPatch = (it, extra) => {
  const others = platformsOf(it).filter((p) => p !== "depop");
  return { status: "sold", shippedAt: null, platform: "depop", platforms: ["depop", ...others], delistOn: others, payoutEstimated: false, ...extra };
};

/* ---------- state + inbox (shopmeta/depop) ---------- */
async function loadRun() {
  const state = (await getKv("depop_state")) || { seen: {} };
  const inbox = [...(((await getDoc("shopmeta", "depop")) || {}).inbox || [])], added = [];
  return { state, inbox, added, inInbox: (id) => inbox.some((e) => e.id === id), toInbox: (e) => { inbox.push(e); added.push(e); } };
}
async function saveRun(run, started, fields) {
  for (const [k, at] of Object.entries(run.state.seen)) if (started - at > SEEN_KEEP_MS) delete run.state.seen[k];
  await putKv("depop_state", run.state);
  // Re-read first: entries you matched or dismissed in the app while this ran stay gone.
  const latest = (await getDoc("shopmeta", "depop")) || {}, now = latest.inbox || [];
  await putDoc("shopmeta", "depop", { ...latest, inbox: [...now, ...run.added.filter((e) => !now.some((x) => x.id === e.id))], ...fields });
}

/* ---------- Google / Gmail (read-only) ---------- */
async function googleToken(form) {
  const r = await fetch(GOOGLE_TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: env("GOOGLE_CLIENT_ID"), client_secret: env("GOOGLE_CLIENT_SECRET"), ...form }).toString() });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Google sign-in failed (" + r.status + "): " + (body.error_description || body.error || "no details"));
  return body;
}
async function gmailToken() {
  const t = await getKv("gmail_token");
  if (!t || !t.refresh_token) throw new Error("Gmail isn't connected yet. Open the Depop connect link from SETUP.md.");
  return (await googleToken({ grant_type: "refresh_token", refresh_token: t.refresh_token })).access_token;
}
async function gmailGet(url, token) {
  const r = await fetch(url, { headers: { Authorization: "Bearer " + token } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Gmail " + r.status + ": " + JSON.stringify(body.error || body).slice(0, 300));
  return body;
}
const b64 = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));
function bodyText(part) {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body && part.body.data) return b64(part.body.data);
  for (const p of part.parts || []) { const t = bodyText(p); if (t) return t; }
  if (part.mimeType === "text/html" && part.body && part.body.data) return b64(part.body.data).replace(/<br\s*\/?>|<\/(p|div|tr|td|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
  return "";
}

// Reads one Depop sale email ("Your USPS shipping label and sale confirmation for @buyer." or, from Nov 2026,
// "You’ve made a sale on Depop! Here’s your USPS shipping label for @buyer"). Throws if the layout changed,
// so a Depop redesign shows up as a sync error instead of wrong sales.
function parseSaleEmail(subject, body) {
  const buyerM = subject.match(/for @([A-Za-z0-9._-]*[A-Za-z0-9_-])/); // the subject ends in "."
  if (!buyerM) throw new Error("Depop sale email without a buyer in the subject: " + subject.slice(0, 80));
  const lines = body.replace(/\(\s*https?:[^)]*\)/g, " ").split(/\r?\n/).map((l) => l.replace(/[͏­​-‍﻿]/g, "").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, "&").replace(/\s+/g, " ").trim()).filter(Boolean);
  const start = lines.findIndex((l) => /^(Order|Sale) details$/i.test(l)), end = lines.findIndex((l, i) => i > start && /^Ship to$/i.test(l));
  if (start < 0 || end < 0) throw new Error("Depop changed its sale email (no Order/Sale details / Ship to). Nothing was changed.");
  const items = [];
  for (let i = start + 1; i < end; i++) {
    const pm = lines[i + 1] && lines[i + 1].match(/^\$\s?([\d,]+\.\d{2})$/);
    if (pm) { items.push({ title: lines[i].replace(/^image\s+/i, "").replace(/(\.\.\.|…)$/, "").trim(), paid: money(pm[1]) }); i++; }
  }
  const all = lines.join("\n"), payM = all.match(/What you.ll receive\s*\$\s?([\d,]+\.\d{2})/i);
  if (!items.length || !payM) throw new Error("Depop changed its sale email (no items or payout). Nothing was changed.");
  return { buyer: buyerM[1], items, payout: money(payM[1]) };
}

// One email line → one item, only when exactly one Depop-listed item fits on title AND price. Emails cut titles short,
// so a title alone can match a different item that already sold; a price mismatch (an accepted offer) goes to you instead.
function matchLine(line, pool, taken) {
  const t = norm(line.title);
  const open = pool.filter((it) => !taken.has(it.sku));
  const byTitle = t.length >= 8 ? open.filter((it) => it.depopTitle && norm(it.depopTitle).startsWith(t)) : [];
  if (byTitle.length) {
    const exact = byTitle.filter((it) => it.price === line.paid);
    if (exact.length === 1) return { it: exact[0] };
    return { why: exact.length ? `Title and price fit ${exact.length} items` : `Price differs from the listing (offer?)` };
  }
  const byName = open.filter((it) => it.name && norm(it.name).length >= 6 && t.includes(norm(it.name)) && it.price === line.paid);
  if (byName.length === 1) return { it: byName[0] };
  return { why: byName.length ? `Fits ${byName.length} items` : "No listed Depop item fits the title" };
}

async function runEmail(dry) {
  const started = Date.now(), changes = [], run = await loadRun(), { state } = run;
  const since = state.emailCursor ? state.emailCursor - OVERLAP_MS : started - FIRST_RUN_DAYS * 86400000;
  const token = await gmailToken();
  // Every email from this sender is read; ones that aren't sales are listed in changes, so a new subject never hides sales.
  const q = `from:sold@alerts.depop.com after:${Math.floor(since / 1000)}`;
  const ids = [];
  for (let pageToken = ""; ;) {
    const page = await gmailGet(GMAIL + "?" + new URLSearchParams({ q, maxResults: "100", ...(pageToken ? { pageToken } : {}) }), token);
    ids.push(...(page.messages || []).map((m) => m.id));
    if (!page.nextPageToken) break; pageToken = page.nextPageToken;
  }
  const fresh = ids.filter((id) => !state.seen["mail-" + id]);
  const all = fresh.length ? await getColl("shop") : [];
  const pool = all.filter((it) => statusOf(it) === "listed" && onDepop(it));
  // A sale you (or the Selling Hub read) already logged: same buyer, sold within 4 days of the email.
  const logged = (buyer, soldAt) => all.some((it) => SOLD.includes(statusOf(it)) && it.buyer && it.buyer.toLowerCase() === buyer.toLowerCase() && it.soldAt && Math.abs(it.soldAt - soldAt) < 4 * 86400000);
  const taken = new Set();
  // Oldest first, so bundles and repeat buyers land in sale order.
  const msgs = [];
  for (const id of fresh) msgs.push(await gmailGet(GMAIL + "/" + id + "?format=full", token));
  msgs.sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
  for (const m of msgs) {
    const subject = ((m.payload.headers || []).find((x) => x.name.toLowerCase() === "subject") || {}).value || "";
    if (!/for @[A-Za-z0-9._-]/.test(subject)) { changes.push(`Skipped a Depop email that isn't a sale: "${subject.slice(0, 80)}"`); state.seen["mail-" + m.id] = started; continue; }
    const sale = parseSaleEmail(subject, bodyText(m.payload));
    const soldAt = soldAtMs(Number(m.internalDate)), shares = splitPayout(sale.payout, sale.items.map((x) => x.paid));
    const matched = [];
    if (logged(sale.buyer, soldAt)) { changes.push(`@${sale.buyer}: already logged, left alone`); state.seen["mail-" + m.id] = started; continue; }
    for (const [i, line] of sale.items.entries()) {
      const r = matchLine(line, pool, taken), key = "mail-" + m.id + "-" + i;
      if (!r.it) {
        if (!run.inInbox(key)) { run.toInbox({ id: key, kind: "sale", title: line.title, paid: line.paid, payout: shares[i], buyer: sale.buyer, soldAt, why: r.why, at: started }); changes.push(`"${line.title}": ${r.why}, sent to Depop sales to check`); }
        continue;
      }
      const it = r.it; taken.add(it.sku);
      const patch = soldPatch(it, { paid: line.paid, payout: shares[i], buyer: sale.buyer, soldAt, depopOrderId: "mail-" + m.id });
      if (!dry) await patchDoc("shop", it.sku, patch);
      matched.push(it.sku);
      changes.push(`${it.sku}: marked sold for $${line.paid}, payout $${shares[i]} (from email)${patch.delistOn.length ? ", delist on " + patch.delistOn.join(", ") : ""}`);
    }
    if (matched.length > 1 && !dry) for (const sku of matched) await patchDoc("shop", sku, { bundleId: "depop-" + m.id });
    state.seen["mail-" + m.id] = started;
  }
  if (!dry) { state.emailCursor = started; await saveRun(run, started, { lastEmailAt: Date.now(), lastEmailError: null }); }
  return { dry: !!dry, source: "email", emails: fresh.length, changes };
}

/* ---------- Selling Hub read (from the scheduled Chrome task) ---------- */
const SKU = /^[A-Z0-9][A-Z0-9-]{2,23}$/;
const SHIPPED_WORDS = /shipped|in transit|delivered|completed/i;
const CANCEL_WORDS = /cancel/i;
const TO_SHIP_WORDS = /ship order|to ship|ship now|awaiting/i;
function checkPayload(p) {
  const bad = (m) => { throw new Error("Browser read rejected: " + m); };
  if (!p || typeof p !== "object") bad("not JSON");
  if (!Array.isArray(p.sold) || !Array.isArray(p.active)) bad("needs sold and active lists");
  if (!Number.isInteger(p.activeTotal) || p.activeTotal < 0) bad("activeTotal must be the number on the Active items page");
  for (const r of p.sold) {
    if (typeof r.buyer !== "string" || !/^[A-Za-z0-9._-]+$/.test(r.buyer)) bad("sold row without a buyer username");
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(r.soldOn || "")) bad(`sold row for @${r.buyer} needs soldOn as MM/DD/YYYY`);
    if (typeof r.shipping !== "string") bad(`sold row for @${r.buyer} needs the shipping status text`);
    if (!(typeof r.total === "number" && r.total >= 0)) bad(`sold row for @${r.buyer} needs total as a number`);
    if (!Array.isArray(r.skus) || r.skus.some((s) => !SKU.test(s))) bad(`sold row for @${r.buyer} has a malformed SKU list`);
    if (!Number.isInteger(r.count) || r.count < 1) bad(`sold row for @${r.buyer} needs the item count`);
  }
  for (const a of p.active) {
    if (a.sku != null && !SKU.test(a.sku)) bad("active row with a malformed SKU: " + String(a.sku).slice(0, 30));
    if (typeof a.title !== "string") bad("active row without a title");
    if (a.price != null && typeof a.price !== "number") bad("active row price must be a number");
    for (const f of ["listedOn", "updatedOn"]) if (a[f] != null && !/^\d{2}\/\d{2}\/\d{4}$/.test(a[f])) bad(`active row ${a.sku || a.title.slice(0, 30)}: ${f} must be MM/DD/YYYY`);
  }
  return p;
}

async function runBrowser(p, dry) {
  const started = Date.now(), changes = [], run = await loadRun(), { state } = run;
  const items = {}; for (const it of await getColl("shop")) items[it.sku] = it;
  const save = async (sku, patch) => { items[sku] = { ...items[sku], ...patch }; if (!dry) await patchDoc("shop", sku, patch); };
  const soldSkus = new Set(p.sold.flatMap((r) => r.skus));

  // Sold rows: Sold by exact SKU, then Shipped / Cancelled from the row's shipping status.
  for (const r of p.sold) {
    const [mo, d, y] = r.soldOn.split("/").map(Number), soldAt = dayMs(y, mo, d);
    const rowKey = `row-${r.buyer}-${r.soldOn}-${r.skus.join(",") || r.count}`;
    let rowItems = r.skus.map((s) => items[s]).filter(Boolean);
    for (const sku of r.skus.filter((s) => !items[s])) {
      const key = rowKey + "-missing-" + sku;
      if (!state.seen[key] && !run.inInbox(key)) { run.toInbox({ id: key, kind: "sale", sku, title: "", paid: null, payout: r.total, buyer: r.buyer, soldAt, why: "SKU not in MackroBytes", at: started }); changes.push(`${sku}: sold to @${r.buyer} on Depop, but MackroBytes has no such SKU`); }
      state.seen[key] = started;
    }
    if (!r.skus.length) {
      // No SKU on the listing: find it by buyer (from an email or a hand-entered sale).
      rowItems = Object.values(items).filter((it) => it.buyer && it.buyer.toLowerCase() === r.buyer.toLowerCase() && platformsOf(it)[0] === "depop" && SOLD.includes(statusOf(it)) && it.soldAt && Math.abs(it.soldAt - soldAt) < 4 * 86400000);
      if (!rowItems.length) {
        // Only open orders go to the inbox: old shipped sales without a SKU were logged by hand.
        if (TO_SHIP_WORDS.test(r.shipping) && !state.seen[rowKey] && !run.inInbox(rowKey)) { run.toInbox({ id: rowKey, kind: "sale", title: "", paid: null, payout: r.total, buyer: r.buyer, soldAt, why: "No SKU on the Depop listing", at: started }); changes.push(`@${r.buyer} ${r.soldOn}: no SKU on the listing, sent to Depop sales to check`); }
        state.seen[rowKey] = started;
        continue;
      }
    }
    const newSold = rowItems.filter((it) => !SOLD.includes(statusOf(it)) && !CANCEL_WORDS.test(r.shipping));
    if (newSold.length && !state.seen[rowKey + "-sold"]) {
      const shares = splitPayout(r.total, newSold.map((it) => it.price));
      for (const [i, it] of newSold.entries()) {
        await save(it.sku, soldPatch(it, { paid: it.paid != null ? it.paid : null, payout: shares[i], buyer: r.buyer, soldAt, depopOrderId: rowKey, ...(newSold.length > 1 ? { bundleId: "depop-" + rowKey } : {}) }));
        changes.push(`${it.sku}: marked sold to @${r.buyer}, payout $${shares[i]}${newSold.length > 1 ? " (bundle share)" : ""}`);
      }
    }
    state.seen[rowKey + "-sold"] = started;
    for (const it of rowItems) {
      const cur = items[it.sku], key = rowKey + "-" + it.sku;
      if (platformsOf(cur)[0] !== "depop" || (cur.buyer && cur.buyer.toLowerCase() !== r.buyer.toLowerCase())) continue; // another sale of this SKU
      if (CANCEL_WORDS.test(r.shipping)) {
        if (SOLD.includes(statusOf(cur)) && !state.seen[key + "-cancel"] && !run.inInbox(key + "-cancel")) { run.toInbox({ id: key + "-cancel", kind: "cancel", sku: it.sku, title: cur.name || "", at: started }); changes.push(`${it.sku}: Depop order cancelled (flagged)`); }
        state.seen[key + "-cancel"] = started;
      } else if (SHIPPED_WORDS.test(r.shipping) && statusOf(cur) === "sold" && !state.seen[key + "-ship"]) {
        await save(it.sku, { status: "shipped", shippedAt: started, autoShipped: true });
        changes.push(`${it.sku}: marked shipped${cur.packCheckedAt ? "" : " (bag not checked yet)"}`);
        state.seen[key + "-ship"] = started;
      } else if (SHIPPED_WORDS.test(r.shipping)) state.seen[key + "-ship"] = started; // already shipped or moved by hand
    }
  }

  // Active listings: Prep/Ended → Listed; Listed items get linked to Depop.
  const live = new Set();
  let noSku = 0, unknown = 0;
  for (const a of p.active) {
    if (!a.sku) { noSku++; continue; }
    live.add(a.sku);
    const it = items[a.sku];
    if (!it) { unknown++; continue; }
    const st = statusOf(it), on = platformsOf(it), plats = onDepop(it) ? on : [...on, "depop"];
    if (st === "prep" || st === "ended") {
      await save(a.sku, { status: "listed", price: a.price != null ? a.price : it.price, platforms: plats, platform: plats[0], listedAt: depopListedAt(a, it, started), depopTitle: a.title });
      changes.push(`${a.sku}: marked listed on Depop at ${a.price != null ? "$" + a.price : "no price"}${a.listedOn ? ", listed " + a.listedOn : a.updatedOn ? ", listed by " + a.updatedOn : ", NO listed date on the Depop card, so today was used: check it"}`);
    } else if (st === "listed" && (!onDepop(it) || it.depopTitle !== a.title)) {
      await save(a.sku, { platforms: plats, platform: it.platform || "depop", depopTitle: a.title, ...(it.price == null && a.price != null ? { price: a.price } : {}) });
      if (!onDepop(it)) changes.push(`${a.sku}: Depop listing linked`);
    }
  }
  // Gone from Depop without a sale: only when the whole Active list was read, and only for items this read has seen live before.
  let goneChecked = false;
  if (p.active.length === p.activeTotal) {
    goneChecked = true;
    for (const it of Object.values(items)) {
      if (statusOf(it) !== "listed" || !onDepop(it) || !it.depopTitle || live.has(it.sku) || soldSkus.has(it.sku)) continue;
      const rest = platformsOf(it).filter((x) => x !== "depop");
      await save(it.sku, rest.length ? { platforms: rest, platform: rest[0], depopTitle: null } : { status: "ended", endedAt: started, depopTitle: null });
      changes.push(rest.length ? `${it.sku}: off Depop, still listed on ${rest.join(", ")}` : `${it.sku}: Depop listing gone without a sale, marked ended`);
    }
  } else changes.push(`Read ${p.active.length} of ${p.activeTotal} active listings, so nothing was marked ended`);
  if (noSku) changes.push(`${noSku} active Depop listing${noSku === 1 ? " has" : "s have"} no SKU, so ${noSku === 1 ? "it" : "they"} can't be matched`);
  if (unknown) changes.push(`${unknown} active Depop listing${unknown === 1 ? " has a SKU" : "s have SKUs"} MackroBytes doesn't have`);

  if (!dry) await saveRun(run, started, { lastBrowserAt: Date.now(), lastBrowserError: null });
  return { dry: !!dry, source: "browser", sold: p.sold.length, active: p.active.length, goneChecked, changes };
}

/* ---------- requests ---------- */
async function signedInUser(req) {
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  const r = await fetch(SB() + "/auth/v1/user", { headers: { apikey: ANON(), Authorization: auth } });
  return r.ok;
}
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.length > 0 && a.length === b.length && [...a].reduce((d, c, i) => d | (c.charCodeAt(0) ^ b.charCodeAt(i)), 0) === 0;
async function saveError(field, e) {
  try { const meta = (await getDoc("shopmeta", "depop")) || { inbox: [] }; await putDoc("shopmeta", "depop", { ...meta, [field]: String(e && e.message || e), [field + "At"]: Date.now() }); }
  catch (e2) { console.error("Couldn't save the sync error", e2); }
}

async function handle(req) {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const url = new URL(req.url), q = url.searchParams;

  if (req.method === "GET" && q.has("connect")) {
    if (!same(q.get("connect"), env("SYNC_SECRET"))) return text("Wrong connect link.", 403);
    const state = crypto.randomUUID();
    await putKv("gmail_oauth_state", { state, at: Date.now() });
    const go = GOOGLE_AUTH + "?" + new URLSearchParams({ client_id: env("GOOGLE_CLIENT_ID"), redirect_uri: REDIRECT(), response_type: "code", scope: SCOPE, access_type: "offline", prompt: "consent", state });
    return new Response(null, { status: 302, headers: { Location: go } });
  }
  if (req.method === "GET" && q.has("code")) {
    const saved = await getKv("gmail_oauth_state");
    if (!saved || !same(q.get("state"), saved.state) || Date.now() - saved.at > 15 * 60 * 1000) return text("This sign-in link expired. Open the connect link again.", 403);
    const t = await googleToken({ grant_type: "authorization_code", code: q.get("code"), redirect_uri: REDIRECT() });
    if (!t.refresh_token) return text("Google didn't send a refresh token. Remove MackroBytes at myaccount.google.com/permissions, then open the connect link again.", 400);
    if (!String(t.scope || "").split(" ").every((s) => s === SCOPE)) return text("Google granted more than Gmail read-only. Nothing was saved.", 400);
    await putKv("gmail_token", { refresh_token: t.refresh_token, connected_at: Date.now() });
    await sb("private_kv?key=eq.gmail_oauth_state", { method: "DELETE" });
    return text("Gmail (read-only) is connected to MackroBytes. You can close this tab.");
  }
  if (req.method === "GET" && q.has("error")) return text("Google sign-in was cancelled: " + q.get("error"), 400);

  if (req.method === "POST") {
    const bySecret = same(req.headers.get("x-sync-secret") || "", env("SYNC_SECRET"));
    const cronHdr = req.headers.get("x-cron-token") || "";
    const byCron = !bySecret && cronHdr.length >= 32 && same(cronHdr, ((await getKv("cron_token")) || {}).token);
    if (!bySecret && !byCron && !(await signedInUser(req))) return text("Not allowed.", 401);
    const raw = await req.text(), dry = q.get("dry") === "1";
    let body = {};
    if (raw.trim()) { try { body = JSON.parse(raw); } catch (_) { return json({ error: "Body isn't valid JSON." }, 400); } }
    // Only the secret holder (the scheduled task) may post a browser read.
    if (body.browser) {
      if (!bySecret) return text("Not allowed.", 401);
      try { return json(await runBrowser(checkPayload(body.browser), dry)); }
      catch (e) { console.error("Depop browser read failed", e); if (!dry) await saveError("lastBrowserError", e); return json({ error: String(e && e.message || e) }, 500); }
    }
    try { return json(await runEmail(dry)); }
    catch (e) { console.error("Depop email sync failed", e); if (!dry) await saveError("lastEmailError", e); return json({ error: String(e && e.message || e) }, 500); }
  }
  return text("MackroBytes Depop sync.", 404);
}

Deno.serve(async (req) => {
  try { return await handle(req); }
  catch (e) { console.error("depop-sync failed", e); return text("depop-sync error: " + String(e && e.message || e), 500); }
});
