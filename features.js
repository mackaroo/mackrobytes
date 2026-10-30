"use strict";
/* Features added when Garage Sort and Declutter & Sell merged into MackroBytes:
   auto SKUs, quick add, weekly listing goal, Claude lookups, swipe navigation,
   and the Sort tab (declutter cards, worth-selling check, ask-first list, donation log, where-is-it). */

/* ---------- SKUs & quick add ---------- */
function skuHead() { return (S.settings.skuPrefix || "MB") + String(new Date().getFullYear() % 100).padStart(2, "0") + "-"; }
function nextSku() {
  const head = skuHead(), yy = new Date().getFullYear() % 100;
  const stored = num(S.settings.skuYear) === yy ? (num(S.settings.skuNext) || 1) : 1;
  const used = Object.values(S.items).map(it => String(it.sku || "")).filter(s => s.startsWith(head)).map(s => parseInt(s.slice(head.length)) || 0);
  return head + String(Math.max(stored, 1 + Math.max(0, ...used))).padStart(4, "0");
}
// Advance the counter when a SKU from the current series gets used.
function useSku(sku) {
  const head = skuHead(); if (!String(sku).startsWith(head)) return;
  const n = parseInt(String(sku).slice(head.length)) || 0, yy = new Date().getFullYear() % 100;
  const cur = num(S.settings.skuYear) === yy ? (num(S.settings.skuNext) || 1) : 1;
  if (n >= cur) saveSettings({ skuYear: yy, skuNext: n + 1 });
}
async function newItem(fields) {
  const sku = nextSku(), id = skuId(sku);
  await saveItem(id, { sku, box: "hobby", stage: "intake", createdAt: Date.now(), ...fields }, { create: true });
  useSku(sku); return id;
}
// "Tinker Bell lamp $25" -> item named "Tinker Bell lamp" priced $25 on eBay.
async function quickAdd(text) {
  text = String(text || "").trim(); if (!text) return;
  const m = text.match(/^(.*?)\s*\$\s*(\d+(?:\.\d{1,2})?)\s*$/);
  const name = (m ? m[1] : text).trim(), price = m ? +m[2] : null;
  if (!name) { toast("Type what it is first."); return; }
  const id = await newItem({ name, ...(price != null ? { prices: { ebay: price } } : {}) });
  toast("Added " + S.items[id].sku, { label: "Open", fn: () => openDetail(id) });
}
function quickAddHTML(ph) {
  return `<form class="quick" data-quick><input type="text" name="q" placeholder="${h(ph || "Quick add: Tinker Bell lamp $25")}" aria-label="Quick add an item" enterkeyhint="done" autocomplete="off"><button class="btn primary" type="submit">Add</button></form>`;
}
document.addEventListener("submit", e => {
  const f = e.target.closest("[data-quick]"); if (!f) return;
  e.preventDefault(); const inp = f.querySelector("input"); quickAdd(inp.value); inp.value = "";
});

/* ---------- weekly listing goal ---------- */
function weekStart(d = new Date()) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return +x; }
function listedThisWeek() {
  const t0 = weekStart(); let n = 0;
  for (const it of Object.values(S.items)) { const pl = it.plat || {}; if (Object.values(pl).some(x => x && x.listedAt && x.listedAt >= t0)) n++; }
  return n;
}
function goalCardHTML() {
  const goal = Math.max(1, num(S.settings.weeklyGoal) || 3), n = listedThisWeek(), pct = Math.min(1, n / goal);
  const C = 2 * Math.PI * 32, toList = Object.values(S.items).filter(it => ["intake", "photographed", "drafted"].includes(it.stage || "intake")).length;
  const left = Math.max(0, goal - n), days = 7 - ((new Date().getDay() + 6) % 7);
  return `<section class="card goal"><div style="min-width:0"><div class="eyebrow">This week</div><h2>${n >= goal ? "Goal met. Nice work!" : left + " more to list"}</h2>
    <p class="small" style="margin:4px 0 10px;opacity:.9">${n} of ${goal} listed · ${days} day${days > 1 ? "s" : ""} left · ${toList} waiting to list</p>
    <button class="btn sm" data-act="stagejump" data-v="drafted">What's ready?</button></div>
    <svg class="ring" viewBox="0 0 80 80" role="img" aria-label="${n} of ${goal} listed this week"><circle class="bgc" cx="40" cy="40" r="32"/><circle class="fg" cx="40" cy="40" r="32" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - pct)).toFixed(1)}" transform="rotate(-90 40 40)"/><text x="40" y="47" text-anchor="middle">${Math.round(pct * 100)}%</text></svg></section>`;
}

