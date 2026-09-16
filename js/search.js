// ============================================================
// search.js — progressive, cancellable text search across a PDF
// ============================================================
// Large PDFs are scanned page by page (never all at once). The scan
// yields to the browser every few pages so it never blocks the UI,
// results appear live as soon as they're found, and the whole job can
// be cancelled from the UI.

import { el, escapeHtml, normalizeQuery, snippet } from './ui.js';

const MAX_RESULTS = 500;
const YIELD_EVERY = 3;

export class BookSearch {
  /**
   * @param {object} ui   DOM element ids (strings) — see constructor body
   * @param {object} opts { pm: PdfManager, pageCount, onOpenPage(page) }
   */
  constructor(ui, opts) {
    this.opts = opts;
    this._cache = new Map(); // pageNo -> text (weak memory: capped below)
    this._abort = null;
    this._running = false;

    this.resultsEl = document.getElementById(ui.results);
    this.progressWrap = document.getElementById(ui.progress);
    this.fillEl = document.getElementById(ui.fill);
    this.statusEl = document.getElementById(ui.status);
    this.emptyEl = document.getElementById(ui.empty);
    this.emptyTitleEl = document.getElementById(ui.emptyTitle);
    this.emptySubEl = document.getElementById(ui.emptySub);
  }

  async run(rawQuery) {
    const query = normalizeQuery(rawQuery);
    if (!query || !this.opts.pm) return;
    this.cancel();

    const { pm, pageCount, onOpenPage } = this.opts;
    this._running = true;
    this._abort = { cancelled: false };

    this.resultsEl.innerHTML = '';
    this.emptyEl.hidden = true;
    this.progressWrap.hidden = false;
    this._setStatus(`Searching…`);

    let found = 0;
    const abort = () => this._abort.cancelled;

    const yieldTask = () =>
      new Promise((res) =>
        (typeof requestIdleCallback === 'function'
          ? requestIdleCallback(res, { timeout: 40 })
          : setTimeout(res, 0))
      );

    for (let p = 1; p <= pageCount; p++) {
      if (abort()) break;
      if (p % YIELD_EVERY === 0) await yieldTask();

      let text = this._cache.get(p);
      if (text === undefined) {
        text = await pm.getPageText(p);
        if (text) this._rememberText(p, text);
      }

      if (abort()) break;

      if (text) {
        const idx = text.toLowerCase().indexOf(query);
        if (idx >= 0) {
          found++;
          if (found <= MAX_RESULTS) {
            this._addResult(p, text, query, onOpenPage);
          }
        }
      }

      if (p % 10 === 0 || p === pageCount) {
        const pct = Math.round((p / pageCount) * 100);
        this.fillEl.style.width = `${pct}%`;
        this._setStatus(`Page ${p} / ${pageCount} — ${found} match${found === 1 ? '' : 'es'}`);
      }
    }

    this._running = false;
    if (abort()) {
      this._setStatus(`Stopped. ${found} match${found === 1 ? '' : 'es'} found.`);
      return;
    }

    this.fillEl.style.width = '100%';
    this._setStatus(`Done — ${found.toLocaleString()} match${found === 1 ? '' : 'es'} across ${pageCount.toLocaleString()} pages`);
    if (found === 0) {
      this.emptyEl.hidden = false;
      this.emptyTitleEl.textContent = 'No matches';
      this.emptySubEl.textContent = 'Search extracted the text of every page in this scan. The words you searched for were not found, or the pages are image-only scans.';
    } else if (found > MAX_RESULTS) {
      this.emptyEl.hidden = false;
      this.emptyTitleEl.textContent = 'Many matches';
      this.emptySubEl.textContent = `Showing the first ${MAX_RESULTS} of ${found.toLocaleString()} matches. Refine your search to narrow it down.`;
    }
  }

  _rememberText(p, text) {
    this._cache.set(p, text);
    if (this._cache.size > 300) {
      const oldest = this._cache.keys().next().value;
      this._cache.delete(oldest);
    }
  }

  _addResult(p, text, query, onOpenPage) {
    const row = el('button', 'search-result');
    row.type = 'button';
    row.setAttribute('aria-label', `Go to page ${p}`);
    row.addEventListener('click', () => onOpenPage(p));

    const badge = el('span', 'search-result-badge', `Page ${p}`);
    const raw = snippet(text, query, 110);
    const highlighted = escapeHtml(raw).replace(
      new RegExp(`(${escapeRegex(query)})`, 'gi'),
      '<mark>$1</mark>'
    );
    const body = el('span', 'search-result-text', highlighted);
    row.append(badge, body);
    this.resultsEl.appendChild(row);
  }

  _setStatus(msg) {
    if (this.statusEl) this.statusEl.textContent = msg;
  }

  cancel() {
    if (this._abort) this._abort.cancelled = true;
    this._abort = null;
  }

  clear() {
    this.cancel();
    this.resultsEl.innerHTML = '';
    this.progressWrap.hidden = true;
    this.emptyEl.hidden = true;
    this._cache.clear();
  }

  get isRunning() { return this._running; }
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}