import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs";

const $ = (id) => document.getElementById(id);
const els = {
  filter: $("filter"),
  magazine: $("magazine"),
  fromPage: $("fromPage"),
  toPage: $("toPage"),
  pageInfo: $("pageInfo"),
  stripNikud: $("stripNikud"),
  extractBtn: $("extractBtn"),
  driveLink: $("driveLink"),
  status: $("status"),
  outputCard: $("outputCard"),
  output: $("output"),
  copyBtn: $("copyBtn"),
};

let MAGAZINES = [];
let currentDoc = null; // { id, pdf }

// ---- Drive helpers -------------------------------------------------------
// This endpoint serves the file with `Access-Control-Allow-Origin: *` and
// supports HTTP Range requests, so pdf.js fetches only the pages it needs.
const driveDownloadUrl = (id) =>
  `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;
const driveViewUrl = (id) => `https://drive.google.com/file/d/${id}/view`;

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
    // Group this column's items into visual lines by y.
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

// ---- Loading a magazine's PDF -------------------------------------------
async function ensureDoc(id) {
  if (currentDoc && currentDoc.id === id) return currentDoc.pdf;
  if (currentDoc?.pdf) {
    try { await currentDoc.pdf.destroy(); } catch {}
  }
  setStatus("טוען את הגיליון…", "busy");
  const task = pdfjsLib.getDocument({
    url: driveDownloadUrl(id),
    disableAutoFetch: true, // fetch only needed objects via Range requests
    disableStream: false,
    rangeChunkSize: 1 << 16,
  });
  const pdf = await task.promise;
  currentDoc = { id, pdf };
  return pdf;
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
  if (!m) { els.driveLink.href = "#"; els.pageInfo.textContent = "—"; return; }
  els.driveLink.href = driveViewUrl(m.id);
  els.pageInfo.textContent = "בחר טווח עמודים";
  // Reset cached doc info hint (page count fills after first load).
  if (m._pages) els.pageInfo.textContent = `סה\"כ ${m._pages} עמודים`;
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

els.extractBtn.addEventListener("click", async () => {
  const m = selectedMagazine();
  if (!m) return setStatus("בחר גיליון תחילה.", "err");

  let from = parseInt(els.fromPage.value, 10);
  let to = parseInt(els.toPage.value, 10);
  if (!Number.isInteger(from) || from < 1) from = 1;
  if (!Number.isInteger(to) || to < from) to = from;

  els.extractBtn.disabled = true;
  try {
    const pdf = await ensureDoc(m.id);
    m._pages = pdf.numPages;
    els.pageInfo.textContent = `סה\"כ ${pdf.numPages} עמודים`;

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
      if (to > from) parts.push(`— עמוד ${p} —\n${cleaned}`);
      else parts.push(cleaned);
    }

    els.output.value = parts.join("\n\n");
    els.outputCard.hidden = false;
    setStatus(`הטקסט חולץ מעמודים ${from}–${to}.`, "ok");
    els.outputCard.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    console.error(err);
    setStatus("שגיאה בטעינת הגיליון. נסה שוב, או פתח אותו ב־Drive ידנית.", "err");
  } finally {
    els.extractBtn.disabled = false;
  }
});

els.copyBtn.addEventListener("click", async () => {
  const text = els.output.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
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
    const res = await fetch("magazines.json");
    MAGAZINES = await res.json();
    MAGAZINES.sort((a, b) => b.issue - a.issue); // newest first
    renderOptions(MAGAZINES);
  } catch (e) {
    setStatus("לא ניתן לטעון את רשימת הגיליונות.", "err");
  }
})();
