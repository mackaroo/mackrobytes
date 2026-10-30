"use strict";
/* ---------- constants ---------- */
const BOXES = { fragile: "Fragile", hobby: "Hobby & Tech", soft: "Soft & Collectibles" };
const STAGES = [["intake","Intake"],["photographed","Photographed"],["drafted","Drafted"],["listed","Listed"],["sold","Sold"],["shipped","Shipped"],["complete","Complete"]];
const STAGE_IDX = Object.fromEntries(STAGES.map((s, i) => [s[0], i]));
const PLAT = { ebay: "eBay", depop: "Depop", fb: "FB Marketplace" };
const CONDITIONS = ["New","New with tags","New without tags","New (other)","Like new","Used – excellent","Used – good","Used – fair","For parts / not working"];
const DEFAULTS = {
  shopName: "MackroBytes", fbName: "", zip: "48386", city: "White Lake, MI", handlingDays: 1,
  ebayFvfPct: 13.6, ebayOrderFeeHigh: 0.40, ebayOrderFeeLow: 0.30, salesTaxPct: 6, buyTaxPct: 6, ebayAdPct: 0,
  depopPct: 3.3, depopFixed: 0.45, depopBoostPct: 0,
  fbShipPct: 10, fbShipMin: 0.80,
  pkgEnvelope: 0.10, pkgPoly: 0.15, pkgBubble: 0.40, pkgBox: 0.75,
  staleDays: 30, theme: "auto", weeklyGoal: 3, sellMin: 12, skuPrefix: "MB", skuYear: null, skuNext: 1,
  season: "auto", photoCleanupDays: 30, mileRateH1: 0.725, mileRateH2: 0.76, mileSwitch: "2026-07-01", templates: null
};
const SEASONS = { fall: "Fall", winter: "Winter", spring: "Spring", summer: "Summer" };
const EXP_CATS = ["Shipping supplies", "Postage outside the apps", "Platform and subscription fees", "Equipment", "Office supplies", "Phone and internet (business share)", "Other"];
const DEFAULT_TEMPLATES = [
  { id: "t1", name: "Thanks for your order", plat: "ebay depop", text: "Thanks so much for your order of the {item}! It ships within {handling} business day, and you'll get tracking as soon as it's on the way.\n\n{shop}" },
  { id: "t2", name: "Shipped", plat: "ebay depop fb", text: "Your {item} shipped today! Tracking: {tracking}\n\nThanks again for your order." },
  { id: "t3", name: "Still available?", plat: "fb", text: "Hi! Yes, the {item} is still available. I can meet near {city} or ship it to you. What works best?" },
  { id: "t4", name: "Counter offer", plat: "ebay depop fb", text: "Thanks for the offer! The best I can do on the {item} is {counter}. It's in {condition} condition and ships within {handling} business day." },
  { id: "t5", name: "Bundle deal", plat: "ebay depop fb", text: "Happy to bundle! Add another item from my listings and I'll take {pct}% off the total and combine shipping." },
  { id: "t6", name: "Lowball reply", plat: "ebay depop fb", text: "I appreciate the offer, but I can't go that low on this one. I could do {floor} if that works for you." },
  { id: "t7", name: "Review request", plat: "ebay depop", text: "Hope you're loving the {item}! If everything arrived as described, a quick review would mean a lot to my small shop. Thank you!" },
  { id: "t8", name: "Pickup details", plat: "fb", text: "Great! I can meet at a public spot near {city}. The price is {price}, cash or Marketplace checkout. What day and time work for you?" }
];
// USPS Ground Advantage estimates (commercial, mid-zone). Max packed ounces -> price. Estimates only.
const GA = [[4,4.80],[8,5.45],[12,6.25],[15.99,7.45],[32,9.35],[48,10.60],[64,11.70],[80,12.90],[160,17.80],[320,27.00],[1120,48.00]];
const PKG_OZ = { envelope: 0.5, poly: 1, bubble: 2, box: 8 };
const PKG_NAME = { envelope: "Rigid envelope / toploader", poly: "Poly mailer", bubble: "Bubble mailer", box: "Box" };

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const h = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = n => (n == null || !isFinite(n)) ? "—" : (n < 0 ? "−$" : "$") + Math.abs(n).toFixed(2);
const num = v => { if (v === "" || v == null) return null; const n = parseFloat(String(v).replace(/[$,]/g, "")); return isFinite(n) ? n : null; };
const getPath = (o, p) => p.split(".").reduce((a, k) => a == null ? a : a[k], o);
const today = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
const daysSince = t => t ? Math.floor((Date.now() - t) / 86400000) : null;
function pathPatch(p, v) { const keys = p.split("."); const out = {}; let cur = out; keys.forEach((k, i) => { if (i === keys.length - 1) cur[k] = v; else cur = cur[k] = {}; }); return out; }
function deepMerge(a, b) {
  const o = { ...(a || {}) };
  for (const k in b) { const v = b[k];
    if (v && typeof v === "object" && !Array.isArray(v) && o[k] && typeof o[k] === "object" && !Array.isArray(o[k])) o[k] = deepMerge(o[k], v);
    else o[k] = v; }
  return o;
}
const skuId = s => { let id = String(s).trim().replace(/[^A-Za-z0-9_\-.~:@+]/g, "_").slice(0, 120); if (id === "." || id === "..") id = "_" + id; return id; };
function parseBox(s) { s = String(s || "").toLowerCase(); if (s.startsWith("f")) return "fragile"; if (s.startsWith("h") || s.includes("tech")) return "hobby"; if (s.startsWith("s") || s.includes("collect")) return "soft"; return null; }
function md(t) {
  let html = h(t).split("\n").map(l => {
    if (/^#{1,4} /.test(l)) return "<h4>" + l.replace(/^#+ /, "") + "</h4>";
    if (/^\s*[-*•] /.test(l)) return "<li>" + l.replace(/^\s*[-*•] /, "") + "</li>";
    if (/^\s*\d+[.)] /.test(l)) return "<li>" + l.replace(/^\s*\d+[.)] /, "") + "</li>";
    if (!l.trim()) return "";
    return "<p>" + l + "</p>";
  }).join("");
  html = html.replace(/(?:<li>.*?<\/li>)+/g, m => "<ul>" + m + "</ul>");
  return html.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
}
function toast(msg, action) {
  const el = $("#toast"); el.innerHTML = "<span>" + h(msg) + "</span>"; el.hidden = false;
  if (action) { const b = document.createElement("button"); b.textContent = action.label; b.onclick = () => { el.hidden = true; action.fn(); }; el.append(b); }
  clearTimeout(toast.t); toast.t = setTimeout(() => el.hidden = true, action ? 6000 : 2600);
}
async function copyText(text, btn) {
  const done = ok => { if (!btn) return; const o = btn.dataset.label || btn.textContent; btn.dataset.label = o; btn.textContent = ok ? "Copied" : "Select & copy"; setTimeout(() => btn.textContent = o, 1400); };
  try { await navigator.clipboard.writeText(text); done(true); }
  catch { const ta = document.createElement("textarea"); ta.value = text; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;opacity:0;top:0"; document.body.append(ta); ta.select(); ta.setSelectionRange(0, text.length); let ok = false; try { ok = document.execCommand("copy"); } catch {} ta.remove(); done(ok); }
}

/* ---------- state & store ---------- */
const S = { items: {}, settings: { ...DEFAULTS }, audits: {}, expenses: {}, things: {}, donations: {}, tab: "today", filter: { q: "", box: "all", stage: "all", bin: "all", sort: "new" }, open: null, chat: [], tools: "fees", bundle: { sel: {}, pct: 10, plat: "ebay" }, period: "month", exp: { type: "expense" }, delExp: null, offerT: { item: "", amt: "", plat: "ebay" }, msgItem: "", tplEdit: false };
// DB is true once signed in to Supabase; LOCAL is the no-config preview that keeps data in this browser only.
let DB = false, LOCAL = false;
let ASSETS = null;
const queues = {};
function enqueue(key, fn) { const p = (queues[key] || Promise.resolve()).then(fn, fn); queues[key] = p.catch(() => {}); return p; }
function setSync(state, text) {
  const map = { ok: "Synced", saving: "Saving…", err: "Couldn't save", local: "Preview", connecting: "Connecting…" };
  $("#sync").innerHTML = '<span class="dot ' + state + '"></span><span>' + h(text || map[state]) + "</span>";
}
const COLLS = ["items", "audits", "expenses", "things", "donations"];
function persistLocal() { try { const d = { settings: S.settings }; COLLS.forEach(c => d[c] = S[c]); localStorage.setItem("mb-local", JSON.stringify(d)); } catch {} }
function dbErr(e) {
  if (e && /JWT|auth/i.test(e.message || "")) return "You've been signed out. Reload and sign in again.";
  if (e && /quota|exceed|too large/i.test(e.message || "")) return "Storage is full. Delete old items or photos, then try again.";
  return "Couldn't save. Check your connection and try again.";
}
// Write one document; every collection goes through here so all devices stay in sync.
async function putDoc(coll, id, data, quietSync) {
  if (!DB) { persistLocal(); return; }
  if (!quietSync) setSync("saving");
  try { await enqueue(coll + "/" + id, () => STORE.put(coll, id, data)); if (!quietSync) setSync("ok"); }
  catch (e) { setSync("err"); toast(dbErr(e)); }
}
async function delDoc(coll, id) {
  if (!DB) { persistLocal(); return; }
  try { await enqueue(coll + "/" + id, () => STORE.del(coll, id)); } catch (e) { toast(dbErr(e)); }
}
async function saveItem(id, patch, opts = {}) {
  patch = { ...patch, updatedAt: Date.now() };
  S.items[id] = opts.create ? patch : deepMerge(S.items[id], patch);
  if (opts.quiet && S.open === id) detailSig = sig(S.items[id]);
  renderSoon();
  await putDoc("items", id, S.items[id]);
}
async function deleteItem(id) { delete S.items[id]; renderSoon(); await delDoc("items", id); }
async function saveSettings(patch) { S.settings = { ...S.settings, ...patch }; renderSoon(); await putDoc("settings", "profile", { ...S.settings }); }
async function saveAudit(date, body) { S.audits[date] = body; renderSoon(); await putDoc("audits", date, body, true); }
async function saveExpense(id, data) { S.expenses[id] = data; renderSoon(); await putDoc("expenses", id, data, true); }
async function deleteExpense(id) { delete S.expenses[id]; renderSoon(); await delDoc("expenses", id); }
function seasonNow(d = new Date()) { const m = d.getMonth(); return m >= 2 && m <= 4 ? "spring" : m >= 5 && m <= 7 ? "summer" : m >= 8 && m <= 10 ? "fall" : "winter"; }
function applySeason() {
  const th = ["light", "dark"].includes(S.settings.theme) ? S.settings.theme : null;
  if (th) document.documentElement.dataset.theme = th; else delete document.documentElement.dataset.theme;
  const v = SEASONS[S.settings.season] ? S.settings.season : seasonNow();
  if (document.documentElement.dataset.season !== v) document.documentElement.dataset.season = v;
}

async function boot() {
  applySeason(); renderTabs(); render();
  const configured = window.CONFIG && CONFIG.SUPABASE_URL && !CONFIG.SUPABASE_URL.startsWith("YOUR") && typeof STORE !== "undefined";
  if (!configured) {
    LOCAL = true; setSync("local");
    try { const d = JSON.parse(localStorage.getItem("mb-local") || "null"); if (d) { COLLS.forEach(c => S[c] = d[c] || {}); S.settings = { ...DEFAULTS, ...(d.settings || {}) }; } } catch {}
    render(); return;
  }
  if (!(await AUTH.session())) { showLogin(); return; }
  startSync();
}
function showLogin() {
  const m = $("#login"); m.hidden = false;
  $("#loginForm").onsubmit = async e => {
    e.preventDefault(); const err = $("#loginErr"); err.hidden = true;
    try { await AUTH.signIn($("#loginEmail").value.trim(), $("#loginPw").value); m.hidden = true; startSync(); }
    catch { err.textContent = "That email and password didn't work."; err.hidden = false; }
  };
}
function startSync() {
  DB = true; setSync("connecting"); PHOTOS.onReady = renderSoon;
  ASSETS = { upload: async blob => ({ id: await PHOTOS.upload(blob) }), delete: async id => PHOTOS.remove(id) };
  let first = true; const fail = () => setSync("err", "Sync stopped — reload");
  STORE.watch("items", m => { S.items = m; setSync("ok"); renderSoon(); if (first) { first = false; setTimeout(cleanupPhotos, 2000); } }, fail);
  STORE.watch("settings", m => { S.settings = { ...DEFAULTS, ...(m.profile || {}) }; renderSoon(); }, fail);
  ["audits", "expenses", "things", "donations"].forEach(c => STORE.watch(c, m => { S[c] = m; renderSoon(); }, fail));
}

/* ---------- money & shipping ---------- */
function gaPrice(oz) { for (const [max, p] of GA) if (oz <= max) return p; return GA[GA.length - 1][1]; }
function shipPlan(it) {
  const w = num(it.weightOz); const box = it.box; const notes = [];
  let pkg = it.pkg || (it.flat && w != null && w <= 3 ? "envelope" : box === "fragile" ? "box" : box === "soft" ? "poly" : (w != null && w > 16 ? "box" : "bubble"));
  if (w == null) return { pkg, service: "Weigh the item first", cost: null, packedOz: null, notes: ["Add the item's weight to get a shipping estimate."] };
  let packedOz = w + PKG_OZ[pkg] + (box === "fragile" ? 4 : 0);
  packedOz = Math.ceil(packedOz * 10) / 10;
  let service, cost;
  if (pkg === "envelope" && packedOz <= 3) { service = "eBay Standard Envelope (eBay only)"; cost = 0.80; notes.push("For trading cards, coins, stamps and similar flat items up to 3 oz. On Depop or FB use Ground Advantage."); }
  else if (it.media) { const lb = Math.ceil(packedOz / 16); service = "USPS Media Mail"; cost = 4.30 + (lb - 1) * 0.80; notes.push("Media Mail is only for books, CDs, DVDs and printed music. Video games and anything with ads don't qualify. It's slower and can be inspected."); }
  else { service = "USPS Ground Advantage"; cost = gaPrice(packedOz); if (packedOz > 15.99) notes.push("Over 1 lb: also price a Priority Mail Flat Rate box. Heavy, small items often ship cheaper that way."); }
  const d = it.dims || {}; const cu = (num(d.l) || 0) * (num(d.w) || 0) * (num(d.h) || 0);
  if (cu > 1728) notes.push("The box is over 1 cubic foot, so USPS charges dimensional weight. Use the smallest box that fits.");
  if (box === "fragile") notes.push("Fragile: 2 inches of padding on every side, double-box glass and ceramics, and do a shake test before sealing.");
  if (pkg === "poly") notes.push("Soft goods: fold neatly, put in a clear bag, then a poly mailer. Lightest and cheapest option.");
  return { pkg, service, cost: Math.round(cost * 100) / 100, packedOz, notes };
}
function pkgCost(pkg) { const s = S.settings; return num({ envelope: s.pkgEnvelope, poly: s.pkgPoly, bubble: s.pkgBubble, box: s.pkgBox }[pkg]) || 0; }
// Net payout for one platform. price = item price, ship = what buyer pays for shipping, label = what you pay for the label.
function netFor(p, { price, ship = 0, label = 0, pkg = 0, cost = 0, local = false }) {
  const s = S.settings; price = price || 0; ship = ship || 0;
  let fees = 0, lines = [];
  if (p === "ebay") {
    const base = (price + ship) * (1 + (num(s.salesTaxPct) || 0) / 100);
    const fvf = base * (num(s.ebayFvfPct) || 0) / 100;
    const order = (price + ship) <= 10 ? (num(s.ebayOrderFeeLow) || 0) : (num(s.ebayOrderFeeHigh) || 0);
    const ad = base * (num(s.ebayAdPct) || 0) / 100;
    lines = [["Final value fee", fvf], ["Per-order fee", order]]; if (ad) lines.push(["Promoted listing", ad]);
    fees = fvf + order + ad;
  } else if (p === "depop") {
    const t = price + ship; const pay = t * (num(s.depopPct) || 0) / 100 + (num(s.depopFixed) || 0);
    const boost = t * (num(s.depopBoostPct) || 0) / 100;
    lines = [["Payment processing", pay]]; if (boost) lines.push(["Boost fee", boost]);
    fees = pay + boost;
  } else if (p === "fb") {
    if (local) { lines = [["Local pickup fee", 0]]; ship = 0; label = 0; pkg = 0; }
    else { const f = Math.max(num(s.fbShipMin) || 0, price * (num(s.fbShipPct) || 0) / 100); lines = [["Selling fee (shipped)", f]]; fees = f; }
  }
  const net = price + ship - fees - label - pkg - (cost || 0);
  return { gross: price + ship, fees, lines, label, pkg, cost: cost || 0, net, ship };
}
// The four payout columns: eBay, Depop, FB shipped, FB local pickup.
const FEE_COLS = [["ebay", false], ["depop", false], ["fb", false], ["fb", true]];
const feeCalcRows = v => FEE_COLS.map(([p, local]) => ({ p, local, r: netFor(p, { price: num(v.price), ship: num(v.ship), label: num(v.label), pkg: num(v.pkg), cost: num(v.cost), local }) }));
// The price shown in lists: eBay first, then Depop, then FB.
const mainPrice = it => num((it.prices || {}).ebay) ?? num((it.prices || {}).depop) ?? num((it.prices || {}).fb);
function itemNet(it, p, local) {
  const sp = shipPlan(it); const price = num((it.prices || {})[p]);
  const label = num(it.labelCost) ?? sp.cost ?? 0;
  const ship = it.freeShip ? 0 : (num(it.shipCharge) ?? label);
  return netFor(p, { price, ship, label, pkg: pkgCost(sp.pkg), cost: num(it.cost) || 0, local });
}

/* ---------- audit rules ---------- */
function ruleFindings() {
  const out = []; const st = num(S.settings.staleDays) || 30;
  for (const [id, it] of Object.entries(S.items)) {
    const nm = it.name || id; const stg = STAGE_IDX[it.stage || "intake"]; const photos = (it.photos || []).length;
    const add = (sev, text, fix) => out.push({ id, sev, text: nm + ": " + text, fix });
    if (it.stage === "sold") { const d = daysSince(it.sale && it.sale.date); const where = "Grab " + (it.sku || id) + " from the " + (BOXES[it.box] || "") + " box."; if (d != null && d >= (num(S.settings.handlingDays) || 1)) add("high", "sold " + d + " day(s) ago and not shipped yet", where + " Ship today to protect your handling-time metrics."); else add("med", "sold, ship within your handling time", where + " Print the label and pack it."); continue; }
    if (stg >= 4) continue;
    if (stg >= 1 && photos < 3) add("med", "only " + photos + " photo(s)", "Aim for 8–12: front, back, labels, flaws, scale.");
    if (stg >= 2 && !(it.listing && it.listing.ebayTitle)) add("med", "drafted but no title yet", "Run Write my listing.");
    if (it.listing && (it.listing.ebayTitle || "").length > 80) add("high", "eBay title is over 80 characters", "Trim it or eBay will reject it.");
    if (stg >= 2 && !num((it.prices || {}).ebay) && !num((it.prices || {}).depop) && !num((it.prices || {}).fb)) add("med", "no price set", "Check sold comps and set a price.");
    if (num(it.weightOz) == null && stg >= 1) add("low", "no weight", "Weigh it so shipping and net payout are accurate.");
    const pl = it.plat || {};
    for (const p of Object.keys(PLAT)) { const x = pl[p] || {}; if (x.status === "listed") { const d = daysSince(x.listedAt); if (d != null && d >= st) add("med", PLAT[p] + " listing is " + d + " days old with no sale", p === "ebay" ? "Send offers to watchers, or lower the price 10% and refresh the photos." : p === "depop" ? "Refresh the listing, send offers to likers, or lower the price 10%." : "Renew the listing and drop the price a little."); } }
    const listedOn = Object.keys(PLAT).filter(p => (pl[p] || {}).status === "listed");
    const fit = (it.ai && it.ai.platformFit) || {};
    const missing = Object.keys(PLAT).filter(p => !listedOn.includes(p) && fit[p] && fit[p].fit !== "skip");
    if (listedOn.length && missing.length) add("low", "could also go on " + missing.map(p => PLAT[p]).join(", "), "Crosslist it for more reach. Remove the other listings when it sells.");
    for (const p of listedOn) { const n = itemNet(it, p, false); if (num((it.prices || {})[p]) && n.net < 3) add("high", "nets only " + money(n.net) + " on " + PLAT[p], "Raise the price, charge for shipping, or bundle it."); }
  }
  const rank = { high: 0, med: 1, low: 2 };
  return out.sort((a, b) => rank[a.sev] - rank[b.sev]);
}

/* ---------- AI ---------- */
function profileText() {
  const s = S.settings;
  return [
    "SELLER PROFILE",
    "- Shop name on eBay and Depop: " + s.shopName + ". Facebook Marketplace runs under a personal profile" + (s.fbName ? " (" + s.fbName + ")" : "") + ", so FB listings never mention the shop name.",
    "- Ships from ZIP " + s.zip + " (" + s.city + "). Handling time: " + s.handlingDays + " business day(s).",
    "- Has a 4x6 thermal label printer, a scale, poly mailers, bubble mailers and boxes. Buys labels through each platform.",
    "- Takes every photo on an iPhone 15 Pro.",
    "- Inventory is SKU-labeled and stored in three boxes: Fragile, Hobby & Tech, Soft & Collectibles.",
    "- Fees in use: eBay " + s.ebayFvfPct + "% final value fee on item + shipping + tax, plus $" + s.ebayOrderFeeHigh + " per order (" + "$" + s.ebayOrderFeeLow + " at $10 or less)" + (num(s.ebayAdPct) ? ", promoted listings " + s.ebayAdPct + "%" : "") + ". Depop: no selling fee, " + s.depopPct + "% + $" + s.depopFixed + " payment processing. FB Marketplace: free for local pickup; " + s.fbShipPct + "% (min $" + s.fbShipMin + ") when shipped.",
    "- Today is " + today() + "."
  ].join("\n");
}
function itemForAI(it, id) {
  const sp = shipPlan(it);
  return {
    sku: it.sku || id, name: it.name, box: BOXES[it.box], brand: it.brand, category: it.category, condition: it.condition,
    flawsAndConditionNotes: it.condNotes, included: it.included, costBasis: num(it.cost), weightOz: num(it.weightOz), dimsIn: it.dims,
    stage: it.stage, prices: it.prices, floor: it.floor, listedOn: Object.fromEntries(Object.entries(it.plat || {}).map(([p, x]) => [p, { status: x.status, daysListed: daysSince(x.listedAt) }])),
    engagement: it.engagement, soldCompsSellerFound: it.comps, shippingEstimate: { service: sp.service, packaging: PKG_NAME[sp.pkg], packedOz: sp.packedOz, labelCost: sp.cost },
    currentTitle: it.listing && it.listing.ebayTitle
  };
}
function looseJSON(t) {
  t = String(t || "").trim();
  try { return JSON.parse(t); } catch {}
  const f = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (f) { try { return JSON.parse(f[1]); } catch {} }
  const a = t.indexOf("{"), b = t.lastIndexOf("}"); if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  throw { code: "invalid_json", message: "No JSON found" };
}
const AI_ERR = {
  invalid_json: "Claude's answer wasn't in the expected format. Tap the button to try again.",
  cancelled: "Stopped."
};
const aiMsg = e => AI_ERR[e && e.code] || "Something went wrong. Try again.";
// Every AI feature is copy & paste: show the prompt, wait for the pasted reply. attach = how many photos to attach in Claude.
async function ai({ prompt, json = false, attach = 0 }) { const t = await manualAI(prompt, attach); return json ? looseJSON(t) : t; }
function manualAI(prompt, attach) {
  return new Promise((resolve, reject) => {
    const m = $("#modal"); m.hidden = false;
    m.innerHTML = `<div class="modal-card" role="dialog" aria-label="Copy prompt to Claude">
      <div class="card-h"><h2>Send to Claude</h2><button class="btn sm ghost sp" id="mClose">Cancel</button></div>
      <p class="small muted">1. Copy the prompt and paste it into the Claude app${attach ? ", attaching this item's photos (up to " + attach + ")" : ""}. 2. Copy Claude's whole reply. 3. Paste it below.</p>
      <textarea id="mPrompt" readonly style="min-height:120px" class="small mono">${h(prompt)}</textarea>
      <button class="btn primary" id="mCopy">Copy prompt</button>
      <hr>
      <label class="f" for="mAns">Claude's reply</label>
      <textarea id="mAns" placeholder="Paste the reply here"></textarea>
      <button class="btn primary" id="mUse">Use this reply</button></div>`;
    const close = () => { m.hidden = true; m.innerHTML = ""; };
    $("#mCopy").onclick = e => copyText(prompt, e.currentTarget);
    $("#mClose").onclick = () => { close(); reject({ code: "cancelled" }); };
    $("#mUse").onclick = () => { const v = $("#mAns").value.trim(); if (!v) { toast("Paste Claude's reply first."); return; } close(); resolve(v); };
  });
}
function listingPrompt(it, id, nPhotos) {
  return `You are a senior e-commerce listing specialist helping a reseller list an item on eBay, Depop and Facebook Marketplace.

${profileText()}

ITEM (from the seller's notes):
${JSON.stringify(itemForAI(it, id), null, 1)}

PHOTOS: ${nPhotos ? nPhotos + " photo(s) of the actual item are attached. Use them to identify brand, model, color, size, material and visible condition. Never invent details you can't see or that weren't given; put anything uncertain in \"verify\"." : "No photos attached. Work from the notes only and put anything uncertain in \"verify\"."}

RULES
- eBay title: at most 80 characters, keyword-first (Brand, Model/Line, key specs, size/color, condition when it matters). No ALL CAPS, no emojis, no "L@@K", no words like "rare" unless true.
- eBay description: plain text in short paragraphs: what it is; honest condition with every flaw; what's included; measurements/specs; then "Ships from Michigan within ${S.settings.handlingDays} business day. Thanks for shopping ${S.settings.shopName}!"
- eBay item specifics: fill as many accurate ones as possible.
- Depop description: the first line works as the title (Depop search reads it), casual but clear; then condition, measurements, a short style note. Also give up to 5 search keywords.
- Facebook Marketplace: plain title under 100 characters and a short friendly description that mentions pickup near ${S.settings.city} or shipping. Never mention ${S.settings.shopName}.
- Pricing: you have no live market data. Base prices on your knowledge plus any sold comps the seller pasted, and state your confidence. Give a list price for each platform (FB local can be a little lower because it has no fees), a floor price (lowest the seller should accept), a quick-sale price, eBay Best Offer auto-accept and auto-decline amounts, and the best search phrase for checking sold comps.
- Platform fit: rate each platform "best", "good" or "skip" for this item, with one line on why.
- Shipping: the cheapest safe service and packaging from this seller's supplies.

Reply with ONLY one JSON object in exactly this shape (numbers in USD, no $ signs):
{"identified":"one line","verify":["..."],"platformFit":{"ebay":{"fit":"best","why":"..."},"depop":{"fit":"good","why":"..."},"fb":{"fit":"skip","why":"..."}},"ebay":{"title":"...","description":"...","itemSpecifics":[["Brand","..."]],"categoryHint":"...","price":0,"bestOfferAccept":0,"bestOfferDecline":0},"depop":{"description":"...","keywords":["..."],"price":0},"fb":{"title":"...","description":"...","price":0},"pricing":{"floor":0,"quickSale":0,"confidence":"medium","rationale":"...","compSearch":"..."},"shipping":{"service":"...","packaging":"...","notes":"..."},"photoTips":["..."]}`;
}
/* ---------- photos ---------- */
const memPhotos = {}; // preview-only blobs when there's no asset store
const photoSrc = p => memPhotos[p.id] || (DB ? PHOTOS.src(p.id) : "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==");
const photoFetchUrl = async p => memPhotos[p.id] || await PHOTOS.url(p.id);
async function fileToJpeg(file, maxSide = 2400, q = 0.92) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return await new Promise(r => c.toBlob(r, "image/jpeg", q));
}
async function storePhoto(blob) {
  if (ASSETS) { const r = await ASSETS.upload(blob); return r.id; }
  const id = "local" + Date.now() + Math.random().toString(36).slice(2, 6); memPhotos[id] = URL.createObjectURL(blob); return id;
}
async function addPhotos(id, files) {
  if (!files || !files.length) return;
  toast("Saving " + files.length + " photo(s)…");
  const added = [];
  for (const f of files) {
    try { const blob = await fileToJpeg(f); added.push({ id: await storePhoto(blob), at: Date.now() }); }
    catch (e) { toast(e && e.code === "quota_exceeded" ? "Photo storage is full. Delete some old photos." : "A photo couldn't be saved. Try a different one."); }
  }
  if (!added.length) return;
  const it = S.items[id]; const patch = { photos: [...(it.photos || []), ...added] };
  if ((it.stage || "intake") === "intake") patch.stage = "photographed";
  await saveItem(id, patch);
  toast(added.length + " photo(s) saved" + (LOCAL ? " (preview only)" : ""));
}

