#!/usr/bin/env python3
"""Builds `long-manual.pdf`: 214 pages of alarm text, the length of a real one.

WHY 214 PAGES. It is the length `docs/library-ocr.md` has used throughout as the
representative long manual, so the extraction measurement and the recognition
measurement describe documents of the same size and can be compared.

WHAT IT IS FOR. Two facts that only a long document can establish:

  1. HOW LONG EXTRACTION TAKES. 0.21 s through the real service, against 83 to
     89 minutes for the same length through recognition — which is why
     extraction happens inside the upload request and recognition cannot.
  2. THAT `MAX_INDEXED_CHARACTERS` NOW BITES. At about 4 kB of text a page this
     manual produces 896 kB, so the 400 000-character index budget stops at
     page 96 and the remaining 118 pages are not searchable. The library says
     so rather than hiding it, and `docs/library-ocr.md` §0 carries the
     measurement and the recommendation.

Every page carries its own alarm numbers, so a test can tell WHICH pages reached
the index rather than only how many.

Run it from the repository root:

    python3 -I src/services/__fixtures__/make-long-manual.py \
            src/services/__fixtures__/long-manual.pdf
"""

import sys
import zlib

PAGES = 214
LINES_PER_PAGE = 45
LINE = (
    "ALARM %d MODULE OVERTEMPERATURE CHECK THE COOLING FAN AND THE FILTER "
    "BEFORE REPLACING THE DRIVE"
)

objects: dict[int, bytes] = {}
objects[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
objects[4] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"

page_ids: list[int] = []
next_id = 100
for page in range(PAGES):
    lines = "\n".join(
        "BT /F1 10 Tf 40 %d Td (%s) Tj ET"
        % (780 - 14 * line, LINE % (300000 + page * 40 + line))
        for line in range(LINES_PER_PAGE)
    )
    body = zlib.compress((lines + "\n").encode("latin-1"))
    content_id, page_id = next_id, next_id + 1
    next_id += 2
    objects[content_id] = (
        b"<< /Length %d /Filter /FlateDecode >>\nstream\n" % len(body) + body + b"\nendstream"
    )
    objects[page_id] = (
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources "
        b"<< /Font << /F1 4 0 R >> >> /Contents %d 0 R >>" % content_id
    )
    page_ids.append(page_id)

objects[2] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (
    b" ".join(b"%d 0 R" % page_id for page_id in page_ids),
    len(page_ids),
)

out = bytearray(b"%PDF-1.7\n")
offsets: dict[int, int] = {}
for number in sorted(objects):
    offsets[number] = len(out)
    out += b"%d 0 obj\n" % number + objects[number] + b"\nendobj\n"

start = len(out)
highest = max(objects) + 1
out += b"xref\n0 %d\n" % highest
out += b"0000000000 65535 f \n"
for number in range(1, highest):
    if number in offsets:
        out += b"%010d 00000 n \n" % offsets[number]
    else:
        out += b"0000000000 65535 f \n"
out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (highest, start)

destination = sys.argv[1]
with open(destination, "wb") as handle:
    handle.write(bytes(out))
print("wrote %s (%d bytes, %d pages)" % (destination, len(out), PAGES))
