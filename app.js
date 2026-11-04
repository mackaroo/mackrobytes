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
  const s = String(v == null ? "" : v).replace(/[$,\s]/g, "");
  return /^(\d+\.?\d*|\.\d+)$/.test(s) ? cents(Number(s)) : null;
}

const BOXES = { fragile: "Fragile", hobby: "Hobby & Tech", soft: "Soft & Collectibles" };
const PLATFORMS = { depop: "Depop", ebay: "eBay", fb: "Facebook" };
const YES_NO = { yes: "Yes", no: "No" };
// platform stays as the first one checked, for items saved before platforms existed.
const platformsOf = it => it.platforms && it.platforms.length ? it.platforms : it.platform ? [it.platform] : [];
const platformNames = it => platformsOf(it).map(p => PLATFORMS[p]).filter(Boolean).join(", ");
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
// <input type="datetime-local"> values: local date and time to the minute. Times are stored in ms.
const timeValue = v => { const d = new Date(v || Date.now()); return Number.isNaN(d.getTime()) ? "" : dayValue(d) + "T" + pad2(d.getHours()) + ":" + pad2(d.getMinutes()); };
const parseTime = v => { const ms = new Date(v).getTime(); return Number.isNaN(ms) ? null : ms; };
const newestFirst = (a, b) => String(b.sku).localeCompare(String(a.sku), undefined, { numeric: true });

function toast(msg, { err = false } = {}) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false; t.classList.toggle("err", err);
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, err ? 9000 : 3000);
}
const saveErrMsg = e => e && /JWT|auth/i.test(e.message || "") ? "You've been signed out. Reload and sign in again." : "Couldn't save. Check your connection and try again.";

/* ---------- data ---------- */
const S = { items: {}, meta: {}, tab: "all", q: "", view: "inv", loaded: false, metaLoaded: false };
// SKUs and backups need both, or a new item could reuse a SKU and a backup could come out empty.
const shopReady = () => S.loaded && S.metaLoaded;
const needsShop = fn => t => shopReady() ? fn(t) : toast("Your shop hasn't loaded yet. Try again in a moment, or reload.", { err: true });
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
    console.error("Save failed", id, e);
    // Puts back only this save's fields, so a newer edit to another field survives.
    const now = S.items[id];
    if (now) { const back = { ...now }; Object.keys(patch).forEach(k => { if (back[k] === patch[k]) back[k] = before[k]; }); S.items[id] = back; }
    renderList(); toast(saveErrMsg(e), { err: true }); return false;
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
    const item = { sku, photos: [], driveUrl: "", status: "photos", price: null, platform: null, platforms: [], boosted: false, tracking: null, receiptImg: null, labelImg: null, proofImg: null, paid: null, payout: null, payoutEstimated: false, buyer: null, createdAt: now, updatedAt: now, listedAt: null, soldAt: null, shippedAt: null, ...fields };
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
const uploadErrMsg = names => "Couldn't upload " + names.join(", ") + ". Check your connection and add it again from the item page.";
const isImage = f => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name);
async function addPhotos(id, files) {
  const list = [...files]; if (!list.length) return;
  toast("Saving " + list.length + (list.length === 1 ? " photo…" : " photos…"));
  const added = [], unreadable = [], notUploaded = [];
  for (const f of list) {
    let blob;
    try { if (!isImage(f)) throw new Error("Not an image"); blob = await toJpeg(f); }
    catch (e) { console.error("Photo failed", f.name, e); unreadable.push(f.name); continue; }
    try { added.push({ id: await uploadPhoto(blob), at: Date.now() }); }
    catch (e) { console.error("Upload failed", f.name, e); notUploaded.push(f.name); }
  }
  if (added.length) {
    const cur = S.items[id];
    const nowReady = cur && cur.status === "photos";
    const ok = cur && await patchItem(id, { photos: [...(cur.photos || []), ...added], ...(nowReady ? { status: "ready" } : {}) });
    if (!ok) { await deleteStoredPhotos(added.map(p => p.id)); return; }
    renderPhotoStrip(id);
    if (nowReady) $$('[data-act="setStatus"]').forEach(c => c.classList.toggle("on", c.dataset.v === "ready"));
  }
  if (unreadable.length || notUploaded.length) toast([unreadable.length && photoErrMsg(unreadable), notUploaded.length && uploadErrMsg(notUploaded)].filter(Boolean).join(" "), { err: true });
  else toast(added.length === 1 ? "Photo saved" : added.length + " photos saved");
}

