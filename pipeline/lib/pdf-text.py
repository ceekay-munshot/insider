#!/usr/bin/env python3
# pdf-text.py — read a PDF from stdin, print its text to stdout.
#
# Used by step 01b to read a board-meeting *intimation* PDF and pull the
# scheduled meeting time ("...held on <date> at 4:00 pm..."). Kept tiny and
# fail-soft: any problem (missing lib, unreadable/scanned PDF) prints nothing and
# exits 0, so the Node caller simply treats it as "no time found".
import sys

try:
    try:
        import pymupdf as _fitz  # PyMuPDF >= 1.24
    except Exception:
        import fitz as _fitz  # older import name
    data = sys.stdin.buffer.read()
    doc = _fitz.open(stream=data, filetype="pdf")
    parts = []
    for page in doc:
        parts.append(page.get_text())
    sys.stdout.write("\n".join(parts))
except Exception:
    # No text extracted — caller falls back to the outcome time / default.
    sys.exit(0)
