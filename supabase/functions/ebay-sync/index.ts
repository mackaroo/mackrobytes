// MackroBytes eBay sync: a Supabase Edge Function. Paste this whole file into
// Supabase → Edge Functions → ebay-sync, with "Verify JWT" OFF (eBay's callbacks carry no Supabase login;
// every route below checks its own secret instead). No secrets live in this file: they are function secrets.
//
// Routes
//   GET  ?connect=<SYNC_SECRET>     → sends you to eBay's sign-in to approve read access (one time)
//   GET  ?code=…&state=…            → eBay sends you back here; the refresh token is saved privately
//   GET  ?challenge_code=…          → eBay's account-deletion endpoint check
//   POST (eBay deletion notice)     → acknowledged (MackroBytes keeps only buyer usernames on sold items)
//   POST x-sync-secret header       → run a sync (the 15-minute cron job)
//   POST Authorization: Bearer <signed-in user token> → run a sync now (the app's "Sync eBay" button)
//   Add ?dry=1 to a sync to see what it would change without saving anything.
//
// Written in plain JavaScript syntax (valid TypeScript) so it can be tested with Node.

const env = (k) => Deno.env.get(k) || "";
const SB = () => env("SUPABASE_URL");
// Works with both key styles: newer projects get sb_secret_/sb_publishable_ keys as JSON lists, older ones get JWT keys.
const firstKey = (k) => { try { return Object.values(JSON.parse(env(k) || "{}"))[0] || ""; } catch (_) { return ""; } };
const SERVICE = () => env("SUPABASE_SERVICE_ROLE_KEY") || firstKey("SUPABASE_SECRET_KEYS");
const ANON = () => env("SUPABASE_ANON_KEY") || firstKey("SUPABASE_PUBLISHABLE_KEYS");
// New-style keys go only in the apikey header; only JWT keys may also be sent as a Bearer token.
const keyHeaders = (key) => ({ apikey: key, ...(key.startsWith("eyJ") ? { Authorization: "Bearer " + key } : {}) });
const EBAY_AUTH = "https://auth.ebay.com/oauth2/authorize";
const EBAY_TOKEN = "https://api.ebay.com/identity/v1/oauth2/token";
const EBAY_ORDERS = "https://api.ebay.com/sell/fulfillment/v1/order";
const EBAY_FINANCES = "https://apiz.ebay.com/sell/finances/v1/transaction";
const EBAY_TRADING = "https://api.ebay.com/ws/api.dll";
// api_scope is the base scope the Trading API (your listings) accepts with an OAuth user token.
const SCOPES = ["https://api.ebay.com/oauth/api_scope", "https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly", "https://api.ebay.com/oauth/api_scope/sell.finances"].join(" ");
const FIRST_RUN_DAYS = 90; // eBay's order search only reaches back 90 days
const OVERLAP_MS = 10 * 60 * 1000; // re-reads the last 10 minutes each run so nothing is missed between runs
const SEEN_KEEP_MS = 120 * 24 * 3600 * 1000;
// Items saved before the 5 statuses still carry the old names until their next change.
const OLD_STATUS = { tolist: "prep", unlisted: "prep", photos: "prep", ready: "prep", dropoff: "shipped" };
const statusOf = (it) => OLD_STATUS[it.status] || it.status;
const SOLD = ["sold", "shipped"];
const platformsOf = (it) => (it.platforms && it.platforms.length ? it.platforms : it.platform ? [it.platform] : []);
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const text = (body, status = 200) => new Response(body, { status, headers: { ...cors, "Content-Type": "text/plain; charset=utf-8" } });
const json = (body, status = 200) => new Response(JSON.stringify(body, null, 2), { status, headers: { ...cors, "Content-Type": "application/json" } });
const cents = (n) => Math.round(Number(n) * 100) / 100;