/* ---------- Claude lookup (copy & paste, Claude searches the web) ---------- */
const needsLookup = it => it.lookup !== "done" && it.lookup !== "notfound" && ["intake", "photographed", "drafted"].includes(it.stage || "intake");
function lookupPrompt(list) {
  return `You are a product researcher for a reseller. Use web search to identify each item below exactly. Prefer the manufacturer's page, then a major retailer (Amazon, Target, Walmart, Best Buy). Never guess: if you can't pin down the exact product, set "found" to false and say in "note" what detail would identify it (model number, character name, etc.).

ITEMS (SKU, the seller's name for it, and anything already known):
${JSON.stringify(list.map(([id, it]) => ({ sku: it.sku || id, name: it.name, brand: it.brand, model: it.model, notes: it.condNotes })), null, 1)}

Reply with ONLY one JSON object in exactly this shape:
{"items":[{"sku":"...","found":true,"official":"official product title","brand":"...","model":"model or part number","category":"short product type","material":"...","color":"...","dims":"L x W x H in","weightOz":0,"source":"https://page-you-used","note":""}]}
Leave a field as "" (or null for weightOz) when the source doesn't say.`;
}
function parseDims(s) { const m = String(s || "").match(/([\d.]+)\s*[x×]\s*([\d.]+)\s*[x×]\s*([\d.]+)/i); return m ? { l: +m[1], w: +m[2], h: +m[3] } : null; }
async function runLookup(ids) {
  const list = ids.map(id => [id, S.items[id]]).filter(([, it]) => it);
  if (!list.length) { toast("Nothing to look up."); return; }
  let res; try { res = await ai({ prompt: lookupPrompt(list), json: true }); } catch (e) { if (e && e.code !== "cancelled") toast(aiMsg(e)); return; }
  const rows = (res && res.items) || []; let filled = 0, missed = 0;
  for (const r of rows) {
    const id = list.map(x => x[0]).find(k => (S.items[k].sku || k) === r.sku); if (!id) continue; const it = S.items[id];
    if (!r.found) { missed++; await saveItem(id, { lookup: "notfound", lookupNote: r.note || "", lookupAt: Date.now() }, { quiet: true }); continue; }
    const p = { lookup: "done", lookupAt: Date.now(), lookupSrc: r.source || "", lookupNote: r.note || "", official: r.official || it.official || "" };
    for (const k of ["brand", "model", "category", "material", "color"]) if (r[k] && !it[k]) p[k] = r[k];
    if (r.weightOz && num(it.weightOz) == null) p.weightOz = +r.weightOz;
    const d = parseDims(r.dims); if (d && !(it.dims && num(it.dims.l))) p.dims = d;
    if (r.official && !it.origName && it.name !== r.official) { p.origName = it.name; p.name = r.official; }
    await saveItem(id, p, { quiet: true }); filled++;
  }
  toast(`Lookup: ${filled} filled${missed ? ", " + missed + " not found" : ""}.`);
}
function lookupCardHTML() {
  const ids = Object.entries(S.items).filter(([, it]) => needsLookup(it)).map(([id]) => id);
  if (!ids.length) return "";
  return `<section class="card"><div class="card-h"><h2>Look items up</h2><span class="sp pill on">${ids.length} waiting</span></div>
    <p class="small muted">Claude searches the web for the official title, brand, model, material, color, size and weight, and fills in whatever's blank.</p>
    <div class="btns"><button class="btn primary" data-act="lookupAll">Look up ${Math.min(ids.length, 15)} item${ids.length > 1 ? "s" : ""}</button></div></section>`;
}
function lookupInfoHTML(it) {
  const st = it.lookup === "done" ? `Found${it.lookupSrc ? ` · <a href="${h(it.lookupSrc)}" target="_blank" rel="noopener">source</a>` : ""}` : it.lookup === "notfound" ? "Not found" : "Not looked up yet";
  return `<div class="card-h"><span class="small muted">Lookup: ${st}</span><button class="btn sm sp" data-act="lookupOne">${it.lookup ? "Look up again" : "Look it up"}</button></div>
    ${it.lookupNote ? `<p class="small muted" style="margin:0">${h(it.lookupNote)}</p>` : ""}${it.origName ? `<p class="small muted" style="margin:0">Your name for it: ${h(it.origName)}</p>` : ""}`;
}
document.addEventListener("click", e => {
  const t = e.target.closest("[data-act]"); if (!t) return;
  if (t.dataset.act === "lookupAll") runLookup(Object.entries(S.items).filter(([, it]) => needsLookup(it)).slice(0, 15).map(([id]) => id));
  if (t.dataset.act === "lookupOne" && S.open) runLookup([S.open]);
});

/* ---------- swipe between tabs ---------- */
const TAB_ORDER = ["today", "items", "add", "sort", "profit"];
function goTab(k, dir) {
  S.tab = k; renderTabs(); window.scrollTo(0, 0); const m = $("#main");
  m.classList.remove("swipe-l", "swipe-r"); if (dir) { void m.offsetWidth; m.classList.add(dir > 0 ? "swipe-l" : "swipe-r"); }
  render();
}
(() => {
  let x0 = null, y0 = 0, t0 = 0;
  const blocked = el => el.closest("input, textarea, select, .chips, .scroll-x, .photos, canvas, .pipe, [data-noswipe]");
  document.addEventListener("touchstart", e => {
    if (e.touches.length !== 1 || !$("#sheet").hidden || !$("#modal").hidden || !$("#sorter").hidden || blocked(e.target)) { x0 = null; return; }
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now();
  }, { passive: true });
  document.addEventListener("touchend", e => {
    if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0; x0 = null;
    if (Math.abs(dx) < 70 || Math.abs(dx) < 1.6 * Math.abs(dy) || Date.now() - t0 > 700) return;
    const i = TAB_ORDER.indexOf(S.tab); if (i < 0) return;
    const j = i + (dx < 0 ? 1 : -1); if (j >= 0 && j < TAB_ORDER.length) goTab(TAB_ORDER[j], dx < 0 ? 1 : -1);
  }, { passive: true });
})();
// Swipe right from the left edge closes an open item, like iOS back.
(() => {
  let x0 = null, y0 = 0;
  document.addEventListener("touchstart", e => { const t = e.touches[0]; x0 = !$("#sheet").hidden && t.clientX < 30 ? t.clientX : null; y0 = t.clientY; }, { passive: true });
  document.addEventListener("touchend", e => { if (x0 == null) return; const t = e.changedTouches[0]; if (t.clientX - x0 > 80 && Math.abs(t.clientY - y0) < 60) closeDetail(); x0 = null; }, { passive: true });
})();

