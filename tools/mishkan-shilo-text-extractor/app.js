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
  ocrBtn: $("ocrBtn"),
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
  // Decorative marker glyphs used around bold text — turn into spaces so
  // adjacent words don't merge (e.g. "אבל$פינחס" -> "אבל פינחס").
  t = t.replace(/[$#]/g, " ");
  // Stray underscore inside a Hebrew word (e.g. "ש_לום" -> "שלום").
  t = t.replace(/([֐-׿])_([֐-׿])/g, "$1$2");
  return t
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

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

  const blocks = [];
  const tol = 4;
  for (const col of cols) {
    if (!col.items.length) continue;

    // Group items into visual lines by y.
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

    // Build each line's text (right -> left, gap-based spacing).
    const built = lines.map((line) => {
      line.items.sort((a, b) => b.transform[4] - a.transform[4]);
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
      return { y: line.y, text: s };
    });

    // Skip tiny numeric-only "columns" (page numbers).
    const colText = built.map((l) => l.text).join("").replace(/\s/g, "");
    if (colText.length < 4 && /^\d*$/.test(colText)) continue;

    // Merge wrapped lines into paragraphs: a bigger-than-typical vertical
    // gap starts a new paragraph; otherwise lines join with a space.
    const gaps = [];
    for (let i = 0; i < built.length - 1; i++) {
      const g = built[i].y - built[i + 1].y;
      if (g > 0) gaps.push(g);
    }
    const medGap = median(gaps) || 12;
    const breakGap = medGap + Math.max(2, medGap * 0.15);

    let para = "";
    for (let i = 0; i < built.length; i++) {
      para = para ? para + " " + built[i].text : built[i].text;
      const gap = built[i + 1] ? built[i].y - built[i + 1].y : Infinity;
      if (gap > breakGap) {
        blocks.push(para);
        para = "";
      }
    }
    if (para) blocks.push(para);
    blocks.push(""); // blank line between columns
  }
  return blocks.join("\n");
}

// ---- OCR (image recognition) ---------------------------------------------
// Optional path for text the PDF's text layer corrupts (vocalized quotes):
// render each column to an image and read it with Tesseract's Hebrew model.
const TESSERACT_SRC = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
const TESS_LANG_PATH = "https://tessdata.projectnaptha.com/4.0.0_best";

let tesseractLoading = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  if (!tesseractLoading) {
    tesseractLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = TESSERACT_SRC;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("failed to load tesseract.js"));
      document.head.appendChild(s);
    });
  }
  return tesseractLoading;
}

async function createOcrWorker() {
  await loadTesseract();
  const worker = await window.Tesseract.createWorker("heb", 1, { langPath: TESS_LANG_PATH });
  await worker.setParameters({ tessedit_pageseg_mode: "4" }); // single column, variable sizes
  return worker;
}

async function ocrPage(pdf, pageNum, worker, onProgress) {
  const page = await pdf.getPage(pageNum);
  const base = page.getViewport({ scale: 1 });
  const W = Math.ceil(base.width);

  // Column x-bounds from the (reliable) text-layer positions — OCR each column
  // separately so a multi-column layout isn't read across.
  let bounds = [[0, W]];
  try {
    const items = (await page.getTextContent()).items.filter((it) => it.str && it.str.trim());
    if (items.length) {
      const cols = detectColumns(items, W)
        .filter((c) => c.hi - c.lo > 110)
        .sort((a, b) => b.lo - a.lo); // right -> left
      if (cols.length) bounds = cols.map((c) => [c.lo, c.hi]);
    }
  } catch (_) {}

  const scale = 3;
  const vp = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = vp.width;
  canvas.height = vp.height;
  await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;

  let text = "";
  for (let i = 0; i < bounds.length; i++) {
    if (onProgress) onProgress(i + 1, bounds.length);
    const [lo, hi] = bounds[i];
    const cx = Math.floor(lo * scale);
    const cw = Math.ceil((hi - lo) * scale);
    const sub = document.createElement("canvas");
    sub.width = cw;
    sub.height = canvas.height;
    sub.getContext("2d").drawImage(canvas, cx, 0, cw, canvas.height, 0, 0, cw, canvas.height);
    const res = await worker.recognize(sub);
    text += res.data.text.trim() + "\n\n";
  }
  return text;
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

function getRange(pdf) {
  let from = parseInt(els.fromPage.value, 10);
  let to = parseInt(els.toPage.value, 10);
  if (!Number.isInteger(from) || from < 1) from = 1;
  if (!Number.isInteger(to) || to < from) to = from;
  to = Math.min(to, pdf.numPages);
  return { from, to };
}

function showOutput(parts, from, to, numPages, method) {
  els.output.value = parts.join("\n\n");
  els.outputCard.hidden = false;
  setStatus(`${method}: עמודים ${from}–${to} (מתוך ${numPages}).`, "ok");
  els.outputCard.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function runExtraction(runner) {
  if (!currentDoc?.pdf) {
    return setStatus("טען תחילה קובץ PDF (שלב 2).", "err");
  }
  const pdf = currentDoc.pdf;
  const { from, to } = getRange(pdf);
  if (from > pdf.numPages) {
    return setStatus(`בגיליון זה יש ${pdf.numPages} עמודים בלבד.`, "err");
  }
  els.extractBtn.disabled = true;
  els.ocrBtn.disabled = true;
  try {
    await runner(pdf, from, to);
  } finally {
    els.extractBtn.disabled = false;
    els.ocrBtn.disabled = false;
  }
}

// Fast path — read the PDF text layer.
els.extractBtn.addEventListener("click", () =>
  runExtraction(async (pdf, from, to) => {
    const parts = [];
    for (let p = from; p <= to; p++) {
      setStatus(`מחלץ עמוד ${p} מתוך ${to}…`, "busy");
      const raw = await extractPageText(pdf, p);
      parts.push(fmtPart(cleanText(raw, els.stripNikud.checked), p, from, to));
    }
    showOutput(parts, from, to, pdf.numPages, "חולץ מהטקסט");
  }).catch((e) => {
    console.error(e);
    setStatus("שגיאה בחילוץ הטקסט. נסה טווח עמודים אחר.", "err");
  })
);

// Image-recognition path — OCR the rendered page image.
els.ocrBtn.addEventListener("click", () =>
  runExtraction(async (pdf, from, to) => {
    setStatus("טוען מנוע זיהוי תמונה (הורדה חד־פעמית, עשוי לקחת רגע)…", "busy");
    const worker = await createOcrWorker();
    try {
      const parts = [];
      for (let p = from; p <= to; p++) {
        const text = await ocrPage(pdf, p, worker, (col, nCols) =>
          setStatus(`זיהוי תמונה – עמוד ${p}/${to}${nCols > 1 ? `, טור ${col}/${nCols}` : ""}…`, "busy")
        );
        parts.push(fmtPart(cleanText(text, els.stripNikud.checked), p, from, to));
      }
      showOutput(parts, from, to, pdf.numPages, "זוהה מהתמונה");
    } finally {
      await worker.terminate();
    }
  }).catch((e) => {
    console.error(e);
    setStatus("שגיאה בזיהוי התמונה. ודא חיבור לאינטרנט ונסה שוב.", "err");
  })
);

const fmtPart = (text, p, from, to) =>
  to > from ? `— עמוד ${p} —\n${text}` : text;

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
