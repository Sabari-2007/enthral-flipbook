// ============================================================
// app.js — FlipBook main controller
// ============================================================
import {
  el, debounce, formatBytes, titleFromFileName, escapeHtml, friendlyDate,
} from './js/ui.js';
import * as store from './js/storage.js';
import { listBooks, uploadPdf, deleteBook, bookPdfUrl, shareLinkFor } from './js/cloud.js';
import { PdfManager, PdfOpenError } from './js/pdf-manager.js';
import { BookViewer } from './js/book-viewer.js';
import { Thumbnails } from './js/thumbnails.js';

/* ---------------- DOM refs ---------------- */
const $ = (id) => document.getElementById(id);

const UI = {
  app: $('app'),
  brand: $('brand'),
  brandMeta: $('brand-meta'),
  btnCloseBook: $('btn-close-book'),
  btnUploadTop: $('btn-upload-top'),
  btnUploadWelcome: $('btn-upload-welcome'),
  btnUploadCta: $('btn-upload-cta'),
  btnLibraryUpload: $('btn-library-upload'),
  fileInput: $('file-input'),
  toolbar: $('toolbar'),

  viewWelcome: $('view-welcome'),
  viewReader: $('view-reader'),
  viewLibrary: $('view-library'),
  nav: { home: $('nav-home'), library: $('nav-library'), settings: $('nav-settings') },

  readerBookTitle: $('reader-book-title'),
  readerBookPages: $('reader-book-pages'),
  readerChip: $('reader-current-chip'),
  readerStage: $('reader-stage'),
  bookShell: $('book-shell'),
  pageLoading: $('page-loading'),
  pageLoadingText: $('page-loading-text'),

  arrowPrev: $('btn-arrow-prev'),
  arrowNext: $('btn-arrow-next'),
  pageInput: $('page-input'),
  pageTotal: $('page-total'),
  btnThumbs: $('btn-thumbs'),
  thumbPanel: $('panel-thumbs'),
  thumbStrip: $('thumb-strip'),
  thumbCurrent: $('thumb-current'),

  zoomLabel: $('zoom-label'),
  btnShare: $('btn-share'),
  btnFullscreen: $('btn-fullscreen'),
  btnExitFs: $('btn-exit-fs'),

  panelShare: $('panel-share'),
  btnCloseShare: $('btn-close-share'),
  shareForm: $('share-form'),
  shareLinkInput: $('share-link-input'),
  btnCopyLink: $('btn-copy-link'),
  shareMeta: $('share-meta'),
  panelSettings: $('panel-settings'),
  btnCloseSettings: $('btn-close-settings'),
  btnClearLibrary: $('btn-clear-library'),

  libraryList: $('library-list'),
  libraryEmpty: $('library-empty'),
  recentWrap: $('recent-wrap'),
  recentList: $('recent-list'),

  dropZone: $('drop-zone'),
  loadOverlay: $('load-overlay'),
  loadTitle: $('load-title'),
  loadSub: $('load-sub'),
  loadBarFill: $('load-bar-fill'),
  toast: $('toast'),

  setThemeDark: $('set-theme-dark'),
  setThemeLight: $('set-theme-light'),
  setModeAuto: $('set-mode-auto'),
  setModeSingle: $('set-mode-single'),
  setModeTwo: $('set-mode-two'),
  setAnim: $('set-anim'),
  setAutoturn: $('set-autoturn'),
  setRemember: $('set-remember'),
};

const ZOOMS = [0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5];

const state = {
  book: null,
  pm: null,
  meta: null,
  cloudId: null,
  cloudBooks: [],
  settings: null,
  zoomIndex: 2,
  zoom: 0.9,
  winToken: 0,
  opening: false,
  thumbnails: null,
  autoTurnTimer: null,
};

let pendingSharedPage = null;

const SIDE_PANELS = ['panelShare', 'panelSettings'];

/* ============================================================
   INIT
   ============================================================ */
function init() {
  state.settings = store.loadSettings();
  state.settings.readingMode = 'two';
  applySettings(state.settings);

  wireNav();
  wireButtons();
  wireToolbar();
  wireKeyboard();
  wireDragDrop();
  wireResize();
  wireFullscreen();
  wirePanels();
  wireShare();

  refreshSettingsUI();
  renderLibrary();
  renderRecent();
  refreshCloud();
  checkSharedLink();

  if (!document.documentElement.requestFullscreen) UI.btnFullscreen.hidden = true;

  showView('welcome');
  console.log('[flipbook] FlipBook ready');
}

