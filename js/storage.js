// ============================================================
// storage.js — safe localStorage for settings, library
// ============================================================
// NOTE: only small metadata is stored here. The actual PDF files live
// in browser memory on the user's device — never in localStorage.

const KEYS = {
  settings: 'flipbook.settings.v1',
  library: 'flipbook.library.v1',
};

export const DEFAULT_SETTINGS = {
  theme: 'dark',            // 'dark' | 'light'
  readingMode: 'two',    // 'auto' (<768px single) | 'single' | 'two' (spread)
  pageAnimation: true,      // smooth flip animation
  autoPageTurn: false,      // auto advance
  rememberLastPage: true,   // resume on reopen
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    // Quota / private mode — never fatal.
    return false;
  }
}

/* ---------- Settings ---------- */

export function loadSettings() {
  const stored = read(KEYS.settings, null);
  return { ...DEFAULT_SETTINGS, ...(stored || {}) };
}

export function saveSettings(settings) {
  write(KEYS.settings, settings);
}

/* ---------- Library: [{ id, name, fileName, size, pages, lastPage, openedAt }] ---------- */

/** Stable id for a local file: name + size. */
export function bookId(fileMeta) {
  return `${fileMeta.fileName || fileMeta.name}::${fileMeta.size ?? 0}`;
}

export function loadLibrary() {
  const list = read(KEYS.library, []);
  return Array.isArray(list) ? list : [];
}

export function saveLibrary(list) {
  write(KEYS.library, list);
}

export function upsertLibrary(entry) {
  let list = loadLibrary();
  const id = entry.id || bookId(entry);
  const idx = list.findIndex((b) => b.id === id);
  const record = { ...entry, id };
  if (idx >= 0) list[idx] = record;
  else list.unshift(record);
  // Keep a small history (metadata only) — cap to avoid junk.
  saveLibrary(list.slice(0, 40));
  return record;
}

export function touchLibraryLastPage(fileName, size, pages, lastPage) {
  const id = bookId({ fileName, size });
  const idx = loadLibrary().findIndex((b) => b.id === id);
  if (idx < 0) return null;
  const entry = {
    ...loadLibrary()[idx],
    lastPage,
    openedAt: Date.now(),
    pages,
  };
  return upsertLibrary(entry);
}

export function findLibraryEntry(fileName, size) {
  const id = bookId({ fileName, size });
  return loadLibrary().find((b) => b.id === id) || null;
}

export function removeLibraryEntry(id) {
  saveLibrary(loadLibrary().filter((b) => b.id !== id));
}

export function clearLibrary() {
  saveLibrary([]);
}

/* ---------- Misc ---------- */

export function storageAvailable() {
  try {
    const k = '__fb_test__';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return true;
  } catch (err) {
    return false;
  }
}