/* ---------- Supabase (REST, service role: bypasses row security) ---------- */
async function sb(path, init = {}) {
  if (!SERVICE()) throw new Error("The function has no Supabase secret key in its environment.");
  const r = await fetch(SB() + "/rest/v1/" + path, { ...init, headers: { ...keyHeaders(SERVICE()), "Content-Type": "application/json", ...(init.headers || {}) } });
  if (!r.ok) throw new Error("Supabase " + r.status + " on " + path.split("?")[0] + ": " + (await r.text()).slice(0, 300));
  // Saves answer 201/204 with an empty body; only reads return JSON.
  const body = await r.text();
  return body ? JSON.parse(body) : null;
}
const getDoc = async (coll, id) => { const rows = await sb(`docs?coll=eq.${encodeURIComponent(coll)}&id=eq.${encodeURIComponent(id)}&select=data`); return rows.length ? rows[0].data : null; };
const putDoc = (coll, id, data) => sb("docs", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ coll, id, data, updated_at: new Date().toISOString() }) });
// Merges into the latest saved copy, like the app's own saves, so fields changed elsewhere survive.
async function patchDoc(coll, id, patch) { const cur = await getDoc(coll, id); if (!cur) throw new Error(`${coll}/${id} is gone`); await putDoc(coll, id, { ...cur, ...patch, updatedAt: Date.now() }); }
const getKv = async (key) => { const rows = await sb(`private_kv?key=eq.${encodeURIComponent(key)}&select=value`); return rows.length ? rows[0].value : null; };
const putKv = (key, value) => sb("private_kv", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }) });