/* ============================================================
   NAVIGATION
   ============================================================ */
function wireNav() {
  const items = [
    { btn: UI.nav.home, fn: () => showView(state.book ? 'reader' : 'welcome') },
    { btn: UI.nav.library, fn: () => showView('library') },
    { btn: UI.nav.settings, fn: openSettingsPanel },
  ];
  for (const { btn, fn } of items) btn.addEventListener('click', fn);
  UI.brand.addEventListener('click', (e) => { e.preventDefault(); items[0].fn(); });
}

function setActiveNav(name) {
  const active = ({ welcome: 'home', reader: 'home', library: 'library' })[name] || 'home';
  for (const k in UI.nav) UI.nav[k].classList.toggle('is-active', k === active);
}

function showView(name) {
  state.view = name;
  UI.viewWelcome.classList.toggle('is-hidden', name !== 'welcome');
  UI.viewReader.classList.toggle('is-hidden', name !== 'reader');
  UI.viewLibrary.classList.toggle('is-hidden', name !== 'library');
  setActiveNav(name);
  closeSidePanels();
  if (name === 'library') renderLibrary();
  requestAnimationFrame(() => setBookPositionControls());
}

function closeSidePanels() {
  UI.panelShare.hidden = true;
  UI.panelSettings.hidden = true;
  UI.thumbPanel.hidden = true;
  if (state.thumbnails) state.thumbnails.close();
  UI.btnThumbs.classList.remove('is-on');
}

function openSettingsPanel() {
  closeSidePanels();
  UI.panelSettings.hidden = false;
}

function requireBook() {
  if (state.book) return true;
  toast('Open a PDF first.');
  return false;
}

/* ============================================================
   UPLOAD FLOW
   ============================================================ */
function wireButtons() {
  const pick = () => UI.fileInput.click();
  UI.btnUploadTop.addEventListener('click', pick);
  UI.btnUploadWelcome.addEventListener('click', pick);
  UI.btnUploadCta.addEventListener('click', pick);
  UI.btnLibraryUpload.addEventListener('click', pick);

  UI.fileInput.addEventListener('change', () => {
    const file = UI.fileInput.files && UI.fileInput.files[0];
    UI.fileInput.value = '';
    if (file) openFile(file);
  });

  UI.btnCloseBook.addEventListener('click', closeBook);
  UI.btnClearLibrary.addEventListener('click', () => {
    store.clearLibrary();
    renderLibrary();
    renderRecent();
    toast('Library history cleared.');
  });
}

function wireToolbar() {
  const fns = [
    ['btn-arrow-prev', () => state.book && state.book.prev()],
    ['btn-arrow-next', () => state.book && state.book.next()],
    ['btn-first', () => state.book && state.book.first()],
    ['btn-prev', () => state.book && state.book.prev()],
    ['btn-next', () => state.book && state.book.next()],
    ['btn-last', () => state.book && state.book.last()],
    ['btn-zoom-out', zoomOut],
    ['btn-zoom-in', zoomIn],
    ['btn-share', shareCurrentBook],
  ];
  for (const [id, fn] of fns) $(id).addEventListener('click', fn);
}

