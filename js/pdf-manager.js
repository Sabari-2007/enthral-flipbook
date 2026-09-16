// ============================================================
// pdf-manager.js — lazy PDF loading & rendering for very large files
// ============================================================
//
// Design goals (memory safe for ~300 MB PDFs):
//   * The PDF is opened through a Blob URL so PDF.js pulls only the
//     chunks it needs (range requests) instead of forcing one giant
//     ArrayBuffer up front when the browser supports it.
//   * Pages are rendered lazily — one canvas at a time, sized to the
//     on-screen page width capped at a reasonable pixel ratio.
//   * Rendered pages live in an MRU cache (default max 8 pages). When
//     the cap is exceeded the least-recently-used canvas is dropped and
//     its backing store is zeroed out so pixels are released promptly.
//   * In-flight renders are de-duplicated and matched to cache keys so a
//   * resize re-render can't silently stack work.

const MAX_PAGE_CACHE = 14;      // full-size rendered pages kept in memory
const MAX_THUMB_CACHE = 40;     // small thumbnails kept in memory
export const DPR_CAP = 1.5;     // never create canvas buffers > 1.5x css pixels

/** Friendly, human-parsable errors. */
export class PdfOpenError extends Error {
  constructor(message, kind = 'generic') {
    super(message);
    this.name = 'PdfOpenError';
    this.kind = kind;
  }
}

function workerPath() {
  // Resolves relative to the document (flipbook/index.html).
  return 'vendor/pdf.worker.min.js';
}

export class PdfManager {
  constructor() {
    this._pdf = null;
    this._loadingTask = null;
    this._blobUrl = null;
    this._file = null;
    this.numPages = 0;
    this.pageRatio = 0.75; // fallback portrait ratio, refined after open
    this.metadataTitle = '';
    this._pageCache = new Map();  // key -> { pageNo, canvas }
    this._thumbCache = new Map();
    this._inFlight = new Map();   // key -> Promise<canvas>
    this._workerSet = false;
    this._renderCount = 0;
    this._revoked = false;
  }

  /**
   * Open a PDF File object. Returns a promise resolving to
   * { numPages, ratio, title, fileName, size }.
   */
  async open(file, hooks = {}) {
    const { onLoadProgress } = hooks;

    // ---- validation ----
    if (!window.pdfjsLib) {
      throw new PdfOpenError(
        'The PDF engine did not load. Check that vendor/pdf.min.js is present and that this page is served over http (not opened as a local file).'
      );
    }
    const isPdfName = /\.pdf$/i.test(file?.name || '');
    const isPdfType = file?.type === 'application/pdf';
    if (!isPdfName && !isPdfType) {
      throw new PdfOpenError('That file does not look like a PDF. Please choose a .pdf document.', 'type');
    }

    this._file = file;
    if (!this._workerSet) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerPath();
      this._workerSet = true;
    }

    this._blobUrl = URL.createObjectURL(file);

    // ---- open via Blob URL (progressive / range based) ----
    let pdf = null;
    try {
      const loadingTask = pdfjsLib.getDocument({
        url: this._blobUrl,
        isEvalSupported: false,
        rangeChunkSize: 65536,
        disableAutoFetch: false,
        useSystemFonts: true,
        onProgress: (p) => {
          if (typeof onLoadProgress === 'function' && p && (p.total > 0 || p.loaded > 0)) {
            onLoadProgress(p.loaded, p.total);
          }
        },
      });
      this._loadingTask = loadingTask;
      pdf = await loadingTask.promise;
    } catch (err) {
      // Some environments forbid range fetch against blob URLs — retry with a
      // transferred ArrayBuffer. This is the "every page at once" escape hatch,
      // only used where the lazy path is unavailable.
      console.warn('[flipbook] blob-URL load failed, retrying with ArrayBuffer', err?.name);
      return this._openViaBuffer(file, pdf, hooks);
    }

