# pdf.js 4.10.38 (vendored)

The PDF engine behind EJE's one document viewer (`src/components/documents/PdfViewer.tsx`).
It draws every page of a PDF itself, so a preview never depends on the browser
having a built-in PDF viewer — Chrome on Android, the EJE tablets, has none.

- Source: the published npm package `pdfjs-dist@4.10.38`
  (`https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-4.10.38.tgz`),
  integrity `sha512-/Y3fcFrXEAsMjJXeL9J8+ZG9U01LbuWaYypvDW2ycW1jL269L3js3DVBjDJ0Up9Np1uqDXsDrRihHANhZOlwdQ==`
  (checked against the registry when vendored, 31 October 2026).
- Files, unmodified: `build/pdf.min.mjs`, `build/pdf.worker.min.mjs`, `standard_fonts/`.
- Licence: Apache-2.0 (`LICENSE`); the fonts carry their own licences in `standard_fonts/`.
- Free; no account, key or network service.

WHY VENDORED rather than an npm dependency: the release gate that runs the live
release against this release's database refuses any change to
`package-lock.json` (`scripts/release/rollback-compat.sh`), and static files
served from a versioned path are also what the service worker can cache for the
offline signing wizard (`public/eje-sw.js`). To upgrade, vendor a new version
under a new versioned folder and change `PDFJS_BASE` in `PdfViewer.tsx`.