async function openFile(file, opts = {}) {
  if (!file) return;
  if (state.opening) return;
  state.opening = true;

  disposeRuntime();
  showLoad('Opening PDF…', null, `${escapeHtml(file.name)} · ${formatBytes(file.size)}`);

  const pm = new PdfManager();
  try {
    const meta = await pm.open(file, {
      onLoadProgress: (loaded, total) => {
        if (total > 0) {
          showLoad('Opening PDF…', (loaded / total) * 100,
            `${escapeHtml(file.name)} · ${formatBytes(loaded)} / ${formatBytes(total)}`);
        }
      },
    });

    state.pm = pm;
    state.meta = meta;
    const title = meta.title || titleFromFileName(file.name);

    // Store the PDF in the cloud so it is visible + shareable by everyone.
    state.cloudId = opts.cloudId || null;
    if (!state.cloudId) {
      try {
        const existing = state.cloudBooks.find((b) => b.name === file.name && b.size === file.size);
        if (existing) {
          state.cloudId = existing.id;
        } else {
          const created = await uploadPdf(file);
          state.cloudId = created.id;
          state.cloudBooks.unshift({ id: created.id, name: created.name, size: created.size, uploadedAt: Date.now() });
          renderLibrary();
        }
      } catch (err) {
        console.warn('[flipbook] cloud upload failed', err);
        state.cloudId = null;
      }
    }

    state.book = new BookViewer(UI.bookShell, {
      pageCount: meta.numPages,
      ratio: meta.ratio,
      animation: state.settings.pageAnimation,
      listeners: {
        onFlip: () => onFlip(),
        onState: (st) => { if (st === 'read') { renderWindow(); savePosition(); } },
        onOrientation: () => relayout(),
      },
    });

    showLoad(`Loading page 1 of ${meta.numPages}…`);
    state.book.mount();

    // Enter reading UI
    UI.toolbar.hidden = false;
    UI.btnCloseBook.hidden = false;
    UI.readerBookTitle.textContent = title;
    UI.readerBookPages.textContent = `${meta.numPages.toLocaleString()} pages · ${formatBytes(file.size)}`;
    UI.brandMeta.hidden = false;
    UI.brandMeta.textContent = title;
    document.title = `${title} — FlipBook`;
    showView('reader');

    // Layout after the DOM has settled so measurements are accurate.
    await nextFrame();
    relayout();

    // Per-document subsystem (thumbnails)
    state.thumbnails = new Thumbnails(
      { strip: '#thumb-strip', current: '#thumb-current', panel: UI.thumbPanel },
      { pm, pageCount: meta.numPages, onSelect: (p) => uiGoTo(p) }
    );
    state.thumbnails.build();

    await renderWindow();

    // Resume last page when requested & recorded.
    let resume = 1;
    if (pendingSharedPage && pendingSharedPage > 1 && pendingSharedPage <= meta.numPages) {
      resume = pendingSharedPage;
      pendingSharedPage = null;
      state.book.goTo(resume);
    } else {
      const entry = store.findLibraryEntry(file.name, file.size);
      if (state.settings.rememberLastPage && entry && entry.lastPage > 1 && entry.lastPage <= meta.numPages) {
        resume = entry.lastPage;
        state.book.goTo(resume);
        toast(`Resumed at page ${resume}`);
      }
    }

    store.upsertLibrary({
      id: store.bookId(meta),
      name: title,
      fileName: file.name,
      size: file.size,
      pages: meta.numPages,
      lastPage: resume,
      openedAt: Date.now(),
      cloudId: state.cloudId,
    });
    renderLibrary();
    renderRecent();
    refreshCloud();

    hideLoad();
    state.opening = false;
  } catch (err) {
    state.opening = false;
    hideLoad();
    console.error('[flipbook] open error', err);
    disposeRuntime();
    showView('welcome');
    toast(friendlyError(err), 5200);
  }
}

async function relayout() {
  if (!state.book || !state.pm) return;
  state.book.layout({
    stageW: UI.readerStage.clientWidth,
    stageH: UI.readerStage.clientHeight,
    mode: 'two',
  });
  applyZoomVisual();
  renderWindow();
}

function onFlip() {
  setBookPositionControls();
  savePosition();
  renderWindow();
  state.thumbnails?.setCurrent(firstVisiblePage());
}

/* ============================================================
   LAZY PAGE RENDERING (small window + LRU cache)
   ============================================================ */
function windowPages() {
  const book = state.book;
  const pages = [];
  const add = (arr) => {
    for (const p of arr) {
      if (p >= 1 && p <= book.pageCount && !pages.includes(p)) pages.push(p);
    }
  };
  add(book.visiblePdfPages());            // current spread
  add(book.spreadPdfPagesByOffset(1));    // next spread (revealed during flip)
  add(book.spreadPdfPagesByOffset(2));    // next-next spread (double-swipe)
  add(book.spreadPdfPagesByOffset(-1));   // previous spread (back-flip)
  add(book.spreadPdfPagesByOffset(-2));   // back-back spread (double-swipe)
  return pages;
}

async function renderWindow() {
  if (!state.book || !state.pm) return;
  const token = ++state.winToken;
  const wanted = windowPages();

  // Detach canvases of far pages so the DOM never pins extra buffers.
  for (let p = 1; p <= state.book.pageCount; p++) {
    if (wanted.includes(p)) continue;
    const item = state.book.itemForPage(p);
    if (!item) continue;
    const inner = item.querySelector('.fb-page-inner');
    if (inner && inner.querySelector('.fb-canvas')) {
      inner.replaceChildren(el('div', 'fb-skeleton'));
    }
  }

  const pageW = (state.book.lastMetrics?.pageWidth || 1) * state.zoom;
  const dpr = window.devicePixelRatio || 1;
  const jobs = wanted.map((p) => ensurePage(p, token, pageW, dpr));
  showLoadingChip(jobs.length);
  try {
    await Promise.allSettled(jobs);
  } finally {
    hideLoadingChip(token);
  }
}

