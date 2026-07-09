# Web Tools

A collection of small, single-purpose, front-end-only tools hosted on GitHub Pages.
No backend, no build step — just static HTML/CSS/JS. Each tool lives in its own
directory under `tools/` so it's easy to add or remove one independently.

**Live site:** https://shohamtal.github.io/web-tools/

## Tools

### `tools/mishkan-shilo-text-extractor/`
Extracts clean, copy-ready Hebrew text from the weekly **Mishkan Shilo** magazine PDFs.

Copying directly from the PDFs produces corrupted text (the InDesign Hebrew export
wraps every line in bidirectional control characters and scrambles the niqqud layer).
This tool loads the chosen issue with [pdf.js](https://mozilla.github.io/pdf.js/),
extracts the requested page range, strips the directional control characters (and
optionally the broken niqqud), reconstructs right-to-left **multi-column** reading
order, and shows the result with a copy button.

Flow:
1. Pick an issue from the list and click **הורד מ־Drive** to download it (Google
   Drive blocks direct browser downloads via CORS, so the file is downloaded normally).
2. Drop the downloaded PDF onto the tool.
3. Choose a page range and extract. **Everything runs locally in the browser — the
   file is never uploaded anywhere.**

Notes:
- The magazine list is a static file: `magazines.json` (issue number, parsha, Drive id).
- pdf.js is vendored under `vendor/` so the tool has no CDN dependency and the worker
  is same-origin.
- Vocalized biblical quotes may still come out imperfect because that text is damaged
  in the source PDF itself.

#### Updating the magazine list
New issues appear weekly on the
[Mishkan Shilo site](https://sites.google.com/view/mishkan-shilo). To refresh the list,
re-run the scraper in `scripts/scrape_magazines.py` and commit the updated
`tools/mishkan-shilo-text-extractor/magazines.json`.

```bash
python3 scripts/scrape_magazines.py
```

## Adding a new tool
1. Create `tools/<your-tool>/index.html` (plus any JS/CSS/data it needs).
2. Add a card linking to it in the root `index.html`.