/* ---------- Sort tab: declutter ---------- */
const DEC = {
  keep: { label: "Keep", hint: "swipe right" }, storage: { label: "Storage", hint: "" }, sell: { label: "Sell", hint: "swipe up" },
  donate: { label: "Donate", hint: "swipe left" }, trash: { label: "Trash", hint: "swipe down" }, ask: { label: "Ask first", hint: "" }
};
const DEC_ORDER = ["keep", "storage", "sell", "donate", "trash", "ask"];
const SIZES = { small: ["Small", "fits in a shoebox", 10], medium: ["Medium", "fits in a moving box", 32], large: ["Large", "bigger than that", 96] };
const SORT = { f: "all", q: "", hist: [], skipped: new Set(), cur: null, pending: null };
const lsGet = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const thingName = t => (t.name || "").trim() || "Untitled";
const thingThumb = t => t.photo ? `<img class="thumb" src="${h(photoSrc(t.photo))}" alt="" loading="lazy">` : `<div class="thumb">no photo</div>`;
async function saveThing(id, patch) { S.things[id] = { ...(S.things[id] || {}), ...patch, updatedAt: Date.now() }; renderSoon(); if (!$("#sorter").hidden) renderSorter(); await putDoc("things", id, S.things[id], true); }
async function addThingPhotos(files) {
  if (!files.length) return; toast("Saving " + files.length + " photo(s)…"); let n = 0;
  for (const f of files) {
    try { const blob = await fileToJpeg(f, 1600, 0.85); const id = "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      await saveThing(id, { photo: { id: await storePhoto(blob), at: Date.now() }, bin: lsGet("mb-bin", ""), decision: "undecided", createdAt: Date.now() + n }); n++; }
    catch { toast("A photo couldn't be saved. Try a different one."); }
  }
  toast(n + " added to sort" + (LOCAL ? " (preview only)" : ""), { label: "Sort now", fn: openSorter });
}
const undecided = () => Object.entries(S.things).filter(([, t]) => (t.decision || "undecided") === "undecided").sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));
const thingsBy = d => Object.entries(S.things).filter(([, t]) => t.decision === d);

