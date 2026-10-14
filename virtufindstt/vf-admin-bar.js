// VirtuFinds TT — admin shortcut shown on every storefront page when a
// registered admin is logged in: a round profile button (top right) with a
// link back to the dashboard and a log out action.

const LOG = '[vf-admin-bar]';
let wrap = null;

function buildButton() {
  wrap = document.createElement('div');
  wrap.id = 'vfAdminAvatarWrap';
  wrap.style.cssText = 'display:none;position:fixed;top:14px;right:14px;z-index:9999;';
  wrap.innerHTML =
    '<button id="vfAdminAvatarBtn" type="button" aria-haspopup="true" aria-expanded="false" aria-label="Admin menu" ' +
    'style="width:40px;height:40px;border-radius:50%;border:0;cursor:pointer;background:#0C58E6;color:#fff;font:700 14px/1 system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 14px rgba(0,0,0,.18);">A</button>' +
    '<div id="vfAdminAvatarMenu" style="display:none;position:absolute;right:0;top:calc(100% + 8px);background:#fff;border:1px solid #e4e4e4;border-radius:12px;box-shadow:0 12px 30px rgba(0,0,0,.16);min-width:170px;padding:6px;">' +
    '<a href="admin.html" style="display:block;padding:9px 10px;border-radius:8px;text-decoration:none;color:#1a1a1a;font-weight:600;font-size:13px;">Dashboard</a>' +
    '<button id="vfAdminAvatarLogout" type="button" style="display:block;width:100%;text-align:left;padding:9px 10px;border:0;background:none;border-radius:8px;color:#c0392b;font-weight:600;font-size:13px;cursor:pointer;">Log out</button>' +
    '</div>';
  document.body.appendChild(wrap);

  const btn = wrap.querySelector('#vfAdminAvatarBtn');
  const menu = wrap.querySelector('#vfAdminAvatarMenu');
  const close = function () { menu.style.display = 'none'; btn.setAttribute('aria-expanded', 'false'); };

  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    const open = menu.style.display === 'block';
    menu.style.display = open ? 'none' : 'block';
    btn.setAttribute('aria-expanded', String(!open));
  });
  document.addEventListener('click', function (e) { if (!wrap.contains(e.target)) close(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  wrap.querySelector('#vfAdminAvatarLogout').addEventListener('click', async function () {
    await sb.auth.signOut();
    window.location.reload();
  });
}

async function refresh(session) {
  if (!session) { if (wrap) wrap.style.display = 'none'; return; }

  const res = await sb.from('vf_admins').select('id, first_name, last_name').eq('id', session.user.id).maybeSingle();
  if (res.error) { console.warn(LOG, 'admin lookup failed:', res.error.message); return; }
  if (!res.data) { console.info(LOG, 'logged in, but not a registered VirtuFinds admin'); if (wrap) wrap.style.display = 'none'; return; }

  if (!wrap) buildButton();
  const first = (res.data.first_name || '').trim();
  const last = (res.data.last_name || '').trim();
  let initials = ((first[0] || '') + (last[0] || '')).toUpperCase();
  if (!initials && session.user.email) initials = session.user.email[0].toUpperCase();
  const btn = wrap.querySelector('#vfAdminAvatarBtn');
  btn.textContent = initials || 'A';
  if (session.user.email) btn.title = session.user.email;
  wrap.style.display = 'block';
}

async function init() {
  if (typeof sb === 'undefined') { console.warn(LOG, 'Supabase client not found on this page'); return; }
  try {
    const { data } = await sb.auth.getSession();
    await refresh(data.session);
    // Supabase asks us not to call its API inside this callback, so defer the lookup.
    sb.auth.onAuthStateChange(function (event, session) {
      setTimeout(function () { refresh(session).catch(function (e) { console.warn(LOG, e); }); }, 0);
    });
  } catch (e) {
    console.warn(LOG, 'failed to start:', e);
  }
}

init();
