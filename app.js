"use strict";
/* MackroBytes: add an item, mark it listed, match a receipt to its SKU, track payouts.
   Items live in the "shop" collection, keyed by SKU; shop settings live in shopmeta/profile. */

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const h = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = n => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cents = n => Math.round(n * 100) / 100;
// Accepts "14.99" or "$1,014.99". Returns null if it isn't a usable amount.
function parseMoney(v) {
  const n = Number(String(v == null ? "" : v).replace(/[$,\s]/g, ""));
  return String(v == null ? "" : v).trim() !== "" && Number.isFinite(n) && n >= 0 ? cents(n) : null;
}

const BOXES = { fragile: "Fragile", hobby: "Hobby & Tech", soft: "Soft & Collectibles" };
const PLATFORMS = { depop: "Depop", ebay: "eBay", fb: "Facebook" };
const STATUSES = { unlisted: "Unlisted", photos: "Needs photos", ready: "To be listed", listed: "Listed", sold: "Sold & Packing", dropoff: "Pending Dropoff", shipped: "Shipped" };
const SOLD_STATUSES = ["sold", "dropoff", "shipped"], NOT_LISTED = ["unlisted", "photos", "ready"];
// Items saved before these statuses existed say "tolist". Sorted by photos when loaded; the saved copy changes on their next status change.
function sortOldToList(items) {
  Object.values(items).forEach(it => { if (it.status === "tolist") it.status = (it.photos || []).length || it.driveUrl ? "ready" : "photos"; });
  return items;
}
// <input type="date"> values are local calendar days. soldAt is stored in ms at local noon so the day can't shift across time zones.
const pad2 = n => String(n).padStart(2, "0");
const dayValue = d => d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
const today = () => dayValue(new Date());
const dayToMs = v => { const [y, m, d] = v.split("-").map(Number); return new Date(y, m - 1, d, 12).getTime(); };
function soldDay(v) {
  if (!v) return "";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const d = new Date(v); return Number.isNaN(d.getTime()) ? "" : dayValue(d);
}
const newestFirst = (a, b) => String(b.sku).localeCompare(String(a.sku), undefined, { numeric: true });

function toast(msg, { err = false } = {}) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false; t.classList.toggle("err", err);
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, err ? 9000 : 3000);
}
const saveErrMsg = e => e && /JWT|auth/i.test(e.message || "") ? "You've been signed out. Reload and sign in again." : "Couldn't save. Check your connection and try again.";

/* ---------- old data → new data ---------- */
const STAGE_MAP = { intake: "tolist", photographed: "tolist", drafted: "tolist", listed: "listed", sold: "sold", shipped: "shipped", complete: "shipped" };
function oldPlatform(old) {
  const plat = old.plat || {}, isListed = k => plat[k] && plat[k].status === "listed";
  // A sale saved with no amounts has only a default platform, so an active listing is the better clue.
  const realSale = old.sale && old.sale.platform && (old.sale.gross != null || old.sale.price != null);
  if (realSale) return old.sale.platform;
  if (old.listOn && isListed(old.listOn)) return old.listOn;
  return Object.keys(plat).find(isListed) || (old.sale && old.sale.platform) || old.listOn || null;
}
function convertItem(old) {
  const status = STAGE_MAP[old.stage] || "tolist", sold = status === "sold" || status === "shipped";
  const platform = status === "tolist" ? null : oldPlatform(old);
  const sale = old.sale || {}, plat = (platform && old.plat && old.plat[platform]) || {};
  const rawPrice = platform && old.prices ? parseMoney(old.prices[platform]) : null;
  const paid = sold ? parseMoney(sale.gross != null ? sale.gross : sale.price) : null;
  const payout = paid == null ? null : Math.max(0, cents(paid - (Number(sale.fees) || 0)));
  return {
    sku: old.sku, name: old.name || "", box: BOXES[old.box] ? old.box : "", status,
    photos: (old.photos || []).filter(p => p && p.id), driveUrl: old.driveUrl || "",
    price: rawPrice != null ? rawPrice : (sold ? paid : null), platform,
    paid, payout, payoutEstimated: payout != null,
    createdAt: old.createdAt || Date.now(), updatedAt: Date.now(),
    listedAt: plat.listedAt || null, soldAt: sold ? (sale.date || null) : null,
    shippedAt: status === "shipped" ? (sale.shippedAt || old.completedAt || null) : null
  };
}
function conversionReport(olds, items) {
  const skus = f => items.filter(f).map(i => i.sku);
  return {
    total: olds.length, converted: items.length,
    unknownStage: olds.filter(o => !STAGE_MAP[o.stage]).map(o => o.sku),
    noBox: skus(i => !i.box),
    listedNoPrice: skus(i => i.status === "listed" && i.price == null),
    listedNoPlatform: skus(i => i.status === "listed" && !i.platform),
    soldNoAmounts: skus(i => (i.status === "sold" || i.status === "shipped") && i.payout == null),
    estimatedPayouts: skus(i => i.payoutEstimated)
  };
}