function sortViewHTML() {
  const all = Object.values(S.things), waiting = undecided().length, bin = lsGet("mb-bin", "");
  const counts = Object.fromEntries(DEC_ORDER.map(d => [d, all.filter(t => t.decision === d).length]));
  const decided = all.length - waiting, pct = all.length ? Math.round(decided / all.length * 100) : 0;
  const donPile = thingsBy("donate").filter(([, t]) => !t.done), trash = thingsBy("trash").filter(([, t]) => !t.done), ask = thingsBy("ask");
  const yr = new Date().getFullYear(); const dons = Object.entries(S.donations).filter(([, d]) => String(d.date || "").startsWith(String(yr))).sort((a, b) => (b[1].date || "").localeCompare(a[1].date || ""));
  const q = SORT.q.toLowerCase();
  const found = q ? Object.entries(S.things).filter(([, t]) => ["keep", "storage"].includes(t.decision) && [t.name, t.location, t.bin].join(" ").toLowerCase().includes(q)) : [];
  const filt = SORT.f !== "all" ? thingsBy(SORT.f) : [];
  return `<h1>Sort</h1>
  <section class="card goal"><div style="min-width:0"><div class="eyebrow">Declutter</div><h2>${waiting ? waiting + " waiting to sort" : all.length ? "All sorted!" : "Start with a photo"}</h2>
    <p class="small" style="margin:4px 0 10px;opacity:.9">${all.length ? `${decided} of ${all.length} decided · ${counts.donate + counts.trash} leaving the house` : "Snap one photo per thing, then swipe to decide."}</p>
    <div class="btns">${waiting ? `<button class="btn sm" data-act="sortGo">Start sorting</button>` : ""}<button class="btn sm" data-act="thingCam">Snap photos</button><button class="btn sm" data-act="thingLib">From library</button></div></div>
    <svg class="ring" viewBox="0 0 80 80" aria-hidden="true"><circle class="bgc" cx="40" cy="40" r="32"/><circle class="fg" cx="40" cy="40" r="32" stroke-dasharray="201.1" stroke-dashoffset="${(201.1 * (1 - pct / 100)).toFixed(1)}" transform="rotate(-90 40 40)"/><text x="40" y="47" text-anchor="middle">${pct}%</text></svg></section>
  <section class="card"><div class="grid2" style="align-items:end"><label class="f">Bin or area you're sorting<input type="text" id="sortBin" value="${h(bin)}" placeholder="e.g. Tub 1, hall closet"></label><button class="btn" data-act="nextBin">Next bin →</button></div>
    <p class="small muted" style="margin:0">New photos get tagged with this so you know where things came from.</p></section>
  <div class="tiles">${DEC_ORDER.map(d => `<button class="tile d-${d}" data-act="sortF" data-v="${d}" aria-pressed="${SORT.f === d}"><span class="blob"></span><b>${counts[d]}</b><span>${DEC[d].label}</span></button>`).join("")}</div>
  ${SORT.f !== "all" ? `<section class="card"><div class="card-h"><h2>${DEC[SORT.f].label}</h2><button class="btn sm sp" data-act="sortF" data-v="all">Close</button></div>${filt.length ? `<div class="list">${filt.map(([id, t]) => thingRow(id, t)).join("")}</div>` : `<p class="small muted">Nothing here yet.</p>`}</section>` : ""}
  ${ask.length ? `<section class="card"><div class="card-h"><h2>Ask first</h2><span class="sp pill warn">${ask.length}</span></div><p class="small muted" style="margin:0">Not your call. Show these to whoever owns them, then tap their answer.</p>
    <div class="list">${ask.map(([id, t]) => `<div class="checkrow" style="grid-template-columns:44px minmax(0,1fr)">${thingThumb(t)}<div style="min-width:0"><div class="t" style="font-weight:700">${h(thingName(t))}</div><div class="small muted">Ask ${h(t.owner || "them")}${t.bin ? " · from " + h(t.bin) : ""}</div>
      <div class="btns" style="margin-top:6px">${["keep", "sell", "donate", "trash"].map(d => `<button class="btn sm" data-act="decide" data-id="${h(id)}" data-v="${d}">${DEC[d].label}</button>`).join("")}</div></div></div>`).join("")}</div></section>` : ""}
  <section class="card"><div class="card-h"><h2>Donate pile</h2><span class="sp muted small">${donPile.length} item${donPile.length === 1 ? "" : "s"}</span></div>
    ${donPile.length ? `<div class="list">${donPile.map(([id, t]) => thingRow(id, t, true)).join("")}</div><button class="btn primary" data-act="donLog">Log a drop-off</button>` : `<p class="small muted">Things you mark Donate collect here until you drop them off.</p>`}</section>
  <section class="card"><div class="card-h"><h2>Trash & recycling</h2><span class="sp muted small">${trash.length} left</span></div>
    ${trash.length ? `<div class="list">${trash.map(([id, t]) => `<label class="checkrow"><input type="checkbox" data-trash="${h(id)}">${thingThumb(t)}<span class="t">${h(thingName(t))}</span><span></span></label>`).join("")}</div><p class="small muted" style="margin:0">Tick each one once it's out the door.</p>` : `<p class="small muted">Nothing waiting for the bin.</p>`}</section>
  <section class="card"><h2>Where is it?</h2><input type="text" id="whereQ" value="${h(SORT.q)}" placeholder="Search kept things: name, room, tub" aria-label="Search kept things">
    ${q ? (found.length ? `<div class="list">${found.map(([id, t]) => thingRow(id, t)).join("")}</div>` : `<p class="small muted">No kept things match.</p>`) : `<p class="small muted" style="margin:0">Everything you Keep or put in Storage remembers where it went.</p>`}</section>
  <section class="card"><div class="card-h"><h2>Donations ${yr}</h2><span class="sp num">${money(dons.reduce((a, [, d]) => a + (num(d.value) || 0), 0))}</span></div>
    ${dons.length ? `<div class="list">${dons.map(([, d]) => `<div class="finding" style="grid-template-columns:minmax(0,1fr) auto"><div><div style="font-weight:700">${h(d.place || "Donation")}</div><div class="small muted">${h(d.date)} · ${(d.items || []).length} items</div></div><span class="num">${money(num(d.value) || 0)}</span></div>`).join("")}</div>` : `<p class="small muted">Each drop-off you log is saved for taxes and shows on the Money tab.</p>`}</section>`;
}
function thingRow(id, t, withValue) {
  const where = t.decision === "keep" || t.decision === "storage" ? (t.location || "No spot set") : t.decision === "sell" && t.itemId ? "Listed as " + ((S.items[t.itemId] || {}).sku || "item") : t.bin ? "From " + t.bin : "";
  return `<button class="row-item" data-act="thingOpen" data-id="${h(id)}">${thingThumb(t)}<div style="min-width:0"><div class="t">${h(thingName(t))}</div><div class="m"><span class="dpill d-${t.decision || "undecided"}">${h((DEC[t.decision] || { label: "To sort" }).label)}</span><span class="small muted">${h(where)}</span></div></div><div class="r">${withValue && num(t.value) ? money(num(t.value)) : ""}</div></button>`;
}

/* sorter overlay */
function openSorter(startId) { SORT.skipped.clear(); SORT.cur = startId || null; $("#sorter").hidden = false; document.body.style.overflow = "hidden"; renderSorter(); }
function closeSorter() { $("#sorter").hidden = true; $("#sorter").innerHTML = ""; document.body.style.overflow = ""; SORT.pending = null; renderSoon(); }
function sorterCurrent() {
  if (SORT.cur && S.things[SORT.cur] && (S.things[SORT.cur].decision || "undecided") === "undecided") return SORT.cur;
  const next = undecided().find(([id]) => !SORT.skipped.has(id)); SORT.cur = next ? next[0] : null; return SORT.cur;
}
function renderSorter() {
  const el = $("#sorter"); if (el.hidden) return;
  if (SORT.pending) { el.innerHTML = followupHTML(); return; }
  const id = sorterCurrent(), left = undecided().length;
  if (!id) { el.innerHTML = `<div class="sorter-top"><button class="btn sm" data-act="sortClose">‹ Done</button></div><div class="sorter-stage"><div class="empty"><h2>${left ? "Only skipped ones left" : "All sorted!"}</h2><p>${left ? "Go back through the ones you skipped?" : "Nice work. Check the Donate and Trash piles on the Sort tab."}</p><div class="btns">${left ? `<button class="btn primary" data-act="sortRestart">Show skipped</button>` : ""}<button class="btn" data-act="sortClose">Back to Sort</button></div></div></div>`; return; }
  const t = S.things[id];
  el.innerHTML = `<div class="sorter-top"><button class="btn sm" data-act="sortClose">‹ Done</button><span class="small muted" style="font-weight:700">${left} left${t.bin ? " · " + h(t.bin) : ""}</span>
    <span style="margin-left:auto" class="btns"><button class="btn sm" data-act="sortUndo" ${SORT.hist.length ? "" : "disabled"}>Undo</button><button class="btn sm" data-act="sortSkip">Skip</button></span></div>
  <div class="sorter-stage"><div class="swipecard" id="swipecard" data-id="${h(id)}">
    ${t.photo ? `<img src="${h(photoSrc(t.photo))}" alt="">` : `<div class="noimg">No photo</div>`}
    <span class="stamp r d-keep">KEEP</span><span class="stamp l d-donate">DONATE</span><span class="stamp u d-sell" style="top:18px">SELL</span><span class="stamp dn d-trash" style="top:auto;bottom:90px">TRASH</span>
    <div class="info"><input type="text" id="thingName" value="${h(t.name || "")}" placeholder="What is it? (optional)" aria-label="Name" enterkeyhint="done"></div></div></div>
  <div class="swipe-hints"><span>← Donate</span><span>↑ Sell · ↓ Trash</span><span>Keep →</span></div>
  <div class="dbtns">${DEC_ORDER.map(d => `<button class="dbtn d-${d}" data-act="decide" data-id="${h(id)}" data-v="${d}">${DEC[d].label}${DEC[d].hint ? `<small>${DEC[d].hint}</small>` : ""}</button>`).join("")}</div>`;
  bindSwipe($("#swipecard"));
}
function bindSwipe(card) {
  let sx = 0, sy = 0, dx = 0, dy = 0, on = false;
  const stamps = { r: card.querySelector(".stamp.r"), l: card.querySelector(".stamp.l"), u: card.querySelector(".stamp.u"), dn: card.querySelector(".stamp.dn") };
  const show = () => { stamps.r.style.opacity = Math.max(0, dx / 100); stamps.l.style.opacity = Math.max(0, -dx / 100); stamps.u.style.opacity = Math.max(0, -dy / 100) * (Math.abs(dx) < 60); stamps.dn.style.opacity = Math.max(0, dy / 120) * (Math.abs(dx) < 60); };
  card.addEventListener("pointerdown", e => { if (e.target.closest("input")) return; on = true; sx = e.clientX; sy = e.clientY; dx = dy = 0; card.setPointerCapture(e.pointerId); card.style.transition = "none"; });
  card.addEventListener("pointermove", e => { if (!on) return; dx = e.clientX - sx; dy = e.clientY - sy; card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)`; show(); });
  const end = () => {
    if (!on) return; on = false; card.style.transition = "transform .25s ease";
    const d = dx > 90 ? "keep" : dx < -90 ? "donate" : dy < -90 ? "sell" : dy > 110 ? "trash" : null;
    if (!d) { card.style.transform = ""; dx = dy = 0; show(); return; }
    card.style.transform = `translate(${dx * 4}px, ${dy * 4}px) rotate(${dx / 8}deg)`;
    setTimeout(() => decide(card.dataset.id, d), 180);
  };
  card.addEventListener("pointerup", end); card.addEventListener("pointercancel", end);
}
// Decisions that need one more answer (where it goes, who to ask, worth selling?) open a follow-up step.
async function decide(id, d) {
  const t = S.things[id]; if (!t) return;
  const nm = $("#thingName"); if (nm && nm.closest(`[data-id="${CSS.escape(id)}"]`) && nm.value.trim() !== (t.name || "")) t.name = nm.value.trim();
  if (d === "keep" || d === "storage" || d === "ask" || d === "sell") { SORT.pending = { id, d }; if ($("#sorter").hidden) openSorter(id); else renderSorter(); return; }
  await commit(id, { decision: d, name: t.name || "" });
}
async function commit(id, patch) {
  const t = S.things[id]; SORT.hist.push({ id, prev: { decision: t.decision || "undecided", location: t.location || "", owner: t.owner || "", itemId: t.itemId || null, name: t.name || "" } });
  SORT.pending = null; SORT.cur = null; await saveThing(id, { ...patch, decidedAt: Date.now() });
}
function recentLocations() { const seen = new Map(); Object.values(S.things).filter(t => t.location).sort((a, b) => (b.decidedAt || 0) - (a.decidedAt || 0)).forEach(t => { if (!seen.has(t.location)) seen.set(t.location, 1); }); return [...seen.keys()].slice(0, 8); }
function followupHTML() {
  const { id, d } = SORT.pending, t = S.things[id];
  const head = `<div class="sorter-top"><button class="btn sm" data-act="fuBack">‹ Back</button><span class="small muted" style="font-weight:700">${h(thingName(t))}</span></div>`;
  const pic = t.photo ? `<img class="thumb" style="width:72px;height:72px" src="${h(photoSrc(t.photo))}" alt="">` : "";
  if (d === "keep" || d === "storage") {
    const locs = recentLocations(), dflt = d === "storage" ? ["Storage unit", "Basement", "Garage shelf"] : ["My bedroom", "Office", "Kitchen", "Closet"];
    return head + `<div class="sorter-stage"><section class="card" style="width:min(100%,440px)"><div class="card-h">${pic}<h2>Where does it go?</h2></div>
      <div class="chips" style="flex-wrap:wrap">${[...new Set([...locs, ...dflt])].map(l => `<button class="chip" data-act="fuLoc" data-v="${h(l)}">${h(l)}</button>`).join("")}</div>
      <label class="f">Or type a spot<input type="text" id="fuLoc" placeholder="${d === "storage" ? "e.g. Storage unit, Tub 4" : "e.g. Bedroom closet, top shelf"}" enterkeyhint="done"></label>
      <div class="btns"><button class="btn primary" data-act="fuLoc" data-v="">Save</button><button class="btn" data-act="fuLoc" data-v="-">Skip</button></div></section></div>`;
  }
  if (d === "ask") return head + `<div class="sorter-stage"><section class="card" style="width:min(100%,440px)"><div class="card-h">${pic}<h2>Whose call is it?</h2></div>
      <div class="tiles">${["Mom", "Dad", "Both", "Someone else"].map(o => `<button class="tile d-ask" data-act="fuOwner" data-v="${o}"><span class="blob"></span><b style="font-size:18px">${o}</b></button>`).join("")}</div></section></div>`;
  // sell: worth-selling check
  const w = SORT.pending;
  return head + `<div class="sorter-stage" style="overflow-y:auto"><section class="card" style="width:min(100%,460px)"><div class="card-h">${pic}<h2>Worth selling?</h2></div>
    <label class="f">What would it sell for? $<input type="number" id="wsPrice" inputmode="decimal" step="1" value="${h(w.price ?? t.value ?? "")}" placeholder="Guess, or check eBay sold"></label>
    <a class="btn sm" target="_blank" rel="noopener" href="https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(t.name || "")}&LH_Sold=1&LH_Complete=1">Check eBay sold prices ↗</a>
    <div class="eyebrow">Size to ship</div><div class="chips" style="flex-wrap:wrap">${Object.entries(SIZES).map(([k, [n, d2]]) => `<button class="chip" data-act="wsSize" data-v="${k}" aria-pressed="${(w.size || "small") === k}">${n} <span class="muted small">${d2}</span></button>`).join("")}</div>
    <div id="wsOut">${worthHTML()}</div></section></div>`;
}
function worthCalc() {
  const w = SORT.pending, price = num(w.price), oz = SIZES[w.size || "small"][2];
  if (price == null) return null;
  const sp = shipPlan({ weightOz: oz, box: w.size === "large" ? "fragile" : "hobby" });
  const eb = netFor("ebay", { price, ship: 0, label: sp.cost || 0, pkg: pkgCost(sp.pkg) }), fb = netFor("fb", { price, local: true });
  const best = Math.max(eb.net, fb.net), min = num(S.settings.sellMin) || 12;
  return { price, oz, eb, fb, best, min, ok: best >= min };
}
function worthHTML() {
  const r = worthCalc(); if (!r) return `<p class="small muted">Enter a price to see what you'd actually keep after fees and shipping.</p>`;
  return `<div class="offer-res"><div class="verdict ${r.ok ? "good" : "bad"}">${r.ok ? "Worth listing" : "Probably donate"}</div>
    <div class="small">eBay with free shipping: you keep <b>${money(r.eb.net)}</b> (fees ${money(r.eb.fees)}, label ~${money(r.eb.label)})<br>FB local pickup: you keep <b>${money(r.fb.net)}</b></div>
    <div class="small muted">${r.ok ? "Above your " + money(r.min) + " cutoff." : "Under your " + money(r.min) + " cutoff, so the time to photograph, list and ship probably isn't worth it."}</div></div>
    <div class="btns"><button class="btn ${r.ok ? "primary" : ""}" data-act="wsSell">Sell it</button><button class="btn ${r.ok ? "" : "primary"}" data-act="wsDonate">Donate instead</button></div>`;
}
async function sellThing() {
  const { id } = SORT.pending, t = S.things[id], r = worthCalc();
  const itemId = await newItem({ name: t.name || "Untitled item", stage: t.photo ? "photographed" : "intake", photos: t.photo ? [t.photo] : [],
    ...(r ? { prices: { ebay: r.price, fb: r.price }, weightOz: r.oz } : {}), condNotes: t.bin ? "From " + t.bin : "", fromThing: id });
  await commit(id, { decision: "sell", itemId, value: r ? r.price : t.value || null });
  toast("Added " + S.items[itemId].sku + " to Items", { label: "Open", fn: () => { closeSorter(); openDetail(itemId); } });
}

