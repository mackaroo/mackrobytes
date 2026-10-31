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
  await saveItem(id, { sku, box: "", stage: "intake", createdAt: Date.now(), ...fields }, { create: true });
  useSku(sku); return id;
}
async function quickAdd(text) {
  const name = String(text || "").trim(); if (!name) return;
  const id = await newItem({ name });
  toast("Added " + S.items[id].sku, { label: "Open", fn: () => openDetail(id) });
}
function quickAddHTML() {
  return `<form class="quick" data-quick><input type="text" name="q" placeholder="Quick add: Tinker Bell lamp" aria-label="Quick add an item" enterkeyhint="done" autocomplete="off"><button class="btn primary" type="submit">Add</button></form>`;
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
  const C = 2 * Math.PI * 32;
  const left = Math.max(0, goal - n), days = 7 - ((new Date().getDay() + 6) % 7);
  return `<section class="card goal"><div style="min-width:0"><div class="eyebrow">This week</div><h2>${n >= goal ? "Goal met. Nice work!" : left + " more to list"}</h2>
    <p class="small" style="margin:4px 0 10px;opacity:.9">${n}/${goal} · ${days}d left</p>
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
  return fold("lookup", "Look items up", `<div class="btns"><button class="btn primary" data-act="lookupAll">Look up ${Math.min(ids.length, 15)} item${ids.length > 1 ? "s" : ""}</button></div>`, { cls: "slim", badge: `<span class="pill on">${ids.length}</span>` });
}
function lookupInfoHTML(it) {
  const st = it.lookup === "done" ? `Found${/^https?:\/\//i.test(it.lookupSrc || "") ?` · <a href="${h(it.lookupSrc)}" target="_blank" rel="noopener">source</a>` : ""}` : it.lookup === "notfound" ? "Not found" : "Not looked up yet";
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
// Drop the slide class once it has played, so later re-renders don't replay it.
document.addEventListener("animationend", e => { if (e.target.matches("#main > .wrap")) e.target.parentNode.classList.remove("swipe-l", "swipe-r"); });
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

/* ---------- dropdown sections: a card that opens and closes, remembered per device ---------- */
function fold(key, title, body, { open = false, badge = "", cls = "" } = {}) {
  const o = lsGet("mb-fold-" + key, open ? "1" : "0") === "1";
  return `<details class="card fold ${cls}" data-fold="${key}" ${o ? "open" : ""}><summary><h2>${title}</h2>${badge ? `<span class="sp">${badge}</span>` : ""}</summary><div class="fold-body">${body}</div></details>`;
}
// toggle doesn't bubble, so listen in the capture phase.
document.addEventListener("toggle", e => { const d = e.target; if (d.dataset && d.dataset.fold) lsSet("mb-fold-" + d.dataset.fold, d.open ? "1" : "0"); }, true);

// Dropdowns that replaced rows of chips.
document.addEventListener("change", async e => {
  const t = e.target, k = t.dataset && t.dataset.pick; if (!k) return;
  if (k === "period") { S.period = t.value; render(); }
  if (k === "expType") { S.exp.type = t.value; render(); }
  if (k === "wsSize" && SORT.pending) { SORT.pending.size = t.value; renderSorter(); }
  if (k === "decision") {
    if (t.value === "undecided") { await saveThing(t.dataset.id, { decision: "undecided", done: false }); $("#modal").hidden = true; }
    else { $("#modal").hidden = true; $("#modal").innerHTML = ""; await decide(t.dataset.id, t.value); }
  }
});

/* ---------- keyboard (Mac/PC): Esc closes, / searches, 1–5 switch tabs ---------- */
document.addEventListener("keydown", e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if (e.key === "Escape") {
    const btn = ["#modal #mClose", "#modal [data-act=mclose]", "#editor [data-act=edClose]", "#sorter [data-act=fuBack]", "#sorter [data-act=sortClose]", "#sheet [data-act=close]"]
      .map(s => $(s)).find(b => b && !b.closest("[hidden]"));
    if (btn) { e.preventDefault(); if (typing) document.activeElement.blur(); btn.click(); }
    return;
  }
  if (typing || !$("#sheet").hidden || !$("#modal").hidden || !$("#sorter").hidden || !$("#editor").hidden) return;
  if (e.key === "/") { const q = $("#q") || $("#whereQ"); if (q) { e.preventDefault(); const d = q.closest("details"); if (d) d.open = true; q.focus(); } }
  const n = "12345".indexOf(e.key); if (n >= 0) { e.preventDefault(); goTab(TAB_ORDER[n]); }
});
const thingName = t => (t.name || "").trim() || "Untitled";
const thingThumb = t => t.photo ? `<img class="thumb" src="${h(photoSrc(t.photo))}" alt="" loading="lazy">` : `<div class="thumb">${t.shot ? "#" + t.shot : "no photo"}</div>`;
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
  const found = q ? Object.entries(S.things).filter(([, t]) => ["keep", "storage"].includes(t.decision) && [t.name, t.location, t.bin, t.shot ? "#" + t.shot : ""].join(" ").toLowerCase().includes(q)) : [];
  const filt = SORT.f !== "all" ? thingsBy(SORT.f) : [];
  return `<h1>Sort</h1>
  <section class="card goal"><div style="min-width:0"><div class="eyebrow">Declutter</div><h2>${waiting ? waiting + " waiting to sort" : all.length ? "All sorted!" : "Start with a photo"}</h2>
    <p class="small" style="margin:4px 0 10px;opacity:.9">${all.length ? `${decided}/${all.length} decided` : ""}</p>
    <div class="btns">${waiting ? `<button class="btn sm" data-act="sortGo">Start sorting</button>` : ""}<button class="btn sm" data-act="thingCam">Snap photos</button><button class="btn sm" data-act="thingLib">Library</button></div></div>
    <svg class="ring" viewBox="0 0 80 80" aria-hidden="true"><circle class="bgc" cx="40" cy="40" r="32"/><circle class="fg" cx="40" cy="40" r="32" stroke-dasharray="201.1" stroke-dashoffset="${(201.1 * (1 - pct / 100)).toFixed(1)}" transform="rotate(-90 40 40)"/><text x="40" y="47" text-anchor="middle">${pct}%</text></svg></section>
  ${garageCardHTML()}
  <div class="tiles">${DEC_ORDER.map(d => `<button class="tile d-${d}" data-act="sortF" data-v="${d}" aria-pressed="${SORT.f === d}"><b>${counts[d]}</b><span>${DEC[d].label}</span></button>`).join("")}</div>
  ${SORT.f !== "all" ? `<section class="card"><div class="card-h"><h2>${DEC[SORT.f].label}</h2><button class="btn sm sp" data-act="sortF" data-v="all">Close</button></div>${filt.length ? `<div class="list">${filt.map(([id, t]) => thingRow(id, t)).join("")}</div>` : `<p class="small muted">Nothing here yet.</p>`}</section>` : ""}
  ${ask.length ? fold("ask", "Ask first", `
    <div class="list">${ask.map(([id, t]) => `<div class="checkrow" style="grid-template-columns:44px minmax(0,1fr)">${thingThumb(t)}<div style="min-width:0"><div class="t" style="font-weight:700">${h(thingName(t))}</div><div class="small muted">Ask ${h(t.owner || "them")}${t.bin ? " · from " + h(t.bin) : ""}</div>
      <div class="btns" style="margin-top:6px">${["keep", "sell", "donate", "trash"].map(d => `<button class="btn sm" data-act="decide" data-id="${h(id)}" data-v="${d}">${DEC[d].label}</button>`).join("")}</div></div></div>`).join("")}</div>`, { open: true, badge: `<span class="pill warn">${ask.length}</span>` }) : ""}
  ${fold("donPile", "Donate pile", `
    ${donPile.length ? `<div class="list">${donPile.map(([id, t]) => thingRow(id, t, true)).join("")}</div><button class="btn primary" data-act="donLog">Log a drop-off</button>` : `<p class="small muted" style="margin:0">Empty.</p>`}`, { badge: `<span class="muted small">${donPile.length}</span>` })}
  ${fold("trash", "Trash & recycling", `
    ${trash.length ? `<div class="list">${trash.map(([id, t]) => `<label class="checkrow"><input type="checkbox" data-trash="${h(id)}">${thingThumb(t)}<span class="t">${h(thingName(t))}</span><span></span></label>`).join("")}</div>` : `<p class="small muted" style="margin:0">Empty.</p>`}`, { badge: `<span class="muted small">${trash.length}</span>` })}
  ${fold("where", "Where is it?", `<input type="search" id="whereQ" value="${h(SORT.q)}" placeholder="Search kept things" aria-label="Search kept things">
    ${q ? (found.length ? `<div class="list">${found.map(([id, t]) => thingRow(id, t)).join("")}</div>` : `<p class="small muted" style="margin:0">No matches.</p>`) : ""}`, { open: !!q })}
  ${fold("dons", "Donations " + yr, `
    ${dons.length ? `<div class="list">${dons.map(([, d]) => `<div class="finding" style="grid-template-columns:minmax(0,1fr) auto"><div><div style="font-weight:700">${h(d.place || "Donation")}</div><div class="small muted">${h(d.date)} · ${(d.items || []).length} items</div></div><span class="num">${money(num(d.value) || 0)}</span></div>`).join("")}</div>` : `<p class="small muted" style="margin:0">None yet.</p>`}`, { badge: `<span class="num">${money(dons.reduce((a, [, d]) => a + (num(d.value) || 0), 0))}</span>` })}`;
}
function thingRow(id, t, withValue) {
  let where = t.decision === "keep" || t.decision === "storage" ? (t.location || "No spot set") : t.decision === "sell" && t.itemId ? "Listed as " + ((S.items[t.itemId] || {}).sku || "item") : t.bin ? "From " + t.bin : "";
  if (t.shot) where = (where ? where + " · " : "") + "Photo #" + t.shot;
  return `<button class="row-item" data-act="thingOpen" data-id="${h(id)}">${thingThumb(t)}<div style="min-width:0"><div class="t">${h(thingName(t))}</div><div class="m"><span class="dpill d-${t.decision || "undecided"}">${h((DEC[t.decision] || { label: "To sort" }).label)}</span><span class="small muted">${h(where)}</span></div></div><div class="r">${withValue && num(t.value) ? money(num(t.value)) : ""}</div></button>`;
}