/* ---------- rendering ---------- */
let renderQueued = false, detailSig = "", pointerDown = false, deferred = false;
const sig = o => JSON.stringify(o, (k, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(x => [x, v[x]])) : v);
// Re-rendering under a finger would swallow the tap, so wait until the pointer is up.
document.addEventListener("pointerdown", () => { pointerDown = true; }, true);
const release = () => { pointerDown = false; if (deferred) { deferred = false; setTimeout(render, 30); } };
document.addEventListener("pointerup", release, true); document.addEventListener("pointercancel", release, true);
function renderSoon() { if (renderQueued) return; renderQueued = true; requestAnimationFrame(() => { renderQueued = false; render(); }); }
const editingIn = el => el && el.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
function render() {
  if (pointerDown) { deferred = true; return; }
  applySeason(); renderSide();
  const main = $("#main");
  if (!editingIn(main)) { const y = window.scrollY; main.innerHTML = '<div class="wrap">' + VIEWS[S.tab]() + "</div>"; window.scrollTo(0, y); }
  if (S.open) {
    if (!S.items[S.open]) { closeDetail(); return; }
    if (sig(S.items[S.open]) !== detailSig && !editingIn($("#sheet"))) renderDetail();
  }
}
const ICONS = {
  today: '<path d="M4 6h16M4 12h10M4 18h7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" fill="none"/><circle cx="18.5" cy="16.5" r="3" stroke="currentColor" stroke-width="1.7" fill="none"/>',
  items: '<path d="M3.5 8 12 4l8.5 4v8L12 20l-8.5-4z M3.5 8 12 12l8.5-4 M12 12v8" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" fill="none"/>',
  profit: '<path d="M4 19.5h16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M5 15.5l4.5-4.5 3.5 3 6-7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  sort: '<rect x="5" y="4" width="11" height="15" rx="3" stroke="currentColor" stroke-width="1.6" fill="none" transform="rotate(-8 10 11)"/><path d="M14 7.5l4 1.2-3 11.5" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" fill="none"/>'
};
function renderTabs() {
  const names = { today: "Home", items: "Items", add: "Add", sort: "Sort", profit: "Money" };
  $("#tabs").innerHTML = Object.keys(names).map(k => k === "add"
    ? `<button class="tab add-tab" data-act="tab" data-v="add" aria-label="Add" ${S.tab === k ? 'aria-current="page"' : ""}><span class="fab"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v12M6 12h12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></span></button>`
    : `<button class="tab" data-act="tab" data-v="${k}" ${S.tab === k ? 'aria-current="page"' : ""}><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[k]}</svg>${names[k]}</button>`).join("");
  const tl = $("#toolsBtn"); if (tl) { if (S.tab === "tools") tl.setAttribute("aria-current", "page"); else tl.removeAttribute("aria-current"); }
  const g = $("#gear"); if (g) { if (S.tab === "settings") g.setAttribute("aria-current", "page"); else g.removeAttribute("aria-current"); }
}
const boxTag = b => b ? `<span class="box ${b}"><i></i>${h(BOXES[b])}</span>` : "";
const stageName = s => (STAGES.find(x => x[0] === (s || "intake")) || STAGES[0])[1];
function thumb(it) { const p = (it.photos || [])[0]; return p ? `<img class="thumb" src="${h(photoSrc(p))}" alt="" loading="lazy">` : it.thumb ? `<img class="thumb" src="${h(it.thumb)}" alt="">` : `<div class="thumb">${it.shot ? "#" + it.shot : "no photo"}</div>`; }
function itemListHTML() {
  const F = S.filter; const q = F.q.toLowerCase();
  const rows = Object.entries(S.items).filter(([id, it]) =>
    (F.box === "all" || it.box === F.box) && (F.bin === "all" || (it.bin || "") === F.bin) && (F.stage === "all" || (F.stage === "tolist" ? STAGE_IDX[it.stage || "intake"] <= 2 : (it.stage || "intake") === F.stage)) &&
    (!q || [id, it.sku, it.name, it.brand, it.model, it.official, it.listing && it.listing.ebayTitle, it.shot ? "#" + it.shot : ""].join(" ").toLowerCase().includes(q)));
  const by = { new: (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0), old: (a, b) => (a.createdAt || 0) - (b.createdAt || 0),
    hi: (a, b) => (mainPrice(b) ?? -1) - (mainPrice(a) ?? -1), lo: (a, b) => (mainPrice(a) ?? 1e9) - (mainPrice(b) ?? 1e9),
    name: (a, b) => (a.name || "").localeCompare(b.name || ""), shot: (a, b) => (a.shot ?? 1e9) - (b.shot ?? 1e9) }[F.sort] || ((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  rows.sort((a, b) => by(a[1], b[1]));
  return rows.length ? `<div class="list">${rows.map(([id, it]) => itemRow(id, it)).join("")}</div>` :
    `<div class="empty"><b>${Object.keys(S.items).length ? "No matches." : "No items yet."}</b><button class="btn primary" data-act="tab" data-v="add">Add items</button></div>`;
}
function itemFiltersHTML(F) {
  const sel = (k, opts) => `<label class="f">${opts.label}<select data-filt="${k}">${opts.list.map(([v, n]) => `<option value="${h(v)}" ${F[k] === v ? "selected" : ""}>${h(n)}</option>`).join("")}</select></label>`;
  const bins = knownBins();
  return `<div class="filters">${sel("box", { label: "Box", list: [["all", "All boxes"], ...Object.entries(BOXES)] })}${sel("stage", { label: "Stage", list: [["all", "Any stage"], ["tolist", "To list"], ...STAGES] })}
    ${bins.length ? sel("bin", { label: "Came from", list: [["all", "Any bin"], ...bins.map(b => [b, b])] }) : ""}${sel("sort", { label: "Sort by", list: [["new", "Recently changed"], ["old", "Oldest first"], ["hi", "Price: high to low"], ["lo", "Price: low to high"], ["name", "Name A–Z"], ["shot", "Camera photo #"]] })}</div>`;
}
function itemRow(id, it) {
  const pl = it.plat || {}; const on = Object.keys(PLAT).filter(p => (pl[p] || {}).status === "listed");
  const price = mainPrice(it);
  return `<button class="row-item" data-act="open" data-id="${h(id)}">${thumb(it)}
    <div style="min-width:0"><div class="t">${h(it.name || "Untitled item")}</div>
    <div class="m"><span class="sku">${h(it.sku || id)}</span>${boxTag(it.box)}<span class="pill st-${h(it.stage || "intake")}">${stageName(it.stage)}</span>${it.shot ? `<span class="small muted">#${it.shot}</span>` : ""}</div></div>
    <div class="r"><div class="mono">${price != null ? money(price) : ""}</div><div class="muted small">${on.map(p => PLAT[p].split(" ")[0]).join(" · ")}</div></div></button>`;
}

const VIEWS = {
  sort() { return sortViewHTML(); },
  today() {
    const items = Object.entries(S.items); const s = S.settings;
    const counts = Object.fromEntries(STAGES.map(x => [x[0], 0])); items.forEach(([, it]) => counts[it.stage || "intake"]++);
    const listedVal = items.filter(([, it]) => it.stage === "listed").reduce((a, [, it]) => a + (mainPrice(it) ?? 0), 0);
    const [ma, mb] = periodRange("month"); const soldMonth = salesIn(+ma, +mb);
    const netMonth = soldMonth.reduce((a, x) => a + (num(x.s.net) || 0), 0);
    const toPack = items.filter(([, it]) => it.stage === "sold");
    const f = ruleFindings().filter(x => S.items[x.id] && S.items[x.id].stage !== "sold"); const audit = S.audits[today()];
    const latest = Object.values(S.audits).sort((a, b) => (b.date || "").localeCompare(a.date || ""))[0];
    const kpi = (n, label, act, v) => `<button class="kpi" data-act="${act}" data-v="${v}"><b>${n}</b><span>${label}</span></button>`;
    return `
    ${LOCAL ? `<div class="banner">Preview mode · changes stay in this browser</div>` : ""}
    <div><div class="hello">Hello, ${h(s.ownerName || "Mackenzie")}.</div><div class="hello-sub">${new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</div></div>
    <div class="kpis">
      ${kpi(counts.intake + counts.photographed + counts.drafted, "To list", "homeStage", "tolist")}${kpi(counts.listed, "Listed", "homeStage", "listed")}${kpi(counts.sold, "To ship", "homeStage", "sold")}${kpi(undecided().length, "To sort", "tab", "sort")}
      ${kpi(money(listedVal), "Listed value", "homeStage", "listed")}${kpi(money(netMonth), `Net this month · ${soldMonth.length} sold`, "tab", "profit")}
    </div>
    <div class="mob-only">${goalCardHTML()}</div>
    <div class="mob-only">${quickAddHTML()}</div>
    <div class="home-grid">
      <section class="card inv">${homeInvHTML()}</section>
      <div class="home-side">
        ${toPack.length ? `<section class="card"><div class="card-h"><h2>To pack</h2><span class="pill warn sp">${toPack.length}</span></div><div class="list">${toPack.map(([id, it]) => `<button class="row-item" data-act="open" data-id="${h(id)}">${thumb(it)}<div style="min-width:0"><div class="t">${h(it.name || id)}</div><div class="m"><span class="small muted">Grab</span><span class="sku">${h(it.sku || id)}</span><span class="small muted">from</span>${boxTag(it.box)}</div></div><div class="r small muted">${h(PLAT[(it.sale || {}).platform] || "")}<br>${daysSince((it.sale || {}).date) ? daysSince(it.sale.date) + "d ago" : it.sale ? "today" : ""}</div></button>`).join("")}</div></section>` : ""}
        <section class="card"><div class="card-h"><h2>Needs attention</h2><span class="pill sp ${f.length ? "warn" : "on"}">${f.length || "All clear"}</span></div>
          ${f.length ? `<div>${f.slice(0, 6).map(x => `<div class="finding" data-act="open" data-id="${h(x.id)}"><span class="sev ${x.sev}"></span><div style="min-width:0"><div class="small" style="font-weight:600">${h(x.text)}</div></div></div>`).join("")}</div>${f.length > 6 ? `<p class="small muted" style="margin:0">+${f.length - 6} more</p>` : ""}` : `<p class="muted small" style="margin:0">Nothing to fix.</p>`}</section>
        ${priceCheckCardHTML()}
        ${fold("audit", "Daily audit", `
          <div class="btns"><button class="btn primary" data-act="audit" ${items.length ? "" : "disabled"}>${audit ? "Run again" : "Run today's audit"}</button></div>
          <div id="auditOut" class="ai-out">${(audit || latest) ? md((audit || latest).text) : ""}</div>`, { badge: `<span class="muted small">${audit ? "Ready" : latest ? h(latest.date) : ""}</span>` })}
      </div>
    </div>`;
  },
  items() {
    const F = S.filter;
    return `<div class="card-h"><h1>Items</h1><button class="btn sm primary sp" data-act="tab" data-v="add">Add item</button></div>
      <input type="search" id="q" placeholder="Search" value="${h(F.q)}" aria-label="Search items" data-act-input="search">
      ${fold("filters", "Filter & sort", itemFiltersHTML(F), { cls: "slim", badge: (n => n ? `<span class="pill on">${n}</span>` : "")(["box", "stage", "bin"].filter(k => F[k] !== "all").length) })}
      ${lookupCardHTML()}
      <section class="card" id="itemList">${itemListHTML()}</section>`;
  },
  add() {
    return `<h1>Add items</h1>
    ${fold("addQuick", "Quick add", quickAddHTML(), { open: true })}
    ${fold("addPile", "Sort a pile", `<div class="btns"><button class="btn primary" data-act="thingCam">Snap photos</button><button class="btn" data-act="tab" data-v="sort">Go to Sort</button></div>`)}
    ${fold("addOne", "One item", `
      <div class="grid2"><label class="f">SKU<input type="text" id="aSku" autocapitalize="characters" value="${h(nextSku())}"></label>
      <label class="f">Box<select id="aBox">${Object.entries(BOXES).map(([k, n]) => `<option value="${k}">${h(n)}</option>`).join("")}</select></label></div>
      <label class="f">What is it?<input type="text" id="aName" placeholder="e.g. Nintendo DS Lite, cobalt blue"></label>
      <div class="btns"><button class="btn primary" data-act="addOne">Add and take photos</button><button class="btn" data-act="addOne" data-v="stay">Add another</button></div>`)}
    ${fold("addBulk", "Paste a list", `
      <p class="small muted" style="margin:0"><span class="mono">SKU, name, box</span> per line</p>
      <textarea id="aBulk" class="mono small" placeholder="FR-001, Pyrex mixing bowl, fragile&#10;HT-014, Logitech MX Master 3, hobby&#10;SC-203, Patagonia fleece size M, soft"></textarea>
      <button class="btn primary" data-act="addBulk">Import list</button>`)}`;
  },
  tools() {
    const t = S.tools; const tabs = [["fees", "Fees"], ["offer", "Offers"], ["messages", "Messages"], ["bundle", "Bundles"], ["ship", "Shipping"], ["boost", "Grow"], ["ask", "Ask Claude"]];
    return `<div class="card-h"><h1>Tools</h1><select class="sp pick-sel" data-pick="tool" aria-label="Tool">${tabs.map(([k, n]) => `<option value="${k}" ${t === k ? "selected" : ""}>${n}</option>`).join("")}</select></div>` + TOOLS[t]();
  },
  profit() {
    const [a, b] = periodRange(S.period); const sales = salesIn(+a, +b); const ex = expensesIn(+a, +b);
    const sum = fn => sales.reduce((t, x) => t + (num(fn(x.s)) || 0), 0);
    const gross = sum(s => s.gross), fees = sum(s => s.fees), shipc = sum(s => (num(s.label) || 0) + (num(s.pkg) || 0)), cogs = sum(s => s.cost), net = sum(s => s.net);
    const spend = ex.filter(x => x.e.type !== "mileage").reduce((t, x) => t + x.ded, 0);
    const trips = ex.filter(x => x.e.type === "mileage"); const mileDed = trips.reduce((t, x) => t + x.ded, 0); const mi = trips.reduce((t, x) => t + (num(x.e.miles) || 0), 0);
    const profit = net - spend;
    const now = new Date(); const months = [];
    for (let i = 5; i >= 0; i--) { const m0 = new Date(now.getFullYear(), now.getMonth() - i, 1), m1 = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      months.push({ l: m0.toLocaleDateString(undefined, { month: "short" }), now: i === 0, v: salesIn(+m0, +m1).reduce((t, x) => t + (num(x.s.net) || 0), 0) - expensesIn(+m0, +m1).filter(x => x.e.type !== "mileage").reduce((t, x) => t + x.ded, 0) }); }
    const byPlat = groupSales(sales, x => x.s.local ? "fblocal" : x.s.platform), byBox = groupSales(sales, x => x.it.box || "hobby");
    const platName = k => k === "fblocal" ? "FB local" : PLAT[k] || k;
    const top = [...sales].sort((x, y) => (y.s.net || 0) - (x.s.net || 0)).slice(0, 5);
    const exList = Object.entries(S.expenses).sort((x, y) => (y[1].date || "").localeCompare(x[1].date || "")).slice(0, 40);
    const mileage = S.exp.type === "mileage";
    const brk = (rows, nm) => { const mx = Math.max(1, ...rows.map(r => Math.abs(r[1].net))); return rows.length ? rows.map(([k, r]) => `<div class="brk"><span>${h(nm(k))}</span><div class="hbar" style="width:${Math.max(2, Math.abs(r.net) / mx * 100)}%"></div><span class="num">${money(r.net)} <span class="muted">· ${r.n}</span></span></div>`).join("") : `<p class="small muted">No sales in this period.</p>`; };
    return `<div class="card-h"><h1>Profit</h1><select class="sp pick-sel" data-pick="period" aria-label="Period">${[["month", "This month"], ["last", "Last month"], ["ytd", "This year"], ["all", "All time"]].map(([k, n]) => `<option value="${k}" ${S.period === k ? "selected" : ""}>${n}</option>`).join("")}</select></div>
    <section class="card">
      <div class="stats four"><div class="stat"><b class="${profit >= 0 ? "" : "neg"}">${money(profit)}</b><span>profit after expenses</span></div><div class="stat"><b>${sales.length}</b><span>items sold</span></div><div class="stat"><b>${money(gross)}</b><span>buyers paid</span></div><div class="stat"><b>${sales.length ? money(net / sales.length) : "—"}</b><span>avg net per sale</span></div></div>
      <div class="scroll-x"><table class="money"><tbody>
        <tr><td>Buyers paid</td><td>${money(gross)}</td></tr><tr><td>Platform fees</td><td>−${money(fees)}</td></tr><tr><td>Labels and packaging</td><td>−${money(shipc)}</td></tr><tr><td>What you paid for the items</td><td>−${money(cogs)}</td></tr>
        <tr><td><b>Net from sales</b></td><td><b>${money(net)}</b></td></tr><tr><td>Expenses</td><td>−${money(spend)}</td></tr>
        <tr class="net"><td>Profit</td><td class="${profit >= 0 ? "pos" : "neg"}">${money(profit)}</td></tr></tbody></table></div>
      ${mi ? `<p class="small muted">${mi.toFixed(1)} mi · ${money(mileDed)} deduction (not subtracted)</p>` : ""}
    </section>
    ${fold("m6", "Last 6 months", barChart(months))}
    ${fold("byPlat", "By platform", brk(Object.entries(byPlat), platName))}
    ${fold("byBox", "By box", brk(Object.entries(byBox), k => BOXES[k] || k))}
    ${top.length ? fold("best", "Best sales", `<div class="list">${top.map(x => `<button class="row-item" data-act="open" data-id="${h(x.id)}">${thumb(x.it)}<div style="min-width:0"><div class="t">${h(x.it.name || x.id)}</div><div class="m"><span class="sku">${h(x.it.sku || x.id)}</span><span class="small muted">${h(platName(x.s.local ? "fblocal" : x.s.platform))}</span></div></div><div class="r"><b class="num pos">${money(x.s.net)}</b><div class="small muted">sold ${money(num(x.s.price))}</div></div></button>`).join("")}</div>`) : ""}
    ${fold("exp", "Expenses & mileage", `
      <div class="grid2"><label class="f">Type<select data-pick="expType"><option value="expense" ${mileage ? "" : "selected"}>Expense</option><option value="mileage" ${mileage ? "selected" : ""}>Mileage</option></select></label><label class="f">Date<input type="date" id="exDate" value="${today()}"></label></div>
      <div class="grid2">${mileage ? `<label class="f">Miles (round trip)<input type="number" inputmode="decimal" step="0.1" id="exMiles"></label>` : `<label class="f">Amount $<input type="number" inputmode="decimal" step="0.01" id="exAmt"></label>`}</div>
      ${mileage ? "" : `<label class="f">Category<select id="exCat">${EXP_CATS.map(c => `<option>${h(c)}</option>`).join("")}</select></label>`}</div>
      <label class="f">${mileage ? "Purpose" : "Note"}<input type="text" id="exNote" placeholder="${mileage ? "Post office drop-off, 6 packages" : "Poly mailers, 100 pack"}"></label>
      <div class="btns"><button class="btn primary" data-act="addExp">${mileage ? "Add trip" : "Add expense"}</button></div>
      ${exList.length ? `<div class="list">${exList.map(([id, e]) => { const isM = e.type === "mileage"; const v = isM ? (num(e.miles) || 0) * (num(e.rate) || 0) : num(e.amount); return `<div class="finding"><span class="sev ${isM ? "low" : ""}"></span><div style="min-width:0"><div class="small" style="font-weight:700">${h(isM ? (num(e.miles) || 0) + " mi · " + (e.note || "Trip") : (e.category || "Expense") + (e.note ? " · " + e.note : ""))}</div><div class="small muted">${h(e.date)}${isM ? " · deduction at " + Math.round((num(e.rate) || 0) * 1000) / 10 + "¢/mi" : ""}</div></div><div class="btns" style="flex-wrap:nowrap"><span class="num small">${money(v)}</span>${S.delExp === id ? `<button class="btn sm danger" data-act="delExpYes" data-id="${h(id)}">Delete</button>` : `<button class="btn sm ghost" data-act="delExp" data-id="${h(id)}" aria-label="Delete entry">✕</button>`}</div></div>`; }).join("")}</div>` : ""}
      <hr><div class="btns"><span class="small muted">Export</span><button class="btn sm" data-act="csvSales">Sales CSV</button><button class="btn sm" data-act="csvExp">Expenses CSV</button></div>`)}${donationsCardHTML()}`;
  },
  settings() {
    const s = S.settings; const f = (k, label, type = "text", step) => `<label class="f">${label}<input type="${type}" ${step ? `step="${step}" inputmode="decimal"` : ""} data-set="${k}" value="${h(s[k])}"></label>`;
    return `<h1>Settings</h1>
    ${fold("sShop", "Shop", `<div class="grid2">${f("ownerName", "First name")}${f("shopName", "Shop name")}${f("fbName", "FB name")}${f("zip", "Ship-from ZIP")}${f("city", "FB city")}${f("handlingDays", "Handling days", "number", "1")}${f("staleDays", "Stale after (days)", "number", "1")}</div>`)}
    ${fold("sLook", "Look", `
      <label class="f">Theme<select data-set="theme"><option value="auto" ${!["light", "dark"].includes(s.theme) ? "selected" : ""}>Match my device</option><option value="light" ${s.theme === "light" ? "selected" : ""}>Daylight lavender</option><option value="dark" ${s.theme === "dark" ? "selected" : ""}>Night sky</option></select></label>`)}
    ${fold("sGoals", "Goals & SKUs", `<div class="grid2">${f("weeklyGoal", "Listings per week", "number", "1")}${f("sellMin", "Donate if under $", "number", "1")}${f("skuPrefix", "SKU prefix")}${f("skuNext", "Next SKU #", "number", "1")}</div>
      <p class="small muted" style="margin:0">Next: ${h(s.skuPrefix || "MB")}${String(new Date().getFullYear() % 100)}-${String(num(s.skuNext) || 1).padStart(4, "0")}</p>`)}
    ${fold("sPhotos", "Photos", `
      ${f("photoCleanupDays", "Delete photos N days after sale (0 = never)", "number", "1")}`)}
    ${fold("sTax", "Taxes", `
      <div class="grid3">${f("mileRateH1", "Mileage $/mi", "number", "0.001")}${f("mileRateH2", "Rate after switch", "number", "0.001")}${f("mileSwitch", "Switch date")}</div>`)}
    ${fold("sFees", "Fees", `
      <div class="eyebrow">eBay</div><div class="grid2">${f("ebayFvfPct", "Final value fee %", "number", "0.01")}${f("salesTaxPct", "Avg sales tax % (fee base)", "number", "0.1")}${f("buyTaxPct", "Tax added to what you paid %", "number", "0.1")}${f("ebayOrderFeeHigh", "Per-order fee (> $10)", "number", "0.01")}${f("ebayOrderFeeLow", "Per-order fee (≤ $10)", "number", "0.01")}${f("ebayAdPct", "Promoted listings %", "number", "0.1")}</div>
      <div class="eyebrow">Depop</div><div class="grid2">${f("depopPct", "Payment processing %", "number", "0.01")}${f("depopFixed", "Processing fixed fee", "number", "0.01")}${f("depopBoostPct", "Boost fee % (0 if not boosting)", "number", "0.1")}</div>
      <div class="eyebrow">FB Marketplace (shipped orders)</div><div class="grid2">${f("fbShipPct", "Selling fee %", "number", "0.1")}${f("fbShipMin", "Minimum fee", "number", "0.01")}</div>`)}
    ${fold("sPkg", "Packaging costs", `<div class="grid2">${f("pkgEnvelope", "Envelope / toploader", "number", "0.01")}${f("pkgPoly", "Poly mailer", "number", "0.01")}${f("pkgBubble", "Bubble mailer", "number", "0.01")}${f("pkgBox", "Box + padding", "number", "0.01")}</div>`)}
    ${fold("sBackup", "Backup", `
      <div class="btns"><button class="btn" data-act="export">Save backup file</button><button class="btn" data-act="import">Restore from file</button></div>`)}
    ${DB ? `<section class="card"><h2>Account</h2><div class="btns"><button class="btn danger" data-act="signout">Sign out on this device</button></div></section>` : ""}`;
  }
};

const TOOLS = {
  fees() {
    const v = S.feeCalc || (S.feeCalc = { price: 25, ship: 6.25, label: 6.25, cost: 5, pkg: 0.4 });
    const rows = feeCalcRows(v);
    return `<section class="card"><h2>What you actually keep</h2>
      <div class="grid3"><label class="f">Sale price<input type="number" inputmode="decimal" step="0.01" data-fee="price" value="${h(v.price)}"></label><label class="f">Buyer pays shipping<input type="number" inputmode="decimal" step="0.01" data-fee="ship" value="${h(v.ship)}"></label><label class="f">Your label cost<input type="number" inputmode="decimal" step="0.01" data-fee="label" value="${h(v.label)}"></label><label class="f">Packaging<input type="number" inputmode="decimal" step="0.01" data-fee="pkg" value="${h(v.pkg)}"></label><label class="f">Your cost for item<input type="number" inputmode="decimal" step="0.01" data-fee="cost" value="${h(v.cost)}"></label></div>
      <div class="scroll-x" id="feeTable">${feeTable(rows)}</div>
</section>`;
  },
  offer() {
    return `<section class="card"><h2>Offer helper</h2>${offerBox(null, "t")}</section>`;
  },
  messages() {
    const items = Object.entries(S.items).sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
    const it = S.items[S.msgItem]; const tp = templates(); const ed = S.tplEdit;
    return `<section class="card"><div class="card-h"><h2>Buyer messages</h2><button class="btn sm sp" data-act="tplEdit">${ed ? "Done" : "Edit"}</button></div>
      ${ed ? `<p class="small muted">Placeholders: {item} {sku} {price} {floor} {counter} {tracking} {city} {shop} {handling} {condition} {pct}. Leave {shop} out of FB messages.</p>` : `<label class="f">Fill in details for<select id="msgItem"><option value="">No item, keep placeholders</option>${items.map(([k, x]) => `<option value="${h(k)}" ${S.msgItem === k ? "selected" : ""}>${h((x.sku || k) + " · " + (x.name || ""))}</option>`).join("")}</select></label>`}
      <div>${tp.map((t, i) => ed
        ? `<div class="tpl"><input type="text" data-tpl="${i}" data-k="name" value="${h(t.name)}" aria-label="Template name"><textarea data-tpl="${i}" data-k="text" aria-label="Template text">${h(t.text)}</textarea><div class="btns">${Object.entries(PLAT).map(([k, n]) => `<label class="check small"><input type="checkbox" data-tpl="${i}" data-k="plat" data-v="${k}" ${(t.plat || "").includes(k) ? "checked" : ""}>${n.split(" ")[0]}</label>`).join("")}<button class="btn sm danger" data-act="tplDel" data-i="${i}">Delete</button></div></div>`
        : `<div class="tpl"><div class="card-h"><h3>${h(t.name)}</h3><span class="sp small muted">${(t.plat || "").split(" ").filter(k => PLAT[k]).map(k => PLAT[k].split(" ")[0]).join(" · ")}</span></div><p id="tp${i}">${h(fillTpl(t.text, it))}</p><div class="btns"><button class="btn sm" data-act="copy" data-from="tp${i}">Copy</button></div></div>`).join("")}</div>
      ${ed ? `<button class="btn" data-act="tplAdd">Add a message</button>` : ""}</section>`;
  },
  bundle() {
    const B = S.bundle; const cand = Object.entries(S.items).filter(([, it]) => STAGE_IDX[it.stage || "intake"] <= 3);
    const sel = cand.filter(([id]) => B.sel[id]);
    let out = "";
    if (sel.length >= 2) {
      const p = B.plat; const pct = num(B.pct) || 0;
      const sepNet = sel.reduce((a, [, it]) => a + itemNet(it, p, false).net, 0);
      const subtotal = sel.reduce((a, [, it]) => a + (num((it.prices || {})[p]) || 0), 0);
      const sepShip = sel.reduce((a, [, it]) => a + (num(it.labelCost) ?? shipPlan(it).cost ?? 0), 0);
      const totOz = sel.reduce((a, [, it]) => a + (num(it.weightOz) || 0), 0);
      const anyFragile = sel.some(([, it]) => it.box === "fragile");
      const comb = shipPlan({ weightOz: totOz, box: anyFragile ? "fragile" : "hobby", pkg: "box" });
      const cost = sel.reduce((a, [, it]) => a + (num(it.cost) || 0), 0);
      const price = subtotal * (1 - pct / 100);
      const bn = netFor(p, { price, ship: comb.cost || 0, label: comb.cost || 0, pkg: pkgCost("box"), cost });
      const saved = sepShip - (comb.cost || 0);
      const keep = bn.gross ? 1 - bn.fees / bn.gross : 1; const breakEven = subtotal ? Math.max(0, pct + (bn.net - sepNet) / keep / subtotal * 100) : 0;
      out = `<div class="stats"><div class="stat"><b>${money(price)}</b><span>bundle price (${pct}% off ${money(subtotal)})</span></div><div class="stat"><b class="${bn.net >= sepNet ? "pos" : "neg"}">${money(bn.net)}</b><span>bundle net vs ${money(sepNet)} sold separately</span></div><div class="stat"><b>${money(saved)}</b><span>shipping saved (${comb.packedOz || "?"} oz, ${h(comb.service)})</span></div></div>
        <p class="small">You can offer up to about <b>${breakEven.toFixed(0)}% off</b> on ${PLAT[p]} and still net the same as selling these separately, because one label replaces ${sel.length}.</p>
        <div class="btns"><button class="btn" data-act="bundleAI">Get Claude's bundle advice</button></div><div id="bundleOut" class="ai-out"></div>`;
    }
    return `<section class="card"><h2>Bundle discount check</h2>
      <div class="grid2"><label class="f">Platform<select data-bundle="plat">${Object.entries(PLAT).map(([k, n]) => `<option value="${k}" ${B.plat === k ? "selected" : ""}>${n}</option>`).join("")}</select></label><label class="f">Bundle discount %<input type="number" inputmode="decimal" data-bundle="pct" value="${h(B.pct)}"></label></div>
      ${out}
      <div class="list">${cand.length ? cand.map(([id, it]) => `<label class="check" style="padding:6px 0;border-top:1px solid var(--line)"><input type="checkbox" data-bsel="${h(id)}" ${B.sel[id] ? "checked" : ""}><span style="min-width:0;flex:1">${h(it.name || id)} <span class="sku">${h(it.sku || id)}</span></span><span class="mono small">${money(num((it.prices || {})[B.plat]))}</span></label>`).join("") : `<p class="muted small">No unsold items yet.</p>`}</div>
    </section>
    <section class="card flat"><h2>Tips</h2><details class="tips" open><summary>eBay</summary><ul><li>Set up combined shipping discounts in your shipping preferences so multi-item buyers pay for one shipment.</li><li>Volume pricing (buy 2, save X%) is under Seller Hub, Marketing. It works best on related items, like accessories for the same console.</li><li>Accept bundle offers through Best Offer or a custom invoice. Never take payment off eBay.</li></ul></details>
      <details class="tips"><summary>Depop</summary><ul><li>Turn on bundle discounts in your shop settings. Buyers bundle items from your shop, and the discount applies automatically.</li><li>A tiered discount (say 10% for 2, 15% for 3+) gets buyers browsing your whole shop. Depop rewards that engagement.</li></ul></details>
      <details class="tips"><summary>FB Marketplace</summary><ul><li>No bundle tool, so put "bundle deals available, message me" in descriptions and quote bundle prices in Messenger.</li><li>For local pickup a bundle costs you nothing extra, so you can discount a little deeper.</li></ul></details></section>`;
  },
  ship() {
    const v = S.shipCalc || (S.shipCalc = { weightOz: 10, box: "hobby", flat: false, media: false });
    const sp = shipPlan(v);
    return `<section class="card"><h2>Quick shipping estimate</h2>
      <div class="grid2"><label class="f">Item weight (oz)<input type="number" inputmode="decimal" data-ship="weightOz" value="${h(v.weightOz)}"></label><label class="f">Box<select data-ship="box">${Object.entries(BOXES).map(([k, n]) => `<option value="${k}" ${v.box === k ? "selected" : ""}>${n}</option>`).join("")}</select></label></div>
      <div class="btns"><label class="check"><input type="checkbox" data-ship="flat" ${v.flat ? "checked" : ""}> Flat card / coin / stamp</label><label class="check"><input type="checkbox" data-ship="media" ${v.media ? "checked" : ""}> Book / CD / DVD</label></div>
      <div class="stats"><div class="stat"><b>${money(sp.cost)}</b><span>${h(sp.service)}</span></div><div class="stat"><b>${sp.packedOz ?? "—"} oz</b><span>packed weight</span></div><div class="stat"><b>${h(PKG_NAME[sp.pkg])}</b><span>packaging</span></div></div>
      ${sp.notes.length ? `<ul class="small">${sp.notes.map(n => `<li>${h(n)}</li>`).join("")}</ul>` : ""}
</section>
    <section class="card flat"><h2>Tips</h2>
      <details class="tips" open><summary>Pay less for labels</summary><ul>
        <li>Always buy labels inside eBay, Depop or FB. They get commercial rates, which beat the post office counter.</li>
        <li>Up to 15.99 oz, Ground Advantage is priced by the ounce. Weigh after packing and trim excess packaging when you're near a break (4, 8, 12, 15.99 oz).</li>
        <li>Trading cards up to 3 oz: eBay Standard Envelope costs well under $1 with tracking. Use a toploader in a plain #10 envelope.</li>
        <li>Heavy and small (over 2–3 lb): compare a Priority Mail Flat Rate box with Ground Advantage.</li>
        <li>Books, CDs, DVDs and vinyl: Media Mail is cheapest, but it's slow and video games don't qualify.</li>
        <li>Over 1 cubic foot means dimensional pricing. Use the smallest box that keeps the item safe.</li></ul></details>
      <details class="tips"><summary>Free packaging & drop-off</summary><ul>
        <li>USPS gives free Priority Mail boxes and envelopes (order on usps.com), but only for Priority Mail shipments.</li>
        <li>Reuse clean Amazon boxes and air pillows. Cover every old label and barcode.</li>
        <li>Schedule a free USPS Package Pickup at your door, or drop off at any blue box or post office.</li>
        <li>Your thermal printer handles 4x6 labels. Ask for the 4x6 PDF in each app's label settings.</li></ul></details>
      <details class="tips"><summary>Should you offer free shipping?</summary><ul>
        <li>eBay: under about $25, folding the label into the price with "free shipping" usually converts better and helps search placement. Remember the fee is charged on the full amount either way.</li>
        <li>Heavy or oversized items: use calculated shipping so distant buyers pay their real cost.</li>
        <li>Depop: buyers compare totals, so keep shipping low and the price fair. Free shipping on cheap clothes is a strong hook.</li>
        <li>FB: offer local pickup first (no fees), then shipping as a backup.</li></ul></details></section>`;
  },
  boost() {
    return `<section class="card"><h2>Boost plan</h2>
      <button class="btn primary" data-act="boostAI" ${Object.keys(S.items).length ? "" : "disabled"}>Make my boost plan</button><div id="boostOut" class="ai-out"></div></section>
    <section class="card flat"><h2>Playbook</h2>
      <details class="tips" open><summary>eBay</summary><ul><li>List a little every day. New listings get a visibility bump, and steady activity helps your whole store.</li><li>Fill in every item specific. Search filters depend on them.</li><li>Use 8–12+ photos (up to 24 are free) on a plain background, starting with a sharp square cover photo.</li><li>Turn on Best Offer and send offers to watchers after 2–3 days.</li><li>Ship in 1 business day and offer 30-day returns for the best placement and buyer trust.</li><li>For competitive items, try Promoted Listings General at a low 2–4% rate. Set that rate in Settings so the net math stays honest.</li><li>After 60–90 days with no sale, end it and Sell Similar with fresh photos and a sharper title.</li></ul></details>
      <details class="tips"><summary>Depop</summary><ul><li>Post at peak times (evenings and Sunday) and refresh older listings so they move back up.</li><li>Use square photos with good light; a lifestyle or flat-lay cover shot stands out in the feed.</li><li>Fill every attribute (brand, size, color, condition, style). Depop search relies on them.</li><li>Send offers to people who like your items, and follow and engage with buyers in your niche.</li><li>Keep your shop consistent: same background and lighting so it looks like a brand.</li></ul></details>
      <details class="tips"><summary>FB Marketplace</summary><ul><li>Reply fast. FB shows response time, and buyers move on quickly.</li><li>Renew listings when FB offers it, and relist stale items with new photos.</li><li>Price slightly above your floor. Local buyers expect to haggle.</li><li>Use specific keywords in the title (brand, model, size). FB search is literal.</li><li>Meet in public spots; a police station safe-exchange zone works well.</li></ul></details>
      <details class="tips"><summary>Photos that convert (and never look AI-edited)</summary><ul><li>Shoot near a window in daylight, or under two matching lamps. Don't mix light colors.</li><li>Use the 1x main lens on your 15 Pro and tap to focus on labels and flaws.</li><li>Only global fixes: brightness, white balance, contrast, straightening, cropping. Never remove flaws or change the item. Platforms require photos to show the real item.</li><li>Include a scale shot and every flaw. Honest photos mean fewer returns and better reviews.</li></ul></details></section>`;
  },
  ask() {
    return `<section class="card"><h2>Ask Claude</h2>
      <div class="chips">${["Which items should I drop the price on?", "What should I list next and where?", "How do I ship a ceramic mug safely and cheaply?", "Write a shop bio for MackroBytes"].map(q => `<button class="chip" data-act="askq" data-v="${h(q)}">${h(q)}</button>`).join("")}</div>
      <div class="chat" id="chat">${S.chat.map(m => `<div class="bubble ${m.role === "user" ? "me" : "ai ai-out"}">${m.role === "user" ? h(m.content) : md(m.content)}</div>`).join("")}</div>
      <textarea id="askIn" placeholder="Ask anything" style="min-height:64px"></textarea>
      <div class="btns"><button class="btn primary" data-act="ask">Send</button>${S.chat.length ? `<button class="btn ghost" data-act="chatClear">Clear chat</button>` : ""}</div></section>`;
  }
};
function periodRange(p) {
  const n = new Date(); const y = n.getFullYear(), m = n.getMonth();
  if (p === "month") return [new Date(y, m, 1), new Date(y, m + 1, 1), "This month"];
  if (p === "last") return [new Date(y, m - 1, 1), new Date(y, m, 1), "Last month"];
  if (p === "ytd") return [new Date(y, 0, 1), new Date(y + 1, 0, 1), "This year"];
  return [new Date(2000, 0, 1), new Date(2100, 0, 1), "All time"];
}
// Older sales only stored net; rebuild their breakdown from the item.
function saleParts(it) {
  const s = it.sale; if (s.fees != null && s.gross != null) return s;
  const sp = shipPlan(it); const r = netFor(s.platform, { price: num(s.price), ship: num(s.ship) || 0, label: s.local ? 0 : (num(it.labelCost) ?? sp.cost ?? 0), pkg: s.local ? 0 : pkgCost(sp.pkg), cost: num(it.cost) || 0, local: s.local });
  return { ...s, gross: r.gross, fees: r.fees, label: r.label, pkg: r.pkg, cost: r.cost, net: num(s.net) ?? r.net };
}
function salesIn(a, b) { return Object.entries(S.items).filter(([, it]) => it.sale && it.sale.date >= a && it.sale.date < b).map(([id, it]) => ({ id, it, s: saleParts(it) })); }
function mileRate(date) { const s = S.settings; return (date || today()) >= (s.mileSwitch || "2026-07-01") ? num(s.mileRateH2) : num(s.mileRateH1); }
function expensesIn(a, b) {
  return Object.entries(S.expenses).filter(([, e]) => { const t = new Date((e.date || today()) + "T12:00:00").getTime(); return t >= a && t < b; })
    .map(([id, e]) => ({ id, e, ded: e.type === "mileage" ? (num(e.miles) || 0) * (num(e.rate) ?? mileRate(e.date) ?? 0) : (num(e.amount) || 0) }));
}
function groupSales(list, key) { const g = {}; for (const x of list) { const k = key(x); g[k] = g[k] || { n: 0, net: 0 }; g[k].n++; g[k].net += num(x.s.net) || 0; } return g; }
function barChart(months) {
  const W = 360, H = 170, pt = 22, pb = 24; const max = Math.max(1, ...months.map(m => Math.abs(m.v))); const neg = months.some(m => m.v < 0);
  const span = neg ? (H - pt - pb) / 2 : H - pt - pb; const zero = neg ? pt + span : H - pb; const bw = W / months.length;
  const short = v => (v < 0 ? "−$" : "$") + Math.round(Math.abs(v)).toLocaleString();
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Net profit for the last 6 months"><line x1="0" x2="${W}" y1="${zero}" y2="${zero}" stroke="var(--line)" stroke-width="1"/>${months.map((m, i) => {
    const hgt = Math.abs(m.v) / max * span; const x = i * bw + bw * 0.27; const y = m.v >= 0 ? zero - hgt : zero; const cx = i * bw + bw / 2;
    return `<rect class="bar ${m.v < 0 ? "neg" : m.now ? "now" : ""}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.46).toFixed(1)}" height="${Math.max(m.v ? 2 : 0, hgt).toFixed(1)}" rx="4"/><text x="${cx}" y="${H - 6}" text-anchor="middle">${h(m.l)}</text>${m.v ? `<text x="${cx}" y="${(m.v >= 0 ? y - 6 : y + hgt + 14).toFixed(1)}" text-anchor="middle">${short(m.v)}</text>` : ""}`; }).join("")}</svg>`;
}
function csv(rows) { return rows.map(r => r.map(v => { const t = v == null ? "" : String(v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; }).join(",")).join("\n"); }
function downloadBlob(name, blob) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
async function saveFile(name, text, type) {
  try { downloadBlob(name, new Blob([text], { type })); toast("Saved " + name); return; } catch {}
  const m = $("#modal"); m.hidden = false;
  m.innerHTML = `<div class="modal-card"><div class="card-h"><h2>${h(name)}</h2><button class="btn sm ghost sp" data-act="mclose">Close</button></div><p class="small muted">Copy this and paste it into a spreadsheet.</p><textarea id="fileTxt" readonly class="small" style="min-height:200px">${h(text)}</textarea><button class="btn primary" data-act="copy" data-from="fileTxt">Copy</button></div>`;
}
function exportCSV(kind) {
  const [a, b, label] = periodRange(S.period); const tag = label.toLowerCase().replace(/\s+/g, "-");
  if (kind === "sales") {
    const rows = [["Date", "SKU", "Item", "Platform", "Sale price", "Shipping charged", "Platform fees", "Label", "Packaging", "Item cost", "Net"]];
    salesIn(+a, +b).sort((x, y) => x.s.date - y.s.date).forEach(({ id, it, s }) => rows.push([new Date(s.date).toISOString().slice(0, 10), it.sku || id, it.name || "", s.local ? "FB local" : PLAT[s.platform], s.price, s.ship, (+s.fees).toFixed(2), s.label, s.pkg, s.cost, (+s.net).toFixed(2)]));
    saveFile("mackrobytes-sales-" + tag + ".csv", csv(rows), "text/csv");
  } else {
    const rows = [["Date", "Type", "Category", "Description", "Amount", "Miles", "Rate per mile", "Deduction"]];
    expensesIn(+a, +b).sort((x, y) => (x.e.date || "").localeCompare(y.e.date || "")).forEach(({ e, ded }) => rows.push([e.date, e.type === "mileage" ? "Mileage" : "Expense", e.type === "mileage" ? "Car and truck (business miles)" : e.category, e.note || "", e.type === "mileage" ? "" : e.amount, e.type === "mileage" ? e.miles : "", e.type === "mileage" ? e.rate : "", ded.toFixed(2)]));
    saveFile("mackrobytes-expenses-" + tag + ".csv", csv(rows), "text/csv");
  }
}
function templates() { return Array.isArray(S.settings.templates) && S.settings.templates.length ? S.settings.templates : DEFAULT_TEMPLATES; }
function fillTpl(text, it, extra = {}) {
  const s = S.settings; const price = it ? mainPrice(it) : null;
  const floor = it && num(it.floor) != null ? money(num(it.floor)) : null;
  const map = { item: it ? (it.name || it.sku) : "[item]", sku: it ? it.sku : "[SKU]", price: price != null ? money(price) : "[price]", floor: floor || "[lowest price]",
    counter: extra.counter != null ? money(extra.counter) : floor || "[counter]", tracking: it && it.sale && it.sale.tracking ? it.sale.tracking : "[tracking]",
    city: s.city, shop: s.shopName, handling: s.handlingDays, condition: it && it.condition ? it.condition.toLowerCase() : "great", pct: S.bundle.pct || 10 };
  return text.replace(/\{(\w+)\}/g, (m, k) => map[k] != null ? String(map[k]) : m);
}
const niceRound = x => x >= 20 ? Math.round(x) : Math.round(x * 2) / 2;
function netAt(it, p, price) { const sp = shipPlan(it); const label = num(it.labelCost) ?? sp.cost ?? 0; const ship = it.freeShip ? 0 : (num(it.shipCharge) ?? label); return netFor(p, { price, ship, label, pkg: pkgCost(sp.pkg), cost: num(it.cost) || 0 }).net; }
function offerCalc(it, plat, offer) {
  const pr = it.prices || {}; const list = num(pr[plat]) ?? mainPrice(it);
  if (list == null) return { err: "Set a price for this item first." };
  const floor = num(it.floor) ?? niceRound(list * 0.8); const guessed = num(it.floor) == null;
  let verdict, why, counter = null, tpl = "t4";
  if (offer >= list * 0.9 && offer >= floor) { verdict = "Accept"; why = "It's within 10% of your price and above your lowest."; tpl = null; }
  else if (offer >= floor) { counter = Math.max(offer, niceRound((offer + list) / 2)); verdict = "Counter at " + money(counter); why = "It's above your lowest, so accepting is fine too. Meeting in the middle usually lands."; }
  else if (offer >= floor * 0.7) { counter = Math.max(floor, niceRound((offer + list) / 2)); verdict = "Counter at " + money(counter); why = "It's below your lowest price, so don't accept it as is."; }
  else { counter = floor; verdict = "Decline politely"; why = "It's a lowball. Offer your lowest price instead."; tpl = "t6"; }
  if (guessed) why += " Your lowest price is estimated at 80% of your price; set one for a better answer.";
  const t = tpl && templates().find(x => x.id === tpl);
  return { list, floor, verdict, why, counter, netOffer: netAt(it, plat, offer), netCounter: counter != null ? netAt(it, plat, counter) : null, msg: t ? fillTpl(t.text, it, { counter }) : null };
}
function offerHTML(it, plat, offer, key) {
  if (!it) return `<p class="small muted">Add an item with a price to use this.</p>`;
  if (offer == null) return `<p class="small muted">Type their offer to see what you'd keep and what to reply.</p>`;
  const r = offerCalc(it, plat, offer); if (r.err) return `<p class="small muted">${h(r.err)}</p>`;
  return `<div class="offer-res"><div class="verdict">${h(r.verdict)}</div><div class="small muted">${h(r.why)}</div>
    <table class="money"><tbody><tr><td>You keep at their offer</td><td class="${r.netOffer >= 0 ? "pos" : "neg"}">${money(r.netOffer)}</td></tr>${r.counter != null ? `<tr><td>You keep at ${money(r.counter)}</td><td class="pos">${money(r.netCounter)}</td></tr>` : ""}<tr><td>Your price · lowest</td><td>${money(r.list)} · ${money(r.floor)}</td></tr></tbody></table>
    ${r.msg ? `<textarea id="offMsg-${key}" readonly class="small" style="min-height:110px">${h(r.msg)}</textarea><div class="btns"><button class="btn sm" data-act="copy" data-from="offMsg-${key}">Copy reply</button></div>` : ""}</div>`;
}
function offerBox(id, key) {
  const st = key === "t" ? S.offerT : { item: id, amt: "", plat: "ebay" };
  const items = Object.entries(S.items).filter(([, it]) => STAGE_IDX[it.stage || "intake"] <= 3);
  const itemId = id || (S.items[st.item] ? st.item : (items[0] || [])[0]);
  return `<div data-offbox="${key}" ${id ? `data-item="${h(id)}"` : ""} style="display:flex;flex-direction:column;gap:10px">
    ${id ? "" : `<label class="f">Item<select data-offitem data-off="1">${items.length ? items.map(([k, it]) => `<option value="${h(k)}" ${k === itemId ? "selected" : ""}>${h((it.sku || k) + " · " + (it.name || ""))}</option>`).join("") : `<option value="">No unsold items yet</option>`}</select></label>`}
    <div class="grid2"><label class="f">Their offer $<input type="number" inputmode="decimal" step="0.01" data-offamt data-off="1" value="${h(st.amt)}"></label><label class="f">Platform<select data-offplat data-off="1">${Object.entries(PLAT).map(([k, n]) => `<option value="${k}" ${st.plat === k ? "selected" : ""}>${n}</option>`).join("")}</select></label></div>
    <div data-offout>${offerHTML(S.items[itemId], st.plat, num(st.amt), key)}</div></div>`;
}
function updateOffer(t) {
  const box = t.closest("[data-offbox]"); if (!box) return; const key = box.dataset.offbox;
  const sel = box.querySelector("[data-offitem]"); const id = box.dataset.item || (sel && sel.value);
  const amt = box.querySelector("[data-offamt]").value, plat = box.querySelector("[data-offplat]").value;
  if (key === "t") S.offerT = { item: id, amt, plat };
  box.querySelector("[data-offout]").innerHTML = offerHTML(S.items[id], plat, num(amt), key);
}
async function makeThumb(p) {
  try { const r = await fetch(await photoFetchUrl(p)); const bmp = await createImageBitmap(await r.blob()); const k = 160 / Math.max(bmp.width, bmp.height);
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k); c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height); return c.toDataURL("image/jpeg", 0.7); }
  catch { return null; }
}
// Frees storage: photos of sales completed more than N days ago are deleted, keeping a tiny thumbnail.
async function cleanupPhotos() {
  const days = num(S.settings.photoCleanupDays); if (!days || !ASSETS) return;
  const due = Object.entries(S.items).filter(([, it]) => it.stage === "complete" && (it.photos || []).length && (daysSince(it.completedAt || (it.sale && it.sale.date)) ?? 0) >= days);
  for (const [id, it] of due) {
    const th = await makeThumb(it.photos[0]);
    await saveItem(id, { photos: [], thumb: th, photosClearedAt: Date.now() });
    for (const p of it.photos) ASSETS.delete(p.id).catch(() => {});
  }
  if (due.length) toast("Cleared photos from " + due.length + " completed sale(s) to free up space");
}
function feeTable(rows) {
  const name = r => r.p === "fb" ? (r.local ? "FB local" : "FB shipped") : PLAT[r.p];
  return `<table class="money"><thead><tr><th></th>${rows.map(r => `<th>${name(r)}</th>`).join("")}</tr></thead><tbody>
    <tr><td>Buyer pays</td>${rows.map(r => `<td>${money(r.r.gross)}</td>`).join("")}</tr>
    <tr><td>Platform fees</td>${rows.map(r => `<td>−${money(r.r.fees).replace("−", "")}</td>`).join("")}</tr>
    <tr><td>Label</td>${rows.map(r => `<td>−${money(r.r.label)}</td>`).join("")}</tr>
    <tr><td>Packaging</td>${rows.map(r => `<td>−${money(r.r.pkg)}</td>`).join("")}</tr>
    <tr><td>Item cost</td>${rows.map(r => `<td>−${money(r.r.cost)}</td>`).join("")}</tr>
    <tr class="net"><td>You keep</td>${rows.map(r => `<td class="${r.r.net >= 0 ? "pos" : "neg"}">${money(r.r.net)}</td>`).join("")}</tr></tbody></table>`;
}