/* donation drop-off */
function donLogHTML() {
  const pile = thingsBy("donate").filter(([, t]) => !t.done);
  return `<div class="modal-card" role="dialog" aria-label="Log a drop-off"><div class="card-h"><h2>Log a drop-off</h2><button class="btn sm ghost sp" data-act="mclose">Cancel</button></div>
    <div class="grid2"><label class="f">Where<input type="text" id="donPlace" placeholder="e.g. Goodwill, White Lake" value="${h(lsGet("mb-donplace", ""))}"></label><label class="f">Date<input type="date" id="donDate" value="${today()}"></label></div>
    <p class="small muted" style="margin:0">Untick anything you didn't drop off. Values are what each would sell for at a thrift store (fair market value), for your tax records.</p>
    <div class="list">${pile.map(([id, t]) => `<label class="checkrow" style="grid-template-columns:26px 44px minmax(0,1fr) 88px"><input type="checkbox" data-don="${h(id)}" checked>${thingThumb(t)}<span class="t">${h(thingName(t))}</span><input type="number" inputmode="decimal" step="1" data-donval="${h(id)}" value="${h(t.value ?? "")}" placeholder="$"></label>`).join("")}</div>
    <button class="btn primary" data-act="donSave">Save drop-off</button></div>`;
}
async function saveDonation() {
  const ids = $$("[data-don]").filter(c => c.checked).map(c => c.dataset.don); if (!ids.length) { toast("Tick at least one item."); return; }
  const place = $("#donPlace").value.trim(), date = $("#donDate").value || today(); lsSet("mb-donplace", place);
  const items = ids.map(id => { const v = num($(`[data-donval="${CSS.escape(id)}"]`).value); return { id, name: thingName(S.things[id]), value: v }; });
  const did = "d" + Date.now().toString(36), value = items.reduce((a, x) => a + (x.value || 0), 0);
  S.donations[did] = { date, place, items, value, createdAt: Date.now() }; await putDoc("donations", did, S.donations[did], true);
  for (const x of items) await saveThing(x.id, { done: true, doneAt: Date.now(), donationId: did, value: x.value });
  $("#modal").hidden = true; $("#modal").innerHTML = ""; toast("Drop-off saved: " + items.length + " items, " + money(value));
}
function donationsCardHTML() {
  const yr = String(new Date().getFullYear()); const d = Object.values(S.donations).filter(x => String(x.date || "").startsWith(yr));
  if (!d.length) return "";
  const total = d.reduce((a, x) => a + (num(x.value) || 0), 0), n = d.reduce((a, x) => a + (x.items || []).length, 0);
  return `<section class="card"><div class="card-h"><h2>Donations ${yr}</h2><span class="sp num">${money(total)}</span></div>
    <p class="small muted" style="margin:0">${n} items in ${d.length} drop-off${d.length > 1 ? "s" : ""}. Donated goods are only deductible if you itemize. Keep the receipts; over $500 in a year also needs Form 8283.</p>
    <div class="btns"><button class="btn sm" data-act="csvDon">Export CSV</button></div></section>`;
}