/* ---------- data ---------- */
const S = { items: {}, meta: {}, tab: "all", q: "", loaded: false };
let DB = false;
const queues = {};
const enqueue = (key, fn) => { const p = (queues[key] || Promise.resolve()).then(fn, fn); queues[key] = p.catch(() => {}); return p; };
function persistLocal() { localStorage.setItem("mb-local", JSON.stringify({ format: 2, settings: S.meta, items: S.items })); }

async function createItem(sku, data) {
  if (DB) await STORE.insert("shop", sku, data);
  else { if (S.items[sku]) throw { code: "23505" }; }
  S.items[sku] = data;
  if (!DB) persistLocal();
}
// Shows the change right away, merges only these fields into the saved copy, and puts it back if the save fails.
async function patchItem(id, patch) {
  const before = S.items[id]; if (!before) { toast("That item no longer exists.", { err: true }); return false; }
  S.items[id] = { ...before, ...patch, updatedAt: Date.now() }; renderList();
  try {
    if (DB) await enqueue("shop/" + id, async () => {
      const cur = await STORE.get("shop", id); if (!cur) throw new Error("Item is gone");
      await STORE.put("shop", id, { ...cur, ...patch, updatedAt: Date.now() });
    });
    else persistLocal();
    return true;
  } catch (e) {
    console.error("Save failed", id, e); S.items[id] = before; renderList(); toast(saveErrMsg(e), { err: true }); return false;
  }
}
async function removeItem(id) {
  try {
    if (DB) await enqueue("shop/" + id, () => STORE.del("shop", id));
    delete S.items[id]; if (!DB) persistLocal(); renderList(); return true;
  } catch (e) { console.error("Delete failed", id, e); toast(saveErrMsg(e), { err: true }); return false; }
}
async function saveMeta(patch) {
  S.meta = { ...S.meta, ...patch };
  try {
    if (DB) await enqueue("shopmeta/profile", async () => { const cur = await STORE.get("shopmeta", "profile"); await STORE.put("shopmeta", "profile", { ...(cur || {}), ...patch }); });
    else persistLocal();
  } catch (e) { console.error("Settings save failed", e); toast(saveErrMsg(e), { err: true }); }
}

/* ---------- SKUs ---------- */
function nextSkuNumber() {
  const yy = new Date().getFullYear() % 100, head = (S.meta.skuPrefix || "MB") + String(yy).padStart(2, "0") + "-";
  const stored = Number(S.meta.skuYear) === yy ? (Number(S.meta.skuNext) || 1) : 1;
  const used = Object.values(S.items).map(i => String(i.sku || "")).filter(s => s.startsWith(head)).map(s => parseInt(s.slice(head.length), 10) || 0);
  return { yy, head, n: Math.max(stored, 1 + Math.max(0, ...used)) };
}
// If another device just took this SKU, move past it and try the next one.
async function addNewItem(fields) {
  let bump = 0;
  for (let tries = 0; tries < 5; tries++) {
    const { yy, head, n } = nextSkuNumber(), num = n + bump, sku = head + String(num).padStart(4, "0");
    const now = Date.now();
    const item = { sku, photos: [], driveUrl: "", status: "photos", price: null, platform: null, paid: null, payout: null, payoutEstimated: false, buyer: null, createdAt: now, updatedAt: now, listedAt: null, soldAt: null, shippedAt: null, ...fields };
    try { await createItem(sku, item); saveMeta({ skuYear: yy, skuNext: num + 1 }); renderList(); return sku; }
    catch (e) { if (e && e.code === "23505") { bump++; continue; } throw e; }
  }
  throw new Error("Couldn't find a free SKU");
}