async function ensurePage(p, token, pageW, dpr) {
  const book = state.book;
  if (!book) return;
  const item = book.itemForPage(p);
  if (!item) return;
  const inner = item.querySelector('.fb-page-inner');
  if (!inner) return;
  try {
    const canvas = await state.pm.getPageBitmap(p, pageW, dpr);
    if (token !== state.winToken) return;   // superseded
    if (!item.isConnected) return;          // book disposed meanwhile
    canvas.className = 'fb-canvas';
    if (inner.querySelector('.fb-canvas') !== canvas) {
      inner.replaceChildren(canvas);
    }
  } catch (err) {
    // Keep the skeleton; the next flip will retry.
  }
}

function showLoadingChip(count) {
  clearTimeout(hideChipTimer);
  if (!count) { UI.pageLoading.hidden = true; return; }
  UI.pageLoading.hidden = false;
  UI.pageLoadingText.textContent = `Loading page ${firstVisiblePage()}…`;
}

let hideChipTimer = null;
function hideLoadingChip(token) {
  clearTimeout(hideChipTimer);
  hideChipTimer = setTimeout(() => {
    if (token === state.winToken) UI.pageLoading.hidden = true;
  }, 160);
}

function firstVisiblePage() {
  return state.book ? state.book.visiblePdfPages()[0] : 1;
}

function uiGoTo(p) {
  if (state.book) state.book.goTo(p);
}

/* ============================================================
   POSITION CONTROLS
   ============================================================ */
function setBookPositionControls() {
  if (!state.book) return;
  const [current, second] = state.book.visiblePdfPages();
  const count = state.book.pageCount;
  UI.pageInput.value = String(current);
  UI.pageTotal.textContent = count.toLocaleString();
  UI.readerChip.textContent = second ? `Page ${current} – ${second}` : `Page ${current}`;

  const isLast = second
    ? second === count
    : current === count;

  $( 'btn-first').disabled = current === 1;
  $( 'btn-last').disabled = isLast;
  $( 'btn-prev').disabled = !state.book.canPrev();
  $( 'btn-next').disabled = !state.book.canNext();
  UI.arrowPrev.disabled = !state.book.canPrev();
  UI.arrowNext.disabled = !state.book.canNext();

  state.thumbnails?.setCurrent(current);
}

function goToPageInput() {
  if (!state.book) return;
  const v = parseInt(UI.pageInput.value, 10);
  if (isNaN(v)) { setBookPositionControls(); return; }
  const p = Math.max(1, Math.min(state.book.pageCount, v));
  state.book.goTo(p);
}

const savePosition = debounce(() => {
  if (!state.book || !state.meta) return;
  store.touchLibraryLastPage(state.meta.fileName, state.meta.size, state.meta.numPages, firstVisiblePage());
  renderRecent();
}, 700);

/* ============================================================
   ZOOM
   ============================================================ */
function applyZoomVisual() {
  UI.zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
  UI.bookShell.style.transform = `scale(${state.zoom})`;
}

function setZoom(z) {
  state.zoom = z;
  applyZoomVisual();
  renderWindow();
}

function zoomIn() {
  if (state.zoomIndex >= ZOOMS.length - 1) return;
  setZoom(ZOOMS[++state.zoomIndex]);
}

function zoomOut() {
  if (state.zoomIndex <= 0) return;
  setZoom(ZOOMS[--state.zoomIndex]);
}

function zoomFit() {
  state.zoomIndex = ZOOMS.indexOf(0.9);
  setZoom(0.9);
}

/* ============================================================
   LIBRARY / RECENTS
   ============================================================ */
function mergedLibrary() {
  const byId = new Map();
  for (const b of state.cloudBooks) {
    byId.set(b.id, { id: b.id, name: b.name, size: b.size, uploadedAt: b.uploadedAt });
  }
  for (const e of store.loadLibrary()) {
    const id = e.cloudId || null;
    if (!id) continue;
    const cur = byId.get(id) || { id, name: e.name, size: e.size, uploadedAt: e.openedAt };
    cur.lastPage = e.lastPage;
    cur.pages = e.pages;
    cur.openedAt = e.openedAt;
    byId.set(id, cur);
  }
  return Array.from(byId.values());
}

