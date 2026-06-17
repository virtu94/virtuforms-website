import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://vgmzzavxhuarlacnvnoz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZnbXp6YXZ4aHVhcmxhY252bm96Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2Mjk4NTksImV4cCI6MjA5NDIwNTg1OX0.7-YKlwLrhUYUYbiii93ZvgX01TxVephApDNCP50Rl54';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const pageLinks = [
  ['Home', 'index.html'],
  ['About', 'about.html'],
  ['Pricing', 'pricing.html'],
  ['Zones', 'zones.html'],
  ['Calculator', 'calculator.html'],
  ['Business Clients', 'business-clients.html'],
  ['How It Works', 'how-it-works.html'],
  ['FAQ', 'faq.html'],
  ['Contact', 'contact.html']
];

function dashboardForRole(role) {
  if (role === 'admin') return 'admin-dashboard.html';
  if (role === 'driver') return 'driver-dashboard.html';
  return 'dashboard.html';
}

function initialsFrom(value, fallback = 'VD') {
  const clean = String(value || '').trim();
  if (!clean) return fallback;
  const parts = clean.split(/\s+/).filter(Boolean);
  const initials = ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase();
  return initials || clean.slice(0, 2).toUpperCase() || fallback;
}

function injectStyles() {
  if (document.getElementById('vd-session-nav-style')) return;
  const style = document.createElement('style');
  style.id = 'vd-session-nav-style';
  style.textContent = `
    body.vd-session-authenticated [data-nav-links] { order: 2; }
    .vd-account-menu { position: relative; display: inline-flex; align-items: center; order: 3; margin-left: 0.75rem; flex-shrink: 0; }
    .vd-account-button {
      width: 42px; height: 42px; border-radius: 999px; border: 2px solid rgba(42,157,143,0.22);
      background: #2a9d8f; color: #fff; display: inline-flex; align-items: center; justify-content: center;
      font: 800 0.82rem/1 Inter, Arial, sans-serif; cursor: pointer; box-shadow: 0 8px 18px rgba(13,43,40,0.14);
    }
    .vd-account-button:hover { background: #238277; }
    .vd-account-dropdown {
      position: absolute; top: calc(100% + 0.6rem); right: 0; min-width: 230px; background: #fff;
      border: 1px solid #e6eeee; border-radius: 12px; box-shadow: 0 18px 45px rgba(13,43,40,0.18);
      padding: 0.45rem; z-index: 2000; display: none;
    }
    .vd-account-menu.open .vd-account-dropdown { display: block; }
    .vd-account-name { padding: 0.65rem 0.75rem 0.5rem; color: #0d2b28; font-weight: 800; font-size: 0.88rem; }
    .vd-account-role { display: block; margin-top: 0.12rem; color: #6a6a6a; font-weight: 600; font-size: 0.74rem; text-transform: capitalize; }
    .vd-account-dropdown a, .vd-account-dropdown button {
      width: 100%; border: 0; background: transparent; color: #1a1a1a; text-align: left; text-decoration: none;
      display: block; padding: 0.62rem 0.75rem; border-radius: 8px; font: 700 0.86rem/1.2 Inter, Arial, sans-serif; cursor: pointer;
    }
    .vd-account-dropdown a:hover, .vd-account-dropdown button:hover { background: #f0f9f8; color: #2a9d8f; }
    .vd-account-divider { height: 1px; background: #edf4f3; margin: 0.45rem 0; }
    .vd-account-logout { color: #c0392b !important; }
    @media (max-width: 768px) {
      body.vd-session-authenticated [data-mobile-toggle] { display: none !important; }
      .vd-account-menu {
        width: auto;
        margin: 0;
        display: inline-flex;
        justify-content: center;
        align-items: center;
        z-index: 2600;
      }
      .vd-account-button {
        width: 48px;
        height: 48px;
        min-height: 48px;
        border-radius: 999px;
        flex: 0 0 48px;
      }
      .vd-account-button::after { content: none; }
      .vd-account-dropdown {
        position: fixed;
        top: 5.35rem;
        right: 1rem;
        left: auto;
        width: min(270px, calc(100vw - 2rem));
        min-width: 0;
        max-height: calc(100vh - 6.4rem);
        overflow-y: auto;
        box-shadow: 0 18px 45px rgba(13,43,40,0.22);
      }
      body.vd-session-authenticated [data-nav-links] {
        display: none !important;
      }
    }
  `;
  document.head.appendChild(style);
}

