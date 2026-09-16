// ============================================================
// server.mjs — static file server + cloud PDF storage & share API
// ============================================================
import { createServer } from 'http';
import { readFile, writeFile, stat, mkdir, unlink, open } from 'fs/promises';
import { join, normalize, extname, basename } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const APP = fileURLToPath(new URL('.', import.meta.url));
const CLOUD_DIR = join(APP, 'cloud');
const INDEX_FILE = join(CLOUD_DIR, 'index.json');
const PORT = Number(process.argv[2]) || 8000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
};

async function readIndex() {
  try {
    return JSON.parse(await readFile(INDEX_FILE, 'utf8'));
  } catch {
    return { books: [] };
  }
}

async function writeIndex(index) {
  await mkdir(CLOUD_DIR, { recursive: true });
  await writeFile(INDEX_FILE, JSON.stringify(index, null, 2));
}

async function collectBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const method = req.method || 'GET';

    /* ---------- Cloud API ---------- */

    // Upload a PDF (raw body). Returns a permanent bookmarkable id.
    if (method === 'POST' && pathname === '/api/upload') {
      const name = (url.searchParams.get('name') || 'book.pdf').slice(0, 200);
      const data = await collectBody(req);
      if (!data.length) return sendJson(res, 400, { ok: false, error: 'Empty upload' });
      const id = randomUUID();
      await mkdir(CLOUD_DIR, { recursive: true });
      await writeFile(join(CLOUD_DIR, `${id}.pdf`), data);
      const index = await readIndex();
      index.books.unshift({ id, name, size: data.length, uploadedAt: Date.now() });
      await writeIndex(index);
      return sendJson(res, 200, { ok: true, id, name, size: data.length, url: `/api/book/${id}` });
    }

    // List every stored book — visible to all persons for the cloud.
    if (method === 'GET' && pathname === '/api/books') {
      const index = await readIndex();
      return sendJson(res, 200, { ok: true, books: index.books });
    }

    const bookMatch = /^\/api\/book\/([^/]+)$/.exec(pathname);
    const requestedId = bookMatch ? decodeURIComponent(bookMatch[1]) : null;

    // Serve a stored PDF so any shared link can open it directly.
    // Supports HTTP Range requests so the browser only downloads
    // the parts it needs (e.g. page 1 for the library cover).
    if (method === 'GET' && requestedId) {
      const file = join(CLOUD_DIR, `${basename(requestedId)}.pdf`);
      let info;
      try { info = await stat(file); } catch { return sendJson(res, 404, { ok: false, error: 'Not found' }); }
      if (info.isDirectory()) return sendJson(res, 404, { ok: false, error: 'Not found' });

      const total = info.size;
      const range = req.headers.range || null;

      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (m) {
          let start;
          let end;
          if (m[1] === '' && m[2] !== '') {
            // suffix range: last N bytes
            start = Math.max(0, total - Number(m[2]));
            end = total - 1;
          } else {
            start = Number(m[1]) || 0;
            end = m[2] ? Number(m[2]) : total - 1;
          }
          if (start > end || start >= total) {
            res.writeHead(416, { 'Content-Range': `bytes */${total}` });
            return res.end();
          }
          end = Math.min(end, total - 1);
          const len = end - start + 1;
          const hand = await open(file, 'r');
          const buf = Buffer.alloc(len);
          try { await hand.read(buf, 0, len, start); } finally { await hand.close(); }
          res.writeHead(206, {
            'Content-Type': 'application/pdf',
            'Content-Length': len,
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*',
          });
          return res.end(buf);
        }
      }

      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': body.length,
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(body);
    }

    // Remove a book from the cloud.
    if (method === 'DELETE' && requestedId) {
      await unlink(join(CLOUD_DIR, `${basename(requestedId)}.pdf`)).catch(() => {});
      const index = await readIndex();
      index.books = index.books.filter((b) => b.id !== requestedId);
      await writeIndex(index);
      return sendJson(res, 200, { ok: true });
    }

    if (pathname.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: 'Unknown API' });

    /* ---------- Static files ---------- */
    let path = pathname;
    if (path.endsWith('/')) path += 'index.html';
    path = normalize(path).replace(/^[/\\]+/, '');
    if (path.startsWith('..') || path.includes('\\..\\') || path.includes('/../') || path.startsWith('cloud')) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const file = join(APP, path);
    let info;
    try { info = await stat(file); } catch { res.writeHead(404).end('Not found'); return; }
    if (info.isDirectory()) { res.writeHead(403).end('Forbidden'); return; }
    const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Access-Control-Allow-Origin': '*' });
    res.end(body);
  } catch (e) {
    res.writeHead(500).end('Server error: ' + e.message);
  }
}).listen(PORT, '0.0.0.0', () => console.log('LISTENING ' + PORT));