/* ---------- photos ---------- */
const memPhotos = {}; // preview-only: photos aren't uploaded without a database
const BLANK = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
const photoSrc = id => memPhotos[id] || (DB ? PHOTOS.src(id) : BLANK);
const hasPhoto = p => DB || !!memPhotos[p.id];
function refreshPhotos() { $$("img[data-photo]").forEach(i => { const s = photoSrc(i.dataset.photo); if (i.src !== s) i.src = s; }); }
// Only shrinks for storage. No other changes to the image.
async function toJpeg(file, maxSide = 1600, q = 0.86) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height); bmp.close();
  const blob = await new Promise(r => c.toBlob(r, "image/jpeg", q));
  if (!blob) throw new Error("Couldn't convert the image");
  return blob;
}
async function uploadPhoto(blob) {
  if (DB) return PHOTOS.upload(blob);
  const id = "local" + Date.now() + Math.random().toString(36).slice(2, 6); memPhotos[id] = URL.createObjectURL(blob); return id;
}
async function deleteStoredPhotos(ids) {
  if (!DB) return;
  for (const id of ids) { try { await PHOTOS.remove(id); } catch (e) { console.error("Photo delete failed", id, e); toast("A photo couldn't be removed from storage.", { err: true }); } }
}
const photoErrMsg = names => "Couldn't read " + names.join(", ") + ". Use a JPEG or PNG. iPhone HEIC photos can't be read here.";
const isImage = f => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name);
async function addPhotos(id, files) {
  const list = [...files]; if (!list.length) return;
  toast("Saving " + list.length + (list.length === 1 ? " photo…" : " photos…"));
  const added = [], failed = [];
  for (const f of list) {
    try { if (!isImage(f)) throw new Error("Not an image"); added.push({ id: await uploadPhoto(await toJpeg(f)), at: Date.now() }); }
    catch (e) { console.error("Photo failed", f.name, e); failed.push(f.name); }
  }
  if (added.length) {
    const cur = S.items[id];
    const nowReady = cur && cur.status === "photos";
    const ok = cur && await patchItem(id, { photos: [...(cur.photos || []), ...added], ...(nowReady ? { status: "ready" } : {}) });
    if (!ok) { await deleteStoredPhotos(added.map(p => p.id)); return; }
    renderPhotoStrip(id);
    if (nowReady) $$('[data-act="setStatus"]').forEach(c => c.classList.toggle("on", c.dataset.v === "ready"));
  }
  if (failed.length) toast(photoErrMsg(failed), { err: true });
  else toast(added.length === 1 ? "Photo saved" : added.length + " photos saved");
}

/* ---------- main screen ---------- */
const thumb = (it, cls = "ph") => {
  const p = (it.photos || []).find(hasPhoto);
  return p ? `<img class="${cls}" data-photo="${h(p.id)}" src="${h(photoSrc(p.id))}" alt="">` : `<div class="${cls} none" aria-hidden="true"></div>`;
};
const titleLine = it => `<div class="title"><span class="sku">${h(it.sku)}</span><span class="name">${h(it.name)}</span></div>`;
const boxName = it => BOXES[it.box] || "No box";
const isSold = it => SOLD_STATUSES.includes(it.status);
const flag = t => `<span class="flag">${h(t)}</span>`;

function statusPill(it) {
  const day = it.status === "listed" ? soldDay(it.listedAt) : "";
  const date = day ? " · " + new Date(dayToMs(day)).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
  return `<span class="pill s-${h(it.status)}">${h(STATUSES[it.status])}${date}</span>`;
}
function rowSub(it) {
  const parts = [h(boxName(it))];
  if (it.status === "listed") parts.push(it.price == null ? flag("Needs price") : `${money(it.price)} · ${h(PLATFORMS[it.platform] || "No platform")}`);
  if (isSold(it)) parts.push(it.payout == null ? flag("Needs payout") : `Sold for ${money(it.paid)} · ${it.payoutEstimated ? "Estimated payout" : "Payout"} ${money(it.payout)}`);
  return parts.join(" · ");
}
function renderSummary() {
  const sold = Object.values(S.items).filter(isSold);
  const paid = sold.reduce((a, i) => a + (Number(i.paid) || 0), 0), out = sold.reduce((a, i) => a + (Number(i.payout) || 0), 0);
  const est = sold.filter(i => i.payoutEstimated).length;
  $("#payouts").textContent = money(out); $("#paidTotal").textContent = money(paid);
  $("#estNote").textContent = est ? "Includes " + est + " estimated" : "";
}
function renderList() {
  if (!S.loaded) return;
  renderSummary();
  const all = Object.values(S.items);
  const tabBtn = (k, label, n) => `<button class="tab${S.tab === k && !S.q ? " on" : ""}" data-act="tab" data-v="${k}">${label} <span>${n}</span></button>`;
  $("#tabs").innerHTML = tabBtn("all", "All", all.length) + Object.keys(STATUSES).map(k => tabBtn(k, STATUSES[k], all.filter(i => i.status === k).length)).join("");
  const needle = S.q.trim().toLowerCase();
  const rows = (needle ? all.filter(i => (i.sku + " " + i.name).toLowerCase().includes(needle)) : all.filter(i => S.tab === "all" || i.status === S.tab)).sort(newestFirst);
  $("#list").innerHTML = rows.length ? rows.map(it => `<div class="row" data-act="openItem" data-id="${h(it.sku)}">${thumb(it)}<div class="grow">${titleLine(it)}<div class="sub">${rowSub(it)}</div></div><div class="right">${statusPill(it)}</div></div>`).join("") : `<div class="empty">${needle ? "No items match that." : "No items here."}</div>`;
}