/* garage mode: log each thing as it's photographed on a separate camera, numbered to match the camera's shot order */
const shotNext = () => Math.max(1, parseInt(lsGet("mb-shot", "1")) || 1);
const setShot = n => lsSet("mb-shot", String(Math.max(1, n)));
function knownBins() {
  const seen = new Map(), add = (b, at) => { b = String(b || "").trim(); if (b && !(seen.get(b) >= at)) seen.set(b, at || 0); };
  Object.values(S.things).forEach(t => add(t.bin, t.createdAt)); Object.values(S.items).forEach(it => add(it.bin, it.createdAt));
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]);
}
// <option>s for a list of names; "add" puts a last option that asks for a new name.
function optsHTML(list, val, { none, add } = {}) {
  const all = val && !list.includes(val) ? [val, ...list] : list;
  return (none != null ? `<option value="" ${val ? "" : "selected"}>${h(none)}</option>` : "") + all.map(x => `<option ${x === val ? "selected" : ""}>${h(x)}</option>`).join("") + (add ? `<option value="__new">${h(add)}</option>` : "");
}
function switchBin(b) {
  lsSet("mb-bin", b); const sign = lsGet("mb-sign", "1") === "1";
  if (sign) setShot(shotNext() + 1);
  render(); toast("Now sorting " + b + (sign ? ". Photo #" + (shotNext() - 1) + " is its sign." : ""));
}
function garageCardHTML() {
  const bin = lsGet("mb-bin", ""), n = shotNext();
  return fold("garage", "Garage mode", `
    <div class="grid2" style="align-items:end"><label class="f">Bin or area<select id="sortBin">${optsHTML(knownBins(), bin, { none: "Pick a bin…", add: "New bin…" })}</select></label><button class="btn" data-act="nextBin">Next bin →</button></div>
    <label class="f">Next photo #<div class="stepper"><button class="btn" data-act="shotDn" aria-label="One less">−</button><input type="number" id="shotNo" inputmode="numeric" value="${n}"><button class="btn" data-act="shotUp" aria-label="One more">+</button></div></label>
    <input type="text" id="glName" placeholder="What is it? (optional)" aria-label="What is it" enterkeyhint="done" autocomplete="off">
    <div class="gbtns">${["keep", "sell", "donate", "trash"].map(d => `<button class="dbtn d-${d}" data-act="glLog" data-v="${d}">${DEC[d].label}</button>`).join("")}</div>
    <div class="gbtns three">${["storage", "ask"].map(d => `<button class="dbtn d-${d}" data-act="glLog" data-v="${d}">${DEC[d].label}</button>`).join("")}<button class="dbtn d-undecided" data-act="glLog" data-v="later">Decide later</button></div>
    <label class="check small"><input type="checkbox" id="glSign" ${lsGet("mb-sign", "1") === "1" ? "checked" : ""}> Sign photo starts each bin</label>`, { cls: "garage" });
}
async function garageLog(d) {
  const name = ($("#glName") || {}).value?.trim() || "", bin = lsGet("mb-bin", ""), shot = shotNext(), now = Date.now();
  const id = "t" + now.toString(36) + Math.random().toString(36).slice(2, 6);
  const t = { name, bin, shot, decision: d === "later" ? "undecided" : d, createdAt: now, ...(d === "later" ? {} : { decidedAt: now }) };
  if (d === "sell") t.itemId = await newItem({ name: name || `Photo #${shot}${bin ? " from " + bin : ""}`, bin, shot, condNotes: bin ? "From " + bin : "", fromThing: id });
  setShot(shot + 1); await saveThing(id, t);
  toast(`#${shot} ${name || "logged"}: ${d === "later" ? "decide later" : DEC[d].label}`, { label: "Undo", fn: async () => {
    delete S.things[id]; renderSoon(); await delDoc("things", id); if (t.itemId) await deleteItem(t.itemId); setShot(shot); render(); } });
}
// Choosing "New bin…" (or "New spot…") in any dropdown asks for the name, before other change handlers see it.
document.addEventListener("change", e => {
  const t = e.target; if (t.tagName !== "SELECT" || t.value !== "__new" || t.selectedOptions[0].hasAttribute("data-box")) return;
  const n = (prompt(t.querySelector('option[value="__new"]').textContent.replace("…", "") + " name:") || "").trim();
  if (!n) { e.stopImmediatePropagation(); t.value = ([...t.options].find(o => o.defaultSelected) || t.options[0]).value; return; }
  if (t.id === "sortBin") { e.stopImmediatePropagation(); switchBin(n); return; }
  const o = new Option(n, n, true, true); t.add(o, t.options.length - 1); t.value = n;
}, true);

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
  if (!id) { el.innerHTML = `<div class="sorter-top"><button class="btn sm" data-act="sortClose">‹ Done</button></div><div class="sorter-stage"><div class="empty"><h2>${left ? "Only skipped ones left" : "All sorted!"}</h2><div class="btns">${left ? `<button class="btn primary" data-act="sortRestart">Show skipped</button>` : ""}<button class="btn" data-act="sortClose">Back to Sort</button></div></div></div>`; return; }
  const t = S.things[id];
  el.innerHTML = `<div class="sorter-top"><button class="btn sm" data-act="sortClose">‹ Done</button><span class="small muted" style="font-weight:700">${left} left${t.bin ? " · " + h(t.bin) : ""}</span>
    <span style="margin-left:auto" class="btns"><button class="btn sm" data-act="sortUndo" ${SORT.hist.length ? "" : "disabled"}>Undo</button><button class="btn sm" data-act="sortSkip">Skip</button></span></div>
  <div class="sorter-stage"><div class="swipecard" id="swipecard" data-id="${h(id)}">
    ${t.photo ? `<img src="${h(photoSrc(t.photo))}" alt="">` : `<div class="noimg">${t.shot ? "Camera photo #" + t.shot : "No photo"}</div>`}
    <span class="stamp r d-keep">KEEP</span><span class="stamp l d-donate">DONATE</span><span class="stamp u d-sell" style="top:18px">SELL</span><span class="stamp dn d-trash" style="top:auto;bottom:90px">TRASH</span>
    <div class="info"><input type="text" id="thingName" value="${h(t.name || "")}" placeholder="Name (optional)" aria-label="Name" enterkeyhint="done"></div></div></div>
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
      <div class="tiles">${["Mom", "Dad", "Both", "Someone else"].map(o => `<button class="tile d-ask" data-act="fuOwner" data-v="${o}"><b style="font-size:18px">${o}</b></button>`).join("")}</div></section></div>`;
  // sell: worth-selling check
  const w = SORT.pending;
  return head + `<div class="sorter-stage" style="overflow-y:auto"><section class="card" style="width:min(100%,460px)"><div class="card-h">${pic}<h2>Worth selling?</h2></div>
    <label class="f">Sells for $<input type="number" id="wsPrice" inputmode="decimal" step="1" value="${h(w.price ?? t.value ?? "")}" placeholder="Your guess"></label>
    <a class="btn sm" target="_blank" rel="noopener" href="https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(t.name || "")}&LH_Sold=1&LH_Complete=1">eBay sold ↗</a>
    <label class="f">Size<select data-pick="wsSize">${Object.entries(SIZES).map(([k, [n, d2]]) => `<option value="${k}" ${(w.size || "small") === k ? "selected" : ""}>${n} · ${d2}</option>`).join("")}</select></label>
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
  const r = worthCalc(); if (!r) return "";
  return `<div class="offer-res"><div class="verdict ${r.ok ? "good" : "bad"}">${r.ok ? "Worth listing" : "Probably donate"}</div>
    <div class="small">eBay keeps <b>${money(r.eb.net)}</b> · FB local <b>${money(r.fb.net)}</b></div>
    <div class="small muted">Cutoff ${money(r.min)}</div></div>
    <div class="btns"><button class="btn ${r.ok ? "primary" : ""}" data-act="wsSell">Sell it</button><button class="btn ${r.ok ? "" : "primary"}" data-act="wsDonate">Donate instead</button></div>`;
}
async function sellThing() {
  const { id } = SORT.pending, t = S.things[id], r = worthCalc();
  const itemId = await newItem({ name: t.name || "Untitled item", stage: t.photo ? "photographed" : "intake", photos: t.photo ? [t.photo] : [],
    ...(r ? { weightOz: r.oz } : {}), condNotes: t.bin ? "From " + t.bin : "", fromThing: id });
  await commit(id, { decision: "sell", itemId, value: r ? r.price : t.value || null });
  toast("Added " + S.items[itemId].sku + " to Items", { label: "Open", fn: () => { closeSorter(); openDetail(itemId); } });
}

/* donation drop-off */
function donLogHTML() {
  const pile = thingsBy("donate").filter(([, t]) => !t.done);
  return `<div class="modal-card" role="dialog" aria-label="Log a drop-off"><div class="card-h"><h2>Log a drop-off</h2><button class="btn sm ghost sp" data-act="mclose">Cancel</button></div>
    <div class="grid2"><label class="f">Where<input type="text" id="donPlace" placeholder="e.g. Goodwill, White Lake" value="${h(lsGet("mb-donplace", ""))}"></label><label class="f">Date<input type="date" id="donDate" value="${today()}"></label></div>
    <p class="small muted" style="margin:0">Thrift-store value each</p>
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
    <p class="small muted" style="margin:0">${n} items · ${d.length} drop-off${d.length > 1 ? "s" : ""}${total > 500 ? " · over $500 needs Form 8283" : ""}</p>
    <div class="btns"><button class="btn sm" data-act="csvDon">Export CSV</button></div></section>`;
}

/* thing editor (from lists) */
function thingSheetHTML(id) {
  const t = S.things[id];
  return `<div class="modal-card" role="dialog" aria-label="Edit"><div class="card-h"><h2>${h(thingName(t))}</h2><button class="btn sm ghost sp" data-act="mclose">Close</button></div>
    ${t.photo ? `<img src="${h(photoSrc(t.photo))}" alt="" style="width:100%;max-height:300px;object-fit:cover;border-radius:18px">` : ""}
    <label class="f">Name<input type="text" data-tf="name" data-id="${h(id)}" value="${h(t.name || "")}"></label>
    <div class="grid2"><label class="f">Where it is now<select data-tf="location" data-id="${h(id)}">${optsHTML(recentLocations(), t.location, { none: "Not set", add: "New spot…" })}</select></label><label class="f">Came from<select data-tf="bin" data-id="${h(id)}">${optsHTML(knownBins(), t.bin, { none: "Not set", add: "New bin…" })}</select></label></div>
    <label class="f">Camera photo #<input type="number" inputmode="numeric" data-tf="shot" data-id="${h(id)}" value="${h(t.shot ?? "")}"></label>
    <label class="f">Decision<select data-pick="decision" data-id="${h(id)}"><option value="undecided" ${(t.decision || "undecided") === "undecided" ? "selected" : ""}>Not sorted</option>${DEC_ORDER.map(d => `<option value="${d}" ${t.decision === d ? "selected" : ""}>${DEC[d].label}</option>`).join("")}</select></label>
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
    case "nextBin": { const b = lsGet("mb-bin", "").trim(), m = b.match(/^(.*?)(\d+)\s*$/); switchBin(m ? m[1] + (+m[2] + 1) : b ? b + " 2" : "Tote 1"); break; }
    case "shotUp": setShot(shotNext() + 1); render(); break;
    case "shotDn": setShot(shotNext() - 1); render(); break;
    case "glLog": await garageLog(v); break;
    case "sortF": SORT.f = SORT.f === v ? "all" : v; render(); break;
    case "decide": if (!$("#modal").hidden) { $("#modal").hidden = true; $("#modal").innerHTML = ""; } await decide(id, v); break;
    case "fuBack": SORT.pending = null; if (!S.things[SORT.cur] || S.things[SORT.cur].decision !== "undecided") closeSorter(); else renderSorter(); break;
    case "fuLoc": { const loc = v === "-" ? "" : v || $("#fuLoc").value.trim(); const p = SORT.pending; await commit(p.id, { decision: p.d, location: loc, name: S.things[p.id].name || "" }); if (!undecided().length && !SORT.hist.length) closeSorter(); break; }
    case "fuOwner": { const p = SORT.pending; await commit(p.id, { decision: "ask", owner: v, name: S.things[p.id].name || "" }); break; }
    case "wsSell": await sellThing(); break;
    case "wsDonate": { const p = SORT.pending, r = worthCalc(); await commit(p.id, { decision: "donate", value: r ? r.price : null, name: S.things[p.id].name || "" }); break; }
    case "donLog": modal(donLogHTML()); break;
    case "donSave": saveDonation(); break;
    case "thingOpen": modal(thingSheetHTML(id)); break;
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
  if (t.id === "sortBin" && t.value !== lsGet("mb-bin", "")) { lsSet("mb-bin", t.value); render(); }
  if (t.id === "shotNo") { setShot(parseInt(t.value) || 1); render(); }
  if (t.id === "glSign") lsSet("mb-sign", t.checked ? "1" : "0");
  if (t.dataset.trash) saveThing(t.dataset.trash, { done: true, doneAt: Date.now() });
  if (t.dataset.tf) saveThing(t.dataset.id, { [t.dataset.tf]: t.dataset.tf === "shot" ? num(t.value) : t.value.trim() });
  if (t.id === "thingName" && SORT.cur && S.things[SORT.cur]) saveThing(SORT.cur, { name: t.value.trim() });
});
document.addEventListener("keydown", e => {
  if ($("#sorter").hidden || SORT.pending || /INPUT|TEXTAREA/.test(document.activeElement.tagName) || !SORT.cur) return;
  const k = { ArrowRight: "keep", ArrowLeft: "donate", ArrowUp: "sell", ArrowDown: "trash" }[e.key];
  if (k) { e.preventDefault(); decide(SORT.cur, k); }
});

