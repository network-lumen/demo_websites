const React = window.React;
const { useEffect, useMemo, useRef, useState } = React;

const L = () => (window && window.lumen) || null;

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

function normalizeItem(raw) {
  const it = raw && typeof raw === 'object' ? raw : {};
  const title = String(it.title || '').trim();
  const artist = String(it.artist || '').trim();
  const cid = String(it.cid || '').trim();
  const cover = String(it.cover || '').trim();
  const year = Number(it.year || 0) || null;
  const tags = Array.isArray(it.tags) ? it.tags.map((t) => String(t || '').trim()).filter(Boolean) : [];
  const author = String(it.author || '').trim();
  return { title, artist, cid, cover, year, tags, author };
}

function useResolvedUrl(value) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let alive = true;
    (async () => {
      const raw = String(value || '').trim();
      if (!raw) {
        if (alive) setUrl('');
        return;
      }
      try {
        const resolved = await resolveUrl(raw);
        if (alive) setUrl(resolved || '');
      } catch {
        if (alive) setUrl('');
      }
    })();
    return () => {
      alive = false;
    };
  }, [value]);
  return url;
}

function TopBar({ search, setSearch }) {
  return React.createElement(
    'header',
    { className: 'topbar' },
    React.createElement('div', { className: 'brand' }, 'Lumen Music'),
    React.createElement(
      'nav',
      { className: 'nav' },
      React.createElement('button', { className: 'chip', type: 'button', 'aria-current': 'page' }, 'Catalog'),
    ),
    React.createElement(
      'div',
      { className: 'search' },
      React.createElement('span', { className: 'icon' }, 'S'),
      React.createElement('input', {
        value: search,
        onChange: (e) => setSearch(e.target.value),
        placeholder: 'Search...'
      }),
    ),
  );
}

function Hero({ hero, onPlay, onTip, onSave }) {
  if (!hero) return null;
  const coverUrl = useResolvedUrl(hero.cover);

  return React.createElement(
    'section',
    { className: 'hero' },
    React.createElement(
      'div',
      { className: 'hero-cover' },
      coverUrl ? React.createElement('img', { src: coverUrl, alt: '' }) : React.createElement('div', { className: 'cover-fallback' }),
    ),
    React.createElement(
      'div',
      null,
      React.createElement('div', { className: 'hero-title' }, hero.title || 'Untitled'),
      React.createElement(
        'p',
        { className: 'hero-sub' },
        [hero.artist, hero.year ? String(hero.year) : ''].filter(Boolean).join(' • '),
      ),
      React.createElement(
        'div',
        { className: 'hero-actions' },
        React.createElement('button', { className: 'btn primary', type: 'button', onClick: () => onPlay(hero) }, 'Play'),
        React.createElement('button', { className: 'btn subtle', type: 'button', onClick: () => onTip(hero) }, 'Tip'),
        React.createElement('button', { className: 'btn subtle', type: 'button', onClick: () => onSave(hero) }, 'Save'),
      ),
    ),
  );
}

function Card({ it, onPlay, onTip, onSave }) {
  const coverUrl = useResolvedUrl(it.cover);
  const title = String(it.title || '').trim() || 'Untitled';
  const subtitle = String(it.artist || '').trim();

  return React.createElement(
    'div',
    { className: 'card' },
    React.createElement(
      'div',
      {
        className: 'cover',
        role: 'button',
        tabIndex: 0,
        onClick: () => onPlay(it),
        onKeyDown: (e) => (e.key === 'Enter' ? onPlay(it) : null)
      },
      coverUrl ? React.createElement('img', { src: coverUrl, alt: '', loading: 'lazy' }) : React.createElement('div', { className: 'cover-fallback' }),
      React.createElement(
        'div',
        { className: 'actions' },
        React.createElement(
          'button',
          {
            className: 'icon-btn',
            type: 'button',
            onClick: (e) => {
              e.preventDefault();
              e.stopPropagation();
              onTip(it);
            }
          },
          'Tip',
        ),
        React.createElement(
          'button',
          {
            className: 'icon-btn',
            type: 'button',
            onClick: (e) => {
              e.preventDefault();
              e.stopPropagation();
              onSave(it);
            }
          },
          'Save',
        ),
      ),
      React.createElement(
        'button',
        {
          className: 'play-fab',
          type: 'button',
          title: 'Play',
          onClick: (e) => {
            e.preventDefault();
            e.stopPropagation();
            onPlay(it);
          }
        },
        '>',
      ),
    ),
    React.createElement(
      'div',
      { className: 'meta' },
      React.createElement('div', { className: 'title', title }, title),
      React.createElement('div', { className: 'subtitle', title: subtitle }, subtitle || 'Track'),
    ),
  );
}

function Row({ title, list, onPlay, onTip, onSave }) {
  return React.createElement(
    'section',
    { className: 'row' },
    React.createElement('h2', { className: 'row-title' }, title),
    React.createElement(
      'div',
      { className: 'row-mask' },
      React.createElement(
        'div',
        { className: 'scroller' },
        list.map((it, idx) => React.createElement(Card, { key: it.cid || `${it.title}-${idx}`, it, onPlay, onTip, onSave })),
      ),
    ),
  );
}