/* ---------- item detail ---------- */
function openDetail(id) { S.open = id; $("#sheet").hidden = false; document.body.style.overflow = "hidden"; renderDetail(true); }
function closeDetail() { S.open = null; $("#sheet").hidden = true; $("#sheet").innerHTML = ""; document.body.style.overflow = ""; detailSig = ""; renderSoon(); }
const fid = p => "f-" + p.replace(/\./g, "-");
function fld(it, p, label, opts = {}) {
  const v = getPath(it, p) ?? ""; const attrs = `id="${fid(p)}" data-f="${p}" ${opts.num ? 'data-num="1" type="number" inputmode="decimal" step="0.01"' : 'type="text"'} ${opts.ph ? `placeholder="${h(opts.ph)}"` : ""}`;
  if (opts.area) return `<label class="f">${label}<textarea id="${fid(p)}" data-f="${p}" ${opts.ph ? `placeholder="${h(opts.ph)}"` : ""}>${h(v)}</textarea></label>`;
  return `<label class="f">${label}<input ${attrs} value="${h(v)}"></label>`;
}
function copyField(it, p, label, opts = {}) {
  const v = getPath(it, p) ?? ""; const max = opts.max;
  return `<div class="copyfield"><div class="lbl"><label for="${fid(p)}">${label}</label>${max ? `<span class="count ${String(v).length > max ? "over" : ""}" data-count="${p}">${String(v).length}/${max}</span>` : ""}<button class="btn sm sp" data-act="copy" data-from="${fid(p)}">Copy</button></div>
    ${opts.area ? `<textarea id="${fid(p)}" data-f="${p}" ${max ? `data-max="${max}"` : ""} style="min-height:${opts.tall ? 160 : 84}px">${h(v)}</textarea>` : `<input type="text" id="${fid(p)}" data-f="${p}" ${max ? `data-max="${max}"` : ""} value="${h(v)}">`}</div>`;
}
function moneySection(it) {
  const rows = FEE_COLS.filter(([p]) => num((it.prices || {})[p]) != null).map(([p, local]) => ({ p, local, r: itemNet(it, p, local) }));
  return rows.length ? `<div class="scroll-x">${feeTable(rows)}</div>` : `<p class="small muted">Set a price below to see your payout on each platform.</p>`;
}
function shipSection(it) {
  const sp = shipPlan(it);
  return `<div class="stats"><div class="stat"><b>${money(sp.cost)}</b><span>${h(sp.service)}</span></div><div class="stat"><b>${sp.packedOz ?? "—"} oz</b><span>packed weight</span></div><div class="stat"><b>${h(PKG_NAME[sp.pkg])}</b><span>packaging</span></div></div>
    ${sp.notes.length ? `<ul class="small" style="margin:0;padding-left:18px">${sp.notes.map(n => `<li>${h(n)}</li>`).join("")}</ul>` : ""}
    ${it.ai && it.ai.shipping ? `<p class="small"><b>Claude:</b> ${h(it.ai.shipping.service)}, ${h(it.ai.shipping.packaging)}. ${h(it.ai.shipping.notes || "")}</p>` : ""}`;
}
function researchLinks(it) {
  const q = encodeURIComponent((it.listing && it.listing.compSearch) || it.name || "");
  return `<div class="btns"><a class="btn sm" target="_blank" rel="noopener" href="https://www.ebay.com/sch/i.html?_nkw=${q}&LH_Sold=1&LH_Complete=1">eBay sold</a><a class="btn sm" target="_blank" rel="noopener" href="https://www.depop.com/search/?q=${q}">Depop</a><a class="btn sm" target="_blank" rel="noopener" href="https://www.facebook.com/marketplace/search/?query=${q}">FB Marketplace</a></div>`;
}
function renderDetail() {
  const id = S.open; const it = S.items[id]; if (!it) return; detailSig = sig(it);
  const sheet = $("#sheet"); const body = $(".sheet-body", sheet); const y = body ? body.scrollTop : 0;
  const L = it.listing || {}; const A = it.ai || {}; const pl = it.plat || {};
  const photos = it.photos || [];
  sheet.className = "sheet";
  sheet.innerHTML = `<div class="sheet-top"><div class="wrap"><button class="btn sm" data-act="close" title="Back (Esc)">‹ Back</button><span class="sku">${h(it.sku || id)}</span>${boxTag(it.box)}
    <select style="margin-left:auto;width:auto" data-f="stage" aria-label="Stage">${STAGES.map(([k, n]) => `<option value="${k}" ${(it.stage || "intake") === k ? "selected" : ""}>${n}</option>`).join("")}</select></div></div>
  <div class="sheet-body"><div class="wrap">
    <input type="text" data-f="name" id="f-name" value="${h(it.name || "")}" placeholder="Item name" aria-label="Item name" style="font:600 24px var(--f-display);background:transparent;border-color:transparent;padding-left:0">

    <section class="card"><div class="card-h"><h2>Photos</h2><span class="sp muted small">${photos.length} / 24</span></div>
      ${photos.length ? `<div class="photos">${photos.map((p, i) => `<button class="ph" data-act="edit" data-i="${i}" aria-label="Edit photo ${i + 1}"><img src="${h(photoSrc(p))}" alt="" loading="lazy">${i === 0 ? '<span class="tag">Cover</span>' : ""}</button>`).join("")}</div>` : `<p class="small muted" style="margin:0">Front, back, labels, flaws, scale.</p>`}
      <div class="btns"><button class="btn primary" data-act="cam">Take photo</button><button class="btn" data-act="lib">Library</button>${it.driveUrl ? `<a class="btn sm" href="${h(it.driveUrl)}" target="_blank" rel="noopener">Google Drive folder ↗</a>` : ""}</div>
      ${!ASSETS ? `<p class="small muted" style="margin:0">${LOCAL ? "Preview: photos aren't saved." : "Sign in to upload photos."}</p>` : ""}
    </section>

    ${fold("dDetails", "Details", `
      <div class="grid2"><label class="f">Box<select data-f="box">${Object.entries(BOXES).map(([k, n]) => `<option value="${k}" ${it.box === k ? "selected" : ""}>${n}</option>`).join("")}</select></label>
      <label class="f">Condition<select data-f="condition"><option value="">Choose…</option>${CONDITIONS.map(c => `<option ${it.condition === c ? "selected" : ""}>${h(c)}</option>`).join("")}</select></label>
      ${fld(it, "brand", "Brand")}${fld(it, "category", "Type / category", { ph: "e.g. video game console" })}
      <label class="f">Came from<select data-f="bin">${optsHTML(knownBins(), it.bin, { none: "Not set", add: "New bin…" })}</select></label>${fld(it, "shot", "Camera photo #", { num: 1 })}
      ${fld(it, "model", "Model #")}${fld(it, "color", "Color")}${fld(it, "material", "Material")}${fld(it, "official", "Official title")}</div>
      ${lookupInfoHTML(it)}
      ${fld(it, "condNotes", "Flaws & condition notes", { area: true, ph: "Scratches, missing parts, tested and working?" })}
      ${fld(it, "included", "What's included", { ph: "Charger, box, manual…" })}
      <div class="grid4">${fld(it.costPre == null && it.cost != null ? { ...it, costPre: it.cost } : it, "costPre", "You paid (before tax) $", { num: 1, ph: "+" + (num(S.settings.buyTaxPct) ?? 6) + "% tax auto" })}${fld(it, "weightOz", "Weight (oz)", { num: 1 })}${fld(it, "dims.l", "L (in)", { num: 1 })}${fld(it, "dims.w", "W (in)", { num: 1 })}</div>
      <div class="grid4">${fld(it, "dims.h", "H (in)", { num: 1 })}</div>
      <div class="btns"><label class="check"><input type="checkbox" data-f="flat" ${it.flat ? "checked" : ""}> Flat card / coin</label><label class="check"><input type="checkbox" data-f="media" ${it.media ? "checked" : ""}> Book / CD / DVD</label></div>`, { open: true })}

    ${fold("dResearch", "Research", `
      <div class="btns"><button class="btn primary" data-act="pcItem">${it.priceCheck ? "Price check again" : "Price check"}</button></div>
      ${it.priceCheck ? pcResultHTML(it.priceCheck, "item") : ""}
      ${researchLinks(it)}
      ${fld(it, "comps", "Sold comps you found", { area: true, ph: "eBay sold: $42, $38, $45 (used, no box)\nDepop: $40 listed" })}
      ${fld(it, "engagement", "Views / watchers / likes", { ph: "eBay 120 views, 4 watchers; Depop 9 likes" })}`, { badge: it.priceCheck ? `<span class="pill on">Checked</span>` : "" })}

    ${fold("dWrite", "Write my listing", `
      <div class="btns"><button class="btn primary" data-act="gen">${A.generatedAt ? "Rewrite listing" : "Write my listing"}</button></div>
      <div id="genStatus"></div>
      ${A.identified ? `<p class="small"><b>Claude sees:</b> ${h(A.identified)}</p>` : ""}
      ${A.platformFit ? `<div class="eyebrow">Where to list</div><div class="fit">${Object.keys(PLAT).map(p => { const x = A.platformFit[p] || {}; return `<div class="fitc ${h(x.fit)}"><div class="card-h"><b>${PLAT[p]}</b><span class="sp pill ${x.fit === "best" ? "on" : ""}">${h(x.fit || "?")}</span></div><span class="small">${h(x.why || "")}</span></div>`; }).join("")}</div>` : ""}
      ${A.verify && A.verify.length ? `<div class="banner"><b>Check before posting:</b> ${A.verify.map(h).join(" · ")}</div>` : ""}
      ${A.pricing ? `<p class="small"><b>Pricing (${h(A.pricing.confidence || "?")} confidence):</b> ${h(A.pricing.rationale || "")}${A.pricing.quickSale ? ` Quick-sale price: <span class="mono">${money(num(A.pricing.quickSale))}</span>.` : ""}</p>` : ""}
      ${A.photoTips && A.photoTips.length ? `<details class="tips"><summary>Photo tips for this item</summary><ul>${A.photoTips.map(t => `<li>${h(t)}</li>`).join("")}</ul></details>` : ""}`, { open: true, badge: A.generatedAt ? `<span class="muted small">${new Date(A.generatedAt).toLocaleDateString()}</span>` : "" })}

    ${fold("dPrices", "Prices", `
      <div class="pricegrid">${[["prices.ebay", "eBay"], ["prices.depop", "Depop"], ["prices.fb", "FB"], ["floor", "Floor"]].map(([p, n]) => `<div class="pricebox"><div class="card-h"><label class="eyebrow" for="${fid(p)}">${n}</label><button class="btn sm ghost sp" data-act="copy" data-from="${fid(p)}" style="min-height:24px;padding:2px 6px">Copy</button></div><input type="number" inputmode="decimal" step="0.01" id="${fid(p)}" data-f="${p}" data-num="1" value="${h(getPath(it, p) ?? "")}"></div>`).join("")}</div>
      ${L.offerAccept || L.offerDecline ? `<p class="small muted">eBay Best Offer: auto-accept at <span class="mono">${money(num(L.offerAccept))}</span>, auto-decline below <span class="mono">${money(num(L.offerDecline))}</span>.</p>` : ""}
      <div class="eyebrow">What you actually keep</div><div id="moneySec">${moneySection(it)}</div>
      <div class="grid3">${fld(it, "shipCharge", "Buyer pays shipping $", { num: 1, ph: "= label" })}${fld(it, "labelCost", "Actual label $", { num: 1, ph: "estimate" })}<label class="check" style="align-self:end;padding-bottom:10px"><input type="checkbox" data-f="freeShip" ${it.freeShip ? "checked" : ""}> Free shipping</label></div>`, { open: true })}

    ${STAGE_IDX[it.stage || "intake"] <= 3 ? fold("dOffer", "Offer helper", offerBox(id, "d")) : ""}

    ${fold("dCopy", "Listing copy", `
      <div class="plat-h"><b>eBay</b></div>
      ${copyField(it, "listing.ebayTitle", "Title", { max: 80 })}
      ${copyField(it, "listing.ebayDesc", "Description", { area: true, tall: 1 })}
      ${L.ebaySpecifics && L.ebaySpecifics.length ? `<div class="copyfield"><div class="lbl">Item specifics${L.category ? " · " + h(L.category) : ""}<button class="btn sm sp" data-act="copy" data-from="specs">Copy all</button></div><textarea id="specs" readonly class="small">${h(L.ebaySpecifics.map(([k, v]) => k + ": " + v).join("\n"))}</textarea></div>` : ""}
      <hr><div class="plat-h"><b>Depop</b></div>
      ${copyField(it, "listing.depopDesc", "Description (first line acts as the title)", { area: true, tall: 1 })}
      ${copyField(it, "listing.depopKeywords", "Keywords")}
      <hr><div class="plat-h"><b>FB Marketplace</b></div>
      ${copyField(it, "listing.fbTitle", "Title", { max: 100 })}
      ${copyField(it, "listing.fbDesc", "Description", { area: true })}`)}

    ${fold("dShip", "Shipping", `<div id="shipSec">${shipSection(it)}</div>
      <label class="f">Packaging<select data-f="pkg"><option value="">Automatic</option>${Object.entries(PKG_NAME).map(([k, n]) => `<option value="${k}" ${it.pkg === k ? "selected" : ""}>${n}</option>`).join("")}</select></label>`)}

    ${fold("dWhere", "Where it's listed", `
      ${Object.keys(PLAT).map(p => { const x = pl[p] || {}; return `<div class="grid2" style="align-items:end"><label class="f">${PLAT[p]}<select data-f="plat.${p}.status"><option value="none" ${!x.status || x.status === "none" ? "selected" : ""}>Not listed</option><option value="planned" ${x.status === "planned" ? "selected" : ""}>Planned</option><option value="listed" ${x.status === "listed" ? "selected" : ""}>Listed${x.listedAt ? " · " + daysSince(x.listedAt) + "d" : ""}</option><option value="ended" ${x.status === "ended" ? "selected" : ""}>Ended</option></select></label>
        <div class="btns" style="flex-wrap:nowrap"><input type="url" data-f="plat.${p}.url" id="${fid("plat." + p + ".url")}" placeholder="Listing link" value="${h(x.url || "")}">${x.url ? `<a class="btn sm" href="${h(x.url)}" target="_blank" rel="noopener">Open</a>` : ""}</div></div>`; }).join("")}`, { badge: (n => n ? `<span class="pill on">${n} live</span>` : "")(Object.keys(PLAT).filter(p => (pl[p] || {}).status === "listed").length) })}

    <section class="card"><h2>Sale</h2>
      ${it.sale && it.stage === "sold" ? `<div class="pick"><span>Grab</span><span class="big">${h(it.sku || id)}</span><span>from the</span>${boxTag(it.box)}<span>box</span></div>` : ""}
      ${it.sale ? `<p class="small">Sold on <b>${h(PLAT[it.sale.platform])}</b> for <span class="mono">${money(num(it.sale.price))}</span> on ${new Date(it.sale.date).toLocaleDateString()}. Net <b class="mono ${it.sale.net >= 0 ? "pos" : "neg"}">${money(it.sale.net)}</b>.${it.sale.shippedAt ? " Shipped " + new Date(it.sale.shippedAt).toLocaleDateString() + "." : ""}</p>
        ${fld(it, "sale.tracking", "Tracking number")}
        <div class="btns">${it.stage === "sold" ? `<button class="btn primary" data-act="shipped">Mark shipped</button>` : ""}${it.stage === "shipped" ? `<button class="btn primary" data-act="complete">Mark complete</button>` : ""}<button class="btn ghost" data-act="unsell">Undo sale</button></div>
        ${Object.keys(PLAT).filter(p => p !== it.sale.platform && (pl[p] || {}).status === "listed").length ? `<div class="banner">Still listed on ${Object.keys(PLAT).filter(p => p !== it.sale.platform && (pl[p] || {}).status === "listed").map(p => PLAT[p]).join(", ")}. Remove those listings now so you don't double-sell.</div>` : ""}`
      : `<div class="grid3"><label class="f">Sold on<select id="sPlat">${Object.entries(PLAT).map(([k, n]) => `<option value="${k}">${n}</option>`).join("")}<option value="fblocal">FB local pickup</option></select></label><label class="f">Sale price $<input type="number" inputmode="decimal" step="0.01" id="sPrice"></label><label class="f">Buyer paid ship $<input type="number" inputmode="decimal" step="0.01" id="sShip"></label></div>
        <button class="btn primary" data-act="sold">Mark sold</button>`}
    </section>

    <section class="card flat"><div class="btns"><button class="btn danger" data-act="del">Delete item</button><span id="delConfirm"></span></div></section>
  </div></div>`;
  $(".sheet-body", sheet).scrollTop = y;
}
function refreshComputed() {
  const it = S.items[S.open]; if (!it) return;
  const m = $("#moneySec"); if (m) m.innerHTML = moneySection(it);
  const s = $("#shipSec"); if (s) s.innerHTML = shipSection(it);
}

