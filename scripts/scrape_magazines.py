#!/usr/bin/env python3
"""Scrape the Mishkan Shilo site and rebuild magazines.json (newest first).

Usage:
    python3 scripts/scrape_magazines.py

Requires only the Python standard library.
"""
import json
import os
import re
import html
import urllib.request

SITE_URL = (
    "https://sites.google.com/view/mishkan-shilo/"
    "%D7%A2%D7%9E%D7%95%D7%AA%D7%AA-%D7%9E%D7%A9%D7%9B%D7%9F-%D7%A9%D7%99%D7%9C%D7%94"
)
OUT = os.path.join(
    os.path.dirname(__file__),
    "..",
    "tools",
    "mishkan-shilo-text-extractor",
    "magazines.json",
)

# Each magazine is an <a href=".../file/d/<id>/view">גיליון משכן שילה <n> - פרשת ...</a>
ANCHOR = re.compile(
    r'<a[^>]*/file/d/([A-Za-z0-9_-]{20,})/view[^>]*>(.*?)</a>', re.S
)


def fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", "replace")


def parse(page: str):
    seen, items = set(), []
    for m in ANCHOR.finditer(page):
        fid = m.group(1)
        text = html.unescape(re.sub(r"<[^>]+>", "", m.group(2))).strip()
        if "משכן שילה" not in text or fid in seen:
            continue
        num = re.search(r"(\d{3,4})", text)
        if not num:
            continue
        seen.add(fid)
        parsha_m = re.search(r"\d{3,4}\s*-\s*(.*)$", text)
        parsha = parsha_m.group(1).strip().rstrip(".").strip() if parsha_m else text
        items.append(
            {"issue": int(num.group(1)), "title": text, "parsha": parsha, "id": fid}
        )
    items.sort(key=lambda x: -x["issue"])
    return items


def main():
    items = parse(fetch(SITE_URL))
    if not items:
        raise SystemExit("No magazines parsed — site layout may have changed.")
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"Wrote {len(items)} magazines (issues {items[-1]['issue']}–{items[0]['issue']}) to {OUT}")


if __name__ == "__main__":
    main()