/* thing editor (from lists) */
function thingSheetHTML(id) {
  const t = S.things[id];
  return `<div class="modal-card" role="dialog" aria-label="Edit"><div class="card-h"><h2>${h(thingName(t))}</h2><button class="btn sm ghost sp" data-act="mclose">Close</button></div>
    ${t.photo ? `<img src="${h(photoSrc(t.photo))}" alt="" style="width:100%;max-height:300px;object-fit:cover;border-radius:18px">` : ""}
    <label class="f">Name<input type="text" data-tf="name" data-id="${h(id)}" value="${h(t.name || "")}"></label>
    <div class="grid2"><label class="f">Where it is now<input type="text" data-tf="location" data-id="${h(id)}" value="${h(t.location || "")}"></label><label class="f">Came from<input type="text" data-tf="bin" data-id="${h(id)}" value="${h(t.bin || "")}"></label></div>
    <div class="eyebrow">Decision</div><div class="chips" style="flex-wrap:wrap">${DEC_ORDER.map(d => `<button class="chip" data-act="decide" data-id="${h(id)}" data-v="${d}" aria-pressed="${t.decision === d}">${DEC[d].label}</button>`).join("")}<button class="chip" data-act="thingReset" data-id="${h(id)}">Back to unsorted</button></div>
    ${t.itemId && S.items[t.itemId] ? `<button class="btn" data-act="open" data-id="${h(t.itemId)}">Open ${h(S.items[t.itemId].sku)} in Items</button>` : ""}
    <div id="thDel"><button class="btn sm danger" data-act="thingDel" data-id="${h(id)}">Delete</button></div></div>`;
}