function libraryEntryCard(entry) {
  const card = el('div', 'book-card book-card--cover');

  const cover = el('div', 'book-card-cover');
  const img = el('img', 'book-card-cover-img');
  img.alt = `Cover of ${entry.name}`;
  img.loading = 'lazy';
  img.decoding = 'async';
  cover.appendChild(img);

  const title = el('div', 'book-card-title', escapeHtml(entry.name));

  const actions = el('div', 'book-card-actions');
  const open = el('button', 'btn btn-primary');
  open.type = 'button';
  open.textContent = 'Open';
  open.setAttribute('aria-label', `Open ${entry.name}`);
  open.addEventListener('click', () => openCloudBook(entry, entry.lastPage || 1));
  actions.appendChild(open);

  const share = el('button', 'btn btn-ghost');
  share.type = 'button';
  share.textContent = 'Share';
  share.setAttribute('aria-label', `Share ${entry.name}`);
  share.addEventListener('click', () => shareCloudBook(entry));
  actions.appendChild(share);

  const remove = el('button', 'book-card-remove');
  remove.type = 'button';
  remove.title = 'Delete';
  remove.setAttribute('aria-label', `Delete ${entry.name}`);
  remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2m-8.5 0 .7 12h9.6l.7-12M10 11v5M14 11v5"/></svg>';
  remove.addEventListener('click', () => removeCloudBook(entry));
  actions.appendChild(remove);

  card.append(cover, title, actions);

  paintCover(img, entry.id, entry.name);
  return card;
}

function renderLibrary() {
  const list = mergedLibrary();
  UI.libraryEmpty.hidden = list.length > 0;
  UI.libraryList.innerHTML = '';
  for (const entry of list) UI.libraryList.appendChild(libraryEntryCard(entry));
}

function renderRecent() {
  const list = store.loadLibrary().slice(0, 4);
  UI.recentWrap.hidden = list.length === 0;
  UI.recentList.innerHTML = '';
  for (const entry of list) {
    const chip = el('button', 'recent-chip');
    chip.type = 'button';
    chip.setAttribute('aria-label', `Continue reading ${entry.name}`);
    const icon = el('span', 'chip-icon');
    icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5.5C10 4 7 4 4 4v14c3 0 6 .2 8 2 2-1.8 5-2 8-2V4c-3 0-6 .4-8 1.5z"/></svg>';
    const main = el('span', 'recent-chip-main');
    main.appendChild(el('span', 'recent-chip-name', escapeHtml(entry.name)));
    main.appendChild(el('span', 'recent-chip-sub',
      `${entry.pages ?? 0} pages · last page ${entry.lastPage ?? 1} · ${friendlyDate(entry.openedAt)}`));
    chip.append(icon, main);
    chip.addEventListener('click', () => continueReading(entry));
    UI.recentList.appendChild(chip);
  }
}

function continueReading(entry) {
  if (state.book && state.meta && store.bookId(state.meta) === entry.id) {
    state.book.goTo(Math.max(1, entry.lastPage || 1));
    showView('reader');
    return;
  }
  if (entry.cloudId) {
    openCloudBook({ id: entry.cloudId, name: entry.name }, entry.lastPage || 1);
    return;
  }
  toast('Select the PDF file again to resume it.');
  UI.fileInput.click();
}

/* ============================================================
   SHARE
   ============================================================ */
function shareCurrentBook() {
  if (!state.book || !state.meta) { toast('Open a PDF first.'); return; }
  const p = firstVisiblePage();
  const id = state.cloudId || store.bookId(state.meta);
  const url = shareLinkFor(id, p);
  showSharePanel(url,
    `<div class="share-meta-row"><strong>${escapeHtml(state.meta.name || 'FlipBook')}</strong></div>
     <div class="share-meta-row">${(state.meta.pages || 0).toLocaleString()} pages · opens on page ${p}</div>
     <div class="share-meta-row muted">Anyone with this link can open this PDF straight from the cloud.</div>`);
}

