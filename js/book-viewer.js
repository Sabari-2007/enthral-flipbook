// ============================================================
// book-viewer.js — thin, robust wrapper around StPageFlip
// ============================================================
//
// Handles:
//   * responsive sizing (spread fills ~most of the stage, capped at
//     sensible limits), as StPageFlip "stretch" reads the parent box
//   * forcing portrait / landscape orientation to match the app's
//     reading mode (the library only auto-flips when minWidth allows)
//   * the exact mapping between PDF page numbers and the library's
//     item index / spread index model, including the cover page
//   * next / prev / jump (animated for adjacent spreads, instant jump
//     for long distances)
//
// StPageFlip layout model (v2.x):
//   items[] index i -> PDF page i+1
//   portrait: one page per spread   -> spreadIndex = i (= page-1)
//   landscape (showCover): [0] alone (cover), then [1,2],[3,4],...
//     spreadIndex s (s>=1) shows pages {2s, 2s+1}
//   getCurrentPageIndex() returns spread[0] (item index of left page)

import { el } from './ui.js';
import { playPageTurn } from './sound.js';

const ANIM_MS = 750;

export class BookViewer {
  /**
   * @param {HTMLElement} root        existing element that will hold the book
   * @param {object} opts
   * @param {number} opts.pageCount   total PDF pages
   * @param {number} opts.ratio       pdf page aspect (width/height)
   * @param {boolean} opts.animation  page-turn animation on/off
   * @param {object} opts.listeners   { onFlip(idx), onState(state), onOrientation(o) }
   */
  constructor(root, opts) {
    this.root = root;
    this.pageCount = Math.max(1, opts.pageCount);
    this.ratio = opts.ratio || 0.75;
    this.animation = opts.animation !== false;
    this.listeners = opts.listeners || {};
    this.pageFlip = null;
    this.items = [];
    this.lastMetrics = null;
    this._defaults = null;
    this._prevSpread = null;
  }

  get isMounted() { return !!this.pageFlip; }

  /* ---------------- lifecycle ---------------- */

  mount() {
    if (this.pageFlip) return;

    const items = [];
    for (let i = 0; i < this.pageCount; i++) {
      const page = el('div', 'fb-page');
      if (i === 0) page.dataset.density = 'hard';
      const inner = el('div', 'fb-page-inner');
      const skel = el('div', 'fb-skeleton');
      inner.appendChild(skel);
      page.appendChild(inner);
      items.push(page);
    }

    const flipRoot = el('div', 'flip-root');
    this.root.appendChild(flipRoot);
    this.items = items;

    const FlipClass = window.St?.PageFlip || window.PageFlip;
    if (!FlipClass) {
      throw new Error('StPageFlip library not found. Check vendor/page-flip.browser.js.');
    }

    this.pageFlip = new FlipClass(flipRoot, {
      width: 600,                          // base page size — only the RATIO matters
      height: 600 / this.ratio,            // (used for autoSize padding + layout math)
      size: 'stretch',
      minWidth: 1,
      maxWidth: 2200,
      minHeight: 1,
      maxHeight: 2200,
      flippingTime: ANIM_MS,
      usePortrait: true,
      autoSize: true,
      showCover: true,
      drawShadow: true,
      maxShadowOpacity: 0.55,
      startZIndex: 0,
      mobileScrollSupport: true,
      swipeDistance: 22,
      clickEventForward: false,
      useMouseEvents: true,
      showPageCorners: true,
      disableFlipByClick: false,
      startPage: 0,
    });

    this.pageFlip.on('flip', (e) => {
      const cur = this._currentSpreadIndex();
      let dir = 1;
      if (this._prevSpread !== null) dir = Math.sign(cur - this._prevSpread) || 1;
      this._prevSpread = cur;
      playPageTurn(dir);
      this._safe('onFlip', e.data);
    });
    this.pageFlip.on('changeState', (e) => this._safe('onState', e.data));
    this.pageFlip.on('changeOrientation', (e) => this._safe('onOrientation', e.data));
    this.pageFlip.on('init', () => this._safe('onInit'));

    this.pageFlip.loadFromHTML(items);

    // Layout immediately so the first window can be rendered (the 'init'
    // event refines it a tick later).
    this.layout(this.lastLayoutInput || {});
    return this;
  }

  dispose() {
    if (this.pageFlip) {
      try { this.pageFlip.destroy(); } catch (err) { /* carry on */ }
      this.pageFlip = null;
    }
    this.root.innerHTML = '';
    this.items = [];
    this.lastMetrics = null;
  }

  _safe(name, value) {
    try { this.listeners[name]?.(value); } catch (err) {
      console.error('[flipbook] listener error', name, err);
    }
  }

  /* ---------------- sizing / orientation ---------------- */

