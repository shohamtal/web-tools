import * as pdfjsLib from "./vendor/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.min.mjs";

const $ = (id) => document.getElementById(id);
const els = {
  filter: $("filter"),
  magazine: $("magazine"),
  fromPage: $("fromPage"),
  toPage: $("toPage"),
  pageInfo: $("pageInfo"),
  stripNikud: $("stripNikud"),
  extractBtn: $("extractBtn"),
  refreshBtn: $("refreshBtn"),
  saveListBtn: $("saveListBtn"),
  driveLink: $("driveLink"),
  fileInput: $("fileInput"),
  dropZone: $("dropZone"),
  dropText: $("dropText"),
  status: $("status"),
  outputCard: $("outputCard"),
  output: $("output"),
  copyBtn: $("copyBtn"),
};

let MAGAZINES = [];
let currentDoc = null; // { key, pdf } — the loaded PDF

// ---- Drive helpers -------------------------------------------------------
// Google Drive blocks direct browser downloads (CORS), so the user downloads
// the chosen issue once and loads the file here; extraction is fully local.
const driveViewUrl = (id) => `https://drive.google.com/file/d/${id}/view`;

// ---- Live re-scan of the Mishkan Shilo site ------------------------------
const SITE_URL =
  "https://sites.google.com/view/mishkan-shilo/" +
  "%D7%A2%D7%9E%D7%95%D7%AA%D7%AA-%D7%9E%D7%A9%D7%9B%D7%9F-%D7%A9%D7%99%D7%9C%D7%94";