function shareCloudBook(book) {
  const url = shareLinkFor(book.id, 1);
  showSharePanel(url,
    `<div class="share-meta-row"><strong>${escapeHtml(book.name || 'FlipBook')}</strong></div>
     <div class="share-meta-row">${formatBytes(book.size || 0)} · opens from the cloud</div>
     <div class="share-meta-row muted">Anyone with this link can open this PDF straight from the cloud.</div>`);
}

function copyToClipboard(url) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(url).then(() => true).catch(() => copyToClipboardFallback(url));
  }
  return Promise.resolve(copyToClipboardFallback(url));
}

function copyToClipboardFallback(url) {
  try {
    const ta = document.createElement('textarea');
    ta.value = url;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) {
    return false;
  }
}

function showSharePanel(url, metaHtml) {
  closeSidePanels();
  UI.shareLinkInput.value = url;
  UI.shareMeta.innerHTML = metaHtml || '';
  UI.shareForm.hidden = false;
  UI.panelShare.hidden = false;
  UI.btnCopyLink.textContent = 'Copy Link';
  UI.btnCopyLink.disabled = false;
}

function wireShare() {
  UI.btnCloseShare.addEventListener('click', () => closeSidePanels());
  UI.btnCopyLink.addEventListener('click', async () => {
    const url = UI.shareLinkInput.value;
    if (!url) return;
    const ok = await copyToClipboard(url);
    UI.btnCopyLink.textContent = ok ? 'Copied!' : 'Copy failed';
    if (ok) {
      UI.btnCopyLink.disabled = true;
      setTimeout(() => {
        UI.btnCopyLink.textContent = 'Copy Link';
        UI.btnCopyLink.disabled = false;
      }, 1600);
    }
    toast(ok ? 'Link copied to clipboard' : 'Could not copy the link automatically');
  });
  UI.shareLinkInput.addEventListener('click', () => UI.shareLinkInput.select());
}

/* ============================================================
   CLOUD LIBRARY
   ============================================================ */
async function refreshCloud() {
  state.cloudBooks = await listBooks();
  renderLibrary();
}

async function openCloudBook(book, page) {
  try {
    const res = await fetch(bookPdfUrl(book.id));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const file = new File([blob], book.name || 'book.pdf', { type: 'application/pdf' });
    pendingSharedPage = page && page > 1 ? page : null;
    await openFile(file, { cloudId: book.id });
  } catch (err) {
    console.error('[flipbook] cloud open failed', err);
    toast('Could not open the PDF from the cloud.');
  }
}

async function removeCloudBook(book) {
  try {
    await deleteBook(book.id);
  } catch (err) {
    console.warn('[flipbook] cloud delete failed', err);
  }
  store.saveLibrary(store.loadLibrary().filter((e) => e.cloudId !== book.id));
  renderRecent();
  await refreshCloud();
  toast('Removed from the library.');
}

/* ============================================================
   COVERS
   ============================================================ */
const coverCache = new Map();

/** Render page 1 of a cloud PDF and paint it into the card's <img>. */
async function paintCover(img, id, name) {
  if (!window.pdfjsLib) return;
  if (coverCache.has(id)) {
    img.src = coverCache.get(id);
    img.classList.add('is-loaded');
    return;
  }
  try {
    if (!window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    }
    const task = window.pdfjsLib.getDocument({
      url: bookPdfUrl(id),
      isEvalSupported: false,
      disableAutoFetch: true,
      rangeChunkSize: 65536,
      useSystemFonts: true,
    });
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const targetW = 260;
    const scale = (targetW * (window.devicePixelRatio || 1)) / base.width;
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext('2d', { alpha: false });
    await page.render({ canvasContext: ctx, viewport: vp, background: '#ffffff' }).promise;
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    pdf.destroy().catch(() => {});
    coverCache.set(id, dataUrl);
    if (img.isConnected) {
      img.src = dataUrl;
      img.classList.add('is-loaded');
    }
  } catch (err) {
    console.warn('[flipbook] cover failed', name, err?.message || err);
    if (img.isConnected) img.classList.add('is-error');
  }
}

/** Open a book from a shared link (e.g. #/shared/<cloudId>/p<page>). */
async function checkSharedLink() {
  const m = /#\/shared\/([^/]+)\/p(\d+)/.exec(location.hash || '');
  if (!m) return;
  const id = decodeURIComponent(m[1]);
  const page = Math.max(1, Number(m[2]) || 1);
  const books = await listBooks();
  const book = books.find((b) => b.id === id) || { id, name: 'book.pdf' };
  await openCloudBook(book, page);
}