  /**
   * Recompute the shell (book container) size for the current stage and
   * force the desired orientation, then tell StPageFlip to re-measure.
   * Cheap enough to call on every resize / fullscreen / mode change.
   *
   * @param {{stageW:number, stageH:number, mode:string}} input
   *   mode: 'auto' | 'single' | 'two'
   */
  layout(input = {}) {
    if (!this.pageFlip) return null;
    this.lastLayoutInput = input;

    const stageW = Math.max(80, input.stageW || 800);
    const stageH = Math.max(120, input.stageH || 600);
    const mode = input.mode || 'auto';
    const r = this.ratio || 0.75;

    // Orientation decides how many pages turn per swipe.
    //   'two'   => two-page spread, indices advance by +2/-2 per turn
    //   'single'=> one page at a time
    //   'auto'  => spread on wide screens, single page below 768px
    let force;
    if (mode === 'two') force = 'landscape';
    else if (mode === 'single') force = 'portrait';
    else force = stageW < 768 || stageH < 460 ? 'portrait' : 'landscape';

    let shellW;
    if (force === 'landscape') {
      // Two-page spread. Height of the spread = shellW / (2 * ratio).
      // Cap by width AND by height so the book never overflows vertically.
      shellW = Math.min(stageW, stageH * 2 * r, 1260);
    } else {
      // Single portrait page.
      shellW = Math.min(stageW, stageH * r, 780);
    }
    const shellH = force === 'landscape' ? shellW / (2 * r) : shellW / r;

    this.root.style.width = `${Math.round(shellW)}px`;
    this.root.style.height = `${Math.round(shellH)}px`;

    // Force orientation by adjusting the library's auto-portrait threshold.
    // When forcing portrait we need minWidth * 2 > shellW; landscape just
    // requires a tiny threshold.
    const s = this.pageFlip.getSettings();
    if (force === 'portrait') s.minWidth = shellW / 2 + 1;
    else s.minWidth = 1;

    this.pageFlip.update();

    const rect = this.pageFlip.getBoundsRect();
    const metrics = {
      orientation: this.pageFlip.getOrientation() === 'portrait' ? 'portrait' : 'landscape',
      shellW,
      shellH,
      pageWidth: rect?.pageWidth || shellW / 2,
      pageHeight: rect?.height || shellH,
      left: rect?.left || 0,
      top: rect?.top || 0,
    };
    this.lastMetrics = metrics;
    return metrics;
  }

  /** Displayed page width in CSS px (used to size canvas buffers). */
  get pageWidthCss() {
    return this.lastMetrics?.pageWidth || 1;
  }

  get orientation() {
    return this.pageFlip ? (this.pageFlip.getOrientation() === 'portrait' ? 'portrait' : 'landscape') : 'landscape';
  }

  /* ---------------- spread math ---------------- */

  _lastSpreadIndex() {
    if (this.orientation === 'portrait') return this.pageCount - 1;
    return this.pageCount <= 1 ? 0 : Math.floor(this.pageCount / 2);
  }

  _spreadIndexFor(pdfPage) {
    if (this.orientation === 'portrait') return pdfPage - 1;
    if (pdfPage === 1) return 0;
    return Math.floor(pdfPage / 2);
  }

  /** Library index of the current spread (item index of its left page). */
  getItemIndex() {
    return this.pageFlip ? this.pageFlip.getCurrentPageIndex() : 0;
  }

  _currentSpreadIndex() {
    if (!this.pageFlip) return 0;
    const cur = this.pageFlip.getCurrentPageIndex();
    if (this.orientation === 'portrait') return cur;
    return cur === 0 ? 0 : (cur + 1) / 2;
  }

  /** PDF page numbers currently visible, e.g. [4,5] or [1]. */
  visiblePdfPages() {
    if (!this.pageFlip) return [1];
    const cur = this.getItemIndex();
    if (this.orientation === 'portrait') return [cur + 1];
    if (cur === 0) return [1];
    return [cur + 1, cur + 2].filter((p) => p <= this.pageCount);
  }

  /** PDF page numbers of the spread at `offset` spreads away from current. */
  spreadPdfPagesByOffset(offset = 0) {
    if (!this.pageFlip) return [];
    const target = this._currentSpreadIndex() + offset;
    const last = this._lastSpreadIndex();
    if (target < 0 || target > last) return [];
    if (this.orientation === 'portrait') return [target + 1];
    if (target === 0) return [1];
    return [2 * target, 2 * target + 1].filter((p) => p <= this.pageCount);
  }

  canPrev() { return this._currentSpreadIndex() > 0; }
  canNext() { return this._currentSpreadIndex() < this._lastSpreadIndex(); }

  /* ---------------- navigation ---------------- */

  currentItemIndex() { return this.getItemIndex(); }

  next() {
    if (!this.canNext()) return false;
    if (this.animation) this.pageFlip.flipNext('top');
    else this.pageFlip.turnToNextPage();
    return true;
  }

  prev() {
    if (!this.canPrev()) return false;
    if (this.animation) this.pageFlip.flipPrev('top');
    else this.pageFlip.turnToPrevPage();
    return true;
  }

  /**
   * Jump to a PDF page. Adjacent spread => animated flip; big jumps => instant.
   */
  goTo(pdfPage) {
    if (!this.pageFlip) return;
    const p = Math.max(1, Math.min(this.pageCount, Math.round(pdfPage)));
    if (p === this.visiblePdfPages()[0]) return;

    const target = this._spreadIndexFor(p);
    const current = this._currentSpreadIndex();
    const delta = target - current;
    const absDelta = Math.abs(delta);

    if (this.animation && absDelta === 1) {
      if (delta > 0) this.pageFlip.flipNext('top');
      else this.pageFlip.flipPrev('top');
    } else if (this.animation && absDelta > 1 && absDelta <= 3) {
      // Sweep through a few spreads quickly but still feel alive.
      const steps = delta > 0 ? absDelta : -absDelta;
      let done = 0;
      const tick = () => {
        if (done >= Math.abs(steps) || !this.pageFlip) return;
        // Flipping while flipping is ignored by the library, so keep it 1:1.
        this.pageFlip.flipNext('top');
        done++;
        setTimeout(tick, 60);
      };
      tick();
    } else {
      this.pageFlip.turnToPage(p - 1);
    }
  }

  first() { this.goTo(1); }
  last() { this.goTo(this.pageCount); }

  /** The element that displays a given PDF page. */
  itemForPage(pdfPage) {
    return this.items[pdfPage - 1] || null;
  }
}