const React = window.React;
const { useEffect, useMemo, useRef, useState } = React;

const L = () => (window && window.lumen) || null;
const DEFAULT_TIP_TO = (() => {
  try {
    const v = String(window?.BOOK_LIBRARY_TIP_TO || '').trim();
    if (v) return v;
  } catch {}
  // Same wallet as streaming_catalog demo.
  return 'lmn1j9pnpx98cqu80tnpj9xz0jutmkw09gmlcl6y2h';
})();

function isLikelyLmnAddress(s) {
  const v = String(s || '').trim();
  return /^lmn1[0-9a-z]{20,}$/i.test(v);
}

function useToast() {
  const [toast, setToast] = useState({ open: false, kind: 'info', message: '' });
  const timerRef = useRef(null);

  function hide() {
    setToast((t) => ({ ...t, open: false }));
  }

  function show(message, kind = 'info', ms = 2600) {
    const msg = String(message || '').trim();
    if (!msg) return;

    setToast({ open: true, kind, message: msg });

    try {
      if (timerRef.current) clearTimeout(timerRef.current);
    } catch {}
    timerRef.current = setTimeout(() => hide(), ms);
  }

  useEffect(() => {
    return () => {
      try {
        if (timerRef.current) clearTimeout(timerRef.current);
      } catch {}
    };
  }, []);

  return { toast, show, hide };
}

async function safeCall(fn) {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, error: String(e?.message || e || 'failed') };
  }
}

let __gatewayBasePromise = null;
async function getGatewayBase() {
  if (__gatewayBasePromise) return __gatewayBasePromise;
  __gatewayBasePromise = (async () => {
    // 1) If running inside the Lumen Browser app renderer, use its settings.
    try {
      const api = L();
      if (api?.settingsGetAll) {
        const res = await api.settingsGetAll();
        const base = String(res?.settings?.localGatewayBase || '').trim();
        if (base) return base.replace(/\/+$/, '');
      }
    } catch {}

    // 2) Use the document <base href="..."> injected by the Lumen Browser (domain viewer).
    //    Prefer the <base> element because some browsers keep document.baseURI as "blob:".
    const candidates = [];
    try {
      const baseEl = document.querySelector('base[href]');
      if (baseEl?.href) candidates.push(String(baseEl.href));
    } catch {}
    try {
      if (document.baseURI) candidates.push(String(document.baseURI));
    } catch {}
    try {
      if (location?.href) candidates.push(String(location.href));
    } catch {}

    for (const c of candidates) {
      try {
        const u = new URL(String(c || ''));
        if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin;
      } catch {}
    }

    // 3) Last resort fallback for local testing.
    return 'http://127.0.0.1:8080';
  })();
  return __gatewayBasePromise;
}

async function resolveUrl(u) {
  const raw = String(u || '').trim();
  if (!raw) return '';
  try {
    if (L()?.resolveUrl) return await L().resolveUrl(raw);
  } catch {}
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^lumen:\/\//i.test(raw)) {
    const s = raw.replace(/^lumen:\/\//i, '');
    const base = await getGatewayBase();
    return base.replace(/\/+$/, '') + '/' + s.replace(/^\/+/, '');
  }
  if (/^\/(ipfs|ipns)\//i.test(raw)) {
    const base = await getGatewayBase();
    return base.replace(/\/+$/, '') + raw;
  }
  return raw;
}

function toLumenIpfsOrIpnsUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  if (/^lumen:\/\//i.test(raw)) return raw;
  if (/^\/(ipfs|ipns)\//i.test(raw)) return 'lumen://' + raw.replace(/^\/+/, '');
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      const m = String(u.pathname || '').match(/^\/(ipfs|ipns)\/(.+)$/i);
      if (m && m[1] && m[2]) {
        const kind = String(m[1]).toLowerCase();
        const rest = String(m[2]).replace(/^\/+/, '');
        return `lumen://${kind}/${rest}${u.search || ''}${u.hash || ''}`;
      }
    } catch {}
  }
  return '';
}