/* ============================================================
   KEYBOARD
   ============================================================ */
function wireKeyboard() {
  window.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

    if (e.key === 'Escape') {
      if (!UI.panelShare.hidden || !UI.panelSettings.hidden) {
        closeSidePanels();
        e.preventDefault();
      }
      return;
    }
    if (typing) return;

    switch (e.key) {
      case 'ArrowRight': e.preventDefault(); if (state.book) state.book.next(); break;
      case 'ArrowLeft': e.preventDefault(); if (state.book) state.book.prev(); break;
      case 'Home': e.preventDefault(); if (state.book) state.book.first(); break;
      case 'End': e.preventDefault(); if (state.book) state.book.last(); break;
      case 'f': case 'F': if (state.book) toggleFullscreen(); break;
      default: break;
    }
  });

  UI.pageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); goToPageInput(); UI.pageInput.blur(); }
  });
  UI.pageInput.addEventListener('blur', goToPageInput);
  UI.pageInput.addEventListener('input', () => {
    UI.pageInput.value = UI.pageInput.value.replace(/[^0-9]/g, '').slice(0, 6);
  });
}

/* ============================================================
   FULLSCREEN / RESIZE / DND
   ============================================================ */
function wireFullscreen() {
  UI.btnFullscreen.addEventListener('click', toggleFullscreen);
  UI.btnExitFs.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', () => {
    const active = document.fullscreenElement === UI.app;
    document.body.classList.toggle('is-fullscreen', active);
    UI.btnExitFs.hidden = !active;
    relayout();
  });
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await UI.app.requestFullscreen();
  } catch (err) {
    toast('Fullscreen is not available in this browser/context.');
  }
}

function wireResize() {
  const onResize = debounce(() => relayout(), 140);
  window.addEventListener('resize', onResize);
}

function wireDragDrop() {
  const hasFiles = (types) => Array.from(types || []).some((t) => t === 'Files');

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e.dataTransfer?.types)) return;
    e.preventDefault();
    UI.dropZone.hidden = false;
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e.dataTransfer?.types)) return;
    e.preventDefault();
  });
  window.addEventListener('dragleave', (e) => {
    // Only hide when the drag truly left the window.
    if (e.relatedTarget === null) UI.dropZone.hidden = true;
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    UI.dropZone.hidden = true;
    const file = Array.from(e.dataTransfer?.files || []).find((f) => /\.pdf$/i.test(f.name));
    if (file) openFile(file);
    else toast('Drop a .pdf file to open it.');
  });
}

/* ============================================================
   SETTINGS
   ============================================================ */
function wirePanels() {
  UI.btnCloseSettings.addEventListener('click', () => closeSidePanels());
  $('btn-close-thumbs').addEventListener('click', () => closeSidePanels());

  UI.btnThumbs.addEventListener('click', () => {
    if (!state.book) { toast('Open a PDF first.'); return; }
    const shouldOpen = UI.thumbPanel.hidden;
    closeSidePanels();
    UI.thumbPanel.hidden = !shouldOpen;
    UI.btnThumbs.classList.toggle('is-on', shouldOpen);
    if (shouldOpen) state.thumbnails?.open();
  });

  const bindSwitch = (btn, key) => btn.addEventListener('click', () => {
    state.settings[key] = !state.settings[key];
    store.saveSettings(state.settings);
    applySettings(state.settings);
    refreshSettingsUI();
    if (key === 'pageAnimation' && state.book) state.book.animation = state.settings.pageAnimation;
  });
  bindSwitch(UI.setAnim, 'pageAnimation');
  bindSwitch(UI.setAutoturn, 'autoPageTurn');
  bindSwitch(UI.setRemember, 'rememberLastPage');

  UI.setThemeDark.addEventListener('click', () => changeTheme('dark'));
  UI.setThemeLight.addEventListener('click', () => changeTheme('light'));
  UI.setModeAuto.addEventListener('click', () => changeReadingMode('auto'));
  UI.setModeSingle.addEventListener('click', () => changeReadingMode('single'));
  UI.setModeTwo.addEventListener('click', () => changeReadingMode('two'));

  // devtools hook
  window.__flipbook = { state, store, resetPosition: () => store.clearLibrary() };
}

function changeTheme(t) {
  state.settings.theme = t;
  store.saveSettings(state.settings);
  applySettings(state.settings);
  refreshSettingsUI();
}