document.addEventListener("click", async e => {
  const t = e.target.closest("[data-act]"); if (!t) return; const a = t.dataset.act, v = t.dataset.v, id = t.dataset.id;
  const modal = html => { const m = $("#modal"); m.hidden = false; m.innerHTML = html; };
  switch (a) {
    case "sortGo": openSorter(); break;
    case "sortClose": closeSorter(); break;
    case "sortRestart": SORT.skipped.clear(); renderSorter(); break;
    case "sortSkip": if (SORT.cur) SORT.skipped.add(SORT.cur); SORT.cur = null; renderSorter(); break;
    case "sortUndo": { const last = SORT.hist.pop(); if (!last) break; await saveThing(last.id, last.prev); SORT.cur = last.id; SORT.skipped.delete(last.id); renderSorter(); break; }
    case "thingCam": $("#thingCam").click(); break;
    case "thingLib": $("#thingLib").click(); break;
    case "nextBin": { const b = $("#sortBin").value.trim(), m = b.match(/^(.*?)(\d+)\s*$/); const nb = m ? m[1] + (+m[2] + 1) : b ? b + " 2" : "Tub 1"; lsSet("mb-bin", nb); render(); toast("Now sorting " + nb); break; }
    case "sortF": SORT.f = SORT.f === v ? "all" : v; render(); break;
    case "decide": if (!$("#modal").hidden) { $("#modal").hidden = true; $("#modal").innerHTML = ""; } await decide(id, v); break;
    case "fuBack": SORT.pending = null; if (!S.things[SORT.cur] || S.things[SORT.cur].decision !== "undecided") closeSorter(); else renderSorter(); break;
    case "fuLoc": { const loc = v === "-" ? "" : v || $("#fuLoc").value.trim(); const p = SORT.pending; await commit(p.id, { decision: p.d, location: loc, name: S.things[p.id].name || "" }); if (!undecided().length && !SORT.hist.length) closeSorter(); break; }
    case "fuOwner": { const p = SORT.pending; await commit(p.id, { decision: "ask", owner: v, name: S.things[p.id].name || "" }); break; }
    case "wsSize": SORT.pending.size = v; renderSorter(); break;
    case "wsSell": await sellThing(); break;
    case "wsDonate": { const p = SORT.pending, r = worthCalc(); await commit(p.id, { decision: "donate", value: r ? r.price : null, name: S.things[p.id].name || "" }); break; }
    case "donLog": modal(donLogHTML()); break;
    case "donSave": saveDonation(); break;
    case "thingOpen": modal(thingSheetHTML(id)); break;
    case "thingReset": await saveThing(id, { decision: "undecided", done: false }); $("#modal").hidden = true; break;
    case "thingDel": $("#thDel").innerHTML = `<span class="small">Delete this for good?</span> <button class="btn sm danger" data-act="thingDelYes" data-id="${h(id)}">Yes, delete</button>`; break;
    case "thingDelYes": { const th = S.things[id]; delete S.things[id]; $("#modal").hidden = true; renderSoon(); await delDoc("things", id); if (th && th.photo && !th.itemId && ASSETS) ASSETS.delete(th.photo.id).catch(() => {}); break; }
    case "csvDon": { const rows = [["Date", "Place", "Item", "Value"]]; Object.values(S.donations).sort((x, y) => (x.date || "").localeCompare(y.date || "")).forEach(d => (d.items || []).forEach(x => rows.push([d.date, d.place, x.name, x.value]))); saveFile("donations-" + today() + ".csv", csv(rows), "text/csv"); break; }
  }
});
document.addEventListener("input", e => {
  const t = e.target;
  if (t.id === "wsPrice") { SORT.pending.price = t.value; $("#wsOut").innerHTML = worthHTML(); }
  if (t.id === "whereQ") { SORT.q = t.value; clearTimeout(SORT.qt); SORT.qt = setTimeout(() => { render(); const el = $("#whereQ"); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, 250); }
});
document.addEventListener("change", e => {
  const t = e.target;
  if (t.id === "thingCam" || t.id === "thingLib") { const f = [...t.files]; t.value = ""; addThingPhotos(f); }
  if (t.id === "sortBin") lsSet("mb-bin", t.value.trim());
  if (t.dataset.trash) saveThing(t.dataset.trash, { done: true, doneAt: Date.now() });
  if (t.dataset.tf) saveThing(t.dataset.id, { [t.dataset.tf]: t.value.trim() });
  if (t.id === "thingName" && SORT.cur && S.things[SORT.cur]) saveThing(SORT.cur, { name: t.value.trim() });
});
document.addEventListener("keydown", e => {
  if ($("#sorter").hidden || SORT.pending || /INPUT|TEXTAREA/.test(document.activeElement.tagName) || !SORT.cur) return;
  const k = { ArrowRight: "keep", ArrowLeft: "donate", ArrowUp: "sell", ArrowDown: "trash" }[e.key];
  if (k) { e.preventDefault(); decide(SORT.cur, k); }
});