/* ---------- actions ---------- */
async function generateListing() {
  const id = S.open; const it = S.items[id]; const st = $("#genStatus"); const btn = $('[data-act="gen"]');
  const nPhotos = Math.min((it.photos || []).length, 6);
  btn.disabled = true; st.innerHTML = `<div class="thinking"><span class="spin"></span>Waiting for Claude's reply…</div>`;
  try {
    const r = await ai({ prompt: listingPrompt(it, id, nPhotos), json: true, attach: nPhotos });
    if (!r || typeof r !== "object") throw { code: "invalid_json" };
    const prev = { listing: it.listing || {}, prices: it.prices || {}, floor: it.floor ?? null, ai: it.ai || {} };
    const e = r.ebay || {}, d = r.depop || {}, f = r.fb || {}, pr = r.pricing || {};
    const patch = {
      listing: { ebayTitle: String(e.title || "").slice(0, 120), ebayDesc: e.description || "", ebaySpecifics: Array.isArray(e.itemSpecifics) ? e.itemSpecifics.filter(x => Array.isArray(x) && x.length >= 2).map(x => [String(x[0]), String(x[1])]) : Object.entries(e.itemSpecifics || {}).map(([k, v]) => [k, String(v)]),
        category: e.categoryHint || "", offerAccept: num(e.bestOfferAccept), offerDecline: num(e.bestOfferDecline),
        depopDesc: d.description || "", depopKeywords: Array.isArray(d.keywords) ? d.keywords.join(", ") : (d.keywords || ""),
        fbTitle: f.title || "", fbDesc: f.description || "", compSearch: pr.compSearch || "" },
      prices: { ebay: num(e.price), depop: num(d.price), fb: num(f.price) }, floor: num(pr.floor),
      ai: { identified: r.identified || "", verify: Array.isArray(r.verify) ? r.verify.map(String) : [], platformFit: r.platformFit || {}, pricing: pr, shipping: r.shipping || null, photoTips: Array.isArray(r.photoTips) ? r.photoTips.map(String) : [], generatedAt: Date.now() }
    };
    if (STAGE_IDX[it.stage || "intake"] < 2) patch.stage = "drafted";
    const fit = r.platformFit || {}; const plat = {};
    for (const p of Object.keys(PLAT)) if (!(it.plat && it.plat[p] && it.plat[p].status && it.plat[p].status !== "none") && fit[p] && fit[p].fit !== "skip") plat[p] = { status: "planned" };
    if (Object.keys(plat).length) patch.plat = plat;
    await saveItem(id, patch);
    toast("Listing written", { label: "Undo", fn: () => saveItem(id, prev) });
    if (st) st.innerHTML = "";
  } catch (e) { if (st) st.innerHTML = e && e.code === "cancelled" ? "" : `<p class="small neg">${h(aiMsg(e))}</p>`; if (btn) btn.disabled = false; }
}
function inventoryForAI(limit = 120) {
  return Object.entries(S.items).slice(0, limit).map(([id, it]) => {
    const x = itemForAI(it, id); delete x.flawsAndConditionNotes; delete x.included; delete x.dimsIn; x.photos = (it.photos || []).length; x.hasDescription = !!(it.listing && it.listing.ebayDesc);
    if (it.sale) x.sale = { platform: it.sale.platform, price: it.sale.price, net: it.sale.net, daysAgo: daysSince(it.sale.date) };
    return x;
  });
}
async function runAI(btn, outSel, prompt) {
  const out = $(outSel); btn.disabled = true;
  out.innerHTML = `<div class="thinking"><span class="spin"></span>Waiting for Claude's reply…</div>`;
  try { const t = await ai({ prompt }); const o = $(outSel); if (o) o.innerHTML = md(t); return t; }
  catch (e) { const o = $(outSel); if (o) o.innerHTML = e && e.code === "cancelled" ? "" : `<p class="small neg">${h(aiMsg(e))}</p>`; return null; }
  finally { btn.disabled = false; }
}
async function runAudit(btn) {
  const findings = ruleFindings().slice(0, 40).map(f => "[" + f.sev + "] " + f.text);
  const prompt = `You are a professional e-commerce consultant doing a daily audit of a reseller's listings on eBay, Depop and Facebook Marketplace.

${profileText()}

AUTOMATED CHECKS FOUND:
${findings.join("\n") || "(none)"}

INVENTORY (JSON, one object per SKU):
${JSON.stringify(inventoryForAI())}

Write today's audit in plain Markdown, using "## " headings and "- " bullets, no tables, under 450 words:
## Today's top 5 moves
(the most valuable specific actions, naming SKUs)
## Pricing moves
(which SKUs to raise, lower or send offers on, with suggested prices)
## Crosslisting
(items that should go on another platform and why)
## Visibility tip of the day
(one concrete tactic for whichever platform needs it most)
## Watch out
(risks: unshipped orders, thin margins, double-sell risk)
Be direct and professional. If the inventory is small or missing data, say what data would help.`;
  const t = await runAI(btn, "#auditOut", prompt);
  if (t) await saveAudit(today(), { date: today(), text: t, createdAt: Date.now() });
}
async function markSold() {
  const id = S.open; const it = S.items[id]; let p = $("#sPlat").value; const local = p === "fblocal"; if (local) p = "fb";
  const price = num($("#sPrice").value); if (price == null) { toast("Enter the sale price."); return; }
  const shipIn = num($("#sShip").value);
  const sp = shipPlan(it); const label = local ? 0 : (num(it.labelCost) ?? sp.cost ?? 0);
  const r = netFor(p, { price, ship: local ? 0 : (shipIn ?? (it.freeShip ? 0 : label)), label, pkg: local ? 0 : pkgCost(sp.pkg), cost: num(it.cost) || 0, local });
  const r2 = x => Math.round(x * 100) / 100;
  await saveItem(id, { stage: local ? "complete" : "sold", completedAt: local ? Date.now() : null, sale: { platform: p, local, price, ship: r.ship, gross: r2(r.gross), fees: r2(r.fees), label: r2(r.label), pkg: r2(r.pkg), cost: r2(r.cost), net: r2(r.net), date: Date.now() }, plat: { [p]: { status: "ended" } } });
  toast("Marked sold. Net " + money(r.net));
}