function PlayerBar({ player, onClose }) {
  if (!player.open) return null;
  return React.createElement(
    'div',
    { className: 'player-bar' },
    React.createElement(
      'div',
      { className: 'player-thumb' },
      player.coverUrl ? React.createElement('img', { src: player.coverUrl, alt: '' }) : React.createElement('div', { className: 'cover-fallback' }),
    ),
    React.createElement(
      'div',
      { className: 'player-meta' },
      React.createElement('div', { className: 't' }, player.title),
      React.createElement('div', { className: 'a' }, player.artist || ''),
    ),
    React.createElement('div', { className: 'player-audio' }, React.createElement('audio', { src: player.src, controls: true, autoPlay: true })),
    React.createElement('button', { className: 'btn small', type: 'button', onClick: onClose }, 'x'),
  );
}

function Toast({ toast, onClose }) {
  if (!toast?.open) return null;
  return React.createElement(
    'div',
    { className: 'toast-wrap' },
    React.createElement(
      'div',
      { className: `toast ${toast.kind}` },
      React.createElement('div', { className: 'msg' }, toast.message),
      React.createElement('button', { className: 'x', type: 'button', onClick: onClose }, 'x'),
    ),
  );
}

function App() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [items, setItems] = useState([]);
  const [hero, setHero] = useState(null);
  const [search, setSearch] = useState('');
  const [player, setPlayer] = useState({ open: false, title: '', artist: '', coverUrl: '', src: '' });
  const { toast, show: showToast, hide: hideToast } = useToast();

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError('');
      try {
        const res = await fetch('catalog.json', { cache: 'no-store' });
        if (!res.ok) throw new Error('Failed to load catalog.json');
        const data = await res.json();
        const listRaw = Array.isArray(data?.items) ? data.items : [];
        const list = listRaw.map(normalizeItem).filter((it) => it.title || it.cid);
        setItems(list);
        setHero(list[0] || null);
      } catch (e) {
        setError(String(e?.message || e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const grouped = useMemo(() => {
    const q = String(search || '').trim().toLowerCase();
    const filteredItems = q
      ? items.filter((it) => {
          const s = [it.title, it.artist, it.cid, it.tags.join(' ')].join(' ').toLowerCase();
          return s.includes(q);
        })
      : items;

    const tagsCount = new Map();
    for (const it of filteredItems) {
      for (const t of it.tags || []) {
        tagsCount.set(t, (tagsCount.get(t) || 0) + 1);
      }
    }

    const tags = Array.from(tagsCount.entries())
      .filter(([, n]) => n > 0 && n < filteredItems.length) // don't duplicate the "All" row
      .map(([t]) => t)
      .sort((a, b) => a.localeCompare(b));

    const rows = [{ title: 'All', list: filteredItems }];
    for (const t of tags) rows.push({ title: t, list: filteredItems.filter((it) => (it.tags || []).includes(t)) });
    return rows;
  }, [items, search]);

  async function playItem(it) {
    const base = normalizeItem(it);
    if (!base.cid) {
      showToast('CID missing for this item.', 'warn');
      return;
    }

    try {
      const src = await resolveUrl(base.cid);
      const coverUrl = base.cover ? await resolveUrl(base.cover) : '';
      setPlayer({ open: true, title: base.title || 'Track', artist: base.artist || '', coverUrl, src });
    } catch (e) {
      console.warn('[music_catalog] play failed:', e);
      showToast('Failed to play.', 'error', 3400);
    }
  }

  async function pin(it) {
    const fn = L()?.save || L()?.pin;
    if (!fn) {
      showToast('Save not available in this context.', 'warn');
      return;
    }
    const base = normalizeItem(it);
    if (!base.cid) {
      showToast('CID missing for this item.', 'warn');
      return;
    }
    const res = await safeCall(() => fn({ cidOrUrl: base.cid, name: base.title || base.cid }));
    if (res?.ok) showToast('Saved.', 'success');
    else if (res?.error === 'busy') showToast('Already processing...', 'warn');
    else if (res?.error && res.error !== 'user_cancelled') showToast('Save failed: ' + String(res?.error || 'failed'), 'error', 3400);
  }

  async function tip(it) {
    if (!L()?.sendToken) {
      showToast('Tip not available in this context.', 'warn');
      return;
    }
    const base = normalizeItem(it);
    const to = base.author || '';
    if (!to) {
      showToast('No tip destination for this item.', 'warn');
      return;
    }
    const memo = `Tip for ${base.title || 'music'}`;
    const res = await safeCall(() => L().sendToken({ to, memo, amountLmn: 1 }));
    if (res?.ok) showToast('Sent.', 'success');
    else if (res?.error === 'busy') showToast('Already processing...', 'warn');
    else if (res?.error && res.error !== 'user_cancelled') showToast('Send failed: ' + String(res?.error || 'failed'), 'error', 3400);
  }

  return React.createElement(
    React.Fragment,
    null,
    React.createElement(TopBar, { search, setSearch }),
    React.createElement(
      'main',
      { className: 'container' },
      loading
        ? React.createElement('div', { style: { padding: '24px 2px', color: 'var(--muted)' } }, 'Loading catalog...')
        : error
          ? React.createElement('div', { style: { padding: '24px 2px', color: 'var(--danger)' } }, error)
          : React.createElement(
              React.Fragment,
              null,
              React.createElement(Hero, { hero, onPlay: playItem, onTip: tip, onSave: pin }),
              grouped.map((g) => React.createElement(Row, { key: g.title, title: g.title, list: g.list, onPlay: playItem, onTip: tip, onSave: pin })),
            ),
    ),
    React.createElement(PlayerBar, { player, onClose: () => setPlayer({ open: false, title: '', artist: '', coverUrl: '', src: '' }) }),
    React.createElement(Toast, { toast, onClose: hideToast }),
  );
}

ReactDOM.createRoot(document.getElementById('app')).render(React.createElement(App));
