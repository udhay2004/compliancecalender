// public/js/notifications.js
//
// The notification bell, shared by the client portal and every staff
// page. Include with <script src="/js/notifications.js" defer></script>.
// It moves the page's existing .nav-user into a small right-hand group
// and puts the bell next to it; the page's own code keeps writing into
// #navUser exactly as before.
(function () {
  if (window.__ccBell) return;
  window.__ccBell = true;

  const POLL_MS = 30000;
  let open = false;
  let lastUnread = null;

  function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function ago(iso) {
    const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return 'just now';
    const m = Math.round(s / 60); if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60); if (h < 24) return h + ' h ago';
    const d = Math.round(h / 24); if (d < 7) return d + ' d ago';
    return new Date(iso).toLocaleDateString();
  }
  // Only ever follow links inside this app.
  function safeLink(link) { return typeof link === 'string' && link.startsWith('/') && !link.startsWith('//') ? link : null; }

  function mount() {
    const navUser = document.querySelector('.topbar .nav-user');
    if (!navUser) return null;
    const group = document.createElement('div');
    group.className = 'nav-right';
    navUser.parentNode.insertBefore(group, navUser);
    const wrap = document.createElement('div');
    wrap.className = 'bell-wrap';
    wrap.innerHTML = `
      <button type="button" class="bell-btn" aria-haspopup="true" aria-expanded="false" aria-label="Notifications">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg>
        <span class="bell-count" hidden></span>
      </button>
      <div class="bell-panel" role="dialog" aria-label="Notifications" hidden>
        <div class="bell-head"><span>Notifications</span><button type="button" class="bell-readall">Mark all as read</button></div>
        <div class="bell-list"><div class="bell-empty">Loading…</div></div>
      </div>`;
    group.appendChild(wrap);
    group.appendChild(navUser);
    return wrap;
  }

  function render(wrap, data) {
    const count = wrap.querySelector('.bell-count');
    const btn = wrap.querySelector('.bell-btn');
    const unread = data.unread || 0;
    count.hidden = unread === 0;
    count.textContent = unread > 99 ? '99+' : String(unread);
    btn.setAttribute('aria-label', unread ? `Notifications, ${unread} unread` : 'Notifications');
    const list = wrap.querySelector('.bell-list');
    const rows = data.notifications || [];
    if (!rows.length) {
      list.innerHTML = '<div class="bell-empty">Nothing yet. Updates about documents, prices and payments will show up here.</div>';
      return;
    }
    list.innerHTML = rows.map(n => `
      <button type="button" class="bell-item${n.read ? '' : ' unread'}" data-id="${esc(n.id)}" data-link="${esc(safeLink(n.link) || '')}">
        <span class="bell-title">${esc(n.title)}</span>
        ${n.body ? `<span class="bell-body">${esc(n.body)}</span>` : ''}
        <span class="bell-meta">${esc(ago(n.createdAt))}${n.actorName ? ' · ' + esc(n.actorName) : ''}</span>
      </button>`).join('');
  }

  async function refresh(wrap) {
    try {
      const res = await fetch('/api/notifications?limit=25', { credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();
      render(wrap, data);
      if (lastUnread !== null && data.unread > lastUnread) {
        document.dispatchEvent(new CustomEvent('cc:notifications', { detail: data }));
      }
      lastUnread = data.unread;
    } catch (e) { /* offline — try again next tick */ }
  }

  function init() {
    const wrap = mount();
    if (!wrap) return;
    const btn = wrap.querySelector('.bell-btn');
    const panel = wrap.querySelector('.bell-panel');
    const setOpen = (v) => { open = v; panel.hidden = !v; btn.setAttribute('aria-expanded', String(v)); if (v) refresh(wrap); };

    btn.addEventListener('click', (e) => { e.stopPropagation(); setOpen(!open); });
    document.addEventListener('click', (e) => { if (open && !wrap.contains(e.target)) setOpen(false); });
    document.addEventListener('keydown', (e) => { if (open && e.key === 'Escape') { setOpen(false); btn.focus(); } });

    wrap.querySelector('.bell-readall').addEventListener('click', async () => {
      await fetch('/api/notifications/read-all', { method: 'POST' }).catch(() => {});
      refresh(wrap);
    });
    wrap.querySelector('.bell-list').addEventListener('click', async (e) => {
      const item = e.target.closest('.bell-item');
      if (!item) return;
      await fetch(`/api/notifications/${encodeURIComponent(item.dataset.id)}/read`, { method: 'POST' }).catch(() => {});
      const link = safeLink(item.dataset.link);
      if (link && link !== location.pathname + location.search) location.href = link;
      else { refresh(wrap); setOpen(false); document.dispatchEvent(new CustomEvent('cc:notifications', { detail: {} })); }
    });

    refresh(wrap);
    setInterval(() => { if (!document.hidden) refresh(wrap); }, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(wrap); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
