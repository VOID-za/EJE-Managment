#!/usr/bin/env python3
"""Builds `cid-manual.pdf`, the fixture LIB-TEXT-1 is measured against.

WHY A BUILT FIXTURE RATHER THAN A REAL MANUAL. A manufacturer's manual is
somebody's copyright and megabytes of it, and a test needs neither. What the
test needs is a PDF encoded THE WAY A REAL ONE IS, and that is a precise,
reproducible thing:

  * a Type0 font with /Identity-H encoding and a subset /BaseFont name,
  * the content stream carrying GLYPH IDS rather than characters,
  * a /ToUnicode CMap mapping those ids back to text,
  * FlateDecode on every stream.

That is what Acrobat, InDesign and FrameMaker produce, and it is exactly the
case `src/lib/pdf/extract-text.ts` states it cannot read: without walking the
/ToUnicode map, the glyph ids come out as mojibake, the readable-character
check correctly rejects them, and the document is reported as a scan that needs
recognition. `pdftotext` resolves the map and returns the sentence.

FOUR PAGES, AND PAGE 3 IS DELIBERATELY A PICTURE. A real manual is mostly text
with the occasional scanned diagram, and that mix is the whole point of the
per-page index: three pages are searchable at once, one page is named as the
only candidate for recognition, and the document is honestly PARTIALLY
searchable rather than wholly one thing or the other.

Run it from the repository root:

    python3 -I src/services/__fixtures__/make-cid-manual.py \
            src/services/__fixtures__/cid-manual.pdf
"""

import sys
import zlib

# Page 3 has no text at all: an image-only page, like a scanned wiring diagram.
PAGES = [
    "ALARM 414 HYDRAULIC PRESSURE LOW CHECK PUMP AND RELIEF VALVE",
    "ALARM 415 LIFT MOTOR OVERTEMPERATURE ALLOW TO COOL BEFORE RESTART",
    None,
    "TORQUE SETTINGS MAST BOLTS 210 NEWTON METRES LUBRICATE BEFORE FITTING",
]

# One subset font for the whole document, numbering its glyphs from 3 upward in
# the order they first appear -- which is what a subsetter does.
order: list[str] = []
gid_of: dict[str, int] = {}
for page in PAGES:
    for character in page or "":
        if character not in gid_of:
            gid_of[character] = 3 + len(order)
            order.append(character)

TOUNICODE = """/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CMapName /Identity-H def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
%d beginbfchar
%s
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end
""" % (
    len(order),
    "\n".join("<%04X> <%04X>" % (gid_of[c], ord(c)) for c in order),
)


def flate(payload: bytes) -> bytes:
    body = zlib.compress(payload)
    return b"<< /Length %d /Filter /FlateDecode >>\nstream\n" % len(body) + body + b"\nendstream"


def text_content(line: str) -> bytes:
    codes = "".join("%04X" % gid_of[c] for c in line)
    return ("BT /F1 12 Tf 60 760 Td <%s> Tj ET\n" % codes).encode("latin-1")


# A 2x2 grey image stands in for a scanned diagram: the page carries marks and
# no text, which is what makes it a recognition candidate rather than a blank.
IMAGE_BYTES = bytes([0x40, 0xC0, 0xC0, 0x40])
PICTURE_CONTENT = b"q 400 0 0 300 60 450 cm /Im1 Do Q\n"

objects: dict[int, bytes] = {}
page_ids: list[int] = []
next_id = 100

objects[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
objects[4] = (
    b"<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+Helvetica /Encoding /Identity-H "
    b"/DescendantFonts [5 0 R] /ToUnicode 6 0 R >>"
)
objects[5] = (
    b"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AAAAAA+Helvetica /CIDSystemInfo "
    b"<< /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 8 0 R /DW 600 >>"
)
objects[6] = flate(TOUNICODE.encode("latin-1"))
objects[8] = (
    b"<< /Type /FontDescriptor /FontName /AAAAAA+Helvetica /Flags 4 /ItalicAngle 0 "
    b"/Ascent 718 /Descent -207 /CapHeight 718 /StemV 88 /FontBBox [-166 -225 1000 931] >>"
)
objects[9] = (
    b"<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray "
    b"/BitsPerComponent 8 /Length %d >>\nstream\n" % len(IMAGE_BYTES)
) + IMAGE_BYTES + b"\nendstream"

for line in PAGES:
    content_id, page_id = next_id, next_id + 1
    next_id += 2
    objects[content_id] = flate(text_content(line) if line is not None else PICTURE_CONTENT)
    resources = (
        b"<< /Font << /F1 4 0 R >> >>" if line is not None else b"<< /XObject << /Im1 9 0 R >> >>"
    )
    objects[page_id] = (
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources "
        + resources
        + b" /Contents %d 0 R >>" % content_id
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

# A plain cross-reference TABLE rather than a stream: the built-in reader does
# not walk the xref at all (it scans for the `stream` keyword), so using the
# older form keeps this fixture about FONT ENCODING and nothing else.
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
print("wrote %s (%d bytes, %d pages, page 3 is an image)" % (destination, len(out), len(PAGES)))