function getDefaultBibiOrigin() {
  try {
    // Use base element (domain viewer uses blob: URLs).
    const candidates = [];
    try {
      const baseEl = document.querySelector('base[href]');
      if (baseEl?.href) candidates.push(String(baseEl.href));
    } catch {}
    try {
      if (document.baseURI) candidates.push(String(document.baseURI));
    } catch {}
    try {
      if (location?.href) candidates.push(String(location.href));
    } catch {}
    for (const c of candidates) {
      try {
        const u = new URL('./lib/bibi/', String(c || ''));
        return u.href.replace(/\/+$/, '');
      } catch {}
    }
  } catch {}
  return '/lib/bibi';
}

const BIBI_ORIGIN = (window.BIBI_ORIGIN || getDefaultBibiOrigin()).replace(/\/+$/, '');

function joinPath(a, b) {
  if (!a) return b || '';
  if (!b) return a || '';
  return a.replace(/\/$/, '') + '/' + b.replace(/^\//, '');
}

function absolutePath(root, p) {
  const v = String(p || '').trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return v;
  if (/^lumen:\/\//i.test(v)) return v;
  if (/^\/(ipfs|ipns)\//i.test(v)) return v;
  return joinPath(root, v);
}

function parseHash() {
  const raw = String(location.hash || '').replace(/^#/, '');
  const p = new URLSearchParams(raw);
  return {
    root: String(p.get('root') || ''),
    q: String(p.get('q') || '')
  };
}

function setHash(next) {
  const p = new URLSearchParams();
  if (next.root) p.set('root', next.root);
  if (next.q) p.set('q', next.q);
  location.hash = p.toString();
}

function normalizeRootEntry(s) {
  let x = String(s || '').trim();
  if (!x || x.startsWith('#')) return '';

  x = x.replace(/^lumen:\/\//i, '');

  // ipfs://<cid>/... → /ipfs/<cid>/...
  x = x.replace(/^ipfs:\/\//i, '');
  x = x.replace(/^ipns:\/\//i, '');

  x = x.replace(/^\/?ipfs\//i, '/ipfs/');
  x = x.replace(/^\/?ipns\//i, '/ipns/');

  if (!x.startsWith('/ipfs/') && !x.startsWith('/ipns/')) x = '/ipfs/' + x.replace(/^\/+/, '');
  return x;
}

async function fetchText(pathOrUrl) {
  const url = await resolveUrl(pathOrUrl);
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

async function fetchJSON(pathOrUrl) {
  return JSON.parse(await fetchText(pathOrUrl));
}

async function mapLimit(arr, limit, fn) {
  const list = Array.isArray(arr) ? arr : [];
  const max = Math.max(1, Math.floor(limit || 6));
  const out = new Array(list.length);
  let nextIndex = 0;

  const workers = new Array(Math.min(max, list.length)).fill(0).map(async () => {
    while (true) {
      const idx = nextIndex++;
      if (idx >= list.length) break;
      out[idx] = await fn(list[idx], idx);
    }
  });

  await Promise.all(workers);
  return out;
}

function isAdultVerified() {
  try {
    return localStorage.getItem('adultVerified') === 'true';
  } catch {
    return false;
  }
}

function openAgeGate(onConfirm) {
  let overlay = document.getElementById('age-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'age-overlay';
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.display = 'grid';
    overlay.style.placeItems = 'center';
    overlay.style.background = 'rgba(0,0,0,0.8)';
    overlay.style.zIndex = '10000';
    overlay.innerHTML = `
      <div class="p-6 rounded-xl bg-neutral-900 text-white ring-1 ring-white/10 max-w-[520px] w-[92vw]">
        <h2 class="text-xl font-extrabold mb-1">Adults only</h2>
        <p class="opacity-90 text-sm">You must be of legal age in your country of residence to view adult content.</p>
        <div class="mt-4 flex gap-2 justify-end">
          <button id="age-cancel" class="px-3 py-2 rounded bg-white/10 hover:bg-white/20">Cancel</button>
          <button id="age-confirm" class="px-3 py-2 rounded bg-amber-500 text-black font-semibold">I confirm I am of legal age</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#age-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#age-confirm').addEventListener('click', () => {
      try {
        localStorage.setItem('adultVerified', 'true');
      } catch {}
      overlay.remove();
      if (typeof onConfirm === 'function') onConfirm();
    });
  }
}

function normalizeBookMeta(root, meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  let bookRel = '';
  if (typeof m.book === 'string') bookRel = m.book;
  else if (m.source && typeof m.source === 'object') bookRel = m.source.path || m.source.url || '';
  else if (Array.isArray(m.sources) && m.sources[0]) bookRel = m.sources[0].path || m.sources[0].url || '';

  const coverRel = m.cover || m.poster || '';
  const tags = Array.isArray(m.tags) ? m.tags.map((t) => String(t || '').trim()).filter(Boolean) : [];

  return {
    id: String(m.id || root),
    root,
    title: String(m.title || 'Untitled'),
    author: String(m.author || ''),
    year: Number(m.year || 0) || null,
    tags,
    pages: Number(m.pages || m.pageCount || 0) || null,
    reads: Number(m.reads || 0) || 0,
    rating: Number(m.ratingPct || m.rating || 0) || null,
    adult: !!m.adult,
    publisher: String(m.publisher || m.owner || ''),
    coverPath: absolutePath(root, coverRel),
    bookPath: absolutePath(root, bookRel)
  };
}

function normalizeCatalogItem(raw) {
  if (typeof raw === 'string') {
    return {
      title: '',
      cid: String(raw || '').trim(),
      cover: '',
      year: null,
      tags: [],
      category: '',
      author: ''
    };
  }

  const it = raw && typeof raw === 'object' ? raw : {};
  const title = String(it.title || '').trim();
  const cid = String(it.cid || it.root || '').trim();
  const cover = String(it.cover || '').trim();
  const year = typeof it.year === 'number' && Number.isFinite(it.year) ? it.year : null;
  const tags = Array.isArray(it.tags) ? it.tags.map((t) => String(t || '').trim()).filter(Boolean) : [];
  const category = String(it.category || '').trim();
  const author = String(it.author || '').trim();
  return { title, cid, cover, year, tags, category, author };
}

function normalizeCoverPath(root, rawCoverPath) {
  const v = String(rawCoverPath || '').trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return v;
  if (/^lumen:\/\//i.test(v)) return v;
  if (/^\/(ipfs|ipns)\//i.test(v)) return v;
  return absolutePath(root, v);
}

async function loadBooksFromWhitelist(rootOverride) {
  const root = String(rootOverride || '').trim();
  const base = root && (root.startsWith('/ipfs/') || root.startsWith('/ipns/')) ? root : '';

  let whitelistText = '';
  if (base) {
    try {
      whitelistText = await fetchText(joinPath(base, 'catalog.json'));
    } catch {
      try {
        whitelistText = await fetchText(joinPath(base, 'whitelist.txt'));
      } catch {
        whitelistText = '';
      }
    }
  } else {
    try {
      const primary = await fetch('catalog.json', { cache: 'no-store' });
      if (primary.ok) {
        whitelistText = await primary.text();
      } else {
        const legacy = await fetch('whitelist.txt', { cache: 'no-store' });
        whitelistText = legacy.ok ? await legacy.text() : '';
      }
    } catch {
      try {
        const legacy = await fetch('whitelist.txt', { cache: 'no-store' });
        whitelistText = legacy.ok ? await legacy.text() : '';
      } catch {
        whitelistText = '';
      }
    }
  }

  const trimmed = String(whitelistText || '').trim();

  const entries = [];
  if (trimmed && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
    try {
      const parsed = JSON.parse(trimmed);
      const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : [];
      for (const raw of items) {
        const it = normalizeCatalogItem(raw);
        const normalizedRoot = normalizeRootEntry(it.cid);
        if (!normalizedRoot) continue;
        entries.push({ root: normalizedRoot, overrides: it });
      }
    } catch {
      // fall through to legacy parsing
    }
  }

  if (!entries.length) {
    const roots = whitelistText
      .split(/[\r\n]+/)
      .map((s) => normalizeRootEntry(s))
      .filter(Boolean);
    for (const r of roots) entries.push({ root: r, overrides: null });
  }

  const seen = new Set();
  const uniqueEntries = entries.filter((e) => {
    if (!e?.root || seen.has(e.root)) return false;
    seen.add(e.root);
    return true;
  });

  if (!uniqueEntries.length) return [];

  const books = await mapLimit(uniqueEntries, 8, async (entry) => {
    const r = entry.root;
    const o = entry.overrides;
    try {
      let meta = null;
      try {
        meta = await fetchJSON(joinPath(r, 'metadata.json'));
      } catch {
        meta = await fetchJSON(joinPath(r, 'content/metadata.json'));
      }
      const baseBook = normalizeBookMeta(r, meta);

      const title = o?.title ? o.title : baseBook.title;
      const year = Number.isFinite(o?.year) ? o.year : baseBook.year;
      const tags = Array.isArray(o?.tags) && o.tags.length ? o.tags : baseBook.tags;
      const category = o?.category ? o.category : '';
      const publisher = o?.author ? o.author : baseBook.publisher;
      const coverPath = o?.cover ? normalizeCoverPath(r, o.cover) : baseBook.coverPath;

      const coverUrl = coverPath ? await resolveUrl(coverPath) : '';
      return { ...baseBook, title, year, tags, category, publisher, coverPath, coverUrl };
    } catch (e) {
      console.warn('[book_library] skipping root (metadata load failed):', r, e);
      return null;
    }
  });

  return books.filter(Boolean);
}

function ReaderModal({ open, title, bookUrl, onClose }) {
  const iframeRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      // Inject dark-mode CSS if same-origin; ignore errors if cross-origin.
      try {
        const iframe = iframeRef.current;
        if (!iframe) return;
        const doc = iframe.contentDocument;
        if (!doc) return;
        const existing = doc.querySelector('style[data-injected="bibi-dark"]');
        if (existing) return;
        const style = doc.createElement('style');
        style.setAttribute('data-injected', 'bibi-dark');
        style.textContent = `
          :root, html, body { background: #0b0b0b !important; color: #ddd !important; }
          a { color: #9bc9ff !important; }
          #bibi, #bibi-body, #bibi-header, #bibi-footer { background: transparent !important; }
          .bibi-button, .bibi-menu, .bibi-tools, .bibi-ui { background-color: rgba(20,20,20,.9) !important; color: #ddd !important; border-color: #333 !important; }
          ::-webkit-scrollbar { width: 10px; height: 10px; }
          ::-webkit-scrollbar-thumb { background: #333; border-radius: 6px; }
          ::selection { background: rgba(155,201,255,.35); }
        `;
        doc.head.appendChild(style);
      } catch {}
    }, 300);
    return () => clearTimeout(t);
  }, [open]);

  if (!open) return null;

  const src =
    BIBI_ORIGIN +
    '/index.html?book=' +
    encodeURIComponent(bookUrl) +
    '#autostart=1&ui=full&reader=view';

  return React.createElement(
    'div',
    { className: 'fixed inset-0 z-50' },
    React.createElement('div', { className: 'absolute inset-0 bg-black/70', onClick: onClose }),
    React.createElement(
      'div',
      { className: 'absolute inset-0 flex items-center justify-center p-4' },
      React.createElement(
        'div',
        { className: 'bg-neutral-950 rounded-xl ring-1 ring-white/10 shadow-xl overflow-hidden relative w-[92vw] max-w-5xl' },
        React.createElement(
          'div',
          { className: 'flex items-center justify-between px-4 py-3 border-b border-white/10' },
          React.createElement('div', { className: 'text-sm font-semibold' }, title || 'Reader'),
          React.createElement(
            'button',
            { type: 'button', onClick: onClose, className: 'px-2 py-1 rounded bg-white/10 hover:bg-white/15 text-sm' },
            'Close',
          ),
        ),
        React.createElement('iframe', {
          ref: iframeRef,
          src,
          title: 'Bibi EPUB',
          style: { border: 'none', width: '100%', height: '82vh', background: '#0b0b0b' },
          allow: 'fullscreen'
        }),
      ),
    ),
  );
}

function FiltersBar({ sort, setSort }) {
  const Btn = ({ active, onClick, children }) =>
    React.createElement(
      'button',
      {
        type: 'button',
        onClick,
        className:
          'px-3 py-1.5 rounded border ' +
          (active ? 'border-amber-500 text-white' : 'border-white/10 text-white/80 hover:text-white')
      },
      children,
    );

  return React.createElement(
    'div',
    { className: 'flex flex-wrap items-center gap-2 mb-4 mt-2' },
    React.createElement('div', { className: 'text-sm text-white/60 mr-2' }, 'Sort:'),
    Btn({ active: sort === 'new', onClick: () => setSort('new'), children: 'Newest' }),
    Btn({ active: sort === 'reads', onClick: () => setSort('reads'), children: 'Most read' }),
    Btn({ active: sort === 'rating', onClick: () => setSort('rating'), children: 'Top rated' }),
    Btn({ active: sort === 'pages', onClick: () => setSort('pages'), children: 'Longest' }),
  );
}

function CategoriesBox({ items, onPick }) {
  const map = new Map();
  for (const v of items) {
    for (const t of v.tags || []) {
      const k = String(t || '').trim();
      if (!k) continue;
      map.set(k, 1 + (map.get(k) || 0));
    }
  }
  const cats = Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50);

  return React.createElement(
    'div',
    { className: 'bg-white/5 rounded-lg border border-white/10 p-3' },
    React.createElement('div', { className: 'font-semibold mb-2' }, 'Top tags'),
    React.createElement(
      'div',
      { className: 'flex flex-wrap gap-2' },
      ...cats.map(([name, n]) =>
        React.createElement(
          'button',
          {
            key: name,
            type: 'button',
            onClick: () => onPick(name),
            className: 'px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-sm'
          },
          `${name} (${n})`,
        ),
      ),
    ),
  );
}

function BookCard({ book, onRead, onSave, onTip }) {
  const canRead = !!book.bookPath;
  const canSave = !!book.bookPath;

  return React.createElement(
    'div',
    { className: 'group' },
    React.createElement(
      'div',
      { className: 'relative rounded-lg overflow-hidden ring-1 ring-white/10 bg-black' },
      book.coverUrl
        ? React.createElement('img', {
            src: book.coverUrl,
            alt: '',
            className: 'w-full aspect-[2/3] object-cover',
            loading: 'lazy',
            onError: () => console.warn('[book_library] cover failed to load', { cover: book.coverPath, resolved: book.coverUrl })
          })
        : React.createElement('div', { className: 'w-full aspect-[2/3] bg-white/5' }),
      React.createElement(
        'div',
        {
          className:
            'absolute inset-x-0 bottom-0 p-2 bg-gradient-to-t from-black/70 to-transparent flex items-center justify-between text-xs'
        },
        React.createElement(
          'div',
          { className: 'flex items-center gap-2' },
          book.pages ? React.createElement('span', { className: 'px-1.5 py-0.5 rounded bg-black/70' }, `${book.pages} pages`) : null,
        ),
        React.createElement(
          'div',
          { className: 'flex items-center gap-2' },
          React.createElement('span', { className: 'px-1.5 py-0.5 rounded bg-black/70' }, `${book.reads || 0} reads`),
          book.rating ? React.createElement('span', { className: 'px-1.5 py-0.5 rounded bg-black/70' }, `${book.rating}%`) : null,
        ),
      ),
      !canRead ? React.createElement('span', { className: 'absolute top-2 left-2 text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-500 text-black' }, 'NO EPUB') : null,
    ),
    React.createElement('div', { className: 'mt-1 text-sm font-semibold line-clamp-2' }, book.title),
    React.createElement(
      'div',
      { className: 'text-xs text-white/60 line-clamp-1' },
      [book.author, book.year ? String(book.year) : ''].filter(Boolean).join(' · '),
    ),
    (book.tags || []).length
      ? React.createElement('div', { className: 'text-xs text-white/60 line-clamp-1' }, (book.tags || []).slice(0, 3).join(' · '))
      : null,
    React.createElement(
      'div',
      { className: 'mt-2 flex flex-wrap gap-2' },
      React.createElement(
        'button',
        { type: 'button', className: 'text-xs px-2 py-1 rounded bg-white/10 hover:bg-white/20', onClick: () => onRead(book), disabled: !canRead },
        canRead ? 'Read' : 'Unavailable',
      ),
      React.createElement(
        'button',
        { type: 'button', className: 'text-xs px-2 py-1 rounded bg-white/10 hover:bg-white/20', onClick: () => onSave(book), disabled: !canSave },
        'Save',
      ),
      React.createElement(
        'button',
        { type: 'button', className: 'text-xs px-2 py-1 rounded bg-white/10 hover:bg-white/20', onClick: () => onTip(book) },
        'Tip',
      ),
    ),
  );
}

function BookGrid({ books, onRead, onSave, onTip }) {
  return React.createElement(
    'div',
    { className: 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4' },
    ...books.map((b) =>
      React.createElement(BookCard, {
        key: b.id || b.root,
        book: b,
        onRead,
        onSave,
        onTip
      }),
    ),
  );
}

function EmptyState({ hasRoot }) {
  return React.createElement(
    'div',
    { className: 'rounded-lg border border-white/10 bg-white/5 p-6 text-sm text-white/80' },
    React.createElement('div', { className: 'font-semibold mb-1' }, 'No books found'),
    React.createElement(
      'p',
      { className: 'opacity-80' },
      hasRoot
        ? 'Your catalog has no valid entries. Add book roots containing metadata.json.'
        : 'Add a local catalog.json next to this page, or provide a root using #root=/ipfs/<SITE_CID>.',
    ),
  );
}

function App() {
  const [hash, setHashState] = useState(parseHash());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [books, setBooks] = useState([]);
  const [q, setQ] = useState(hash.q || '');
  const [sort, setSort] = useState('new'); // 'new' | 'reads' | 'rating' | 'pages'
  const [reader, setReader] = useState({ open: false, title: '', bookUrl: '' });
  const { toast, show: showToast, hide: hideToast } = useToast();

  // hash listen
  useEffect(() => {
    const onHash = () => setHashState(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // keep q in sync (back/forward)
  useEffect(() => {
    const next = String(hash.q || '');
    setQ(next);
  }, [hash.q]);

  // whitelist load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const loaded = await loadBooksFromWhitelist(hash.root);
        if (!cancelled) setBooks(loaded);
      } catch (e) {
        if (!cancelled) setError(String(e?.message || e || 'Failed to load books'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hash.root]);

  const filtered = useMemo(() => {
    const term = String(q || '').trim().toLowerCase();
    let list = books;
    if (term) {
      list = list.filter(
        (v) =>
          String(v.title || '').toLowerCase().includes(term) ||
          String(v.author || '').toLowerCase().includes(term) ||
          (v.tags || []).join(' ').toLowerCase().includes(term),
      );
    }
    if (sort === 'reads') list = list.slice().sort((a, b) => (b.reads || 0) - (a.reads || 0));
    else if (sort === 'rating') list = list.slice().sort((a, b) => (b.rating || 0) - (a.rating || 0));
    else if (sort === 'pages') list = list.slice().sort((a, b) => (b.pages || 0) - (a.pages || 0));
    return list;
  }, [books, q, sort]);

  async function onRead(book) {
    try {
      if (book.adult && !isAdultVerified()) {
        openAgeGate(() => onRead(book));
        return;
      }
      if (!book.bookPath) return;

      // Domain mode: the site runs inside a sandboxed iframe, so complex readers can be flaky.
      // Ask the parent Lumen Browser to open the EPUB in the built-in IPFS viewer instead.
      try {
        if (window.parent && window.parent !== window) {
          const lumenUrl = toLumenIpfsOrIpnsUrl(book.bookPath);
          if (lumenUrl) {
            window.parent.postMessage({ __lumen_site: true, type: 'newtab', url: lumenUrl }, '*');
            return;
          }
        }
      } catch {}

      const bookUrl = await resolveUrl(book.bookPath);
      setReader({ open: true, title: book.title, bookUrl });
    } catch (e) {
      console.warn('[book_library] read failed:', e);
      showToast('Failed to open reader.', 'error', 3400);
      setReader({ open: false, title: '', bookUrl: '' });
    }
  }

  async function onSave(book) {
    const fn = L()?.save || L()?.pin;
    if (!fn) {
      showToast('Save not available in this context.', 'warn');
      return;
    }
    if (!book?.bookPath) {
      showToast('No EPUB to save for this item.', 'warn');
      return;
    }
    const res = await safeCall(() => fn({ cidOrUrl: book.bookPath, name: book.title }));
    if (res?.ok) showToast('Saved.', 'success');
    else if (res?.error === 'busy') showToast('Already processing...', 'warn');
    else if (res?.error && res.error !== 'user_cancelled') showToast('Save failed: ' + String(res?.error || 'failed'), 'error', 3400);
  }

  async function onTip(book) {
    if (!L()?.sendToken) {
      showToast('Tip not available in this context.', 'warn');
      return;
    }
    const raw = String(book.publisher || '').trim();
    const to = isLikelyLmnAddress(raw) ? raw : DEFAULT_TIP_TO;
    if (!to) {
      showToast('No tip destination configured.', 'warn');
      return;
    }
    const memo = `Tip for ${book.title}`;
    const res = await safeCall(() => L().sendToken({ to, memo, amountLmn: 1 }));
    if (res?.ok) showToast('Sent.', 'success');
    else if (res?.error === 'busy') showToast('Already processing...', 'warn');
    else if (res?.error && res.error !== 'user_cancelled') showToast('Send failed: ' + String(res?.error || 'failed'), 'error', 3400);
  }

  return React.createElement(
    'div',
    { className: 'min-h-screen' },
    React.createElement(
      'div',
      { className: 'fixed top-0 inset-x-0 z-40 border-b border-white/10 bg-[#0b0b0b]/95 backdrop-blur' },
      React.createElement(
        'div',
        { className: 'max-w-7xl mx-auto px-4 h-14 flex items-center gap-4' },
        React.createElement('div', { className: 'text-xl font-black text-amber-500 tracking-wide' }, 'BOOK LIBRARY'),
        React.createElement(
          'div',
          { className: 'ml-auto relative w-72' },
          React.createElement('input', {
            value: q,
            onChange: (e) => {
              const v = e.target.value;
              setQ(v);
            },
            placeholder: 'Search books...',
            className:
              'w-full bg-white/10 placeholder-white/60 rounded px-3 py-1.5 outline-none focus:ring-2 ring-white/30 text-sm'
          }),
        ),
      ),
    ),
    React.createElement(
      'main',
      { className: 'max-w-7xl mx-auto px-4 pt-16 pb-10 grid grid-cols-12 gap-6' },
      React.createElement(
        'aside',
        { className: 'hidden lg:block col-span-3' },
        React.createElement(CategoriesBox, {
          items: books,
          onPick: (tag) => {
            setQ(tag);
          }
        }),
      ),
      React.createElement(
        'section',
        { className: 'col-span-12 lg:col-span-9' },
        React.createElement(FiltersBar, { sort, setSort }),
        loading
          ? React.createElement('div', { className: 'py-16 text-center text-white/60' }, 'Loading...')
          : error
            ? React.createElement('div', { className: 'py-16 text-center text-red-400' }, error)
            : filtered.length
              ? React.createElement(BookGrid, { books: filtered, onRead, onSave, onTip })
              : React.createElement(EmptyState, { hasRoot: !!hash.root }),
      ),
    ),
    React.createElement(ReaderModal, {
      open: !!reader.open,
      title: reader.title,
      bookUrl: reader.bookUrl,
      onClose: () => setReader({ open: false, title: '', bookUrl: '' })
    }),
    toast?.open
      ? React.createElement(
          'div',
          { className: 'fixed bottom-4 right-4 z-[99999] max-w-[90vw]' },
          React.createElement(
            'div',
            {
              className: `px-4 py-3 rounded-lg shadow-lg border border-white/10 backdrop-blur bg-black/70 text-sm flex items-start gap-3 ${
                toast.kind === 'error'
                  ? 'text-red-200'
                  : toast.kind === 'success'
                    ? 'text-green-200'
                    : toast.kind === 'warn'
                      ? 'text-amber-200'
                      : 'text-white/90'
              }`
            },
            React.createElement('div', { className: 'flex-1' }, toast.message),
            React.createElement('button', { className: 'text-white/60 hover:text-white', onClick: hideToast, type: 'button' }, '×'),
          ),
        )
      : null,
  );
}

ReactDOM.createRoot(document.getElementById('app')).render(React.createElement(App));