// The site sends no CORS headers, so a live scan must route through a public
// CORS proxy. These are best-effort and sometimes down — if they all fail we
// fall back to reloading the committed list (kept fresh by the weekly Action).
const PROXIES = [
  { url: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`, json: false },
  { url: (u) => `https://api.codetabs.com/v1/proxy/?quest=${u}`, json: false },
  { url: (u) => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`, json: true },
];

function decodeEntities(s) {
  const el = document.createElement("textarea");
  el.innerHTML = s;
  return el.value;
}

function parseMagazines(html) {
  const re = /<a[^>]*\/file\/d\/([A-Za-z0-9_-]{20,})\/view[^>]*>(.*?)<\/a>/gs;
  const seen = new Set();
  const items = [];
  let m;
  while ((m = re.exec(html))) {
    const id = m[1];
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, "")).trim();
    if (!text.includes("משכן שילה") || seen.has(id)) continue;
    const num = text.match(/(\d{3,4})/);
    if (!num) continue;
    seen.add(id);
    const pm = text.match(/\d{3,4}\s*-\s*(.*)$/);
    const parsha = pm ? pm[1].trim().replace(/\.$/, "").trim() : text;
    items.push({ issue: +num[1], title: text, parsha, id });
  }
  items.sort((a, b) => b.issue - a.issue);
  return items;
}

async function fetchSiteHtml() {
  for (const proxy of PROXIES) {
    try {
      const r = await fetch(proxy.url(SITE_URL));
      if (!r.ok) continue;
      const t = proxy.json ? (await r.json()).contents : await r.text();
      if (t && t.includes("משכן שילה")) return t;
    } catch (_) {
      /* try next proxy */
    }
  }
  throw new Error("all proxies failed");
}

// ---- Text cleaning -------------------------------------------------------
const RE_DIRECTIONAL = /[​-‏‪-‮⁦-⁩﻿­￼�]/g;
const RE_NIKUD = /[֑-ׇֽֿׁׂׅׄ]/g;

function cleanText(text, stripNikud) {
  let t = text.replace(RE_DIRECTIONAL, "");
  if (stripNikud) t = t.replace(RE_NIKUD, "");
  return t
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---- Page text reconstruction (RTL + multi-column aware) -----------------
// The magazines are laid out in 1–3 columns. We detect column gutters as
// low-occupancy vertical bands, order columns right-to-left (Hebrew reading
// order), then within each column order lines top->bottom and right->left.
function detectColumns(items, width) {
  const occ = new Array(width).fill(0);
  for (const it of items) {
    const x0 = Math.max(0, Math.floor(it.transform[4]));
    const x1 = Math.min(width, Math.ceil(it.transform[4] + (it.width || 0)));
    for (let x = x0; x < x1; x++) occ[x]++;
  }
  const peak = Math.max(1, ...occ);
  const thr = Math.max(2, peak * 0.1);
  const margin = Math.round(width * 0.06);

  const gutters = [];
  let run = 0;
  for (let x = margin; x <= width - margin; x++) {
    if (occ[x] < thr) {
      run++;
    } else {
      if (run >= 8) gutters.push(x - run / 2);
      run = 0;
    }
  }
  if (run >= 8) gutters.push(width - margin - run / 2);

  const bounds = [0, ...gutters, width];
  const cols = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    cols.push({ lo: bounds[i], hi: bounds[i + 1], items: [] });
  }
  return cols;
}

async function extractPageText(pdf, pageNum) {
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale: 1 });
  const width = Math.ceil(viewport.width);
  const content = await page.getTextContent();
  const items = content.items.filter((it) => it.str && it.str.trim());
  if (!items.length) return "";

  const cols = detectColumns(items, width);
  for (const it of items) {
    const cx = it.transform[4] + (it.width || 0) / 2;
    const col = cols.find((c) => cx >= c.lo && cx < c.hi) || cols[cols.length - 1];
    col.items.push(it);
  }
  cols.sort((a, b) => b.lo - a.lo); // rightmost column first (RTL)

  const out = [];
  const tol = 4;
  for (const col of cols) {
    if (!col.items.length) continue;
    const lines = [];
    for (const it of col.items) {
      const y = it.transform[5];
      let line = lines.find((l) => Math.abs(l.y - y) <= tol);
      if (!line) {
        line = { y, items: [] };
        lines.push(line);
      }
      line.items.push(it);
    }
    lines.sort((a, b) => b.y - a.y); // top -> bottom

    for (const line of lines) {
      line.items.sort((a, b) => b.transform[4] - a.transform[4]); // right -> left
      let s = "";
      for (let i = 0; i < line.items.length; i++) {
        const cur = line.items[i];
        s += cur.str;
        const next = line.items[i + 1];
        if (next) {
          const gap = cur.transform[4] - (next.transform[4] + (next.width || 0));
          const h = cur.height || 10;
          if (gap > h * 0.25 && !s.endsWith(" ")) s += " ";
        }
      }
      out.push(s);
    }
    out.push(""); // blank line between columns
  }
  return out.join("\n");
}

// ---- Loading a PDF from a local file -------------------------------------
async function loadFile(file) {
  if (!file) return;
  if (currentDoc?.pdf) {
    try { await currentDoc.pdf.destroy(); } catch (_) {}
    currentDoc = null;
  }
  setStatus(`מעבד את הקובץ “${file.name}”…`, "busy");
  els.dropZone.classList.remove("loaded");
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    currentDoc = { key: file.name + ":" + file.size, pdf };
    els.dropText.textContent = `✓ ${file.name} — ${pdf.numPages} עמודים`;
    els.dropZone.classList.add("loaded");
    els.pageInfo.textContent = `סה\"כ ${pdf.numPages} עמודים`;
    setStatus("הקובץ נטען. בחר טווח עמודים ולחץ “חלץ טקסט”.", "ok");
  } catch (e) {
    console.error(e);
    els.dropText.textContent = "גרור לכאן קובץ PDF, או לחץ לבחירה";
    setStatus("הקובץ אינו PDF תקין. ודא שהורדת את הקובץ במלואו.", "err");
  }
}

// ---- UI wiring -----------------------------------------------------------
function setStatus(msg, kind) {
  els.status.hidden = !msg;
  els.status.textContent = msg || "";
  els.status.className = "status" + (kind ? " " + kind : "");
}

function selectedMagazine() {
  const id = els.magazine.value;
  return MAGAZINES.find((m) => m.id === id) || null;
}

function renderOptions(list) {
  els.magazine.innerHTML = "";
  for (const m of list) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = `${m.issue} · ${m.parsha}`;
    els.magazine.appendChild(opt);
  }
  onMagazineChange();
}

function onMagazineChange() {
  const m = selectedMagazine();
  els.driveLink.href = m ? driveViewUrl(m.id) : "#";
}

els.filter.addEventListener("input", () => {
  const q = els.filter.value.trim();
  if (!q) return renderOptions(MAGAZINES);
  const list = MAGAZINES.filter(
    (m) => String(m.issue).includes(q) || m.title.includes(q) || m.parsha.includes(q)
  );
  renderOptions(list.length ? list : MAGAZINES);
});
els.magazine.addEventListener("change", onMagazineChange);

function applyList(list, offerSave) {
  const prevMax = MAGAZINES.length ? Math.max(...MAGAZINES.map((m) => m.issue)) : 0;
  const newCount = list.filter((m) => m.issue > prevMax).length;
  MAGAZINES = list.slice().sort((a, b) => b.issue - a.issue);
  els.filter.value = "";
  renderOptions(MAGAZINES);
  els.saveListBtn.hidden = !offerSave;
  return newCount;
}