document.addEventListener("click", async e => {
  const t = e.target.closest("[data-act]"); if (!t) return;
  const a = t.dataset.act, v = t.dataset.v;
  switch (a) {
    case "tab": { const i = TAB_ORDER.indexOf(S.tab), j = TAB_ORDER.indexOf(v); goTab(v, i >= 0 && j >= 0 && i !== j ? Math.sign(j - i) : 0); break; }
    case "open": openDetail(t.dataset.id); break;
    case "close": closeDetail(); break;
    case "stagejump": S.filter.stage = v; S.filter.box = "all"; S.filter.bin = "all"; S.filter.q = ""; goTab("items", S.tab === "items" ? 0 : 1); break;
    case "copy": { const el = document.getElementById(t.dataset.from); const txt = el ? (el.value ?? el.textContent) : ""; if (!String(txt).trim()) { toast("Nothing to copy yet."); break; } copyText(String(txt), t); break; }
    case "addOne": {
      const sku = $("#aSku").value.trim(); if (!sku) { toast("Enter the SKU."); break; }
      const id = skuId(sku); if (S.items[id]) { toast("That SKU already exists."); openDetail(id); break; }
      await saveItem(id, { sku, name: $("#aName").value.trim(), box: $("#aBox").value, stage: "intake", createdAt: Date.now() }, { create: true }); useSku(sku);
      if (v === "stay") { $("#aSku").value = nextSku(); $("#aName").value = ""; $("#aSku").focus(); toast("Added " + sku); } else openDetail(id);
      break; }
    case "addBulk": {
      const lines = $("#aBulk").value.split(/\n/).map(l => l.trim()).filter(Boolean); let n = 0, skip = 0;
      for (const l of lines) { const parts = l.split(/\t|,/).map(x => x.trim()); const sku = parts[0]; if (!sku || /^sku$/i.test(sku)) continue;
        const id = skuId(sku); if (S.items[id]) { skip++; continue; }
        let box = parseBox(parts[parts.length - 1]); let name = parts.slice(1, box && parts.length > 2 ? -1 : undefined).join(", ");
        await saveItem(id, { sku, name, box: box || "hobby", stage: "intake", createdAt: Date.now() }, { create: true }); useSku(sku); n++; }
      toast("Imported " + n + " item(s)" + (skip ? ", skipped " + skip + " existing" : "")); $("#aBulk").value = ""; break; }
    case "cam": $("#camIn").click(); break;
    case "lib": $("#libIn").click(); break;
    case "edit": openEditor(S.open, +t.dataset.i); break;
    case "gen": generateListing(); break;
    case "audit": runAudit(t); break;
    case "sold": markSold(); break;
    case "shipped": saveItem(S.open, { stage: "shipped", sale: { shippedAt: Date.now() } }); break;
    case "complete": saveItem(S.open, { stage: "complete", completedAt: Date.now() }); break;
    case "unsell": { const sp = (S.items[S.open].sale || {}).platform; saveItem(S.open, { stage: "listed", sale: null, ...(sp ? { plat: { [sp]: { status: "listed" } } } : {}) }); break; }
    case "del": $("#delConfirm").innerHTML = `<span class="small">Delete this item and its data?</span> <button class="btn sm danger" data-act="delYes">Yes, delete</button>`; break;
    case "delYes": { const id = S.open; const photos = S.items[id].photos || []; closeDetail(); await deleteItem(id); if (ASSETS) for (const p of photos) ASSETS.delete(p.id).catch(() => {}); toast("Item deleted"); break; }
    case "bundleAI": {
      const sel = Object.keys(S.bundle.sel).filter(k => S.bundle.sel[k] && S.items[k]);
      runAI(t, "#bundleOut", `You are a reseller pricing expert.\n\n${profileText()}\n\nA buyer wants these items together on ${PLAT[S.bundle.plat]}:\n${JSON.stringify(sel.map(k => itemForAI(S.items[k], k)))}\n\nThe seller is considering ${S.bundle.pct}% off. In plain Markdown ("- " bullets, under 200 words): is that discount smart, what bundle price to counter with, how to ship them together (one box? padding?), and how to word the offer message.`); break; }
    case "boostAI": runAI(t, "#boostOut", `You are a marketplace growth strategist for small resellers.\n\n${profileText()}\n\nINVENTORY:\n${JSON.stringify(inventoryForAI(80))}\n\nWrite a practical 2-week plan in plain Markdown ("## " headings, "- " bullets, under 450 words) to raise views, watchers/likes and sales on eBay, Depop and FB Marketplace for this specific inventory. Include a daily routine (minutes per day), which SKUs to feature or bundle, posting times, and one thing to stop doing. Only recommend features those platforms actually have; if unsure a feature exists, say "check if available".`); break;
    case "askq": $("#askIn").value = v; askClaude(); break;
    case "ask": askClaude(); break;
    case "chatClear": S.chat = []; render(); break;
    case "export": exportData(); break;
    case "signout": AUTH.signOut(); break;
    case "import": $("#importIn").click(); break;
    case "mclose": $("#modal").hidden = true; $("#modal").innerHTML = ""; break;
    case "addExp": {
      const date = $("#exDate").value || today(); const note = $("#exNote").value.trim(); const id = "e" + Date.now() + Math.random().toString(36).slice(2, 5);
      if (S.exp.type === "mileage") { const miles = num($("#exMiles").value); if (!miles) { toast("Enter the miles driven."); break; } await saveExpense(id, { type: "mileage", date, miles, rate: mileRate(date), note, createdAt: Date.now() }); toast("Trip added: " + money(miles * mileRate(date)) + " deduction"); }
      else { const amount = num($("#exAmt").value); if (!amount) { toast("Enter the amount."); break; } await saveExpense(id, { type: "expense", date, amount, category: $("#exCat").value, note, createdAt: Date.now() }); toast("Expense added"); }
      break; }
    case "delExp": S.delExp = t.dataset.id; render(); break;
    case "delExpYes": S.delExp = null; deleteExpense(t.dataset.id); break;
    case "csvSales": exportCSV("sales"); break;
    case "csvExp": exportCSV("expenses"); break;
    case "tplEdit": S.tplEdit = !S.tplEdit; render(); break;
    case "tplAdd": saveSettings({ templates: [...templates().map(x => ({ ...x })), { id: "t" + Date.now(), name: "New message", plat: "ebay depop fb", text: "Hi! " }] }); break;
    case "tplDel": { const prev = templates().map(x => ({ ...x })); const arr = prev.filter((_, i) => i !== +t.dataset.i); saveSettings({ templates: arr }); toast("Message deleted", { label: "Undo", fn: () => saveSettings({ templates: prev }) }); break; }
    case "edApply": edApplyAll(t); break;
    case "edClose": closeEditor(); break;
    case "edRot": ED.adj.rot = (ED.adj.rot + 1) % 4; edDraw(); break;
    case "edCrop": ED.adj.crop = v; $$(".edcrop").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === v)); edDraw(); break;
    case "edAuto": edAuto(); break;
    case "edReset": ED.adj = edDefaults(); edSyncSliders(); edDraw(); break;
    case "edSave": edSave(t); break;
    case "edDownload": edDownload(t); break;
    case "edCover": edCover(); break;
    case "edDelete": $("#edDel").innerHTML = `<button class="btn sm danger" data-act="edDeleteYes">Yes, delete photo</button>`; break;
    case "edDeleteYes": edDelete(); break;
  }
});
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
async function askClaude() {
  const box = $("#askIn"); const q = box.value.trim(); if (!q) return; box.value = ""; box.blur();
  S.chat.push({ role: "user", content: q }); render();
  const ctx = `You are a friendly, expert e-commerce advisor for a reseller. Be concise and specific. Use plain Markdown ("- " bullets, "## " headings, no tables).\n\n${profileText()}\n\nINVENTORY SUMMARY:\n${JSON.stringify(inventoryForAI(60)).slice(0, 60000)}`;
  const history = S.chat.slice(-9, -1).map(m => (m.role === "user" ? "ME: " : "YOU: ") + m.content).join("\n\n");
  let cancelled = false;
  try { S.chat.push({ role: "assistant", content: await ai({ prompt: ctx + (history ? "\n\nEARLIER IN THIS CHAT:\n" + history : "") + "\n\nQUESTION: " + q }) }); }
  catch (e) { if (e && e.code === "cancelled") { S.chat.pop(); cancelled = true; } else S.chat.push({ role: "assistant", content: aiMsg(e) }); }
  render(); if (cancelled && $("#askIn")) $("#askIn").value = q;
}
function exportData() {
  const data = JSON.stringify({ exportedAt: new Date().toISOString(), settings: S.settings, items: S.items, audits: S.audits, expenses: S.expenses, things: S.things, donations: S.donations }, null, 2);
  // One fixed name so each new backup replaces the last one.
  downloadBlob("mackrobytes-backup.json", new Blob([data], { type: "application/json" })); toast("Backup saved");
}
document.addEventListener("change", async e => {
  const t = e.target;
  if (t.id === "camIn" || t.id === "libIn") { const files = [...t.files]; t.value = ""; if (S.open) addPhotos(S.open, files); return; }
  if (t.id === "importIn") {
    const f = t.files[0]; t.value = ""; if (!f) return;
    try { const d = JSON.parse(await f.text()); let n = 0; if (d.settings) await saveSettings(d.settings);
      for (const [id, it] of Object.entries(d.items || {})) { if (!S.items[id]) { await saveItem(id, it, { create: true }); n++; } }
      for (const c of ["audits", "expenses", "things", "donations"]) for (const [id, x] of Object.entries(d[c] || {})) if (!S[c][id]) { S[c][id] = x; await putDoc(c, id, x, true); }
      toast("Restored " + n + " item(s). Existing SKUs were left alone."); } catch { toast("That file isn't a MackroBytes backup."); }
    return; }
  if (t.id === "msgItem") { S.msgItem = t.value; render(); return; }
  if (t.dataset.tpl != null) { const arr = templates().map(x => ({ ...x })); const tp = arr[+t.dataset.tpl]; const k = t.dataset.k;
    if (k === "plat") { const set = new Set((tp.plat || "").split(" ").filter(Boolean)); t.checked ? set.add(t.dataset.v) : set.delete(t.dataset.v); tp.plat = [...set].join(" "); } else tp[k] = t.value;
    saveSettings({ templates: arr }); return; }
  if (t.dataset.off) return;
  if (t.dataset.set) { const k = t.dataset.set; saveSettings({ [k]: t.type === "number" ? num(t.value) : t.value }); return; }
  if (t.dataset.bundle) { S.bundle[t.dataset.bundle] = t.value; render(); return; }
  if (t.dataset.bsel) { S.bundle.sel[t.dataset.bsel] = t.checked; render(); return; }
  if (t.dataset.ship) { S.shipCalc[t.dataset.ship] = t.type === "checkbox" ? t.checked : t.type === "number" ? num(t.value) : t.value; render(); return; }
  if (t.dataset.filt) { S.filter[t.dataset.filt] = t.value; const l = $("#itemList"); if (l) l.innerHTML = itemListHTML(); return; }
  if (t.dataset.f && S.open) {
    const p = t.dataset.f; const it = S.items[S.open];
    let v = t.type === "checkbox" ? t.checked : t.dataset.num ? num(t.value) : t.value;
    let patch = pathPatch(p, v);
    if (p === "costPre") patch.cost = v == null ? null : Math.round(v * (1 + (num(S.settings.buyTaxPct) ?? 6) / 100) * 100) / 100;
    if (p === "stage" && v === "complete") patch.completedAt = Date.now();
    if (/^plat\.\w+\.status$/.test(p)) { const pf = p.split(".")[1];
      if (v === "listed") { patch.plat[pf].listedAt = (it.plat && it.plat[pf] && it.plat[pf].listedAt) || Date.now(); if (STAGE_IDX[it.stage || "intake"] < 3) patch.stage = "listed"; } }
    const structural = p === "stage" || p === "box" || /status$/.test(p);
    await saveItem(S.open, patch, { quiet: !structural });
    if (structural) { detailSig = ""; t.blur(); renderSoon(); } else refreshComputed();
  }
});
document.addEventListener("input", e => {
  const t = e.target;
  if (t.dataset.off) { updateOffer(t); return; }
  if (t.dataset.fee) { S.feeCalc[t.dataset.fee] = t.value; $("#feeTable").innerHTML = feeTable(feeCalcRows(S.feeCalc)); }
  if (t.dataset.actInput === "search") { S.filter.q = t.value; const l = $("#itemList"); if (l) l.innerHTML = itemListHTML(); }
  if (t.dataset.max) { const c = document.querySelector(`[data-count="${t.dataset.f}"]`); if (c) { c.textContent = t.value.length + "/" + t.dataset.max; c.classList.toggle("over", t.value.length > +t.dataset.max); } }
  if (t.classList.contains("edsl")) { ED.adj[t.dataset.k] = +t.value; t.nextElementSibling.textContent = t.value; edDrawSoon(); }
});
document.addEventListener("focusout", () => setTimeout(() => { if (!editingIn($("#main")) && !editingIn($("#sheet"))) renderSoon(); }, 300));
document.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.id === "askIn" && !e.shiftKey) { e.preventDefault(); askClaude(); } });