/* ---------- header turns solid once the page scrolls ---------- */
addEventListener("scroll", () => { const t = $(".top"); if (t) t.classList.toggle("scrolled", scrollY > 4); }, { passive: true });

/* ---------- price check: market value + where to list (copy & paste, Claude searches the web) ---------- */
const PC = { q: "", res: null };
try { Object.assign(PC, JSON.parse(lsGet("mb-pc", "{}"))); } catch {}
function priceCheckPrompt(q, it) {
  const known = it ? { brand: it.brand, model: it.model, condition: it.condition, flaws: it.condNotes, included: it.included } : null;
  return `You are a resale pricing researcher. Use web search to find what this item has actually SOLD for recently (last 90 days if possible): eBay sold/completed listings first, then Mercari, Poshmark, Depop and Facebook Marketplace. Asking prices are not sold prices; only use them if you find no sales, and say so in "tips".

${profileText()}

ITEM: ${q}${known ? "\nKNOWN DETAILS: " + JSON.stringify(known) : ""}

If the name could be several products, pick the most likely one and say what to check in "verify". Never invent sales. Suggest a list price per platform for this seller (FB is local pickup, so it can be a little lower).

Reply with ONLY one JSON object in exactly this shape (USD numbers without $ signs; null when unknown):
{"identified":"exact product name","model":"model or part number","found":true,"soldLow":0,"soldTypical":0,"soldHigh":0,"retailNew":null,"salesFound":0,"demand":"high","speed":"how fast these usually sell","weightOz":0,"fragile":false,"best":"ebay","platforms":{"ebay":{"fit":"best","price":0,"why":"..."},"depop":{"fit":"good","price":0,"why":"..."},"fb":{"fit":"skip","price":0,"why":"..."}},"other":"another site worth trying and why, or empty","quickSale":0,"tips":["..."],"verify":["..."],"compSearch":"best search phrase for sold comps","sources":["https://..."],"confidence":"medium"}`;
}
// Take-home per platform with this seller's fees: buyer pays the label on eBay and Depop, FB is local pickup.
function pcRows(r) {
  const sp = shipPlan({ weightOz: num(r.weightOz), box: r.fragile ? "fragile" : "hobby" }), label = sp.cost || 0, pkg = pkgCost(sp.pkg), P = r.platforms || {};
  return { label, oz: sp.packedOz, rows: Object.keys(PLAT).map(p => { const x = P[p] || {}, price = num(x.price) ?? num(r.soldTypical) ?? 0;
    return { p, x, price, net: netFor(p, p === "fb" ? { price, local: true } : { price, ship: label, label, pkg }).net }; }) };
}
async function runPriceCheck(q, id) {
  q = String(q || "").trim(); if (!q) { toast("Type a name or model # first."); return; }
  let r; try { r = await ai({ prompt: priceCheckPrompt(q, id ? S.items[id] : null), json: true }); } catch (e) { if (e && e.code !== "cancelled") toast(aiMsg(e)); return; }
  if (!r || typeof r !== "object") { toast(aiMsg({ code: "invalid_json" })); return; }
  r.q = q; r.at = Date.now();
  if (id) { await saveItem(id, { priceCheck: r, ...pcItemPatch(r, S.items[id]) }); toast("Price check saved to this item"); return; }
  PC.q = q; PC.res = r; lsSet("mb-pc", JSON.stringify(PC)); renderSoon();
}
function pcResultHTML(r, ctx) {
  if (r.found === false && num(r.soldTypical) == null) return `<div class="banner">Couldn't find sold prices for that. ${h((r.verify || []).join(" · ") || "Try adding the brand or model #.")}</div>`;
  const { label, oz, rows } = pcRows(r), top = rows.reduce((a, x) => x.net > a.net ? x : a, rows[0]);
  const pick = rows.find(x => x.p === r.best) || top, min = num(S.settings.sellMin) || 12, ok = top.net >= min;
  const lo = num(r.soldLow), hi = num(r.soldHigh), typ = num(r.soldTypical);
  const range = lo != null && hi != null && lo !== hi ? money(lo) + "–" + money(hi) : money(typ ?? lo ?? hi);
  const q = encodeURIComponent(r.compSearch || r.identified || r.q || "");
  return `<div class="offer-res">
    <div class="small muted">${h(r.identified || r.q)}${r.model ? " · " + h(r.model) : ""} · ${h(r.confidence || "?")} confidence</div>
    <div class="verdict">Sells for ${range}</div>
    <div class="small">${typ != null ? "Typical " + money(typ) : ""}${num(r.salesFound) ? " · " + num(r.salesFound) + " recent sales" : ""}${r.demand ? " · " + h(r.demand) + " demand" : ""}${num(r.retailNew) ? " · new " + money(num(r.retailNew)) : ""}${r.speed ? "<br>" + h(r.speed) : ""}</div>
    <div class="pick"><span>List on</span><span class="big">${h(PLAT[pick.p])}</span></div>
    ${pick.x.why ? `<p class="small" style="margin:0">${h(pick.x.why)}</p>` : ""}
    <div class="scroll-x"><table class="money"><thead><tr><th></th><th>Fit</th><th>List at</th><th>You keep</th></tr></thead><tbody>
      ${rows.map(x => `<tr class="${x.x.fit === "skip" ? "muted" : ""}"><td>${x.p === "fb" ? "FB local" : h(PLAT[x.p])}</td><td><span class="pill ${x.x.fit === "best" ? "on" : ""}">${h(x.x.fit || "?")}</span></td><td>${money(x.price)}</td><td class="${x.net >= min ? "pos" : ""}">${money(x.net)}</td></tr>`).join("")}</tbody></table></div>
    ${r.other ? `<p class="small muted" style="margin:0">Also try: ${h(r.other)}</p>` : ""}
    <div class="small ${ok ? "pos" : "neg"}" style="font-weight:700">${ok ? "Worth listing." : "Under " + money(min) + ". Bundle or donate."}${num(r.quickSale) ? ` <span class="muted" style="font-weight:600">Quick-sale price: ${money(num(r.quickSale))}.</span>` : ""}</div>
    ${r.tips && r.tips.length ? `<ul class="small" style="margin:0;padding-left:18px">${r.tips.slice(0, 4).map(t => `<li>${h(t)}</li>`).join("")}</ul>` : ""}
    ${r.verify && r.verify.length ? `<div class="banner"><b>Check:</b> ${r.verify.map(h).join(" · ")}</div>` : ""}
    <div class="btns">${ctx === "item" ? "" : `<button class="btn primary" data-act="pcAdd">Add as item</button>`}
      <a class="btn sm" target="_blank" rel="noopener" href="https://www.ebay.com/sch/i.html?_nkw=${q}&LH_Sold=1&LH_Complete=1">eBay sold ↗</a>
      ${(r.sources || []).filter(u => /^https?:\/\//.test(u)).slice(0, 2).map((u, i) => `<a class="btn sm" target="_blank" rel="noopener" href="${h(u)}">Source ${i + 1} ↗</a>`).join("")}</div>
    <div class="small muted">Checked ${new Date(r.at || Date.now()).toLocaleDateString()}</div></div>`;
}
function priceCheckCardHTML() {
  return fold("pc", "Price check", `
    <form class="quick" data-pc><input type="text" name="q" value="${h(PC.q)}" placeholder="Name or model #" aria-label="Item name or model number" enterkeyhint="search" autocomplete="off"><button class="btn primary" type="submit">Research</button></form>
    ${PC.res ? pcResultHTML(PC.res, "home") + `<div class="btns"><button class="btn sm ghost" data-act="pcClear">Clear</button></div>` : ""}`, { open: !!PC.res });
}
// What a price check fills on an item: only blank details, plus the suggested platform if none is picked.
function pcItemPatch(r, it = {}) {
  const p = {};
  if (!it.listOn && PLAT[r.best]) p.listOn = r.best === "fb" ? "fblocal" : r.best;
  if (num(it.weightOz) == null && num(r.weightOz)) p.weightOz = num(r.weightOz);
  if (!it.model && r.model) p.model = r.model;
  return p;
}
document.addEventListener("submit", e => {
  const f = e.target.closest("[data-pc]"); if (!f) return;
  e.preventDefault(); const inp = f.querySelector("input"); inp.blur(); runPriceCheck(inp.value);
});
document.addEventListener("click", async e => {
  const t = e.target.closest("[data-act]"); if (!t) return;
  switch (t.dataset.act) {
    case "pcClear": PC.q = ""; PC.res = null; lsSet("mb-pc", "{}"); render(); break;
    case "pcAdd": { const r = PC.res; if (!r) break;
      const id = await newItem({ name: r.identified || r.q, box: r.fragile ? "fragile" : "", priceCheck: r, ...pcItemPatch(r) });
      PC.q = ""; PC.res = null; lsSet("mb-pc", "{}");
      toast("Added " + S.items[id].sku, { label: "Open", fn: () => openDetail(id) }); break; }
    case "pcItem": { const it = S.open && S.items[S.open]; if (!it) break;
      runPriceCheck([it.brand, it.model, it.official || it.name].filter(Boolean).join(" "), S.open); break; }
  }
});