/* ---------- receipt, label and proof images: kept for records, apart from the listing photos ---------- */
const RECORDS = { receipt: ["receiptImg", "Depop receipt"], label: ["labelImg", "Shipping label"], proof: ["proofImg", "Proof of shipping"] };
const recordIds = it => Object.values(RECORDS).map(([f]) => it[f] && it[f].id).filter(Boolean);
function slotHtml(kind) {
  const [field, label] = RECORDS[kind], saved = S.items[panel.id][field], draft = (panel.drafts || {})[kind], onItem = panel.view === "item";
  const shown = saved && hasPhoto(saved) ? saved : null;
  const thumbHtml = draft ? `<div class="thumb"><img src="${h(draft.url)}" alt="${h(label)}"><button type="button" class="thumb-x" data-act="dropDraft" data-v="${kind}" aria-label="Remove image">×</button></div>`
    : shown ? `<div class="thumb"><img data-photo="${h(shown.id)}" src="${h(photoSrc(shown.id))}" alt="${h(label)}"${onItem ? ` data-act="viewRecord" data-v="${kind}"` : ""}>${onItem ? `<button type="button" class="thumb-x" data-act="askDropRecord" data-v="${kind}" aria-label="Remove image">×</button>` : ""}</div>` : "";
  return `<div class="f" id="slot-${kind}">${h(label)}<div class="slot">${thumbHtml}<button type="button" class="drop small" data-slot="${kind}" data-act="pickSlot" data-v="${kind}">${draft || shown ? "Replace image" : "Upload or take a picture"}</button></div></div>`;
}
const redrawSlot = kind => { const s = $("#slot-" + kind); if (s) s.outerHTML = slotHtml(kind); };
// Checks the image can be read now. In a popup it waits for the save; on the item page it saves right away.
async function slotFile(kind, file) {
  const p = panel; if (!file) return;
  try { if (!isImage(file)) throw new Error("Not an image"); (await createImageBitmap(file)).close(); }
  catch (e) { console.error("Image failed", file.name, e); return toast(photoErrMsg([file.name]), { err: true }); }
  if (panel !== p) return;
  if (p.view === "item") {
    toast("Saving image…");
    if (await patchWithRecords(p.id, {}, { [kind]: { file } })) { toast("Image saved"); if (panel === p) redrawSlot(kind); }
    return;
  }
  const drafts = p.drafts = p.drafts || {};
  if (drafts[kind]) URL.revokeObjectURL(drafts[kind].url);
  drafts[kind] = { file, url: URL.createObjectURL(file) };
  redrawSlot(kind);
}
// Larger than listing photos so small print and barcodes stay readable. Replaced images are removed only after a good save.
async function patchWithRecords(id, patch, drafts = {}) {
  const fields = {}, ids = [], cur = S.items[id] || {};
  for (const kind of Object.keys(drafts)) {
    try { const up = await uploadPhoto(await toJpeg(drafts[kind].file, 2400, 0.9)); ids.push(up); fields[RECORDS[kind][0]] = { id: up, at: Date.now() }; }
    catch (e) { console.error("Image upload failed", kind, e); await deleteStoredPhotos(ids); toast(uploadErrMsg([RECORDS[kind][1]]), { err: true }); return false; }
  }
  const replaced = Object.keys(fields).map(f => cur[f] && cur[f].id).filter(Boolean);
  if (!await patchItem(id, { ...patch, ...fields })) { await deleteStoredPhotos(ids); return false; }
  deleteStoredPhotos(replaced);
  return true;
}
// Saves a popup's form with its images. The button stays off while images upload, so a double click can't save twice.
async function savePopup(patch) {
  const p = panel, go = $("#panel button[type=submit]"), drafts = p.drafts || {};
  go.disabled = true;
  if (Object.keys(drafts).length) toast("Saving images…");
  const ok = await patchWithRecords(p.id, patch, drafts);
  go.disabled = false;
  return ok && panel === p;
}
function recordView() {
  const [field, label] = RECORDS[panel.kind], rec = S.items[panel.id][field];
  return `<h2>${h(label)}</h2>${rec ? `<img class="big record" data-photo="${h(rec.id)}" src="${h(photoSrc(rec.id))}" alt="${h(label)}">` : `<p class="muted">This image was removed.</p>`}<div class="btns"><button class="btn" data-act="openItem" data-id="${h(panel.id)}" autofocus>Back</button></div>`;
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
const bundlePartners = it => it.bundleId ? Object.values(S.items).filter(i => i.bundleId === it.bundleId && i.sku !== it.sku).sort(newestFirst) : [];

function statusPill(it) {
  const day = it.status === "listed" ? soldDay(it.listedAt) : "";
  const date = day ? " · " + new Date(dayToMs(day)).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
  return `<button type="button" class="pill s-${h(it.status)}" data-act="statusMenu" data-id="${h(it.sku)}" aria-haspopup="menu">${h(STATUSES[it.status])}${date}</button>`;
}
function rowSub(it) {
  const parts = [h(boxName(it))];
  if (it.status === "listed") parts.push(it.price == null ? flag("Needs price") : `${money(it.price)} · ${h(platformNames(it) || "No platform")}`);
  if (isSold(it)) parts.push(it.payout == null ? flag("Needs payout") : `${it.paid == null ? flag("Needs sold price") : "Sold for " + money(it.paid)} · ${it.payoutEstimated ? "Estimated payout" : "Payout"} ${money(it.payout)}${bundlePartners(it).length ? " · Bundle" : ""}`);
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
  if (S.view === "sales") scheduleSales();
  renderSummary();
  const all = Object.values(S.items);
  const tabBtn = (k, label, n) => `<button class="tab${S.tab === k && !S.q ? " on" : ""}" data-act="tab" data-v="${k}">${label} <span>${n}</span></button>`;
  $("#tabs").innerHTML = tabBtn("all", "All", all.length) + Object.keys(STATUSES).map(k => tabBtn(k, STATUSES[k], all.filter(i => i.status === k).length)).join("");
  const needle = S.q.trim().toLowerCase();
  const rows = (needle ? all.filter(i => (i.sku + " " + i.name).toLowerCase().includes(needle)) : all.filter(i => S.tab === "all" || i.status === S.tab)).sort(newestFirst);
  $("#list").innerHTML = rows.length ? rows.map(it => `<div class="row" data-act="openItem" data-id="${h(it.sku)}">${thumb(it)}<div class="grow">${titleLine(it)}<div class="sub">${rowSub(it)}</div></div><div class="right">${statusPill(it)}</div></div>`).join("") : `<div class="empty">${needle ? "No items match that." : "No items here."}</div>`;
}

/* ---------- status menu (the pill on each row) ---------- */
const statusMenuOpen = () => !$("#statusMenu").hidden;
const closeStatusMenu = () => { $("#statusMenu").hidden = true; };
const focusPill = id => { const p = $$('#list [data-act="statusMenu"]').find(b => b.dataset.id === id); if (p) p.focus({ preventScroll: true }); };
function openStatusMenu(pill) {
  const m = $("#statusMenu"), it = S.items[pill.dataset.id];
  m.dataset.id = pill.dataset.id;
  m.innerHTML = Object.keys(STATUSES).map(k => `<button type="button" role="menuitem" class="pill s-${k}${it.status === k ? " on" : ""}" data-act="pickStatus" data-v="${k}">${h(STATUSES[k])}</button>`).join("");
  m.hidden = false;
  // Opens below the pill, or above it when there's no room. Scrolls with the page.
  const r = pill.getBoundingClientRect(), mw = m.offsetWidth, mh = m.offsetHeight;
  const up = r.bottom + 4 + mh > innerHeight && r.top - 4 - mh >= 0;
  m.style.top = scrollY + (up ? r.top - 4 - mh : r.bottom + 4) + "px";
  m.style.left = scrollX + Math.max(8, Math.min(r.right - mw, innerWidth - mw - 8)) + "px";
  m.querySelector(".on").focus({ preventScroll: true });
}

/* ---------- panel ---------- */
let panel = null;
function openPanel(p) { panel = p; drawPanel(); $("#scrim").hidden = false; const f = $("#panel [autofocus]"); if (f) f.focus(); }
function closePanel() { panel = null; $("#scrim").hidden = true; $("#panel").innerHTML = ""; }
function drawPanel() {
  const views = { add: addView, created: createdView, list: listView, salePick: salePickView, salePay: salePayView, saleDone: saleDoneView, ship: shipView, record: recordView, item: itemView, confirm: confirmView, settings: settingsView };
  $("#panel").classList.toggle("pop", ["list", "salePay", "ship"].includes(panel.view));
  $("#panel").innerHTML = `<button class="x" data-act="close" aria-label="Close">×</button>` + (panel.id && !S.items[panel.id] ? `<p class="err">That item no longer exists.</p>` : views[panel.view]());
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
  // Copied now: the file picker's list empties as soon as the picker resets.
  const list = [...files], good = [], bad = [], draft = panel;
  for (const f of list) {
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
    S.q = ""; $("#search").value = ""; S.tab = "photos"; renderList();
    openPanel({ view: "created", id: sku });
    // Follows the item to its next tab only once its photos have really saved.
    addPhotos(sku, files).then(() => { const it = S.items[sku]; if (S.tab === "photos" && it && it.status === "ready") { S.tab = "ready"; renderList(); } });
  } catch (e) { console.error("Add failed", e); btn.disabled = false; fieldErr("addErr", saveErrMsg(e)); }
}
function createdView() {
  const it = S.items[panel.id];
  return `<p class="muted">Write this on the bag</p><div class="bigsku">${h(it.sku)}</div><p class="name">${h(it.name)}</p><p class="muted">Goes in ${h(boxName(it))}</p>
    <div class="btns"><button class="btn primary" data-act="openList" data-id="${h(it.sku)}" autofocus>Mark listed</button><button class="btn" data-act="close">List it later</button></div>`;
}

/* Mark listed */
const platformChecks = on => `<div class="checks">${Object.keys(PLATFORMS).map(k => `<label class="check"><input type="checkbox" data-plat value="${k}"${on.includes(k) ? " checked" : ""}>${h(PLATFORMS[k])}</label>`).join("")}</div>`;
const checkedPlatforms = () => $$("[data-plat]:checked").map(c => c.value);
function listView() {
  const it = S.items[panel.id], on = platformsOf(it).length ? platformsOf(it) : [panel.platform];
  if (!panel.boosted) panel.boosted = it.boosted ? "yes" : "no";
  return `<h2>Mark listed</h2>${titleLine(it)}<form data-form="list">
    <div class="f">Platforms${platformChecks(on)}</div>
    <label class="f">Listed price<input id="listPrice" inputmode="decimal" autocomplete="off" placeholder="14.99" value="${it.price != null ? h(it.price) : ""}" autofocus></label>
    <p class="warn" id="dupWarn" hidden></p>
    <div class="f">Boosted listing${chips("boosted", YES_NO, panel.boosted)}</div>
    <label class="f">Listed date<input id="listDate" type="datetime-local" value="${timeValue()}"></label>
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
  const platforms = checkedPlatforms();
  if (!platforms.length) return fieldErr("listErr", "Check at least one platform.");
  const listedAt = parseTime($("#listDate").value);
  if (listedAt == null) return fieldErr("listErr", "Pick the listed date first.");
  if (listedAt > Date.now()) return fieldErr("listErr", "The listed date can't be in the future.");
  const id = panel.id, stay = panel.stay;
  if (await patchItem(id, { status: "listed", price, platforms, platform: platforms[0], boosted: panel.boosted === "yes", listedAt })) { if (!stay) { S.tab = "listed"; renderList(); } closePanel(); toast(id + " is listed"); }
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
  const row = it => `<div class="row" data-act="salePick" data-id="${h(it.sku)}">${thumb(it)}<div class="grow">${titleLine(it)}<div class="sub">${h(boxName(it))} · ${h(platformNames(it) || STATUSES[it.status])}</div></div><div class="amt"><b>${it.price == null ? "No price" : money(it.price)}</b>${paid != null && it.price === paid ? "<small class='good'>Exact</small>" : ""}</div></div>`;
  return (pool.length ? rankMatches(pool, paid).map(row).join("") : `<div class="empty">No listed items yet.</div>`) +
    (panel.showToList ? "" : `<button type="button" class="link" data-act="saleToList">Show items not listed yet</button>`);
}
function salePickView() {
  return `<h2>Record sale</h2><label class="f">Sold for<input id="salePaid" inputmode="decimal" autocomplete="off" placeholder="14.99" value="${h(panel.paid || "")}" autofocus></label><div id="matches">${matchesHtml()}</div>`;
}
function salePayView() {
  const it = S.items[panel.id], paid = panel.paid || (it.paid != null ? it.paid : "");
  return `<h2>${panel.keep ? "Log as bundle" : "Mark sold"}</h2><div class="row flat">${thumb(it)}<div class="grow">${titleLine(it)}<div class="sub">${h(boxName(it))}</div></div></div><form data-form="sale">
    <label class="f">Sold for<input id="payPaid" inputmode="decimal" autocomplete="off" value="${h(paid)}" ${paid !== "" ? "" : "autofocus"}></label>
    <div id="bundleBox">${bundleHtml()}</div>
    <label class="f">Total payout<input id="payOut" inputmode="decimal" autocomplete="off" placeholder="12.70" value="${it.payout != null ? h(it.payout) : ""}" ${paid !== "" ? "autofocus" : ""}></label>
    <p class="muted" id="bundleSplit" hidden></p>
    <label class="f">Buyer username<input id="payBuyer" autocomplete="off" autocapitalize="off" spellcheck="false" value="${h(it.buyer || "")}"></label>
    <label class="f">Sale date<input id="payDate" type="date" max="${today()}" value="${h(soldDay(it.soldAt) || today())}"></label>
    ${slotHtml("receipt")}
    <label class="f">Tracking number<input id="payTracking" autocomplete="off" autocapitalize="off" spellcheck="false" value="${h(it.tracking || "")}"></label>
    ${slotHtml("label")}
    <p class="err" id="payErr" hidden></p>
    <div class="btns"><button class="btn primary" type="submit">${panel.keep ? "Save bundle" : "Mark sold"}</button>${panel.back ? `<button type="button" class="btn" data-act="saleBack">Back</button>` : ""}</div></form>`;
}
/* Bundles: one buyer, one Depop payout, several SKUs */
// Splits by each item's share of the sale, in whole cents, so the shares always add up to the payout on the receipt.
function splitPayout(payout, amounts) {
  const cents = amounts.map(a => Math.round(a * 100)), sum = cents.reduce((a, c) => a + c, 0), total = Math.round(payout * 100);
  if (!sum) return amounts.map(() => 0);
  const exact = cents.map(c => total * c / sum), out = exact.map(Math.floor);
  let left = total - out.reduce((a, c) => a + c, 0);
  exact.map((v, i) => [v - out[i], i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0) { out[i]++; left--; } });
  return out.map(c => c / 100);
}
const saleBundle = () => (panel.bundle || []).filter(sku => S.items[sku]);
function bundleMatchesHtml() {
  const it = S.items[panel.id], chosen = saleBundle(), needle = (panel.bundleQ || "").trim().toLowerCase();
  // Items still needing a sale logged come first. Items already in another bundle can't be picked.
  const open = i => i.status === "listed" || (isSold(i) && i.payout == null);
  const pool = Object.values(S.items).filter(i => i.sku !== it.sku && !chosen.includes(i.sku) && !i.bundleId && (i.sku + " " + i.name).toLowerCase().includes(needle))
    .sort((a, b) => open(b) - open(a) || newestFirst(a, b)).slice(0, 6);
  return pool.map(i => `<div class="row" data-act="bundleAdd" data-id="${h(i.sku)}">${thumb(i)}<div class="grow">${titleLine(i)}<div class="sub">${h(STATUSES[i.status])}</div></div><div class="amt"><b>${i.price == null ? "No price" : money(i.price)}</b></div></div>`).join("") || `<div class="empty">No items match that.</div>`;
}
function bundleHtml() {
  const it = S.items[panel.id];
  if (it.bundleId && it.bundleId !== panel.bundleId) return "";
  const rows = saleBundle().map(sku => { const b = S.items[sku];
    return `<div class="bundle-item">${titleLine(b)}<label class="f">Sold for<input data-bundle-paid="${h(sku)}" inputmode="decimal" autocomplete="off" placeholder="${b.price == null ? "" : "Listed " + money(b.price)}" value="${h(panel.bundlePaid[sku] != null ? panel.bundlePaid[sku] : "")}"></label><button type="button" class="link danger" data-act="bundleDrop" data-id="${h(sku)}">Remove</button></div>`;
  }).join("");
  return rows + (panel.bundlePicking
    ? `<label class="f">Find the bundled item<input id="bundleSearch" autocomplete="off" placeholder="SKU or name" value="${h(panel.bundleQ || "")}"></label><div id="bundleMatches">${bundleMatchesHtml()}</div>`
    : `<button type="button" class="link" data-act="bundlePick">Add bundled item</button>`);
}
function showBundleSplit() {
  const e = $("#bundleSplit"); if (!e) return;
  const ids = saleBundle(), amounts = [$("#payPaid").value, ...ids.map(sku => panel.bundlePaid[sku])].map(parseMoney), payout = parseMoney($("#payOut").value);
  const ready = ids.length && payout != null && !amounts.includes(null);
  e.hidden = !ready;
  if (ready) { const shares = splitPayout(payout, amounts); e.textContent = [panel.id, ...ids].map((sku, i) => sku + " " + money(shares[i])).join(" · "); }
}
function drawBundle() { $("#bundleBox").innerHTML = bundleHtml(); showBundleSplit(); }
// Images stay on the first SKU only, so removing one item's copy can't delete another's. Saving again after a failure repeats the same values.
async function saveBundle(id, ids, amounts, payout, shared, status) {
  const p = panel, go = $("#panel button[type=submit]"), shares = splitPayout(payout, amounts);
  p.bundleId = p.bundleId || id + "-" + Date.now();
  const common = { ...shared, bundleId: p.bundleId, payoutEstimated: false };
  go.disabled = true;
  const main = await patchWithRecords(id, { ...common, paid: amounts[0], payout: shares[0], ...(p.keep ? {} : { status, shippedAt: null }) }, p.drafts || {});
  if (!main) { go.disabled = false; return false; }
  p.drafts = {};
  const saved = await Promise.all(ids.map((sku, i) => { const b = S.items[sku];
    if (!b) return false;
    return patchItem(sku, { ...common, buyer: shared.buyer || b.buyer || null, tracking: shared.tracking || b.tracking || null, paid: amounts[i + 1], payout: shares[i + 1], ...(isSold(b) ? {} : { status, shippedAt: null }) });
  }));
  go.disabled = false;
  const failed = ids.filter((sku, i) => !saved[i]);
  if (failed.length) { if (panel === p) fieldErr("payErr", "Couldn't save " + failed.join(", ") + ". Press the button again to retry."); return false; }
  return panel === p;
}
async function submitSale() {
  const paid = parseMoney($("#payPaid").value), payout = parseMoney($("#payOut").value), bundle = saleBundle(), bundlePaid = bundle.map(sku => parseMoney(panel.bundlePaid[sku]));
  if (paid == null) return fieldErr("payErr", "Enter what it sold for first.");
  if (bundlePaid.includes(null)) return fieldErr("payErr", "Enter what each bundled item sold for first.");
  if (panel.keep && !bundle.length) return fieldErr("payErr", "Add the other item in the bundle first.");
  const amounts = [paid, ...bundlePaid], totalPaid = amounts.reduce((a, v) => a + Math.round(v * 100), 0) / 100;
  if (payout == null) return fieldErr("payErr", "Enter the total payout first.");
  if (payout > totalPaid) return fieldErr("payErr", "The total payout is more than it sold for. Check both numbers.");
  const day = $("#payDate").value;
  if (!day) return fieldErr("payErr", "Pick the sale date first.");
  if (day > today()) return fieldErr("payErr", "The sale date can't be in the future.");
  const id = panel.id, it = S.items[id], buyer = $("#payBuyer").value.trim() || null, tracking = $("#payTracking").value.trim() || null;
  // Heading to Shipped goes through the Shipped popup. Closing that leaves the item in Sold & Packing.
  const target = panel.target || "sold", status = target === "shipped" ? "sold" : target, stay = panel.stay;
  if (bundle.length) {
    const keep = panel.keep;
    if (!await saveBundle(id, bundle, amounts, payout, { buyer, tracking, soldAt: dayToMs(day) }, status)) return;
    if (keep) { openItem(id); return toast("Bundle saved"); }
    if (!stay) { S.q = ""; $("#search").value = ""; S.tab = status; renderList(); }
    return openPanel(target === "shipped" ? { view: "ship", id } : { view: "saleDone", id, bundleTotal: { paid: totalPaid, payout } });
  }
  const payoutEstimated = !!(it && it.payoutEstimated) && payout === it.payout;
  if (await savePopup({ status, paid, payout, payoutEstimated, buyer, tracking, soldAt: dayToMs(day), shippedAt: null })) {
    if (!stay) { S.q = ""; $("#search").value = ""; S.tab = status; renderList(); }
    openPanel(target === "shipped" ? { view: "ship", id } : { view: "saleDone", id });
  }
}
function saleDoneView() {
  const it = S.items[panel.id], total = panel.bundleTotal, also = total ? bundlePartners(it) : [];
  return `<p class="muted">Sold. Pull this one from</p><div class="bigbox">${h(boxName(it))}</div><div class="done-photo">${thumb(it, "big")}</div><div class="bigsku">${h(it.sku)}</div><p class="name">${h(it.name)}</p>
    ${also.length ? `<p class="muted">Also pull</p>${also.map(b => `<div class="row flat">${thumb(b)}<div class="grow">${titleLine(b)}<div class="sub">${h(boxName(b))}</div></div></div>`).join("")}` : ""}<p class="muted">Sold for ${money(total ? total.paid : it.paid)} · Total payout ${money(total ? total.payout : it.payout)}</p><div class="btns"><button class="btn primary" data-act="close" autofocus>Done</button></div>`;
}

/* Mark shipped */
function shipView() {
  const it = S.items[panel.id];
  const also = bundlePartners(it).filter(b => b.status !== "shipped");
  return `<h2>Mark shipped</h2><div class="row flat">${thumb(it)}<div class="grow">${titleLine(it)}<div class="sub">${h(boxName(it))}</div></div></div>${also.length ? `<p class="muted">Also ships ${also.map(b => h(b.sku)).join(", ")}</p>` : ""}<form data-form="ship">
    <label class="f">Ship date<input id="shipDate" type="datetime-local" value="${timeValue()}"></label>
    <label class="f">Tracking number<input id="shipTracking" autocomplete="off" autocapitalize="off" spellcheck="false" value="${h(it.tracking || "")}" autofocus></label>
    ${slotHtml("proof")}
    <p class="err" id="shipErr" hidden></p>
    <button class="btn primary wide" type="submit">Mark shipped</button></form>`;
}
async function submitShip() {
  const shippedAt = parseTime($("#shipDate").value);
  if (shippedAt == null) return fieldErr("shipErr", "Pick the ship date first.");
  if (shippedAt > Date.now()) return fieldErr("shipErr", "The ship date can't be in the future.");
  const id = panel.id, back = panel.back, tracking = $("#shipTracking").value.trim() || null, also = bundlePartners(S.items[id]).filter(b => b.status !== "shipped");
  if (!await savePopup({ status: "shipped", shippedAt, tracking })) return;
  // patchItem shows its own error for any bundled item that fails.
  await Promise.all(also.map(b => patchItem(b.sku, { status: "shipped", shippedAt, tracking: tracking || b.tracking || null })));
  if (back) openItem(id); else closePanel();
  toast(id + (also.length ? " and its bundle are shipped" : " is shipped"));
}

/* Item page */
function itemView() {
  const it = S.items[panel.id], id = h(it.sku), sold = isSold(it), partners = bundlePartners(it);
  return `<div class="sku">${id}</div>
    <div class="f status">Status<div class="chips">${Object.keys(STATUSES).map(k => `<button type="button" class="chip${it.status === k ? " on" : ""}" data-act="setStatus" data-v="${k}">${h(STATUSES[k])}</button>`).join("")}</div></div>
    <div id="photoStrip">${photoStripHtml(it)}</div>
    <button type="button" class="drop small" id="drop" data-act="pickFiles">Drag photos here<small>or click to choose</small></button>
    ${it.driveUrl ? `<a class="link" href="${h(it.driveUrl)}" target="_blank" rel="noopener">Open photos in Google Drive</a>` : ""}
    <label class="f">Name<input data-field="name" autocomplete="off" value="${h(it.name)}"></label>
    <div class="f">Box${chips("itemBox", BOXES, it.box)}</div>
    ${NOT_LISTED.includes(it.status) ? "" : `<label class="f">Listed price<input data-field="price" inputmode="decimal" autocomplete="off" value="${it.price != null ? h(it.price) : ""}"></label><div class="f">Platforms${platformChecks(platformsOf(it))}</div><div class="f">Boosted listing${chips("itemBoost", YES_NO, it.boosted ? "yes" : "no")}</div><label class="f">Listed date<input data-field="listedAt" type="datetime-local" value="${it.listedAt ? timeValue(it.listedAt) : ""}"></label>`}
    ${sold ? `<label class="f">Sold for<input data-field="paid" inputmode="decimal" autocomplete="off" value="${it.paid != null ? h(it.paid) : ""}"></label><label class="f">${partners.length ? "Payout share" : "Total payout"}${it.payoutEstimated ? ' <span class="flag" data-est>Estimated</span>' : ""}<input data-field="payout" inputmode="decimal" autocomplete="off" value="${it.payout != null ? h(it.payout) : ""}"></label>${it.payoutEstimated ? '<button type="button" class="link" data-est data-act="confirmPayout">Payout is correct</button>' : ""}<label class="f">Buyer username<input data-field="buyer" autocomplete="off" autocapitalize="off" spellcheck="false" value="${h(it.buyer || "")}"></label><label class="f">Sale date<input data-field="soldAt" type="date" max="${today()}" value="${h(soldDay(it.soldAt))}"></label><label class="f">Tracking number<input data-field="tracking" autocomplete="off" autocapitalize="off" spellcheck="false" value="${h(it.tracking || "")}"></label>${it.status === "shipped" ? `<label class="f">Ship date<input data-field="shippedAt" type="datetime-local" value="${it.shippedAt ? timeValue(it.shippedAt) : ""}"></label>` : ""}${partners.length ? `<div class="f">Bundled with<div class="bundle-links">${partners.map(b => `<button type="button" class="link" data-act="openItem" data-id="${h(b.sku)}">${h(b.sku)}</button>`).join("")}</div></div>` : `<button type="button" class="link" data-act="logBundle">Log as bundle</button>`}` : ""}
    ${sold || recordIds(it).length ? Object.keys(RECORDS).map(slotHtml).join("") : ""}
    <p class="err" id="itemErr" hidden></p>
    <button class="link danger" data-act="askDelete" data-id="${id}">Delete item</button>`;
}
function photoStripHtml(it) {
  const photos = (it.photos || []).filter(hasPhoto); if (!photos.length) return "";
  const main = photos.find(p => p.id === panel.photo) || photos[0];
  return `<img class="big" data-photo="${h(main.id)}" src="${h(photoSrc(main.id))}" alt=""><div class="thumbs">${photos.map(p => `<div class="thumb"><img data-photo="${h(p.id)}" data-act="showPhoto" data-v="${h(p.id)}" src="${h(photoSrc(p.id))}" alt=""><button type="button" class="thumb-x" data-act="askDropPhoto" data-v="${h(p.id)}" aria-label="Remove photo">×</button></div>`).join("")}</div>`;
}
function renderPhotoStrip(id) { if (panel && panel.view === "item" && panel.id === id) $("#photoStrip").innerHTML = photoStripHtml(S.items[id]); }
const clearEstimated = () => $$("[data-est]").forEach(e => e.remove());
async function saveField(input) {
  const it = S.items[panel.id], field = input.dataset.field, id = panel.id; fieldErr("itemErr", "");
  if (!it) return fieldErr("itemErr", "That item no longer exists, so this wasn't saved.");
  // A failed save puts the field back, so it never shows a value that wasn't saved.
  const save = (patch, shown) => patchItem(id, patch).then(ok => { if (!ok) input.value = shown; return ok; });
  if (field === "name") {
    const v = input.value.trim();
    if (!v) { input.value = it.name; return fieldErr("itemErr", "An item needs a name."); }
    if (v !== it.name) save({ name: v }, it.name);
    return;
  }
  if (field === "buyer" || field === "tracking") {
    const v = input.value.trim() || null;
    if (v !== (it[field] || null)) save({ [field]: v }, it[field] || "");
    return;
  }
  if (field === "soldAt") {
    const day = input.value;
    if (day > today()) { input.value = soldDay(it[field]); return fieldErr("itemErr", "The sale date can't be in the future, so it wasn't saved."); }
    if (day !== soldDay(it[field])) save({ [field]: day ? dayToMs(day) : null }, soldDay(it[field]));
    return;
  }
  if (field === "listedAt" || field === "shippedAt") {
    const was = it[field] ? timeValue(it[field]) : "", ms = input.value ? parseTime(input.value) : null;
    if (ms > Date.now()) { input.value = was; return fieldErr("itemErr", `The ${field === "listedAt" ? "listed" : "ship"} date can't be in the future, so it wasn't saved.`); }
    if (input.value !== was) save({ [field]: ms }, was);
    return;
  }
  const blank = input.value.trim() === "", v = blank ? null : parseMoney(input.value);
  if (!blank && v == null) { input.value = it[field] != null ? it[field] : ""; return fieldErr("itemErr", "That amount isn't a number, so it wasn't saved."); }
  if (v === it[field]) return;
  const shown = it[field] != null ? it[field] : "", sale = { paid: it.paid, payout: it.payout, [field]: v };
  if (field !== "price" && sale.paid != null && sale.payout != null && sale.payout > sale.paid) { input.value = shown; return fieldErr("itemErr", "The total payout is more than it sold for, so it wasn't saved."); }
  save(field === "payout" ? { payout: v, payoutEstimated: false } : { [field]: v }, shown).then(ok => { if (ok && field === "payout") clearEstimated(); });
}

async function saveItemPlatforms() {
  const id = panel.id, platforms = checkedPlatforms();
  if (!await patchItem(id, { platforms, platform: platforms[0] || null }) && panel && panel.id === id && S.items[id]) {
    const on = platformsOf(S.items[id]); $$("[data-plat]").forEach(c => { c.checked = on.includes(c.value); });
  }
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

/* ---------- Depop fee math ---------- */
// From Depop's "Seller fees and charges" and "Boosted Listings Policy" (US, listings from 23 Mar 2026): no selling fee,
// processing is charged on item + shipping + tax, boost on the item price only when a Depop label is used.
// The buyer pays for the label, so shipping and tax raise the processing fee but don't come out of the payout themselves.
const FEE_DEFAULTS = { ratePct: 3.3, fixed: 0.45, boostPct: 12, ship: 5, taxPct: 6, listPrice: 10, sendPrice: 9, acceptPrice: 8, boosted: false, sendOn: false, acceptOn: false };
const RATE_KEYS = ["ratePct", "fixed", "boostPct"];
const F = (() => {
  const raw = localStorage.getItem("mb-fees"); if (!raw) return { ...FEE_DEFAULTS };
  try { return { ...FEE_DEFAULTS, ...JSON.parse(raw) }; }
  catch (e) { console.error("Fee settings unreadable", e); toast("Saved fee settings couldn't be read, so the defaults are showing.", { err: true }); return { ...FEE_DEFAULTS }; }
})();
const saveFees = () => localStorage.setItem("mb-fees", JSON.stringify(F));
const signedMoney = n => n < 0 ? "-" + money(-n) : money(n);
function feeBreakdown(price, boosted = F.boosted) {
  const base = price + F.ship, tax = cents(base * F.taxPct / 100), proc = cents((base + tax) * F.ratePct / 100 + F.fixed), boost = boosted ? cents(price * F.boostPct / 100) : 0;
  return { price, tax, buyer: cents(base + tax), proc, boost, fees: cents(proc + boost), payout: cents(price - proc - boost) };
}
// Fees round to the cent, so an exact payout isn't always possible. This finds the lowest price that pays at least the target.
function priceForPayout(target, boosted) {
  const k = 1 + F.taxPct / 100, r = F.ratePct / 100, b = boosted ? F.boostPct / 100 : 0, den = 1 - r * k - b;
  if (den <= 0) return null;
  const start = Math.max(0, Math.floor((target + F.fixed + r * F.ship * k) / den * 100) - 3);
  for (let c = start; c < start + 8; c++) if (feeBreakdown(c / 100, boosted).payout >= target) return c / 100;
  return null;
}
// Works back from any number in the formula to the item price. Returns null when that number can't happen at these settings.
function solvePrice(field, v, boosted) {
  const k = 1 + F.taxPct / 100, r = F.ratePct / 100, b = boosted ? F.boostPct / 100 : 0;
  const p = field === "payout" ? priceForPayout(v, boosted)
    : field === "proc" ? (v - F.fixed) / (r * k) - F.ship
    : field === "boost" ? v / b
    : field === "fees" ? (v - F.fixed - r * F.ship * k) / (r * k + b)
    : field === "buyer" ? v / k - F.ship : field === "price" ? v : null;
  return p == null || !Number.isFinite(p) || p < 0 ? null : cents(p);
}
const parseNum = v => { const s = String(v).replace(/[$,%\s]/g, ""); return /^(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : null; };

/* ---------- left menu ---------- */
const VIEWS = { inv: "Inventory", table: "Payout Table", calc: "Fee Calculator", sales: "Sales" };
function setView(v) {
  S.view = VIEWS[v] ? v : "inv"; sessionStorage.setItem("mb-view", S.view);
  $("#rail").innerHTML = Object.keys(VIEWS).map(k => `<button class="rail-btn${S.view === k ? " on" : ""}" data-act="view" data-v="${k}"${S.view === k ? ' aria-current="page"' : ""}>${VIEWS[k]}</button>`).join("");
  $("#viewInv").hidden = S.view !== "inv"; $("#viewTool").hidden = S.view === "inv";
  $(".wrap").classList.toggle("wide", S.view === "sales" || S.view === "calc");
  $("#viewTool").innerHTML = S.view === "table" ? tableViewHtml() : S.view === "calc" ? calcViewHtml() : S.view === "sales" ? salesViewHtml() : "";
  if (S.view === "table" || S.view === "calc") drawFees();
  if (S.view === "sales") drawSales();
  scrollTo(0, 0);
}
const feeField = (key, label, suffix = "") => `<label class="f">${label}<input data-fee="${key}" inputmode="decimal" autocomplete="off"${suffix ? ` aria-label="${h(label)} ${suffix}"` : ""}></label>`;
const taxHint = `<p class="muted hint">Tax follows the buyer's state, not yours. Michigan buyers pay 6%.</p>`;

/* Payout Table */
const TABLE_PRICES = [...Array(20).keys()].map(i => i + 1).concat([25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100]);
const tableVals = p => { const a = feeBreakdown(p, false), b = feeBreakdown(p, true); return { buyer: a.buyer, proc: a.proc, payout: a.payout, boost: b.boost, boosted: b.payout }; };
const moneyTd = (key, v, attr = "") => `<td class="${key === "payout" || key === "boosted" ? "strong" : ""}${v < 0 ? " neg" : ""}"${attr}>${signedMoney(v)}</td>`;
const tableKeys = ["buyer", "proc", "payout", "boost", "boosted"];
function tableViewHtml() {
  return `<h2>Payout Table</h2><div class="fee-settings">${feeField("ship", "Shipping buyer pays ($)")}${feeField("taxPct", "Buyer's sales tax (%)")}</div>${taxHint}
    <div class="sheet-wrap"><table class="sheet money-table"><thead><tr><th>Listed</th><th>Buyer pays</th><th>Processing</th><th>Payout</th><th>Boost fee</th><th>Boosted payout</th></tr></thead>
    <tbody><tr class="try"><td><input class="cell" id="tryPrice" inputmode="decimal" autocomplete="off" placeholder="Any price" aria-label="Try any listed price"></td>${tableKeys.map(k => `<td data-try="${k}">—</td>`).join("")}</tr></tbody><tbody id="feeBody"></tbody></table></div>`;
}
function drawTable() {
  $("#feeBody").innerHTML = TABLE_PRICES.map(p => { const v = tableVals(p); return `<tr><td>${money(p)}</td>${tableKeys.map(k => moneyTd(k, v[k])).join("")}</tr>`; }).join("");
  const p = parseMoney($("#tryPrice").value), v = p == null ? null : tableVals(p);
  $$("[data-try]").forEach(td => { const n = v ? v[td.dataset.try] : null; td.textContent = v ? signedMoney(n) : "—"; td.classList.toggle("neg", !!v && n < 0); td.classList.toggle("strong", td.dataset.try === "payout" || td.dataset.try === "boosted"); });
}

/* Fee Calculator: type in any number and the rest follow */
const CALC_ROWS = { list: ["Listed", "listPrice"], send: ["Auto-send offer", "sendPrice"], accept: ["Auto-accept price", "acceptPrice"] };
const calcInputHtml = (key, field) => `<input data-calc="${key}:${field}" inputmode="decimal" autocomplete="off">`;
const calcRow = (key, field, label, cls = "") => `<label class="calc-row${cls}" data-row="${field}"><span>${label}</span><span class="calc-val">$${calcInputHtml(key, field)}</span></label>`;
const calcCheck = (key, label) => `<label class="check"><input type="checkbox" data-toggle="${key}">${label}</label>`;
function calcViewHtml() {
  const off = key => key === "list" ? "" : `<label class="calc-off"><span class="calc-val">${calcInputHtml(key, "off")}%</span> off</label>`;
  const card = key => `<section class="calc-card" data-card="${key}"><div class="calc-head"><h3>${CALC_ROWS[key][0]}</h3>${off(key)}</div>${calcRow(key, "price", "Price", " calc-main")}<div class="calc-fees">${calcRow(key, "proc", "Processing fee")}${calcRow(key, "boost", "Boost fee")}${calcRow(key, "fees", "Total fees")}</div>${calcRow(key, "payout", "Your payout", " calc-main calc-payout")}${calcRow(key, "buyer", "Buyer pays", " calc-buyer")}</section>`;
  return `<h2>Fee Calculator</h2><div class="checks calc-toggles">${calcCheck("boosted", "Boosted")}${calcCheck("sendOn", "Auto-send offers")}${calcCheck("acceptOn", "Auto-accept offers")}</div>
    <div class="calc-cards">${Object.keys(CALC_ROWS).map(card).join("")}</div>
    <p class="warn" id="calcNote" hidden></p>
    <p class="muted hint">Type in any number and the rest update.</p>
    <div class="fee-settings">${feeField("ship", "Shipping buyer pays ($)")}${feeField("taxPct", "Buyer's sales tax (%)")}</div>${taxHint}
    <details class="rates"><summary>Depop rates</summary><div class="fee-settings">${feeField("ratePct", "Processing (%)")}${feeField("fixed", "Flat fee ($)")}${feeField("boostPct", "Boost (%)")}</div><button type="button" class="link" data-act="resetRates">Reset to Depop's rates</button></details>`;
}
function calcNote(msg) { const n = $("#calcNote"); if (n) { n.textContent = msg || ""; n.hidden = !msg; } }
function drawCalc(active) {
  $$("[data-toggle]").forEach(c => { c.checked = !!F[c.dataset.toggle]; });
  $('[data-card="send"]').hidden = !F.sendOn; $('[data-card="accept"]').hidden = !F.acceptOn;
  // Unboosted, the only fee is processing, so the boost and total lines would just repeat it.
  $$('[data-row="boost"], [data-row="fees"]').forEach(r => { r.hidden = !F.boosted; });
  $$("[data-calc]").forEach(el => {
    if (el === active) return;
    const [key, field] = el.dataset.calc.split(":"), price = F[CALC_ROWS[key][1]], b = feeBreakdown(price);
    el.value = field === "off" ? String(F.listPrice > 0 ? Math.round((1 - price / F.listPrice) * 1000) / 10 : 0) : b[field].toFixed(2);
    el.classList.toggle("neg", field === "payout" && b.payout < 0);
  });
}
function drawFees(active) {
  $$("[data-fee]").forEach(el => { if (el !== active) el.value = F[el.dataset.fee]; });
  if (S.view === "table") drawTable(); else if (S.view === "calc") drawCalc(active);
}
function offerWarning() {
  const w = [];
  if (F.sendOn && F.sendPrice > F.listPrice) w.push("Auto-send offer is above the listed price.");
  if (F.acceptOn && F.acceptPrice > F.listPrice) w.push("Auto-accept price is above the listed price.");
  if (F.sendOn && F.acceptOn && F.sendPrice < F.acceptPrice) w.push("Auto-send offer is below your auto-accept price.");
  return w.join(" ");
}
function calcInput(el) {
  const [key, field] = el.dataset.calc.split(":"), priceKey = CALC_ROWS[key][1], v = parseMoney(el.value);
  el.classList.remove("bad"); calcNote("");
  if (el.value.trim() === "") return;
  if (field === "off" ? parseNum(el.value) == null || parseNum(el.value) > 100 : v == null) { el.classList.add("bad"); return calcNote("That isn't a usable number."); }
  const p = field === "off" ? cents(F.listPrice * (1 - parseNum(el.value) / 100)) : solvePrice(field, v, F.boosted);
  if (p == null) { el.classList.add("bad"); return calcNote("That can't happen at these fee settings."); }
  F[priceKey] = p; saveFees(); drawFees(el);
  const got = feeBreakdown(p);
  const off = field !== "off" && field !== "price" && got[field] !== v;
  calcNote([off ? `Fees round to the cent, so the closest is ${money(p)}, which gives ${money(got[field])}.` : "", offerWarning()].filter(Boolean).join(" "));
}
function feeInput(el) {
  const key = el.dataset.fee, v = parseNum(el.value);
  el.classList.remove("bad");
  if (el.value.trim() === "") return;
  if (v == null || (key !== "ship" && key !== "fixed" && v >= 100)) return el.classList.add("bad");
  F[key] = v; saveFees(); drawFees(el);
}

/* Sales sheet: every cell saves to the item, the same as its item page */
const SH = { q: "", plat: "", month: "", sort: "date", dir: -1 };
const SALES_COLS = { date: "Date", sku: "SKU", platform: "Platform", buyer: "Buyer", paid: "Sold for ($)", fees: "Fees", payout: "Total Payout" };
const feesOf = it => it.paid != null && it.payout != null ? cents(it.paid - it.payout) : null;
const salesKey = { date: i => soldDay(i.soldAt) || null, sku: i => String(i.sku), platform: i => PLATFORMS[i.platform] || null, buyer: i => i.buyer ? i.buyer.toLowerCase() : null, paid: i => i.paid, fees: feesOf, payout: i => i.payout };
function salesRows() {
  const q = SH.q.trim().toLowerCase(), key = salesKey[SH.sort];
  return Object.values(S.items).filter(isSold)
    .filter(i => (!q || (i.sku + " " + i.name + " " + (i.buyer || "")).toLowerCase().includes(q)) && (!SH.plat || i.platform === SH.plat) && (!SH.month || soldDay(i.soldAt).startsWith(SH.month)))
    .sort((a, b) => {
      const x = key(a), y = key(b);
      if (x == null || y == null) return x == null && y == null ? newestFirst(a, b) : x == null ? 1 : -1; // blanks stay last in both directions
      const c = typeof x === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
      return (c * SH.dir) || newestFirst(a, b);
    });
}
function salesViewHtml() {
  return `<h2>Sales</h2><div class="tools"><input id="salesQ" type="search" placeholder="Search SKU, name or buyer" autocomplete="off" aria-label="Search sales" value="${h(SH.q)}">
    <select id="salesPlat" aria-label="Platform"><option value="">All platforms</option>${Object.keys(PLATFORMS).map(k => `<option value="${k}"${SH.plat === k ? " selected" : ""}>${PLATFORMS[k]}</option>`).join("")}</select>
    <select id="salesMonth" aria-label="Month"></select>
    <button class="btn" data-act="salesCsv">Export CSV</button><button class="btn primary" data-act="sale">Record sale</button></div>
    <div class="sheet-wrap"><table class="sheet sales-sheet"><thead id="salesHead"></thead><tbody id="salesBody"></tbody><tfoot id="salesFoot"></tfoot></table></div><p class="muted hint" id="salesNote" hidden></p>`;
}
const moneyCell = (it, col, v) => `<td class="${col === "payout" ? "strong" : ""}"><input class="cell${col === "payout" && it.payoutEstimated ? " est" : ""}" data-sheet="${col}" data-id="${h(it.sku)}" inputmode="decimal" autocomplete="off" aria-label="${SALES_COLS[col]}, ${h(it.sku)}" value="${v == null ? "" : Number(v).toFixed(2)}"></td>`;
function salesRowHtml(it) {
  const id = h(it.sku);
  const platforms = (PLATFORMS[it.platform] ? "" : `<option value="" selected></option>`) + Object.keys(PLATFORMS).map(k => `<option value="${k}"${it.platform === k ? " selected" : ""}>${PLATFORMS[k]}</option>`).join("");
  return `<tr><td><input class="cell" type="date" max="${today()}" data-sheet="date" data-id="${id}" aria-label="Date, ${id}" value="${h(soldDay(it.soldAt))}"></td>
    <td class="sku-cell"><button class="link" data-act="openItem" data-id="${id}" title="${h(it.name)}">${id}</button>${it.bundleId ? ' <span class="muted">Bundle</span>' : ""}</td>
    <td><select class="cell" data-sheet="platform" data-id="${id}" aria-label="Platform, ${id}">${platforms}</select></td>
    <td><input class="cell" data-sheet="buyer" data-id="${id}" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Buyer, ${id}" value="${h(it.buyer || "")}"></td>
    ${moneyCell(it, "paid", it.paid)}${moneyCell(it, "fees", feesOf(it))}${moneyCell(it, "payout", it.payout)}</tr>`;
}
function drawSales() {
  if (S.view !== "sales" || !$("#salesBody")) return;
  if (!S.loaded) { $("#salesBody").innerHTML = `<tr><td colspan="7" class="empty">Loading your shop…</td></tr>`; return; }
  // A redraw (often from another device) keeps your place: the same cell stays focused, with anything half typed.
  const a = document.activeElement, spot = a && a.dataset && a.dataset.sheet ? { id: a.dataset.id, col: a.dataset.sheet, typed: a.value !== a.defaultValue ? a.value : null } : null;
  const sold = Object.values(S.items).filter(isSold);
  const months = [...new Set(sold.map(i => soldDay(i.soldAt).slice(0, 7)).filter(Boolean))].sort().reverse();
  const monthName = m => new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1).toLocaleString("en-US", { month: "short", year: "numeric" });
  if (SH.month && !months.includes(SH.month)) SH.month = "";
  const monthHtml = `<option value="">All dates</option>` + months.map(m => `<option value="${m}"${SH.month === m ? " selected" : ""}>${monthName(m)}</option>`).join("");
  if ($("#salesMonth").innerHTML !== monthHtml) $("#salesMonth").innerHTML = monthHtml;
  $("#salesHead").innerHTML = `<tr>${Object.keys(SALES_COLS).map(k => `<th aria-sort="${SH.sort === k ? (SH.dir > 0 ? "ascending" : "descending") : "none"}"><button data-act="salesSort" data-v="${k}">${SALES_COLS[k]}<span>${SH.sort === k ? (SH.dir > 0 ? " ▲" : " ▼") : ""}</span></button></th>`).join("")}</tr>`;
  const rows = salesRows(), sum = f => rows.reduce((t, i) => t + (Number(f(i)) || 0), 0);
  $("#salesBody").innerHTML = rows.length ? rows.map(salesRowHtml).join("") : `<tr><td colspan="7" class="empty">${sold.length ? "No sales match that." : "No sales logged yet."}</td></tr>`;
  $("#salesFoot").innerHTML = `<tr><td colspan="4">${rows.length} ${rows.length === 1 ? "sale" : "sales"}</td><td>${money(sum(i => i.paid))}</td><td>${money(sum(feesOf))}</td><td class="strong">${money(sum(i => i.payout))}</td></tr>`;
  const est = rows.filter(i => i.payoutEstimated).length, note = $("#salesNote");
  note.textContent = est ? `Amber payouts are estimates (${est}). Type the receipt's payout to confirm one.` : ""; note.hidden = !est;
  if (spot) {
    const el = sheetCell(spot.id, spot.col);
    if (el) { if (spot.typed != null) el.value = spot.typed; el.focus({ preventScroll: true }); }
  }
}
const sheetCell = (id, col) => $$(`#salesBody [data-sheet="${col}"]`).find(c => c.dataset.id === id);
// Waits a tick, so Tab or Enter has finished moving to the next cell before the sheet redraws.
let salesTimer = null;
const scheduleSales = () => { clearTimeout(salesTimer); salesTimer = setTimeout(drawSales, 0); };
async function saveSheetCell(el) {
  const it = S.items[el.dataset.id], col = el.dataset.sheet;
  if (!it) return toast("That item no longer exists.", { err: true });
  const refuse = msg => { el.value = el.defaultValue; toast(msg, { err: true }); };
  if (col === "date") {
    if (el.value > today()) return refuse("The sale date can't be in the future, so it wasn't saved.");
    if (el.value !== soldDay(it.soldAt)) await patchItem(it.sku, { soldAt: el.value ? dayToMs(el.value) : null });
    return;
  }
  if (col === "platform") { const others = platformsOf(it).filter(p => p !== el.value); await patchItem(it.sku, { platform: el.value, platforms: [el.value, ...others] }); return; }
  if (col === "buyer") { const v = el.value.trim() || null; if (v !== (it.buyer || null)) await patchItem(it.sku, { buyer: v }); return; }
  const blank = el.value.trim() === "", v = blank ? null : parseMoney(el.value);
  if (!blank && v == null) return refuse("That amount isn't a number, so it wasn't saved.");
  if (col === "fees") {
    if (blank) return refuse("Fees are Sold for minus Total Payout. Clear the payout instead.");
    if (it.paid == null) return refuse("Enter Sold for first, so the fees have something to come out of.");
    if (v > it.paid) return refuse("Fees can't be more than it sold for, so they weren't saved.");
    if (v !== feesOf(it)) await patchItem(it.sku, { payout: cents(it.paid - v), payoutEstimated: false });
    return;
  }
  const sale = { paid: it.paid, payout: it.payout, [col]: v };
  if (sale.paid != null && sale.payout != null && sale.payout > sale.paid) return refuse("The total payout is more than it sold for, so it wasn't saved.");
  if (v !== it[col]) await patchItem(it.sku, col === "payout" ? { payout: v, payoutEstimated: false } : { paid: v });
}
function moveSheetCell(el, dir) {
  const tr = el.closest("tr"), next = dir > 0 ? tr.nextElementSibling : tr.previousElementSibling, to = next && next.querySelector(`[data-sheet="${el.dataset.sheet}"]`);
  if (to) { to.focus(); if (to.select && to.type !== "date") to.select(); } else el.blur();
}
function salesCsv() {
  const safe = v => { const s = String(v == null ? "" : v), t = /^[=+\-@]/.test(s) ? "'" + s : s; return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const num = v => v == null ? "" : Number(v).toFixed(2);
  const lines = [Object.values(SALES_COLS).join(",")].concat(salesRows().map(i => [soldDay(i.soldAt), i.sku, PLATFORMS[i.platform] || "", i.buyer, num(i.paid), num(feesOf(i)), num(i.payout)].map(safe).join(",")));
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" })); a.download = "mackrobytes-sales.csv";
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------- events ---------- */
// Changing a status keeps the current tab, search and scroll position.
async function changeStatus(id, to) {
  const it = S.items[id]; if (!it) return toast("That item no longer exists.", { err: true });
  const wasSold = isSold(it), toSold = SOLD_STATUSES.includes(to);
  const inDrawer = panel && panel.view === "item" && panel.id === id, after = () => inDrawer ? openItem(id) : closePanel();
  if (to === it.status) return;
  if (to === "sold" || (toSold && !wasSold)) return openPanel({ view: "salePay", id, target: to, stay: true });
  if (to === "shipped") return openPanel({ view: "ship", id, back: inDrawer });
  if (to === "listed" && !wasSold) return openPanel({ view: "list", id, platform: it.platform || "depop", stay: true });
  const partners = bundlePartners(it);
  if (wasSold && !toSold) return askConfirm(partners.length ? `Undo this sale? ${partners.map(b => b.sku).join(", ")} stays sold with its share.` : "Undo this sale?", "Undo sale", async () => {
    const ok = await patchItem(id, { status: to, paid: null, payout: null, payoutEstimated: false, bundleId: null, buyer: null, tracking: null, soldAt: null, shippedAt: null, ...(to === "listed" ? {} : { listedAt: null }) });
    if (ok && to === "listed") return openPanel({ view: "list", id, platform: it.platform || "depop", stay: true });
    after();
  }, after);
  const patch = { status: to };
  if (toSold) patch.shippedAt = null;
  else if (it.status === "listed") patch.listedAt = null;
  const ok = await patchItem(id, patch);
  // A bundle leaves together: one item going to dropoff takes the others that are still packing.
  if (ok && to === "dropoff") await Promise.all(partners.filter(b => b.status === "sold").map(b => patchItem(b.sku, { status: "dropoff" })));
  if (ok && inDrawer) openItem(id);
}
const openItem = id => openPanel({ view: "item", id });
const actions = {
  close: closePanel,
  view: t => setView(t.dataset.v),
  salesSort: t => { const k = t.dataset.v; if (SH.sort === k) SH.dir = -SH.dir; else { SH.sort = k; SH.dir = k === "date" || k === "paid" || k === "fees" || k === "payout" ? -1 : 1; } drawSales(); },
  salesCsv: needsShop(salesCsv),
  resetRates: () => { RATE_KEYS.forEach(k => { F[k] = FEE_DEFAULTS[k]; }); saveFees(); drawFees(); },
  tab: t => { S.tab = t.dataset.v; S.q = ""; $("#search").value = ""; renderList(); },
  add: needsShop(() => openPanel({ view: "add" })),
  sale: needsShop(() => openPanel({ view: "salePick" })),
  settings: () => openPanel({ view: "settings" }),
  pickFiles: () => $("#fileIn").click(),
  openItem: t => openItem(t.dataset.id),
  openList: t => openPanel({ view: "list", id: t.dataset.id, platform: (S.items[t.dataset.id] || {}).platform || "depop" }),
  dropFile: t => { const i = +t.dataset.i; URL.revokeObjectURL(panel.urls[i]); panel.files.splice(i, 1); panel.urls.splice(i, 1); $("#dropPreview").innerHTML = previewHtml(); },
  chip: async t => {
    const g = t.dataset.group, v = t.dataset.v;
    if (g === "box" || g === "boosted") { panel[g] = v; $$(`[data-group="${g}"]`).forEach(c => c.classList.toggle("on", c === t)); return; }
    $$(`[data-group="${g}"]`).forEach(c => c.classList.toggle("on", c === t));
    const id = panel.id, boost = g === "itemBoost", field = boost ? "boosted" : "box";
    if (!await patchItem(id, { [field]: boost ? v === "yes" : v }) && panel && panel.id === id && S.items[id]) { const saved = boost ? (S.items[id].boosted ? "yes" : "no") : S.items[id].box; $$(`[data-group="${g}"]`).forEach(c => c.classList.toggle("on", c.dataset.v === saved)); }
  },
  salePick: t => { panel = { view: "salePay", id: t.dataset.id, paid: panel.paid, back: { paid: panel.paid, showToList: panel.showToList } }; openPanel(panel); },
  saleBack: () => openPanel({ view: "salePick", ...panel.back }),
  saleToList: () => { panel.showToList = true; $("#matches").innerHTML = matchesHtml(); },
  logBundle: () => openPanel({ view: "salePay", id: panel.id, keep: true, bundle: [], bundlePaid: {}, bundlePicking: true }),
  bundlePick: () => { panel.bundlePicking = true; drawBundle(); $("#bundleSearch").focus(); },
  bundleAdd: t => {
    const sku = t.dataset.id, b = S.items[sku];
    panel.bundle = [...saleBundle(), sku]; panel.bundlePaid = { ...panel.bundlePaid, [sku]: b && b.paid != null ? b.paid : "" }; panel.bundlePicking = false; panel.bundleQ = "";
    drawBundle(); fieldErr("payErr", "");
    const input = $$("[data-bundle-paid]").find(i => i.dataset.bundlePaid === sku); if (input) input.focus();
  },
  bundleDrop: t => { panel.bundle = saleBundle().filter(sku => sku !== t.dataset.id); drawBundle(); },
  setStatus: t => changeStatus(panel.id, t.dataset.v),
  confirmPayout: async () => { if (await patchItem(panel.id, { payoutEstimated: false })) clearEstimated(); },
  statusMenu: openStatusMenu,
  pickStatus: async t => { const id = $("#statusMenu").dataset.id; closeStatusMenu(); await changeStatus(id, t.dataset.v); if (!panel) focusPill(id); },
  askDelete: t => { const id = t.dataset.id; askConfirm("Delete " + id + "?", "Delete item", async () => {
    const photos = [...((S.items[id] || {}).photos || []).map(p => p.id), ...recordIds(S.items[id] || {})];
    if (await removeItem(id)) { closePanel(); toast(id + " deleted"); deleteStoredPhotos(photos); } else openItem(id);
  }, () => openItem(id)); },
  showPhoto: t => { panel.photo = t.dataset.v; renderPhotoStrip(panel.id); },
  askDropPhoto: t => { const id = panel.id, pid = t.dataset.v; askConfirm("Remove this photo?", "Remove photo", async () => {
    if (await patchItem(id, { photos: ((S.items[id] || {}).photos || []).filter(p => p.id !== pid) })) deleteStoredPhotos([pid]);
    openItem(id);
  }, () => openItem(id)); },
  pickSlot: t => {
    const kind = t.dataset.v, input = document.createElement("input");
    input.type = "file"; input.accept = "image/*";
    input.onchange = () => slotFile(kind, input.files[0]);
    input.click();
  },
  dropDraft: t => { const kind = t.dataset.v; URL.revokeObjectURL(panel.drafts[kind].url); delete panel.drafts[kind]; redrawSlot(kind); },
  viewRecord: t => openPanel({ view: "record", id: panel.id, kind: t.dataset.v }),
  askDropRecord: t => { const id = panel.id, [field, label] = RECORDS[t.dataset.v]; askConfirm("Remove the " + label.toLowerCase() + " image?", "Remove image", async () => {
    const old = (S.items[id] || {})[field];
    if (await patchItem(id, { [field]: null }) && old) deleteStoredPhotos([old.id]);
    openItem(id);
  }, () => openItem(id)); },
  confirmYes: () => panel.fn(),
  confirmNo: () => panel.back(),
  backup: needsShop(saveBackup),
  signOut: () => AUTH.signOut()
};
// A drag that starts inside the panel and ends outside it (selecting text) also clicks the scrim. Only a press that started outside closes it.
let pressOnScrim = false;
document.addEventListener("pointerdown", e => { pressOnScrim = e.target.id === "scrim"; });
document.addEventListener("click", e => {
  // Clicking outside the status menu only closes it.
  if (statusMenuOpen() && !e.target.closest("#statusMenu")) return closeStatusMenu();
  if (e.target.id === "scrim") return pressOnScrim ? closePanel() : undefined;
  if (e.target.type === "date" || e.target.type === "datetime-local") return e.target.showPicker();
  const t = e.target.closest("[data-act]"); if (!t) return;
  const fn = actions[t.dataset.act]; if (fn) fn(t);
});
document.addEventListener("keydown", e => {
  const cell = e.target.dataset && e.target.dataset.sheet ? e.target : null;
  if (cell && e.key === "Escape") { cell.value = cell.defaultValue; cell.blur(); return; }
  if (cell && e.key === "Enter") { e.preventDefault(); moveSheetCell(cell, e.shiftKey ? -1 : 1); return; }
  if (cell && cell.tagName === "INPUT" && (e.key === "ArrowDown" || e.key === "ArrowUp") && cell.type !== "date") { e.preventDefault(); moveSheetCell(cell, e.key === "ArrowDown" ? 1 : -1); return; }
  // Enter in the bundle search picks the top match instead of submitting the sale.
  if (e.key === "Enter" && e.target.id === "bundleSearch") { e.preventDefault(); const top = $("#bundleMatches [data-act='bundleAdd']"); if (top) top.click(); return; }
  if (e.key !== "Escape") return;
  if (statusMenuOpen()) { closeStatusMenu(); focusPill($("#statusMenu").dataset.id); }
  else if (panel) {
    // Saves a field mid-edit first. An amount it refuses keeps the panel open so the message can be read.
    const f = document.activeElement;
    if (f && f.dataset.field && panel.view === "item") { fieldErr("itemErr", ""); f.blur(); if (!$("#itemErr").hidden) return; }
    closePanel();
  }
});
window.addEventListener("resize", closeStatusMenu);
document.addEventListener("submit", e => {
  e.preventDefault();
  const fn = { add: submitAdd, list: submitList, sale: submitSale, ship: submitShip }[e.target.dataset.form]; if (fn) fn();
});
document.addEventListener("input", e => {
  const id = e.target.id;
  if (e.target.dataset.calc) calcInput(e.target);
  if (e.target.dataset.fee) feeInput(e.target);
  if (id === "tryPrice") drawTable();
  if (id === "salesQ") { SH.q = e.target.value; drawSales(); }
  if (id === "search") { S.q = e.target.value; renderList(); }
  if (id === "salePaid") { panel.paid = e.target.value; $("#matches").innerHTML = matchesHtml(); }
  if (id === "listPrice") { fieldErr("listErr", ""); checkDuplicatePrice(); }
  if (id === "addName") { panel.name = e.target.value; fieldErr("addErr", ""); }
  if (id === "listDate") fieldErr("listErr", "");
  if (id === "shipDate") fieldErr("shipErr", "");
  if (id === "payPaid" || id === "payOut" || id === "payDate") fieldErr("payErr", "");
  if (id === "bundleSearch") { panel.bundleQ = e.target.value; $("#bundleMatches").innerHTML = bundleMatchesHtml(); }
  if (e.target.dataset.bundlePaid) { panel.bundlePaid[e.target.dataset.bundlePaid] = e.target.value; fieldErr("payErr", ""); }
  if (id === "payPaid" || id === "payOut" || e.target.dataset.bundlePaid) showBundleSplit();
});
// Leaving a box tidies what was typed (5 becomes 5.00) and puts back anything unusable.
document.addEventListener("focusout", e => { if (e.target.dataset && (e.target.dataset.calc || e.target.dataset.fee)) { e.target.classList.remove("bad"); drawFees(); } });
document.addEventListener("change", e => {
  if (e.target.dataset.sheet) saveSheetCell(e.target);
  if (e.target.dataset.toggle) {
    const k = e.target.dataset.toggle; F[k] = e.target.checked;
    // A new offer starts below the current listed price: 10% off to send, 20% off to accept.
    if (k === "sendOn" && F.sendOn && F.sendPrice > F.listPrice) F.sendPrice = cents(F.listPrice * .9);
    if (k === "acceptOn" && F.acceptOn && F.acceptPrice > F.listPrice) F.acceptPrice = cents(F.listPrice * .8);
    saveFees(); drawFees(); calcNote(offerWarning());
  }
  if (e.target.id === "salesPlat") { SH.plat = e.target.value; drawSales(); }
  if (e.target.id === "salesMonth") { SH.month = e.target.value; drawSales(); }
  if (e.target.dataset.field && panel && panel.view === "item") saveField(e.target);
  if ("plat" in e.target.dataset && panel) { if (panel.view === "item") saveItemPlatforms(); else fieldErr("listErr", ""); }
  if (e.target.id === "fileIn") { handleFiles(e.target.files); e.target.value = ""; }
});
function handleFiles(files) {
  if (!panel) return;
  if (panel.view === "add") addDraftFiles(files);
  else if (panel.view === "item") addPhotos(panel.id, files);
  else if (panel.view === "salePay" || panel.view === "ship") toast("Drop it on one of the image boxes.", { err: true });
}
// A photo dropped outside the drop area must never navigate the app away.
window.addEventListener("dragover", e => { e.preventDefault(); const d = e.target.closest && e.target.closest("#drop, [data-slot]"); $$("#drop, [data-slot]").forEach(x => x.classList.toggle("over", x === d)); });
window.addEventListener("dragleave", e => { if (!e.relatedTarget) $$("#drop, [data-slot]").forEach(x => x.classList.remove("over")); });
window.addEventListener("drop", e => {
  e.preventDefault(); $$("#drop, [data-slot]").forEach(x => x.classList.remove("over"));
  if (!(e.target.closest && e.target.closest("#panel"))) return;
  const files = e.dataTransfer && e.dataTransfer.files;
  if (!files || !files.length) return toast("That didn't come through as a file. Save the photo to your Mac, then drag it in.", { err: true });
  const slot = e.target.closest("[data-slot]");
  if (slot) return slotFile(slot.dataset.slot, files[0]);
  handleFiles(files);
});

/* ---------- start ---------- */
function showFatal(msg) { setView("inv"); S.loaded = false; $("#list").innerHTML = `<div class="empty"><p class="err">${h(msg)}</p><button class="btn" onclick="location.reload()">Reload</button></div>`; }
async function startSync() {
  DB = true; PHOTOS.onReady = refreshPhotos;
  $("#list").innerHTML = `<div class="empty">Loading your shop…</div>`;
  try { await STORE.get("shopmeta", "profile"); }
  catch (e) { console.error("Couldn't set up data", e); return showFatal("Couldn't load your shop. Nothing was lost. Check your connection, then reload."); }
  const fail = () => { $("#syncErr").hidden = false; };
  STORE.watch("shop", m => { $("#syncErr").hidden = true; S.items = sortOldToList(m); S.loaded = true; renderList(); }, fail);
  STORE.watch("shopmeta", m => { S.meta = m.profile || {}; S.metaLoaded = true; }, fail);
}
function startLocal() {
  $("#previewNote").hidden = false;
  const d = JSON.parse(localStorage.getItem("mb-local") || "null");
  if (d && d.format !== 2) return showFatal("This preview's backup is in the old format. Refresh the backup file.");
  if (d) { S.items = d.items || {}; S.meta = d.settings || {}; }
  sortOldToList(S.items);
  S.loaded = S.metaLoaded = true; renderList();
}
function showLogin() {
  const m = $("#login"); m.hidden = false;
  $("#loginForm").onsubmit = async e => {
    e.preventDefault(); const err = $("#loginErr"); err.hidden = true;
    try { await AUTH.signIn($("#loginEmail").value.trim(), $("#loginPw").value); m.hidden = true; startSync(); }
    catch (e) { console.error("Sign-in failed", e); err.textContent = e && e.status === 400 ? "That email and password didn't work." : "Couldn't reach sign-in. Check your connection and try again."; err.hidden = false; }
  };
}
setView(sessionStorage.getItem("mb-view"));
(async () => {
  const configured = window.CONFIG && CONFIG.SUPABASE_URL && !CONFIG.SUPABASE_URL.startsWith("YOUR");
  if (!configured) return startLocal();
  // typeof STORE also throws when store.js ran but the database library was missing, so it stays inside the try.
  try { if (typeof STORE === "undefined") throw new Error("store.js didn't load"); if (await AUTH.session()) startSync(); else showLogin(); }
  catch (e) { console.error("Sign-in check failed", e); showFatal("Couldn't reach your shop. Check your connection, then reload."); }
})();