async function getSessionProfile() {
  const { data: sessionData } = await supabase.auth.getSession();
  const user = sessionData?.session?.user;
  if (!user) return null;

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('id, role, first_name, last_name, status')
    .eq('id', user.id)
    .single();

  if (error || !profile || profile.status !== 'active') return null;

  let displayName = [profile.first_name, profile.last_name].filter(Boolean).join(' ') || user.email || 'VirtuDrop';

  if (profile.role === 'business') {
    const { data: business } = await supabase
      .from('business_clients')
      .select('business_name')
      .eq('profile_id', user.id)
      .eq('status', 'active')
      .maybeSingle();
    if (business?.business_name) displayName = business.business_name;
  }

  return { user, profile, displayName };
}

function closeMenu(menu) {
  menu.classList.remove('open');
  menu.querySelector('.vd-account-button')?.setAttribute('aria-expanded', 'false');
}

function renderAccountMenu(sessionProfile) {
  const nav = document.querySelector('[data-nav-links]');
  const toggle = document.querySelector('[data-mobile-toggle]');
  if (!nav || document.querySelector('.vd-account-menu')) return;

  document.body.classList.add('vd-session-authenticated');
  nav.classList.remove('open');
  if (toggle) {
    toggle.textContent = 'Menu';
    toggle.setAttribute('aria-hidden', 'true');
    toggle.tabIndex = -1;
  }

  document.querySelectorAll('.nav-login').forEach(link => {
    link.style.display = 'none';
  });

  const { profile, displayName } = sessionProfile;
  const dashboard = dashboardForRole(profile.role);
  const menu = document.createElement('div');
  menu.className = 'vd-account-menu';
  menu.innerHTML = `
    <button type="button" class="vd-account-button" aria-haspopup="true" aria-expanded="false" title="${displayName.replace(/"/g, '&quot;')}">${initialsFrom(displayName)}</button>
    <div class="vd-account-dropdown" role="menu">
      <div class="vd-account-name">${displayName}<span class="vd-account-role">${profile.role}</span></div>
      ${pageLinks.map(([label, href]) => `<a role="menuitem" href="${href}">${label}</a>`).join('')}
      <div class="vd-account-divider"></div>
      <a role="menuitem" href="${dashboard}">Dashboard</a>
      <button type="button" class="vd-account-logout" role="menuitem">Log Out</button>
    </div>
  `;

  const button = menu.querySelector('.vd-account-button');
  button.addEventListener('click', event => {
    event.stopPropagation();
    const isOpen = menu.classList.toggle('open');
    button.setAttribute('aria-expanded', String(isOpen));
  });

  menu.querySelector('.vd-account-logout').addEventListener('click', async () => {
    localStorage.setItem('vd-explicit-logout', String(Date.now()));
    await supabase.auth.signOut();
    window.location.href = 'auth.html';
  });

  document.addEventListener('click', event => {
    if (!menu.contains(event.target)) closeMenu(menu);
  });

  if (toggle?.parentElement) {
    toggle.insertAdjacentElement('afterend', menu);
  } else {
    nav.appendChild(menu);
  }
}

async function init() {
  injectStyles();
  const sessionProfile = await getSessionProfile();
  if (sessionProfile) renderAccountMenu(sessionProfile);
}

init().catch(error => console.warn('VirtuDrop session nav failed:', error));