/* ---------- home overview: every item in one list, plus the laptop sidebar ---------- */
const HOME = { stage: "all", q: "" };
const HOME_STAGES = [["all", "All"], ["tolist", "To list"], ["listed", "Listed"], ["sold", "To ship"], ["shipped", "Shipped"], ["complete", "Done"], ["info", "Needs info"]];
// Unsold items missing details: same checks as the "Needs attention" rules for photos, listing text, price check and weight.
function needsInfo(it) {
  const stg = STAGE_IDX[it.stage || "intake"]; if (stg >= 4 || it.stage === "sold") return false;
  return !it.name || (stg >= 1 && (it.photos || []).length < 3) || (stg >= 1 && it.listOn !== "fblocal" && num(it.weightOz) == null) ||
    (stg >= 2 && !hasCopy(it, it.listOn)) || (stg >= 2 && mainPrice(it) == null);
}
const inHomeStage = (it, k) => k === "all" || (k === "info" ? needsInfo(it) : k === "tolist" ? STAGE_IDX[it.stage || "intake"] <= 2 : (it.stage || "intake") === k);
function homeListHTML() {
  const q = HOME.q.toLowerCase();
  const rows = Object.entries(S.items).filter(([id, it]) => inHomeStage(it, HOME.stage) &&
    (!q || [id, it.sku, it.name, it.brand, it.model, it.official].join(" ").toLowerCase().includes(q)))
    .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
  if (!rows.length) return `<div class="empty"><b>${Object.keys(S.items).length ? "Nothing here." : "No items yet."}</b></div>`;
  // Just photo, SKU, box and stage. The name shows only until there's a photo to recognize the item by.
  return rows.map(([id, it]) => `<div class="inv-row" role="button" tabindex="0" data-act="open" data-id="${h(id)}">${thumb(it)}
      <div style="min-width:0"><div class="t">${h(it.sku || id)}</div>${!(it.photos || []).length && !it.thumb && it.name ? `<div class="nm small muted">${h(it.name)}</div>` : ""}</div>
      <div class="inv-sel"><select class="box-sel ${h(it.box || "none")}" data-qbox="${h(id)}" data-act="noop" aria-label="Box"${(ci => ci >= 0 ? ` style="--bx: var(--c${ci % 7 + 1})"` : "")(Object.keys(S.settings.boxes || {}).indexOf(it.box))}>${boxOpts(it.box || "", true)}</select>
      <select class="st-${h(it.stage || "intake")}" data-qstage="${h(id)}" data-act="noop" aria-label="Stage">${STAGES.map(([k, n]) => `<option value="${k}" ${(it.stage || "intake") === k ? "selected" : ""}>${n}</option>`).join("")}</select></div></div>`).join("");
}
function homeInvHTML() {
  const all = Object.values(S.items); const n = k => all.filter(it => inHomeStage(it, k)).length;
  return `<div class="card-h"><h2>All items</h2><span class="muted small">${all.length}</span><button class="btn sm sp" data-act="tab" data-v="items">Filters & sorting</button></div>
    <input type="search" placeholder="Search name, SKU, brand" value="${h(HOME.q)}" data-act-input="homeSearch" aria-label="Search all items">
    <div class="seg">${HOME_STAGES.map(([k, l]) => `<button data-act="homeStage" data-v="${k}" aria-pressed="${HOME.stage === k}">${l}<span>${n(k)}</span></button>`).join("")}</div>
    <div class="inv-list" id="homeList">${homeListHTML()}</div>`;
}
document.addEventListener("click", e => {
  const t = e.target.closest("[data-act]"); if (!t || t.dataset.act !== "homeStage") return;
  HOME.stage = t.dataset.v; render();
});
document.addEventListener("input", e => {
  if (e.target.dataset.actInput !== "homeSearch") return;
  HOME.q = e.target.value; const l = document.getElementById("homeList"); if (l) l.innerHTML = homeListHTML();
});
// Change an item's stage right from the home list without opening it.
document.addEventListener("change", e => {
  const t = e.target, id = t.dataset && t.dataset.qstage; if (!id || !S.items[id]) return;
  // Sold and Shipped need the sale details, so open the item at Mark sold instead.
  if (STAGE_IDX[t.value] >= 4 && t.value !== "complete" && !S.items[id].sale) { t.value = S.items[id].stage || "intake"; openDetail(id); const pr = $("#sPrice"); if (pr) { pr.scrollIntoView({ block: "center" }); pr.focus(); } toast("Enter what it sold for, then Mark sold."); return; }
  saveItem(id, { stage: t.value, ...(t.value === "complete" ? { completedAt: Date.now() } : {}) }); t.blur();
  toast((S.items[id].sku || id) + " → " + stageName(t.value));
});
document.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.matches && e.target.matches(".inv-row")) openDetail(e.target.dataset.id); });
// "+ New box…" in any box dropdown: name it, save it to settings, then let the normal handler save the item's box.
document.addEventListener("change", e => {
  const t = e.target; if (t.tagName !== "SELECT" || t.value !== "__new" || !t.selectedOptions[0].hasAttribute("data-box")) return;
  const prev = t.dataset.prev ?? ([...t.options].find(o => o.defaultSelected) || t.options[0]).value;
  const name = (prompt("Name the new box (e.g. Bin 4, Garage shelf):") || "").trim();
  if (!name) { t.value = prev; e.stopImmediatePropagation(); return; }
  const have = Object.entries(boxes()).find(([, n]) => n.toLowerCase() === name.toLowerCase());
  const key = have ? have[0] : "b" + Date.now().toString(36);
  if (!have) saveSettings({ boxes: { ...(S.settings.boxes || {}), [key]: name } });
  if (!have) t.add(new Option(name, key), t.options.length - 1); t.value = key; t.dataset.prev = key;
}, true);
document.addEventListener("change", e => {
  const t = e.target, id = t.dataset && t.dataset.qbox; if (!id || !S.items[id]) return;
  t.dataset.prev = t.value; saveItem(id, { box: t.value }); t.blur(); toast((S.items[id].sku || id) + " → " + boxName(t.value));
});

