// ============================================================
// ui.js — small DOM + formatting helpers used across FlipBook
// ============================================================

export const q = (sel, root = document) => root.querySelector(sel);
export const qa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Create an element with optional classes and HTML content. */
export function el(tag, className = '', html = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html) node.innerHTML = html;
  return node;
}

/** Debounce — returns a wrapped fn that runs after `ms` of silence. */
export function debounce(fn, ms = 180) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Tiny id counter for cache keys etc. */
export function uniqueId(prefix = 'id') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Human readable byte size: 300 MB -> "300 MB". */
export function formatBytes(bytes) {
  if (bytes == null || isNaN(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes;
  let u = -1;
  do { v /= 1024; u++; } while (v >= 1024 && u < units.length - 1);
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[u]}`;
}

/** "my-book.pdf" -> "My Book". Also handles paths. */
export function titleFromFileName(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const stripped = base.replace(/\.pdf$/i, '');
  const words = stripped
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ');
  if (words.length === 1) {
    // Preserve titles like "iPhone 12" nicely, capitalise simple words.
    return words[0].replace(/\b([a-z])/, (m) => m.toUpperCase());
  }
  return words
    .map((w) => (w === w.toUpperCase() && w.length > 1 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/** Escape a string before injecting into innerHTML. */
export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Normalise a search query (case-insensitive, keep alphanumerics + spaces). */
export function normalizeQuery(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Take the longest snippet around the first match in a plain-text page. */
export function snippet(text, query, radius = 90) {
  const t = String(text || '');
  const i = t.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return t.slice(0, radius * 2);
  const start = Math.max(0, i - radius);
  const end = Math.min(t.length, i + query.length + radius);
  return (start > 0 ? '…' : '') + t.slice(start, end).replace(/\s+/g, ' ') + (end < t.length ? '…' : '');
}

/** Friendly relative "last opened" date. */
export function friendlyDate(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3;
  if (diff < MIN) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MIN)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h ago`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} d ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}