/* ---------- panel ---------- */
let panel = null;
function openPanel(p) { panel = p; drawPanel(); $("#scrim").hidden = false; const f = $("#panel [autofocus]"); if (f) f.focus(); }
function closePanel() { panel = null; $("#scrim").hidden = true; $("#panel").innerHTML = ""; }
function drawPanel() {
  const views = { add: addView, created: createdView, list: listView, salePick: salePickView, salePay: salePayView, saleDone: saleDoneView, item: itemView, confirm: confirmView, settings: settingsView };
  $("#panel").classList.toggle("pop", panel.view === "salePay");
  $("#panel").innerHTML = `<button class="x" data-act="close" aria-label="Close">×</button>` + views[panel.view]();
}
const fieldErr = (id, msg) => { const e = $("#" + id); if (e) { e.textContent = msg || ""; e.hidden = !msg; } };
const chips = (group, opts, on) => `<div class="chips">${Object.keys(opts).map(k => `<button type="button" class="chip${on === k ? " on" : ""}" data-act="chip" data-group="${group}" data-v="${k}">${h(opts[k])}</button>`).join("")}</div>`;

/* Add item */
function addView() {
  return `<h2>Add item</h2><form data-form="add">
    <button type="button" class="drop" id="drop" data-act="pickFiles">Drag photos here<small>or click to choose</small></button>
    <div class="thumbs" id="dropPreview">${previewHtml()}</div>
    <label class="f">Name<input id="addName" autocomplete="off" value="${h(panel.name || "")}" autofocus></label>
    <div class="f">Box${chips("box", BOXES, panel.box)}</div>
    <p class="err" id="addErr" hidden></p>
    <button class="btn primary wide" id="addGo" type="submit">Get SKU</button></form>`;
}
const previewHtml = () => (panel.files || []).map((f, i) => `<div class="thumb"><img src="${h(panel.urls[i])}" alt=""><button type="button" class="thumb-x" data-act="dropFile" data-i="${i}" aria-label="Remove photo">×</button></div>`).join("");
// Catches unreadable photos now, before the item gets its SKU.
async function addDraftFiles(files) {
  const good = [], bad = [], draft = panel;
  for (const f of files) {
    try { if (!isImage(f)) throw new Error("Not an image"); (await createImageBitmap(f)).close(); good.push(f); }
    catch (e) { console.error("Photo failed", f.name, e); bad.push(f.name); }
  }
  if (bad.length) toast(photoErrMsg(bad), { err: true });
  if (panel !== draft) return;
  panel.files = [...(panel.files || []), ...good]; panel.urls = [...(panel.urls || []), ...good.map(f => URL.createObjectURL(f))];
  $("#dropPreview").innerHTML = previewHtml();
}
async function submitAdd() {
  const name = $("#addName").value.trim();
  if (!name) return fieldErr("addErr", "Enter a name first.");
  if (!panel.box) return fieldErr("addErr", "Pick a box first.");
  const btn = $("#addGo"); btn.disabled = true; const files = panel.files || [];
  try {
    const sku = await addNewItem({ name, box: panel.box });
    S.q = ""; $("#search").value = ""; S.tab = files.length ? "ready" : "photos"; renderList();
    openPanel({ view: "created", id: sku });
    addPhotos(sku, files);
  } catch (e) { console.error("Add failed", e); btn.disabled = false; fieldErr("addErr", saveErrMsg(e)); }
}
function createdView() {
  const it = S.items[panel.id];
  return `<p class="muted">Write this on the bag</p><div class="bigsku">${h(it.sku)}</div><p class="name">${h(it.name)}</p><p class="muted">Goes in ${h(boxName(it))}</p>
    <div class="btns"><button class="btn primary" data-act="openList" data-id="${h(it.sku)}" autofocus>Mark listed</button><button class="btn" data-act="close">List it later</button></div>`;
}

/* Mark listed */
function listView() {
  const it = S.items[panel.id];
  return `<h2>Mark listed</h2>${titleLine(it)}<form data-form="list">
    <label class="f">Listed price<input id="listPrice" inputmode="decimal" autocomplete="off" placeholder="14.99" value="${it.price != null ? h(it.price) : ""}" autofocus></label>
    <p class="warn" id="dupWarn" hidden></p>
    <div class="f">Where${chips("platform", PLATFORMS, panel.platform)}</div>
    <p class="err" id="listErr" hidden></p>
    <button class="btn primary wide" type="submit">Mark listed</button></form>`;
}
function checkDuplicatePrice() {
  const v = parseMoney($("#listPrice").value);
  const other = v == null ? null : Object.values(S.items).find(i => i.status === "listed" && i.sku !== panel.id && i.price === v);
  fieldErr("dupWarn", other ? other.sku + " is already listed at this price. A few cents different keeps sales easy to match." : "");
}
async function submitList() {
  const price = parseMoney($("#listPrice").value);
  if (price == null) return fieldErr("listErr", "Enter the listed price first.");
  if (!panel.platform) return fieldErr("listErr", "Pick where it's listed.");
  const id = panel.id;
  if (await patchItem(id, { status: "listed", price, platform: panel.platform, listedAt: Date.now() })) { S.tab = "listed"; renderList(); closePanel(); toast(id + " is listed"); }
}