const SIDE_ICONS = {
  tools: '<path d="M14.5 6.5a4 4 0 0 1-5 5L5 16a1.8 1.8 0 0 0 2.5 2.5l4.5-4.5a4 4 0 0 1 5-5l-2.4 2.4-2.1-.4-.4-2.1z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" fill="none"/>',
  settings: '<circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M5.5 18.5l2.1-2.1M16.4 7.6l2.1-2.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'
};
// Laptop sidebar below the tabs: quick add, the weekly goal, and Tools/Settings. Hidden on phones.
function renderSide() {
  const el = document.getElementById("side"); if (!el || el.contains(document.activeElement)) return;
  const goal = Math.max(1, num(S.settings.weeklyGoal) || 3), n = listedThisWeek(), days = 7 - ((new Date().getDay() + 6) % 7);
  const link = (k, name) => `<button class="tab" data-act="tab" data-v="${k}" ${S.tab === k ? 'aria-current="page"' : ""}><svg viewBox="0 0 24 24" aria-hidden="true">${SIDE_ICONS[k]}</svg>${name}</button>`;
  el.innerHTML = `<div class="side-sec"><div class="eyebrow">Quick add</div>${quickAddHTML()}</div>
    <div class="side-sec"><div class="eyebrow">This week</div><div class="prog"><i style="width:${Math.min(100, Math.round(n / goal * 100))}%"></i></div>
      <div class="small muted">${n} of ${goal} listed · ${days}d left</div></div>
    <div class="side-foot">${link("tools", "Tools")}${link("settings", "Settings")}</div>`;
}
