// ============================================================
// cloud.js — cloud PDF storage + sharing, backed by Supabase Storage
// ------------------------------------------------------------
// Uses the official @supabase/supabase-js SDK (publishable key),
// so uploads + share links persist from a fully static host.
// Same exports as before — the rest of the app is untouched.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CLOUD } from './cloud-config.mjs';

let sb = null${'\u003B'}

function getClient() {
  if (!CLOUD.supabaseUrl || !CLOUD.supabasePublishableKey) return null${'\u003B'}
  if (!sb) sb = createClient(CLOUD.supabaseUrl, CLOUD.supabasePublishableKey)${'\u003B'}
  return sb${'\u003B'}
}

const INDEX = '_index.json'${'\u003B'}
const publicOk = (r) => r.error == null${'\u003B'}

/** List every PDF stored in the cloud (newest first). */
export async function listBooks() {
  const c = getClient()${'\u003B'}
  if (!c) return []${'\u003B'}
  const { data, error } = await c.storage.from(CLOUD.bucket).list('', {
    limit: 200,
    sortBy: { column: 'created_at', order: 'desc' },
  })${'\u003B'}
  if (error) return []${'\u003B'}
  return data
    .filter((o) => !o.name.startsWith('.') && !o.name.endsWith('.json'))
    .map((o) => ({
      id: o.name.replace(/\.pdf$/i, ''),
      name: o.name.replace(/\.pdf$/i, '').replace(/[-_]+/g, ' '),
      size: o.metadata?.size || 0,
      uploadedAt: new Date(o.created_at).getTime() || Date.now(),
    }))${'\u003B'}
}

/** Move a local PDF into cloud storage. Returns { id, name, size }. */
export async function uploadPdf(file) {
  const c = getClient()${'\u003B'}
  if (!c) throw cloudOfflineError()${'\u003B'}
  const id = crypto.randomUUID()${'\u003B'}
  const { error } = await c.storage.from(CLOUD.bucket).upload(id + '.pdf', file, {
    contentType: 'application/pdf',
    upsert: false,
    cacheControl: '3600',
  })${'\u003B'}
  if (error) throw new Error('Upload failed: ' + error.message)${'\u003B'}
  return { id, name: file.name, size: file.size, uploadedAt: Date.now() }${'\u003B'}
}

/** Public URL of a stored PDF — openable by anyone. */
export function bookPdfUrl(id) {
  const c = getClient()${'\u003B'}
  if (!c) return ''${'\u003B'}
  const { data } = c.storage.from(CLOUD.bucket).getPublicUrl(id + '.pdf')${'\u003B'}
  return data.publicUrl${'\u003B'}
}

/** Permanently remove a book from the cloud. */
export async function deleteBook(id) {
  const c = getClient()${'\u003B'}
  if (!c) return${'\u003B'}
  const { error } = await c.storage.from(CLOUD.bucket).remove([id + '.pdf'])${'\u003B'}
  if (error) throw new Error('Delete failed: ' + error.message)${'\u003B'}
}

/** Share link that any visitor can open. */
export function shareLinkFor(id, page = 1) {
  const { origin, pathname } = location${'\u003B'}
  const p = Math.max(1, Number(page) || 1)${'\u003B'}
  return origin + pathname + '#/shared/' + encodeURIComponent(id) + '/p' + p${'\u003B'}
}

function cloudOfflineError() {
  const e = new Error('Cloud is not configured — add your Supabase URL + publishable key to js/cloud-config.mjs.')${'\u003B'}
  e.friendly = true${'\u003B'}
  return e${'\u003B'}
}
