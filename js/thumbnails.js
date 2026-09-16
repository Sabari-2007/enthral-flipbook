// ============================================================
// thumbnails.js — lazy, low-resolution thumbnail strip
// ============================================================
// Thumbnails are rendered one-by-one only when they scroll into view,
// at ~1/5 page resolution, and are cheap enough that a long book still
// stays responsive. Clicking a thumb jumps to that page.

import { el, q } from './ui.js';

const THUMB_HEIGHT = 150;

export class Thumbnails {
  /**
   * @param {object} ui  { strip:'#thumb-strip', current:'#thumb-current',
   *                       panel:'#panel-thumbs' }
   * @param {object} opts { pm: PdfManager, pageCount, onSelect(page) }
   */
  constructor(ui, opts) {
    this.ui = ui;
    this.opts = opts;
    this.strip = q(ui.strip);
    this.currentEl = q(ui.current);
    this.cells = [];
    this._obs = null;
    this._rendered = new Set();
    this._current = 0;
  }

  build() {
    this.clear();
    const { pageCount, onSelect } = this.opts;
    const frag = document.createDocumentFragment();

    for (let p = 1; p <= pageCount; p++) {
      const cell = el('button', 'thumb-cell');
      cell.type = 'button';
      cell.dataset.page = String(p);
      cell.setAttribute('role', 'listitem');
      cell.setAttribute('aria-label', `Go to page ${p}`);

      const media = el('div', 'thumb-drop');
      const num = el('span', 'thumb-num', String(p));
      cell.appendChild(media);
      cell.appendChild(num);

      cell.addEventListener('click', () => onSelect && onSelect(p));
      frag.appendChild(cell);
      this.cells.push({ cell, media, p });
    }

    this.strip.appendChild(frag);
    this._observe();
    return this;
  }

  _observe() {
    if (!('IntersectionObserver' in window)) return;
    this._obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const cell = entry.target;
          const p = Number(cell.dataset.page || 0);
          if (!this._rendered.has(p) && this.opts.pm) {
            this._rendered.add(p);
            this._renderCell(p, cell);
          }
        }
      },
      { root: this.strip, rootMargin: '120px 0px' }
    );
    for (const c of this.cells) this._obs.observe(c.cell);
  }

  async _renderCell(p, cell) {
    const place = q('.thumb-drop', cell);
    if (!place) return;
    try {
      const canvas = await this.opts.pm.getThumbBitmap(p, THUMB_HEIGHT, 1);
      if (!cell.isConnected) return; // panel closed while rendering

      const w = Math.max(20, Math.round(THUMB_HEIGHT * this.opts.pm.pageRatio));
      canvas.style.cssText = `width:${w}px;height:${THUMB_HEIGHT}px;display:block;margin:0 auto;`;
      place.replaceWith(canvas);
    } catch (err) {
      if (place.isConnected) place.classList.add('thumb-drop--error');
    }
  }

  /** Highlight the page currently displayed; scroll the strip near it. */
  setCurrent(pdfPage) {
    this._current = pdfPage;
    if (this.currentEl) this.currentEl.textContent = `Page ${pdfPage}`;
    for (const c of this.cells) {
      c.cell.classList.toggle('is-current', c.p === pdfPage);
    }
    if (this.strip && !this.strip.hidden) {
      const active = this.cells.find((c) => c.p === pdfPage);
      if (active) active.cell.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    }
  }

  open() {
    this.ui.panel.hidden = false;
    // Give the strip dimensions before observing again.
    this.strip.hidden = false;
    if (this._obs) this._obs.disconnect();
    this._observe();
    this.setCurrent(this._current);
  }

  close() {
    this.ui.panel.hidden = true;
    if (this._obs) this._obs.disconnect();
  }

  isOpen() { return !this.ui.panel.hidden; }

  clear() {
    this.strip.innerHTML = '';
    this.cells = [];
    this._rendered.clear();
    if (this._obs) { this._obs.disconnect(); this._obs = null; }
  }

  dispose() { this.clear(); this.ui.panel.hidden = true; }
}