/* Record sale */
// Exact price first, then closest price, then items with no price. Never empty while anything is listed.
function rankMatches(items, paid) {
  const gap = it => it.price == null || paid == null ? Infinity : Math.abs(it.price - paid);
  return [...items].sort((a, b) => gap(a) - gap(b) || newestFirst(a, b));
}
function matchesHtml() {
  const paid = parseMoney(panel.paid);
  const pool = Object.values(S.items).filter(i => i.status === "listed" || (panel.showToList && NOT_LISTED.includes(i.status)));
  const row = it => `<div class="row" data-act="salePick" data-id="${h(it.sku)}">${thumb(it)}<div class="grow">${titleLine(it)}<div class="sub">${h(boxName(it))} · ${h(PLATFORMS[it.platform] || STATUSES[it.status])}</div></div><div class="amt"><b>${it.price == null ? "No price" : money(it.price)}</b>${paid != null && it.price === paid ? "<small class='good'>Exact</small>" : ""}</div></div>`;
  return (pool.length ? rankMatches(pool, paid).map(row).join("") : `<div class="empty">No listed items yet.</div>`) +
    (panel.showToList ? "" : `<button type="button" class="link" data-act="saleToList">Show items not listed yet</button>`);
}
function salePickView() {
  return `<h2>Record sale</h2><label class="f">Sold for<input id="salePaid" inputmode="decimal" autocomplete="off" placeholder="14.99" value="${h(panel.paid || "")}" autofocus></label><div id="matches">${matchesHtml()}</div>`;
}
function salePayView() {
  const it = S.items[panel.id];
  return `<h2>Mark sold</h2><div class="row flat">${thumb(it)}<div class="grow">${titleLine(it)}<div class="sub">${h(boxName(it))}</div></div></div><form data-form="sale">
    <label class="f">Sold for<input id="payPaid" inputmode="decimal" autocomplete="off" value="${h(panel.paid || "")}" ${panel.paid ? "" : "autofocus"}></label>
    <label class="f">Total payout<input id="payOut" inputmode="decimal" autocomplete="off" placeholder="12.70" ${panel.paid ? "autofocus" : ""}></label>
    <label class="f">Buyer username<input id="payBuyer" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
    <label class="f">Sale date<input id="payDate" type="date" max="${today()}" value="${today()}"></label>
    <p class="err" id="payErr" hidden></p>
    <div class="btns"><button class="btn primary" type="submit">Mark sold</button>${panel.back ? `<button type="button" class="btn" data-act="saleBack">Back</button>` : ""}</div></form>`;
}
async function submitSale() {
  const paid = parseMoney($("#payPaid").value), payout = parseMoney($("#payOut").value);
  if (paid == null) return fieldErr("payErr", "Enter what it sold for first.");
  if (payout == null) return fieldErr("payErr", "Enter the total payout first.");
  if (payout > paid) return fieldErr("payErr", "The total payout is more than it sold for. Check both numbers.");
  const day = $("#payDate").value;
  if (!day) return fieldErr("payErr", "Pick the sale date first.");
  if (day > today()) return fieldErr("payErr", "The sale date can't be in the future.");
  const id = panel.id, buyer = $("#payBuyer").value.trim() || null;
  const status = panel.target || "sold";
  if (await patchItem(id, { status, paid, payout, payoutEstimated: false, buyer, soldAt: dayToMs(day), shippedAt: status === "shipped" ? Date.now() : null })) { S.q = ""; $("#search").value = ""; S.tab = status; renderList(); openPanel({ view: "saleDone", id }); }
}
function saleDoneView() {
  const it = S.items[panel.id];
  return `<p class="muted">Sold. Pull this one from</p><div class="bigbox">${h(boxName(it))}</div><div class="done-photo">${thumb(it, "big")}</div><div class="bigsku">${h(it.sku)}</div><p class="name">${h(it.name)}</p>
    <p class="muted">Sold for ${money(it.paid)} · Total payout ${money(it.payout)}</p><div class="btns"><button class="btn primary" data-act="close" autofocus>Done</button></div>`;
}