    return this._finalize(pdf);
  }

  /** Fallback path: feed the whole file to PDF.js as an ArrayBuffer. */
  async _openViaBuffer(file, partialPdf, hooks) {
    if (partialPdf) { try { await partialPdf.destroy(); } catch (e) { /* noop */ } }
    try {
      const data = await file.arrayBuffer();
      const loadingTask = pdfjsLib.getDocument({
        data,
        isEvalSupported: false,
        useSystemFonts: true,
        onProgress: (p) => {
          if (typeof hooks.onLoadProgress === 'function' && p?.total > 0) {
            hooks.onLoadProgress(p.loaded, p.total);
          }
        },
      });
      this._loadingTask = loadingTask;
      const resolved = await loadingTask.promise;
      return this._finalize(resolved);
    } catch (err2) {
      throw this._classify(err2, file);
    }
  }

  async _finalize(pdf) {
    this._pdf = pdf;
    this.numPages = pdf.numPages || 0;

    // Determine the page aspect ratio (width/height) from page 1.
    let ratio = 0.75;
    try {
      const p1 = await pdf.getPage(1);
      const vp = p1.getViewport({ scale: 1 });
      if (vp.height > 0) ratio = vp.width / vp.height;
      p1.cleanup();
    } catch (err) {
      // Some PDFs report zero-size page 1; keep the fallback ratio.
      console.warn('[flipbook] could not measure page 1', err?.name);
    }
    this.pageRatio = ratio;

    // Try to read the document title (purely cosmetic).
    this.metadataTitle = '';
    try {
      const meta = await pdf.getMetadata();
      const title = meta?.info?.Title || meta?.info?.title;
      if (title && String(title).trim()) this.metadataTitle = String(title).trim();
    } catch (err) { /* metadata is optional */ }

    return {
      numPages: this.numPages,
      ratio: this.pageRatio,
      title: this.metadataTitle,
      fileName: this._file.name,
      size: this._file.size,
    };
  }

  /* ---------------- rendering ---------------- */

  /** Resolve the css-pixel width to render a full page at (includes zoom). */
  _targetWidth(pageWidthCss, dpr) {
    const px = Math.max(40, (pageWidthCss || 0) * Math.min(dpr || 1, DPR_CAP));
    return px;
  }

  /**
   * Get (or render) a full-size canvas bitmap for a PDF page.
   * @param {number} pageNo           1-based PDF page number
   * @param {number} pageWidthCss     on-screen css width of ONE page
   * @param {number} [dpr]            device pixel ratio
   * @returns {Promise<HTMLCanvasElement>}
   */
  getPageBitmap(pageNo, pageWidthCss, dpr = 1) {
    const cssW = Math.round(pageWidthCss * 10) / 10;
    const d = Math.min(getDpr(dpr), DPR_CAP);
    const key = `p:${pageNo}:${Math.round(this._targetWidth(cssW, d))}`;
    return this._bitmap(pageNo, key, d, cssW, this._pageCache, MAX_PAGE_CACHE);
  }

  /**
   * Get (or render) a small thumbnail canvas. Height-driven.
   * @returns {Promise<HTMLCanvasElement>}
   */
  getThumbBitmap(pageNo, targetHeight, dpr = 1) {
    const d = Math.min(dpr || 1, DPR_CAP);
    const h = Math.max(24, Math.round(targetHeight * d));
    const key = `t:${pageNo}:${h}`;
    const target = { w: Math.round((h * this.pageRatio) || 1), h };
    return this._bitmap(pageNo, key, null, target, this._thumbCache, MAX_THUMB_CACHE);
  }

  /**
   * Shared internal renderer.
   *  - `size` is either {w,h} (explicit, for thumbs) or a css width
   *    multiplied by dpr inside _targetWidth (for full pages).
   */
  async _bitmap(pageNo, key, dprCap, size, cache, max) {
    if (!this._pdf) throw new PdfOpenError('PDF is not loaded.', 'state');

    // cache hit (MRU bump)
    if (cache.has(key)) {
      const hit = cache.get(key);
      cache.delete(key);
      cache.set(key, hit);
      return hit.canvas;
    }

    // dedupe concurrent render of the same key
    if (this._inFlight.has(key)) return this._inFlight.get(key);

    const promise = (async () => {
      let canvas = null;
      try {
        const page = await this._pdf.getPage(pageNo);
        const vp1raw = page.getViewport({ scale: 1 });
        let scale;
        if (size && typeof size === 'object') {
          // thumbnail path: size = { w, h } in device pixels
          scale = size.w / vp1raw.width;
        } else {
          // full page path: size = css width in px
          scale = this._targetWidth(size, dprCap) / vp1raw.width;
        }
        const viewport = page.getViewport({ scale });
        const outW = Math.max(1, Math.ceil(viewport.width));
        const outH = Math.max(1, Math.ceil(viewport.height));

        canvas = document.createElement('canvas');
        canvas.width = outW;
        canvas.height = outH;
        canvas.dataset.page = String(pageNo);
        const ctx = canvas.getContext('2d', { alpha: false });
        if (ctx) {
          let ok = false;
          try {
            await page.render({ canvasContext: ctx, viewport }).promise;
            ok = true;
          } catch (err) {
            console.warn('[flipbook] page render failed, page', pageNo, err?.message || err);
          }
          if (!ok) {
            // Retry once with an explicit opaque background — a few pages
            // fail to composite onto an alpha:false context without one,
            // and would otherwise show up as a blank page mid-flip.
            try {
              await page.render({ canvasContext: ctx, viewport, background: '#ffffff' }).promise;
            } catch (err2) {
              console.warn('[flipbook] page render retry failed, page', pageNo, err2?.message || err2);
            }
          }
        }
        page.cleanup();
      } catch (err) {
        // Rendering error — surface as a blank white page so the app
        // never crashes, and let it retry naturally on the next visit.
        canvas = document.createElement('canvas');
        canvas.width = 2;
        canvas.height = 2;
        canvas.dataset.page = String(pageNo);
      }

      const entry = { pageNo, canvas, key };
      cache.set(key, entry);
      this._enforceCache(cache, max);
      return canvas;
    })();

    this._inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      this._inFlight.delete(key);
    }
  }

  /** Enforce the LRU cap and release pixels from evicted canvases. */
  _enforceCache(cache, max) {
    while (cache.size > max) {
      const oldestKey = cache.keys().next().value;
      const evicted = cache.get(oldestKey);
      cache.delete(oldestKey);
      // Never zero a canvas that is still attached to a live page — that
      // would blank it on screen until the next render pass.
      if (evicted?.canvas && !evicted.canvas.isConnected) {
        try {
          if (evicted.canvas.width) evicted.canvas.width = 0;
          if (evicted.canvas.height) evicted.canvas.height = 0;
          evicted.canvas.removeAttribute('height');
          evicted.canvas.removeAttribute('width');
        } catch (e) { /* noop */ }
      }
    }
    // Periodically drop PDF.js's own intermediate page caches.
    if (this._pdf) {
      this._renderCount++;
      if (this._renderCount % 6 === 0) {
        try { this._pdf.cleanup(); } catch (e) { /* noop */ }
      }
    }
    // Bounded in-flight bookkeeping.
    if (this._inFlight.size > MAX_PAGE_CACHE * 2) {
      this._inFlight.clear();
    }
  }

  /** Resolve cached canvas for a page key (used by tests/UI). */
  hasPageInCache(pageNo) {
    for (const [, e] of this._pageCache) if (e.pageNo === pageNo) return true;
    return false;
  }

  /* ---------------- text search ---------------- */

  /** Extract plain text of a page. Returns '' when the page is image-only. */
  async getPageText(pageNo) {
    if (!this._pdf) return '';
    try {
      const page = await this._pdf.getPage(pageNo);
      const items = await page.getTextContent();
      const text = items.items
        .map((it) => (it.str || ' '))
        .join(' ')
        .replace(/\s+/g, ' ');
      page.cleanup();
      return text.trim();
    } catch (err) {
      return '';
    }
  }

  /* ---------------- error classification ---------------- */

  _classify(err, file) {
    const name = err?.name || '';
    if (name === 'PasswordException') {
      return new PdfOpenError(
        'This PDF is password protected. FlipBook does not currently unlock password-protected PDFs.',
        'password'
      );
    }
    if (name === 'InvalidPDFException' || name === 'MissingPDFException') {
      return new PdfOpenError(
        'Unable to open this PDF. The file may be corrupted or not a valid PDF.',
        'corrupt'
      );
    }
    if (name === 'XRefParseException' || name === 'UnexpectedServerResponseException') {
      return new PdfOpenError(
        'Unable to open this PDF. The file may be corrupted or unreadable.',
        'corrupt'
      );
    }
    if (/password/i.test(String(err?.message || ''))) {
      return new PdfOpenError('This PDF is password protected.', 'password');
    }
    if (/memory|cannot allocate/i.test(String(err?.message || ''))) {
      return new PdfOpenError(
        'Not enough browser memory to open this document. Try closing other tabs or a smaller file.',
        'memory'
      );
    }
    const size = file?.size || 0;
    if (size > 0 && err && /worker/i.test(err.message)) {
      return new PdfOpenError(
        'The PDF worker failed to start. Serve this folder with a local HTTP server (e.g. Live Server) and retry.',
        'worker'
      );
    }
    return new PdfOpenError(
      err?.message || 'The document could not be opened.',
      'generic'
    );
  }

  /* ---------------- cleanup ---------------- */

  /** Release the document, workers, blob URL and all buffers. */
  async dispose() {
    for (const map of [this._pageCache, this._thumbCache]) {
      for (const [, e] of map) {
        if (e?.canvas) {
          try { e.canvas.width = 0; e.canvas.height = 0; } catch (err) { /* noop */ }
        }
      }
      map.clear();
    }
    this._inFlight.clear();
    if (this._loadingTask) { try { await this._loadingTask.destroy(); } catch (e) { /* noop */ } }
    if (this._pdf) { try { await this._pdf.destroy(); } catch (e) { /* noop */ } }
    if (this._blobUrl && !this._revoked) {
      URL.revokeObjectURL(this._blobUrl);
      this._revoked = true;
    }
    this._pdf = null;
    this._loadingTask = null;
  }

  get fileSize() {
    return this._file?.size || 0;
  }
}

function getDpr(d) {
  return d || (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
}