/* ---------- eBay sign-in ---------- */
const basic = () => "Basic " + btoa(env("EBAY_CLIENT_ID") + ":" + env("EBAY_CLIENT_SECRET"));
async function ebayToken(form) {
  const r = await fetch(EBAY_TOKEN, { method: "POST", headers: { Authorization: basic(), "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("eBay sign-in failed (" + r.status + "): " + (body.error_description || body.error || "no details"));
  return body;
}
async function accessToken() {
  const t = await getKv("ebay_token");
  if (!t || !t.refresh_token) throw new Error("eBay isn't connected yet. Open the connect link from SETUP.md.");
  if (t.refresh_expires_at && t.refresh_expires_at < Date.now()) throw new Error("The eBay connection expired. Open the connect link from SETUP.md again.");
  return (await ebayToken({ grant_type: "refresh_token", refresh_token: t.refresh_token, scope: SCOPES })).access_token;
}
async function ebayGet(url, token) {
  const r = await fetch(url, { headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("eBay " + r.status + " on " + url.split("?")[0] + ": " + JSON.stringify(body.errors || body).slice(0, 300));
  return body;
}
async function fetchOrders(token, sinceIso) {
  const orders = [];
  for (let offset = 0; ; offset += 200) {
    const q = new URLSearchParams({ filter: `lastmodifieddate:[${sinceIso}..]`, limit: "200", offset: String(offset) });
    const page = await ebayGet(EBAY_ORDERS + "?" + q, token);
    orders.push(...(page.orders || []));
    if (!page.next || !(page.orders || []).length) return orders;
  }
}
// Tracking and ship date per line item, from the order's shipping records (one record per package).
async function fetchShipments(token, orderId) {
  const list = (await ebayGet(EBAY_ORDERS + "/" + encodeURIComponent(orderId) + "/shipping_fulfillment", token)).fulfillments || [];
  const byLine = {};
  for (const f of list) for (const li of f.lineItems || []) byLine[li.lineItemId] = { tracking: f.shipmentTrackingNumber || null, shippedAt: f.shippedDate ? Date.parse(f.shippedDate) : null };
  return byLine;
}

/* ---------- your eBay listings (Trading API, XML) ---------- */
const unxml = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`)); return m ? unxml(m[1].trim()) : null; };
const tags = (xml, name) => [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "g"))].map((m) => m[1]);
async function tradingCall(token, call, body) {
  const r = await fetch(EBAY_TRADING, { method: "POST", headers: { "X-EBAY-API-IAF-TOKEN": token, "X-EBAY-API-CALL-NAME": call, "X-EBAY-API-SITEID": "0", "X-EBAY-API-COMPATIBILITY-LEVEL": "1349", "Content-Type": "text/xml" }, body: `<?xml version="1.0" encoding="utf-8"?><${call}Request xmlns="urn:ebay:apis:eBLBaseComponents">${body}</${call}Request>` });
  const xml = await r.text();
  const ack = tag(xml, "Ack");
  if (!r.ok || (ack !== "Success" && ack !== "Warning")) throw new Error(`eBay ${r.status} on ${call}: ${tag(xml, "LongMessage") || tag(xml, "ShortMessage") || xml.slice(0, 300)}`);
  return xml;
}
// One list ("ActiveList" or "UnsoldList"), every page. Listings without a Custom label (SKU) are kept so they can be counted.
async function fetchListings(token, list) {
  const out = [];
  for (let page = 1; ; page++) {
    const xml = await tradingCall(token, "GetMyeBaySelling", `<${list}><Include>true</Include>${list === "UnsoldList" ? "<DurationInDays>60</DurationInDays>" : ""}<Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination></${list}><DetailLevel>ReturnAll</DetailLevel>`);
    const part = tag(xml, list) || "";
    for (const it of tags(part, "Item")) {
      const price = tag(tag(it, "SellingStatus") || "", "CurrentPrice") || tag(it, "BuyItNowPrice") || tag(it, "StartPrice");
      const details = tag(it, "ListingDetails") || "";
      out.push({ itemId: tag(it, "ItemID"), sku: (tag(it, "SKU") || "").trim(), title: tag(it, "Title") || "", price: price == null ? null : cents(price), startedAt: Date.parse(tag(details, "StartTime") || "") || null, endedAt: Date.parse(tag(details, "EndTime") || "") || null });
    }
    if (page >= Number(tag(tag(part, "PaginationResult") || "", "TotalNumberOfPages") || 1)) return out;
  }
}

// The exact payout once eBay's books have it: sale credits minus label costs for this order. null if not posted yet.
async function exactPayout(token, orderId) {
  const q = new URLSearchParams({ filter: `orderId:{${orderId}}`, limit: "200" });
  const list = (await ebayGet(EBAY_FINANCES + "?" + q, token)).transactions || [];
  const counted = list.filter((t) => t.transactionType === "SALE" || t.transactionType === "SHIPPING_LABEL");
  if (!counted.some((t) => t.transactionType === "SALE")) return null;
  return cents(counted.reduce((a, t) => a + (t.bookingEntry === "DEBIT" ? -1 : 1) * Number(t.amount && t.amount.value || 0), 0));
}
// Until then: what eBay says the order owes you minus its fees. Saved as an estimate.
function estimatedPayout(o) {
  // Without eBay's fee figure there's no honest estimate, so the payout stays blank until eBay posts it.
  const due = o.paymentSummary && o.paymentSummary.totalDueSeller, fee = o.totalMarketplaceFee;
  return due && fee ? cents(Number(due.value) - Number(fee.value)) : null;
}

/* ---------- matching ---------- */
// Same split as the app's bundles: by each item's price, in whole cents, adding up exactly to the payout.
function splitPayout(payout, amounts) {
  const c = amounts.map((a) => Math.round(a * 100)), sum = c.reduce((a, x) => a + x, 0), total = Math.round(payout * 100);
  if (!sum) return amounts.map((_, i) => (i === 0 ? payout : 0));
  const shares = c.map((x) => Math.floor((x * total) / sum)); shares[0] += total - shares.reduce((a, x) => a + x, 0);
  return shares.map((x) => x / 100);
}
// Sale day in US Eastern time, stored mid-day UTC so every US time zone shows the same calendar day.
function soldAtMs(iso) {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: env("SHOP_TIME_ZONE") || "America/New_York" }).format(new Date(iso)).split("-").map(Number);
  return Date.UTC(y, m - 1, d, 17);
}
const isPaid = (o) => ["PAID", "PARTIALLY_REFUNDED"].includes(o.orderPaymentStatus);
const isCancelled = (o) => (o.cancelStatus && o.cancelStatus.cancelState === "CANCELED") || o.orderPaymentStatus === "FULLY_REFUNDED";

/* ---------- the sync ---------- */
async function runSync(dry) {
  const started = Date.now(), changes = [];
  const state = (await getKv("ebay_state")) || { seen: {}, pending: {} };
  const since = new Date(state.cursor ? state.cursor - OVERLAP_MS : started - FIRST_RUN_DAYS * 86400000).toISOString();
  const token = await accessToken();
  const orders = await fetchOrders(token, since);
  const inbox = [...(((await getDoc("shopmeta", "ebay")) || {}).inbox || [])], added = [];
  const inInbox = (id) => inbox.some((e) => e.id === id);
  const toInbox = (entry) => { inbox.push(entry); added.push(entry); };
  const soldNow = new Set(); // SKUs marked sold this run (a dry run saves nothing, so later steps check this)

  for (const o of orders) {
    const lines = o.lineItems || [];
    if (isCancelled(o)) {
      // Flag only: undoing a sale by itself could hide a real problem, so you decide.
      for (const li of lines) {
        const key = "cancel-" + li.lineItemId;
        if (state.seen[key] || inInbox(key)) continue;
        const sku = (li.sku || "").trim(), it = sku ? await getDoc("shop", sku) : null;
        if (it && it.ebayOrderId === o.orderId) { toInbox({ id: key, kind: "cancel", orderId: o.orderId, sku, title: li.title || "", at: started }); changes.push(`${sku}: order ${o.orderId} was cancelled or refunded (flagged)`); }
        state.seen[key] = started;
      }
      continue;
    }
    if (!isPaid(o)) continue;
    if (lines.some((li) => !state.seen[li.lineItemId])) await applySale(o, lines);
    await applyShipped(o, lines);
  }

  // Sold → Shipped once eBay has a label or tracking for that line. Only items this sync sold (same eBay order),
  // and only once per line, so moving it back by hand sticks.
  async function applyShipped(o, lines) {
    const done = lines.filter((li) => li.lineItemFulfillmentStatus === "FULFILLED" && (li.sku || "").trim() && !state.seen["ship-" + li.lineItemId]);
    if (!done.length) return;
    let ships = null;
    for (const li of done) {
      const sku = li.sku.trim(), it = await getDoc("shop", sku);
      const ours = it && (it.ebayOrderId === o.orderId || (dry && soldNow.has(sku)));
      if (!ours) continue;
      // Shipped already, or moved off Sold by hand: left as you saved it.
      if (statusOf(it) !== "sold" && !(dry && soldNow.has(sku))) { state.seen["ship-" + li.lineItemId] = started; continue; }
      if (!ships) ships = await fetchShipments(token, o.orderId);
      const s = ships[li.lineItemId] || {}, tracking = it.tracking || s.tracking || null;
      const shippedAt = s.shippedAt && s.shippedAt <= started ? s.shippedAt : started;
      if (!dry) await patchDoc("shop", sku, { status: "shipped", shippedAt, tracking, autoShipped: true });
      changes.push(`${sku}: marked shipped${tracking ? ", tracking " + tracking : ""}${it.packCheckedAt ? "" : " (bag not checked yet)"}`);
      state.seen["ship-" + li.lineItemId] = started;
    }
  }

  async function applySale(o, lines) {
    let payout = null, estimated = false;
    try { payout = await exactPayout(token, o.orderId); } catch (e) { console.error("Finances lookup failed", o.orderId, e); }
    if (payout == null) { payout = estimatedPayout(o); estimated = payout != null; }
    const prices = lines.map((li) => cents(li.lineItemCost ? li.lineItemCost.value : 0));
    const shares = payout == null ? lines.map(() => null) : splitPayout(payout, prices);
    const buyer = (o.buyer && o.buyer.username) || null, soldAt = soldAtMs(o.creationDate);
    const matched = [];

    for (const [i, li] of lines.entries()) {
      if (state.seen[li.lineItemId]) continue;
      const sku = (li.sku || "").trim(), it = sku ? await getDoc("shop", sku) : null;
      const sale = { orderId: o.orderId, title: li.title || "", sku, paid: prices[i], payout: shares[i], payoutEstimated: estimated, buyer, soldAt };
      if (!it) {
        // No SKU on the listing, or one MackroBytes doesn't have: you match it by hand in the app.
        if (!inInbox(li.lineItemId)) { toInbox({ id: li.lineItemId, kind: "sale", ...sale, at: started }); changes.push(`${sku || "(no SKU)"} "${sale.title}": not matched, sent to the inbox`); }
      } else if (SOLD.includes(statusOf(it))) {
        // Already marked sold (by hand, or by an earlier run): left as you saved it.
        changes.push(`${sku}: already sold, left alone`);
      } else {
        const others = platformsOf(it).filter((p) => p !== "ebay");
        const patch = { status: "sold", paid: sale.paid, payout: sale.payout, payoutEstimated: estimated, buyer, soldAt, shippedAt: null, platform: "ebay", platforms: ["ebay", ...others], ebayOrderId: o.orderId, delistOn: others };
        if (!dry) await patchDoc("shop", sku, patch);
        matched.push(sku); soldNow.add(sku);
        changes.push(`${sku}: marked sold for $${sale.paid}, payout ${sale.payout == null ? "unknown" : "$" + sale.payout}${estimated ? " (estimate)" : ""}${others.length ? ", delist on " + others.join(", ") : ""}`);
      }
      state.seen[li.lineItemId] = started;
    }
    if (matched.length > 1 && !dry) for (const sku of matched) await patchDoc("shop", sku, { bundleId: "ebay-" + o.orderId });
    if ((estimated || payout == null) && matched.length) state.pending[o.orderId] = { skus: matched, prices: matched.map((s) => prices[lines.findIndex((li) => (li.sku || "").trim() === s)]), at: started };
  }

  // Listings: Prep/Ended → Listed when a listing with that SKU is live, Listed → Ended when it ends unsold.
  // A failure here is shown in the app but doesn't undo the order updates above.
  let listingsError = null;
  try { await syncListings(); } catch (e) { console.error("eBay listings failed", e); listingsError = "eBay listings: " + String(e && e.message || e); }
  async function syncListings() {
    const active = await fetchListings(token, "ActiveList"), unsold = await fetchListings(token, "UnsoldList");
    const live = new Set(active.map((l) => l.sku).filter(Boolean));
    let noSku = 0, unknown = 0;
    for (const l of active) {
      if (!l.sku) { noSku++; continue; }
      const key = "list-" + l.itemId;
      if (state.seen[key]) continue;
      const it = await getDoc("shop", l.sku);
      if (!it) { unknown++; continue; }
      const st = statusOf(it), on = platformsOf(it), plats = on.includes("ebay") ? on : [...on, "ebay"];
      if (st === "prep" || st === "ended") {
        const listedAt = l.startedAt && l.startedAt <= started ? l.startedAt : started;
        if (!dry) await patchDoc("shop", l.sku, { status: "listed", price: l.price != null ? l.price : it.price, platforms: plats, platform: plats[0], listedAt, ebayItemId: l.itemId });
        changes.push(`${l.sku}: marked listed on eBay at ${l.price != null ? "$" + l.price : "no price"}`);
      } else if (st === "listed" && (!on.includes("ebay") || it.ebayItemId !== l.itemId)) {
        if (!dry) await patchDoc("shop", l.sku, { platforms: plats, platform: it.platform || "ebay", ebayItemId: l.itemId, ...(it.price == null && l.price != null ? { price: l.price } : {}) });
        changes.push(`${l.sku}: eBay listing linked`);
      }
      // Sold or Shipped: left as you saved it.
      state.seen[key] = started;
    }
    for (const l of unsold) {
      if (!l.sku || live.has(l.sku)) continue; // relisted: the live listing wins
      const key = "end-" + l.itemId;
      if (state.seen[key]) continue;
      const it = await getDoc("shop", l.sku);
      if (!it) continue;
      const on = platformsOf(it);
      if (statusOf(it) === "listed" && on.includes("ebay") && (!it.ebayItemId || it.ebayItemId === l.itemId)) {
        const rest = on.filter((p) => p !== "ebay");
        // Still listed on Depop or Facebook: only eBay comes off. Otherwise the item moves to Ended.
        const patch = rest.length ? { platforms: rest, platform: rest[0], ebayItemId: null } : { status: "ended", endedAt: l.endedAt && l.endedAt <= started ? l.endedAt : started, ebayItemId: null };
        if (!dry) await patchDoc("shop", l.sku, patch);
        changes.push(rest.length ? `${l.sku}: eBay listing ended, still listed on ${rest.join(", ")}` : `${l.sku}: eBay listing ended unsold, marked ended`);
      }
      state.seen[key] = started;
    }
    if (noSku) changes.push(`${noSku} live eBay listing${noSku === 1 ? " has" : "s have"} no Custom label (SKU), so they can't be matched`);
    if (unknown) changes.push(`${unknown} live eBay listing${unknown === 1 ? " has a SKU" : "s have SKUs"} MackroBytes doesn't have`);
  }

  // Fills in the exact payout once eBay posts it, unless you've typed or confirmed a payout since.
  for (const [orderId, p] of Object.entries(state.pending)) {
    let exact = null;
    try { exact = await exactPayout(token, orderId); } catch (e) { console.error("Finances lookup failed", orderId, e); continue; }
    if (exact == null) { if (started - p.at > 14 * 86400000) delete state.pending[orderId]; continue; }
    const shares = splitPayout(exact, p.prices);
    for (const [i, sku] of p.skus.entries()) {
      const it = await getDoc("shop", sku);
      if (!it || it.ebayOrderId !== orderId || !(it.payoutEstimated || it.payout == null)) continue;
      if (!dry) await patchDoc("shop", sku, { payout: shares[i], payoutEstimated: false });
      changes.push(`${sku}: payout confirmed at $${shares[i]}`);
    }
    delete state.pending[orderId];
  }

  for (const [k, at] of Object.entries(state.seen)) if (started - at > SEEN_KEEP_MS) delete state.seen[k];
  if (!dry) {
    await putKv("ebay_state", { ...state, cursor: started });
    // Re-read first: entries you matched or dismissed in the app while this ran stay gone.
    const latest = (await getDoc("shopmeta", "ebay")) || {}, now = latest.inbox || [];
    await putDoc("shopmeta", "ebay", { ...latest, inbox: [...now, ...added.filter((e) => !now.some((x) => x.id === e.id))], lastRunAt: Date.now(), lastOkAt: Date.now(), lastError: listingsError });
  }
  return { dry: !!dry, since, orders: orders.length, changes, ...(listingsError ? { error: listingsError } : {}) };
}

/* ---------- requests ---------- */
async function signedInUser(req) {
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  const r = await fetch(SB() + "/auth/v1/user", { headers: { apikey: ANON(), Authorization: auth } });
  return r.ok;
}
async function sha256hex(s) { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join(""); }
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.length > 0 && a.length === b.length && [...a].reduce((d, c, i) => d | (c.charCodeAt(0) ^ b.charCodeAt(i)), 0) === 0;

async function handle(req) {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const url = new URL(req.url), q = url.searchParams;

  if (req.method === "GET" && q.has("challenge_code")) {
    return json({ challengeResponse: await sha256hex(q.get("challenge_code") + env("EBAY_VERIFY_TOKEN") + env("EBAY_DELETION_ENDPOINT")) });
  }
  if (req.method === "GET" && q.has("connect")) {
    if (!same(q.get("connect"), env("SYNC_SECRET"))) return text("Wrong connect link.", 403);
    const state = crypto.randomUUID();
    await putKv("ebay_oauth_state", { state, at: Date.now() });
    const go = EBAY_AUTH + "?" + new URLSearchParams({ client_id: env("EBAY_CLIENT_ID"), redirect_uri: env("EBAY_RUNAME"), response_type: "code", scope: SCOPES, state });
    return new Response(null, { status: 302, headers: { Location: go } });
  }
  if (req.method === "GET" && q.has("code")) {
    const saved = await getKv("ebay_oauth_state");
    if (!saved || !same(q.get("state"), saved.state) || Date.now() - saved.at > 15 * 60 * 1000) return text("This sign-in link expired. Open the connect link again.", 403);
    const t = await ebayToken({ grant_type: "authorization_code", code: q.get("code"), redirect_uri: env("EBAY_RUNAME") });
    await putKv("ebay_token", { refresh_token: t.refresh_token, refresh_expires_at: Date.now() + Number(t.refresh_token_expires_in || 0) * 1000, connected_at: Date.now() });
    await sb("private_kv?key=eq.ebay_oauth_state", { method: "DELETE" });
    return text("eBay is connected to MackroBytes. You can close this tab.");
  }
  if (req.method === "GET" && q.has("error")) return text("eBay sign-in was cancelled: " + q.get("error"), 400);

  if (req.method === "POST") {
    const bySecret = same(req.headers.get("x-sync-secret") || "", env("SYNC_SECRET"));
    if (!bySecret && !(await signedInUser(req))) {
      // eBay's account-deletion notices arrive here with no secret. Nothing to delete beyond a username on old sales.
      if ((req.headers.get("x-ebay-signature") || "")) return new Response(null, { status: 204, headers: cors });
      return text("Not allowed.", 401);
    }
    try { return json(await runSync(q.get("dry") === "1")); }
    catch (e) {
      console.error("eBay sync failed", e);
      // The app shows this, so a broken sync is never silent.
      try { const meta = (await getDoc("shopmeta", "ebay")) || { inbox: [] }; await putDoc("shopmeta", "ebay", { ...meta, lastRunAt: Date.now(), lastError: String(e && e.message || e) }); }
      catch (e2) { console.error("Couldn't save the sync error", e2); }
      return json({ error: String(e && e.message || e) }, 500);
    }
  }
  return text("MackroBytes eBay sync.", 404);
}

// Anything not caught above still answers with its reason (secrets are never in error messages), never a bare 500.
Deno.serve(async (req) => {
  try { return await handle(req); }
  catch (e) { console.error("ebay-sync failed", e); return text("ebay-sync error: " + String(e && e.message || e), 500); }
});