/* Item page */
function itemView() {
  const it = S.items[panel.id]; if (!it) return `<p class="err">That item no longer exists.</p>`;
  const id = h(it.sku), sold = isSold(it);
  return `<div class="sku">${id}</div>
    <div class="f status">Status<div class="chips">${Object.keys(STATUSES).map(k => `<button type="button" class="chip${it.status === k ? " on" : ""}" data-act="setStatus" data-v="${k}">${h(STATUSES[k])}</button>`).join("")}</div></div>
    <div id="photoStrip">${photoStripHtml(it)}</div>
    <button type="button" class="drop small" id="drop" data-act="pickFiles">Drag photos here<small>or click to choose</small></button>
    ${it.driveUrl ? `<a class="link" href="${h(it.driveUrl)}" target="_blank" rel="noopener">Open photos in Google Drive</a>` : ""}
    <label class="f">Name<input data-field="name" autocomplete="off" value="${h(it.name)}"></label>
    <div class="f">Box${chips("itemBox", BOXES, it.box)}</div>
    ${NOT_LISTED.includes(it.status) ? "" : `<label class="f">Listed price<input data-field="price" inputmode="decimal" autocomplete="off" value="${it.price != null ? h(it.price) : ""}"></label><div class="f">Where${chips("itemPlatform", PLATFORMS, it.platform)}</div><label class="f">Listed date<input data-field="listedAt" type="date" max="${today()}" value="${h(soldDay(it.listedAt))}"></label>`}
    ${sold ? `<label class="f">Sold for<input data-field="paid" inputmode="decimal" autocomplete="off" value="${it.paid != null ? h(it.paid) : ""}"></label><label class="f">Total payout${it.payoutEstimated ? ' <span class="flag">Estimated</span>' : ""}<input data-field="payout" inputmode="decimal" autocomplete="off" value="${it.payout != null ? h(it.payout) : ""}"></label><label class="f">Buyer username<input data-field="buyer" autocomplete="off" autocapitalize="off" spellcheck="false" value="${h(it.buyer || "")}"></label><label class="f">Sale date<input data-field="soldAt" type="date" max="${today()}" value="${h(soldDay(it.soldAt))}"></label>` : ""}
    <p class="err" id="itemErr" hidden></p>
    <button class="link danger" data-act="askDelete" data-id="${id}">Delete item</button>`;
}
function photoStripHtml(it) {
  const photos = (it.photos || []).filter(hasPhoto); if (!photos.length) return "";
  const main = photos.find(p => p.id === panel.photo) || photos[0];
  return `<img class="big" data-photo="${h(main.id)}" src="${h(photoSrc(main.id))}" alt=""><div class="thumbs">${photos.map(p => `<div class="thumb"><img data-photo="${h(p.id)}" data-act="showPhoto" data-v="${h(p.id)}" src="${h(photoSrc(p.id))}" alt=""><button type="button" class="thumb-x" data-act="askDropPhoto" data-v="${h(p.id)}" aria-label="Remove photo">×</button></div>`).join("")}</div>`;
}
function renderPhotoStrip(id) { if (panel && panel.view === "item" && panel.id === id) $("#photoStrip").innerHTML = photoStripHtml(S.items[id]); }
async function saveField(input) {
  const it = S.items[panel.id], field = input.dataset.field, id = panel.id; fieldErr("itemErr", "");
  if (field === "name") {
    const v = input.value.trim();
    if (!v) { input.value = it.name; return fieldErr("itemErr", "An item needs a name."); }
    if (v !== it.name) patchItem(id, { name: v });
    return;
  }
  if (field === "buyer") {
    const v = input.value.trim() || null;
    if (v !== (it.buyer || null)) patchItem(id, { buyer: v });
    return;
  }
  if (field === "soldAt" || field === "listedAt") {
    const day = input.value;
    if (day > today()) { input.value = soldDay(it[field]); return fieldErr("itemErr", `The ${field === "soldAt" ? "sale" : "listed"} date can't be in the future, so it wasn't saved.`); }
    if (day !== soldDay(it[field])) patchItem(id, { [field]: day ? dayToMs(day) : null });
    return;
  }
  const blank = input.value.trim() === "", v = blank ? null : parseMoney(input.value);
  if (!blank && v == null) { input.value = it[field] != null ? it[field] : ""; return fieldErr("itemErr", "That amount isn't a number, so it wasn't saved."); }
  if (v === it[field]) return;
  patchItem(id, field === "payout" ? { payout: v, payoutEstimated: false } : { [field]: v });
}

/* Confirm */
function askConfirm(text, ok, fn, back) { openPanel({ view: "confirm", text, ok, fn, back }); }
function confirmView() {
  return `<h2>${h(panel.text)}</h2><div class="btns"><button class="btn danger" data-act="confirmYes">${h(panel.ok)}</button><button class="btn" data-act="confirmNo">Cancel</button></div>`;
}

/* Settings */
function settingsView() {
  return `<h2>Settings</h2><div class="btns col"><button class="btn" data-act="backup">Save backup file</button>${DB ? `<button class="btn" data-act="signOut">Sign out</button>` : `<p class="muted">Preview: changes stay in this browser.</p>`}</div>`;
}
function saveBackup() {
  const data = JSON.stringify({ format: 2, exportedAt: new Date().toISOString(), settings: S.meta, items: S.items }, null, 2);
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([data], { type: "application/json" })); a.download = "mackrobytes-backup.json";
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); toast("Backup saved");
}