els.refreshBtn.addEventListener("click", async () => {
  els.refreshBtn.disabled = true;
  setStatus("סורק את האתר לגיליונות חדשים…", "busy");
  try {
    // 1) Best-effort live scan of the site through a CORS proxy.
    const html = await fetchSiteHtml();
    const list = parseMagazines(html);
    if (!list.length) throw new Error("empty parse");
    const newCount = applyList(list, true);
    setStatus(
      newCount > 0
        ? `נמצאו ${list.length} גיליונות, מתוכם ${newCount} חדשים. ניתן לשמור את הרשימה המעודכנת (⤓) ולשלוח לי אותה, או שהיא תתעדכן אוטומטית מדי שבוע.`
        : `הרשימה כבר מעודכנת (${list.length} גיליונות).`,
      "ok"
    );
  } catch (e) {
    console.error(e);
    // 2) Fallback: reload the committed list (the weekly Action keeps it fresh).
    try {
      const res = await fetch("magazines.json?ts=" + Date.now(), { cache: "no-store" });
      const list = await res.json();
      const newCount = applyList(list, false);
      setStatus(
        newCount > 0
          ? `סריקה חיה אינה זמינה כרגע. נטענו ${newCount} גיליונות חדשים מהרשימה השמורה.`
          : "סריקה חיה אינה זמינה כרגע. הרשימה השמורה עדכנית (מתעדכנת אוטומטית מדי שבוע).",
        "ok"
      );
    } catch (_) {
      setStatus("לא ניתן לרענן כרגע. נסה שוב מאוחר יותר.", "err");
    }
  } finally {
    els.refreshBtn.disabled = false;
  }
});

els.saveListBtn.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(MAGAZINES, null, 2) + "\n"], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "magazines.json";
  a.click();
  URL.revokeObjectURL(a.href);
});

els.extractBtn.addEventListener("click", async () => {
  if (!currentDoc?.pdf) {
    return setStatus("טען תחילה קובץ PDF (שלב 2).", "err");
  }
  const pdf = currentDoc.pdf;

  let from = parseInt(els.fromPage.value, 10);
  let to = parseInt(els.toPage.value, 10);
  if (!Number.isInteger(from) || from < 1) from = 1;
  if (!Number.isInteger(to) || to < from) to = from;

  els.extractBtn.disabled = true;
  try {
    if (from > pdf.numPages) {
      setStatus(`בגיליון זה יש ${pdf.numPages} עמודים בלבד.`, "err");
      return;
    }
    to = Math.min(to, pdf.numPages);

    const parts = [];
    for (let p = from; p <= to; p++) {
      setStatus(`מחלץ עמוד ${p} מתוך ${to}…`, "busy");
      const raw = await extractPageText(pdf, p);
      const cleaned = cleanText(raw, els.stripNikud.checked);
      parts.push(to > from ? `— עמוד ${p} —\n${cleaned}` : cleaned);
    }

    els.output.value = parts.join("\n\n");
    els.outputCard.hidden = false;
    setStatus(`הטקסט חולץ מעמודים ${from}–${to} (מתוך ${pdf.numPages}).`, "ok");
    els.outputCard.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    console.error(err);
    setStatus("שגיאה בחילוץ הטקסט. נסה טווח עמודים אחר.", "err");
  } finally {
    els.extractBtn.disabled = false;
  }
});

// ---- File input + drag & drop --------------------------------------------
els.fileInput.addEventListener("change", (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) loadFile(f);
});
["dragenter", "dragover"].forEach((ev) =>
  els.dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    els.dropZone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((ev) =>
  els.dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    els.dropZone.classList.remove("dragover");
  })
);
els.dropZone.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) loadFile(f);
});

els.copyBtn.addEventListener("click", async () => {
  const text = els.output.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    els.output.select();
    document.execCommand("copy");
  }
  toast("הועתק ✓");
});

function toast(msg) {
  let el = document.querySelector(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 1400);
}

// ---- Init ----------------------------------------------------------------
(async function init() {
  try {
    const res = await fetch("magazines.json", { cache: "no-cache" });
    MAGAZINES = await res.json();
    MAGAZINES.sort((a, b) => b.issue - a.issue); // newest first
    renderOptions(MAGAZINES);
  } catch (e) {
    setStatus("לא ניתן לטעון את רשימת הגיליונות.", "err");
  }
})();
