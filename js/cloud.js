// ============================================================
// cloud.js — server-backed PDF storage & share API
// ============================================================

async function parse(res) {
  if (!res.ok) throw new Error(`Cloud request failed (${res.status})`);
  return res.json();
}

/** List every PDF stored in the cloud (visible to all persons). */
export async function listBooks() {
  try {
    const data = await parse(await fetch('/api/books'));
    return Array.isArray(data.books) ? data.books : [];
  } catch (err) {
    console.warn('[flipbook] cloud list failed', err);
    return [];
  }
}

/** Upload a PDF to the cloud. Returns { id, name, size, url }. */
export function uploadPdf(file) {
  const name = encodeURIComponent(file.name);
  return fetch(`/api/upload?name=${name}&size=${file.size}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf' },
    body: file,
  }).then(parse);
}

/** Permanently remove a book from the cloud. */
export function deleteBook(id) {
  return fetch(`/api/book/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(parse);
}

/** URL of the stored PDF on the server. */
export function bookPdfUrl(id) {
  return `/api/book/${encodeURIComponent(id)}`;
}

/** Public share link. Anyone who opens it can read the PDF from the cloud. */
export function shareLinkFor(id, page = 1) {
  const { origin, pathname } = location;
  const p = Math.max(1, Number(page) || 1);
  return `${origin}${pathname}#/shared/${encodeURIComponent(id)}/p${p}`;
}