/* ---------- events ---------- */
const openItem = id => openPanel({ view: "item", id });
const actions = {
  close: closePanel,
  tab: t => { S.tab = t.dataset.v; S.q = ""; $("#search").value = ""; renderList(); },
  add: () => openPanel({ view: "add" }),
  sale: () => openPanel({ view: "salePick" }),
  settings: () => openPanel({ view: "settings" }),
  pickFiles: () => $("#fileIn").click(),
  openItem: t => openItem(t.dataset.id),
  openList: t => openPanel({ view: "list", id: t.dataset.id, platform: S.items[t.dataset.id].platform || "depop" }),
  dropFile: t => { const i = +t.dataset.i; URL.revokeObjectURL(panel.urls[i]); panel.files.splice(i, 1); panel.urls.splice(i, 1); $("#dropPreview").innerHTML = previewHtml(); },
  chip: async t => {
    const g = t.dataset.group, v = t.dataset.v;
    if (g === "box" || g === "platform") { panel[g] = v; $$(`[data-group="${g}"]`).forEach(c => c.classList.toggle("on", c === t)); return; }
    $$(`[data-group="${g}"]`).forEach(c => c.classList.toggle("on", c === t));
    patchItem(panel.id, g === "itemBox" ? { box: v } : { platform: v });
  },
  salePick: t => { panel = { view: "salePay", id: t.dataset.id, paid: panel.paid, back: { paid: panel.paid, showToList: panel.showToList } }; openPanel(panel); },
  saleBack: () => openPanel({ view: "salePick", ...panel.back }),
  saleToList: () => { panel.showToList = true; $("#matches").innerHTML = matchesHtml(); },
  setStatus: async t => {
    const id = panel.id, it = S.items[id], to = t.dataset.v, wasSold = isSold(it), toSold = SOLD_STATUSES.includes(to);
    if (to === it.status) return;
    if (toSold && !wasSold) return openPanel({ view: "salePay", id, target: to });
    if (to === "listed" && !wasSold) return openPanel({ view: "list", id, platform: it.platform || "depop" });
    if (wasSold && !toSold) return askConfirm("Undo this sale?", "Undo sale", async () => {
      await patchItem(id, { status: to, paid: null, payout: null, payoutEstimated: false, buyer: null, soldAt: null, shippedAt: null, ...(to === "listed" ? {} : { listedAt: null }) });
      openItem(id);
    }, () => openItem(id));
    const patch = { status: to };
    if (toSold) patch.shippedAt = to === "shipped" ? Date.now() : null;
    else if (it.status === "listed") patch.listedAt = null;
    if (await patchItem(id, patch)) openItem(id);
  },
  askDelete: t => { const id = t.dataset.id; askConfirm("Delete " + id + "?", "Delete item", async () => {
    const photos = (S.items[id].photos || []).map(p => p.id);
    if (await removeItem(id)) { closePanel(); toast(id + " deleted"); deleteStoredPhotos(photos); } else openItem(id);
  }, () => openItem(id)); },
  showPhoto: t => { panel.photo = t.dataset.v; renderPhotoStrip(panel.id); },
  askDropPhoto: t => { const id = panel.id, pid = t.dataset.v; askConfirm("Remove this photo?", "Remove photo", async () => {
    if (await patchItem(id, { photos: S.items[id].photos.filter(p => p.id !== pid) })) deleteStoredPhotos([pid]);
    openItem(id);
  }, () => openItem(id)); },
  confirmYes: () => panel.fn(),
  confirmNo: () => panel.back(),
  backup: saveBackup,
  signOut: () => AUTH.signOut()
};
document.addEventListener("click", e => {
  if (e.target.id === "scrim") return closePanel();
  if (e.target.type === "date") return e.target.showPicker();
  const t = e.target.closest("[data-act]"); if (!t) return;
  const fn = actions[t.dataset.act]; if (fn) fn(t);
});
document.addEventListener("keydown", e => { if (e.key === "Escape" && panel) closePanel(); });
document.addEventListener("submit", e => {
  e.preventDefault();
  const fn = { add: submitAdd, list: submitList, sale: submitSale }[e.target.dataset.form]; if (fn) fn();
});
document.addEventListener("input", e => {
  const id = e.target.id;
  if (id === "search") { S.q = e.target.value; renderList(); }
  if (id === "salePaid") { panel.paid = e.target.value; $("#matches").innerHTML = matchesHtml(); }
  if (id === "listPrice") { fieldErr("listErr", ""); checkDuplicatePrice(); }
  if (id === "addName") { panel.name = e.target.value; fieldErr("addErr", ""); }
  if (id === "payPaid" || id === "payOut" || id === "payDate") fieldErr("payErr", "");
});
document.addEventListener("change", e => {
  if (e.target.dataset.field && panel && panel.view === "item") saveField(e.target);
  if (e.target.id === "fileIn") { handleFiles(e.target.files); e.target.value = ""; }
});
function handleFiles(files) {
  if (!panel) return;
  if (panel.view === "add") addDraftFiles(files);
  else if (panel.view === "item") addPhotos(panel.id, files);
}
// A photo dropped outside the drop area must never navigate the app away.
window.addEventListener("dragover", e => { e.preventDefault(); const d = e.target.closest && e.target.closest("#drop"); $$("#drop").forEach(x => x.classList.toggle("over", x === d)); });
window.addEventListener("dragleave", e => { if (!e.relatedTarget) $$("#drop").forEach(x => x.classList.remove("over")); });
window.addEventListener("drop", e => {
  e.preventDefault(); $$("#drop").forEach(x => x.classList.remove("over"));
  if (!(e.target.closest && e.target.closest("#panel"))) return;
  const files = e.dataTransfer && e.dataTransfer.files;
  if (!files || !files.length) return toast("That didn't come through as a file. Save the photo to your Mac, then drag it in.", { err: true });
  handleFiles(files);
});