/* ---------- photo editor ---------- */
// Global, truthful adjustments only: no generative fill, no object removal.
// Saving replaces the stored photo with the edit; the untouched original stays on the phone.
const edDefaults = () => ({ exposure: 0, contrast: 0, highlights: 0, shadows: 0, warmth: 0, tint: 0, saturation: 0, sharpen: 0, straighten: 0, rot: 0, crop: "orig" });
const ED = { id: null, i: 0, bmp: null, adj: edDefaults(), queued: false, holding: false };
const SLIDERS = [["exposure", "Brightness", -100, 100], ["contrast", "Contrast", -100, 100], ["highlights", "Highlights", -100, 100], ["shadows", "Shadows", -100, 100], ["warmth", "Warmth", -100, 100], ["tint", "Tint", -100, 100], ["saturation", "Saturation", -100, 100], ["sharpen", "Sharpen", 0, 100], ["straighten", "Straighten", -10, 10]];
async function loadBmp(p) {
  try { const r = await fetch(await photoFetchUrl(p)); return await createImageBitmap(await r.blob()); }
  catch { return await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = photoSrc(p); }); }
}
const toJpeg = c => new Promise(r => c.toBlob(r, "image/jpeg", 0.9));
async function openEditor(id, i) {
  const photos = S.items[id].photos; const p = photos[i]; ED.id = id; ED.i = i; ED.adj = edDefaults();
  const el = $("#editor"); el.hidden = false; el.className = "sheet"; el.style.zIndex = 30;
  el.innerHTML = `<div class="sheet-top"><div class="wrap"><button class="btn sm" data-act="edClose">Cancel</button><h2 style="font-size:18px">Photo ${i + 1}</h2><button class="btn sm primary" style="margin-left:auto" data-act="edSave">Save</button></div></div>
  <div class="sheet-body"><div class="ed-stage"><canvas id="edCv" aria-label="Photo preview. Press and hold to see it before your changes."></canvas></div>
  <div class="wrap"><p class="small muted" style="margin:0">Press and hold the photo to compare.</p>
  <div class="btns"><button class="btn sm" data-act="edAuto">Auto fix</button><button class="btn sm" data-act="edRot">Rotate</button>${["orig", "1:1", "4:5"].map(c => `<button class="chip edcrop" data-act="edCrop" data-v="${c}" aria-pressed="${c === "orig"}">${c === "orig" ? "Original" : c}</button>`).join("")}<button class="btn sm ghost" data-act="edReset">Reset</button></div>
  <section class="card flat">${SLIDERS.map(([k, n, mn, mx]) => `<label class="slider"><span>${n}</span><input type="range" class="edsl" data-k="${k}" min="${mn}" max="${mx}" step="1" value="0" id="sl-${k}"><output>0</output></label>`).join("")}</section>
  ${photos.length > 1 ? `<button class="btn primary" data-act="edApply">Apply to all ${photos.length} photos</button><p class="small muted" style="margin:0">Uses the same light, color, sharpening and crop on every photo of this item. Rotation and straightening stay per photo.</p>` : ""}
  <div class="btns"><button class="btn" data-act="edDownload">Save to Photos</button>${i > 0 ? `<button class="btn" data-act="edCover">Make cover</button>` : ""}<button class="btn danger" data-act="edDelete">Delete</button><span id="edDel"></span></div>
  <p class="small muted">Only lighting, color, straightening and cropping. Nothing is added or removed, so photos stay true to the item. Saving replaces the stored copy to save space; your original stays in your iPhone's Photos.</p></div></div>`;
  try { ED.bmp = await loadBmp(p); } catch { toast("Couldn't open that photo."); closeEditor(); return; }
  const cv = $("#edCv");
  const hold = on => { ED.holding = on; edDraw(); };
  cv.addEventListener("pointerdown", () => hold(true)); ["pointerup", "pointerleave", "pointercancel"].forEach(ev => cv.addEventListener(ev, () => ED.holding && hold(false)));
  edSyncSliders(); edDraw();
}
function closeEditor() { $("#editor").hidden = true; $("#editor").innerHTML = ""; ED.bmp = null; }
function edSyncSliders() { SLIDERS.forEach(([k]) => { const sl = $("#sl-" + k); if (sl) { sl.value = ED.adj[k]; sl.nextElementSibling.textContent = Math.round(ED.adj[k]); } }); $$(".edcrop").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === ED.adj.crop)); }
function edDrawSoon() { if (ED.queued) return; ED.queued = true; requestAnimationFrame(() => { ED.queued = false; edDraw(); }); }
function edRender(maxSide, adj, raw, b = ED.bmp) {
  const iw = b.width, ih = b.height; const rot = adj.rot % 4;
  const fw = rot % 2 ? ih : iw, fh = rot % 2 ? iw : ih;
  const ar = adj.crop === "1:1" ? 1 : adj.crop === "4:5" ? 0.8 : fw / fh;
  let cw = fw, ch = fh; if (fw / fh > ar) cw = fh * ar; else ch = fw / ar;
  const k = Math.min(1, maxSide / Math.max(cw, ch));
  const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(cw * k)); c.height = Math.max(1, Math.round(ch * k));
  const ctx = c.getContext("2d", { willReadFrequently: true });
  const th = (adj.straighten || 0) * Math.PI / 180; const sn = Math.abs(Math.sin(th)), cs = Math.cos(th);
  const sc = Math.max(cs + (ch / cw) * sn, cs + (cw / ch) * sn);
  ctx.imageSmoothingQuality = "high";
  ctx.translate(c.width / 2, c.height / 2); ctx.rotate(rot * Math.PI / 2 + th); ctx.scale(k * sc, k * sc);
  ctx.drawImage(b, -iw / 2, -ih / 2);
  if (!raw) edPixels(ctx, c.width, c.height, adj);
  return c;
}
function edPixels(ctx, w, hgt, a) {
  const ex = Math.pow(2, a.exposure / 100), con = 1 + a.contrast / 100, hi = a.highlights / 100 * 0.35, sh = a.shadows / 100 * 0.35;
  const wr = a.warmth / 100 * 0.08, ti = a.tint / 100 * 0.06, sat = 1 + a.saturation / 100;
  const id = ctx.getImageData(0, 0, w, hgt); const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i] / 255 + wr, g = d[i + 1] / 255 - ti, b = d[i + 2] / 255 - wr;
    r *= ex; g *= ex; b *= ex;
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b; const Lc = L < 0 ? 0 : L > 1 ? 1 : L;
    const delta = sh * (1 - Lc) * (1 - Lc) + hi * Lc * Lc; r += delta; g += delta; b += delta;
    r = (r - 0.5) * con + 0.5; g = (g - 0.5) * con + 0.5; b = (b - 0.5) * con + 0.5;
    const gr = 0.2126 * r + 0.7152 * g + 0.0722 * b; r = gr + (r - gr) * sat; g = gr + (g - gr) * sat; b = gr + (b - gr) * sat;
    d[i] = r * 255; d[i + 1] = g * 255; d[i + 2] = b * 255; // Uint8ClampedArray clamps
  }
  if (a.sharpen > 0) {
    const amt = a.sharpen / 100 * 0.6; const src = new Uint8ClampedArray(d); const row = w * 4;
    for (let y = 1; y < hgt - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * row + x * 4;
      for (let c = 0; c < 3; c++) { const v = src[i + c]; d[i + c] = v + amt * (4 * v - src[i + c - 4] - src[i + c + 4] - src[i + c - row] - src[i + c + row]); } }
  }
  ctx.putImageData(id, 0, 0);
}
function edDraw() {
  if (!ED.bmp) return; const cv = $("#edCv"); if (!cv) return;
  const out = edRender(1100, ED.adj, ED.holding);
  cv.width = out.width; cv.height = out.height; cv.getContext("2d").drawImage(out, 0, 0);
}
function edAuto() {
  const c = edRender(300, { ...edDefaults(), rot: ED.adj.rot, crop: ED.adj.crop, straighten: ED.adj.straighten }, true);
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let R = 0, G = 0, B = 0, n = 0; const Ls = [];
  for (let i = 0; i < d.length; i += 16) { R += d[i]; G += d[i + 1]; B += d[i + 2]; n++; Ls.push(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]); }
  Ls.sort((x, y) => x - y); const med = Ls[Ls.length >> 1] / 255; const p98 = Ls[Math.floor(Ls.length * 0.98)] / 255;
  R /= n; G /= n; B /= n; const clamp = (v, m) => Math.max(-m, Math.min(m, v));
  Object.assign(ED.adj, {
    exposure: Math.round(clamp(Math.log2(0.5 / Math.max(med, 0.05)) * 100 * 0.5, 45)),
    warmth: Math.round(clamp((B - R) / 255 * 400, 40)), tint: Math.round(clamp((G - (R + B) / 2) / 255 * 400, 30)),
    contrast: 8, highlights: (p98 > 0.97 || med < 0.4) ? -25 : 0, shadows: med < 0.35 ? 20 : 5, saturation: 4, sharpen: 15
  });
  edSyncSliders(); edDraw();
}
async function edSave(btn) {
  if (!ED.bmp) return; btn.disabled = true; btn.textContent = "Saving…";
  try {
    const blob = await toJpeg(edRender(2400, ED.adj, false));
    const photos = [...S.items[ED.id].photos]; const old = photos[ED.i];
    photos[ED.i] = { id: await storePhoto(blob), at: Date.now() };
    await saveItem(ED.id, { photos });
    if (ASSETS) ASSETS.delete(old.id).catch(() => {});
    closeEditor(); toast("Photo saved");
  } catch (e) { btn.disabled = false; btn.textContent = "Save"; toast(e && e.code === "quota_exceeded" ? "Photo storage is full." : "Couldn't save the photo. Try again."); }
}
async function edApplyAll(btn) {
  if (!ED.bmp) return; btn.disabled = true;
  const photos = [...S.items[ED.id].photos]; const olds = [...photos]; const shared = { ...ED.adj, rot: 0, straighten: 0 };
  try {
    for (let j = 0; j < photos.length; j++) {
      btn.textContent = "Saving " + (j + 1) + " of " + photos.length + "…";
      const bmp = j === ED.i ? ED.bmp : await loadBmp(photos[j]);
      const blob = await toJpeg(edRender(2400, j === ED.i ? ED.adj : shared, false, bmp));
      photos[j] = { id: await storePhoto(blob), at: Date.now() };
    }
    await saveItem(ED.id, { photos });
    if (ASSETS) for (const o of olds) ASSETS.delete(o.id).catch(() => {});
    closeEditor(); toast("Edits applied to all " + photos.length + " photos");
  } catch (e) { btn.disabled = false; btn.textContent = "Apply to all " + photos.length + " photos"; toast(e && e.code === "quota_exceeded" ? "Photo storage is full." : "Couldn't finish. No photos were changed."); }
}
async function edDownload() {
  const blob = await toJpeg(edRender(2400, ED.adj, false));
  const name = (S.items[ED.id].sku || ED.id) + "-" + (ED.i + 1) + ".jpg";
  downloadBlob(name, blob); toast("Saved " + name);
}
async function edCover() { const photos = [...S.items[ED.id].photos]; const [p] = photos.splice(ED.i, 1); photos.unshift(p); await saveItem(ED.id, { photos }); closeEditor(); toast("Cover photo set"); }
async function edDelete() { const photos = [...S.items[ED.id].photos]; const [p] = photos.splice(ED.i, 1); await saveItem(ED.id, { photos }); if (ASSETS) ASSETS.delete(p.id).catch(() => {}); closeEditor(); toast("Photo deleted"); }

boot();