function changeReadingMode(m) {
  state.settings.readingMode = m;
  store.saveSettings(state.settings);
  refreshSettingsUI();
  relayout();
}

function applySettings(s) {
  document.documentElement.dataset.theme = s.theme;
  if (state.book) state.book.animation = s.pageAnimation;
  if (s.autoPageTurn) startAutoTurn(); else stopAutoTurn();
}

function refreshSettingsUI() {
  const s = state.settings;
  UI.setThemeDark.classList.toggle('is-active', s.theme === 'dark');
  UI.setThemeDark.setAttribute('aria-pressed', String(s.theme === 'dark'));
  UI.setThemeLight.classList.toggle('is-active', s.theme === 'light');
  UI.setThemeLight.setAttribute('aria-pressed', String(s.theme === 'light'));

  UI.setModeAuto.classList.toggle('is-active', s.readingMode === 'auto');
  UI.setModeAuto.setAttribute('aria-pressed', String(s.readingMode === 'auto'));
  UI.setModeSingle.classList.toggle('is-active', s.readingMode === 'single');
  UI.setModeSingle.setAttribute('aria-pressed', String(s.readingMode === 'single'));
  UI.setModeTwo.classList.toggle('is-active', s.readingMode === 'two');
  UI.setModeTwo.setAttribute('aria-pressed', String(s.readingMode === 'two'));

  UI.setAnim.setAttribute('aria-checked', String(s.pageAnimation));
  UI.setAutoturn.setAttribute('aria-checked', String(s.autoPageTurn));
  UI.setRemember.setAttribute('aria-checked', String(s.rememberLastPage));
}

/* Auto page turning */
function startAutoTurn() {
  stopAutoTurn();
  state.autoTurnTimer = setInterval(() => {
    if (!state.book) return;
    if (!state.settings.autoPageTurn) return;
    if (!UI.loadOverlay.hidden) return;
    if (!UI.panelShare.hidden || !UI.panelSettings.hidden) return;
    if (!state.book.canNext()) return;
    state.book.next();
  }, 5200);
}

function stopAutoTurn() {
  if (state.autoTurnTimer) { clearInterval(state.autoTurnTimer); state.autoTurnTimer = null; }
}

/* ============================================================
   TOAST / LOAD OVERLAY / ERRORS
   ============================================================ */
let toastTimer = null;
function toast(msg, ms = 2800) {
  UI.toast.textContent = msg;
  UI.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { UI.toast.hidden = true; }, ms);
}

function showLoad(title, pct, sub) {
  UI.loadTitle.textContent = title;
  UI.loadSub.textContent = sub || '';
  UI.loadBarFill.style.width = `${pct == null ? 12 : Math.max(2, Math.min(100, pct))}%`;
  UI.loadOverlay.hidden = false;
}

function hideLoad() { UI.loadOverlay.hidden = true; }

function friendlyError(err) {
  if (err instanceof PdfOpenError) return err.message;
  const msg = String((err && err.message) || err || '');
  if (/password/i.test(msg)) return 'This PDF is password protected.';
  if (/worker/i.test(msg)) {
    return 'The PDF engine worker failed to start. Open this folder through a local server (e.g. VS Code Live Server) instead of the file:// protocol and retry.';
  }
  if (/AbortError/i.test(msg)) return 'Opening was interrupted.';
  return 'Unable to open this PDF. The file may be corrupted or too complex for this browser.';
}

/* ============================================================
   TEARDOWN
   ============================================================ */
function disposeRuntime() {
  stopAutoTurn();
  if (state.book) { state.book.dispose(); state.book = null; }
  if (state.thumbnails) { state.thumbnails.dispose(); state.thumbnails = null; }
  if (state.pm) { state.pm.dispose().catch(() => {}); state.pm = null; }
  state.meta = null;
  state.winToken++;
  UI.bookShell.innerHTML = '';
  UI.pageLoading.hidden = true;
  $('btn-close-thumbs').closest('#panel-thumbs') || (UI.thumbPanel.hidden = true);
}

function closeBook() {
  disposeRuntime();
  UI.toolbar.hidden = true;
  UI.btnCloseBook.hidden = true;
  UI.brandMeta.hidden = true;
  document.title = 'FlipBook — Digital Flipbook Reader';
  showView('welcome');
  toast('Book closed. Your reading position stays in the Library.');
}

/* ============================================================
   BOOT
   ============================================================ */
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}