/* ---------- start ---------- */
function showFatal(msg) { S.loaded = false; $("#list").innerHTML = `<div class="empty"><p class="err">${h(msg)}</p><button class="btn" onclick="location.reload()">Reload</button></div>`; }
// Runs once ever: copies the old items into "shop" and leaves the old data alone. Safe to retry; existing SKUs are skipped.
async function convertOldData() {
  const olds = await STORE.all("items"), profile = (await STORE.all("settings")).find(r => r.id === "profile");
  const converted = olds.map(r => convertItem(r.data));
  for (const it of converted) {
    try { await STORE.insert("shop", it.sku, it); }
    catch (e) { if (!(e && e.code === "23505")) throw e; }
  }
  const s = profile ? profile.data : {};
  const report = conversionReport(olds.map(r => r.data), converted);
  console.info("Converted old data", report);
  await STORE.put("shopmeta", "profile", { skuPrefix: s.skuPrefix || "MB", skuYear: s.skuYear || null, skuNext: s.skuNext || 1, convertedAt: new Date().toISOString(), conversionReport: report });
}
async function startSync() {
  DB = true; PHOTOS.onReady = refreshPhotos;
  $("#list").innerHTML = `<div class="empty">Loading your shop…</div>`;
  try { if (!(await STORE.get("shopmeta", "profile"))) await convertOldData(); }
  catch (e) { console.error("Couldn't set up data", e); return showFatal("Couldn't load your shop. Nothing was lost. Check your connection, then reload."); }
  const fail = () => { $("#syncErr").hidden = false; };
  STORE.watch("shop", m => { $("#syncErr").hidden = true; S.items = sortOldToList(m); S.loaded = true; renderList(); }, fail);
  STORE.watch("shopmeta", m => { S.meta = m.profile || {}; }, fail);
}
function startLocal() {
  $("#previewNote").hidden = false;
  const d = JSON.parse(localStorage.getItem("mb-local") || "null");
  if (d && d.format === 2) { S.items = d.items || {}; S.meta = d.settings || {}; }
  else if (d) {
    const olds = Object.values(d.items || {}), converted = olds.map(convertItem);
    converted.forEach(it => { S.items[it.sku] = it; });
    const s = d.settings || {};
    S.meta = { skuPrefix: s.skuPrefix || "MB", skuYear: s.skuYear || null, skuNext: s.skuNext || 1, conversionReport: conversionReport(olds, converted) };
    console.info("Converted old data", S.meta.conversionReport);
    persistLocal();
  }
  sortOldToList(S.items);
  S.loaded = true; renderList();
}
function showLogin() {
  const m = $("#login"); m.hidden = false;
  $("#loginForm").onsubmit = async e => {
    e.preventDefault(); const err = $("#loginErr"); err.hidden = true;
    try { await AUTH.signIn($("#loginEmail").value.trim(), $("#loginPw").value); m.hidden = true; startSync(); }
    catch { err.textContent = "That email and password didn't work."; err.hidden = false; }
  };
}
(async () => {
  const configured = window.CONFIG && CONFIG.SUPABASE_URL && !CONFIG.SUPABASE_URL.startsWith("YOUR") && typeof STORE !== "undefined";
  if (!configured) return startLocal();
  try { if (await AUTH.session()) startSync(); else showLogin(); }
  catch (e) { console.error("Sign-in check failed", e); showFatal("Couldn't reach your shop. Check your connection, then reload."); }
})();
