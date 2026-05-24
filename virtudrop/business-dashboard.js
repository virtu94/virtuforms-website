import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://vgmzzavxhuarlacnvnoz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZnbXp6YXZ4aHVhcmxhY252bm96Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2Mjk4NTksImV4cCI6MjA5NDIwNTg1OX0.7-YKlwLrhUYUYbiii93ZvgX01TxVephApDNCP50Rl54';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    function showLoggedOutGate() {
      document.body.style.margin = '0';
      document.body.style.display = 'block';
      document.body.style.minHeight = '100vh';
      document.body.style.background = '#f4f8f7';
      document.body.innerHTML = `
        <div style="min-height:100vh; display:flex; align-items:center; justify-content:center; background:#f4f8f7; padding:1.5rem; font-family:Inter, Arial, sans-serif;">
          <div style="width:min(440px,100%); background:#fff; border-radius:14px; box-shadow:0 12px 35px rgba(13,43,40,0.14); padding:2rem; text-align:center; border-top:4px solid #2a9d8f;">
            <h1 style="margin:0 0 0.8rem; color:#0d2b28; font-size:1.6rem;">Please log in again</h1>
            <p style="margin:0 0 1.4rem; color:#4a4a4a; line-height:1.6;">Your business dashboard session has ended. Log back in to view protected information.</p>
            <button style="border:0; border-radius:10px; background:#2a9d8f; color:#fff; padding:0.85rem 1.4rem; font-weight:700; cursor:pointer;" onclick="window.location.href='auth.html?returnTo=dashboard.html'">Log In</button>
          </div>
        </div>
      `;
    }

    async function hasActiveSession() {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        showLoggedOutGate();
        return false;
      }
      return true;
    }

    function installSessionRestoreGuard() {
      window.addEventListener('pageshow', () => { hasActiveSession(); });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') hasActiveSession();
      });
      window.addEventListener('focus', () => { hasActiveSession(); });
    }
    installSessionRestoreGuard();

let currentUser = null;
let profile = null;
let business = null;
let orders = [];
let remittanceRecords = [];
let activeLocTab = 'share';
let isSubmittingBusinessOrder = false;

const panelTitles = {
  overview: 'Overview',
  'new-order': 'New Order',
  'delivery-link': 'My Delivery Link',
  active: 'Active Deliveries',
  history: 'Order History',
  'cod-records': 'COD Records',
  remittance: 'Remittance',
  failed: 'Failed & Rescheduled',
  plan: 'My Plan',
  notifications: 'Notifications',
  settings: 'Settings'
};

const paymentMap = { cod: 'cod', 'pkg-online': 'delivery_only', 'all-online': 'prepaid' };
const paymentLabels = { cod: 'Cash on Delivery', delivery_only: 'Delivery Fee Only', prepaid: 'Fully Paid Online' };
const activeStatuses = ['zone_pending', 'pending', 'confirmed', 'assigned', 'out_for_delivery'];
const failedStatuses = ['failed', 'rescheduled'];

function el(selector) {
  return document.querySelector(selector);
}

function all(selector) {
  return Array.from(document.querySelectorAll(selector));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[char]));
}

function money(value) {
  return `TTD $${Number(value || 0).toFixed(2)}`;
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-TT', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateTime(value) {
  if (!value) return '';
  return new Date(value).toLocaleString('en-TT', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function localDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function collectionAmount(order) {
  if (order.payment_type === 'prepaid') return 0;
  if (order.payment_type === 'delivery_only') return Number(order.delivery_fee || 0);
  return Number(order.cod_amount || 0);
}

function clientPayout(order) {
  if (order.payment_type !== 'cod') return 0;
  return Math.max(Number(order.cod_amount || 0) - Number(order.delivery_fee || 0), 0);
}

function statusLabel(status) {
  const labels = {
    zone_pending: 'Pending Zone',
    pending: 'Pending',
    confirmed: 'Confirmed',
    assigned: 'Assigned',
    out_for_delivery: 'Out for Delivery',
    delivered: 'Delivered',
    failed: 'Failed',
    rescheduled: 'Rescheduled'
  };
  return labels[status] || String(status || 'Pending').replaceAll('_', ' ');
}

function statusClass(status) {
  if (status === 'delivered') return 'delivered';
  if (status === 'out_for_delivery') return 'out';
  if (status === 'failed' || status === 'rescheduled') return 'failed';
  return 'picked-up';
}

function routeText(order) {
  return order.area_name || order.delivery_address || order.maps_link || 'Zone pending';
}

function trackingLink(order) {
  if (!order?.order_number || !order?.tracking_token) return '';
  const base = window.location.origin + window.location.pathname.replace(/dashboard\.html$/, 'track.html');
  return `${base}?order=${encodeURIComponent(order.order_number)}&token=${encodeURIComponent(order.tracking_token)}`;
}

function mapsLink(order) {
  if (order?.maps_link) return order.maps_link;
  if (order?.latitude && order?.longitude) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(order.latitude + ',' + order.longitude)}`;
  }
  if (order?.delivery_address || order?.area_name) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent((order.delivery_address || order.area_name) + ', Trinidad')}`;
  }
  return '';
}

function customerNotesParts(order) {
  const notes = String(order?.customer_notes || '');
  const packageMatch = notes.match(/^Package:\s*(.*)$/m);
  const packageText = packageMatch ? packageMatch[1].trim() : '';
  const extraNotes = notes
    .split('\n')
    .filter(line => !line.trim().toLowerCase().startsWith('package:'))
    .join('\n')
    .trim();
  return { packageText, extraNotes };
}

function detailItem(label, value, full = false) {
  return `
    <div class="order-detail-item${full ? ' full' : ''}">
      <div class="order-detail-label">${escapeHtml(label)}</div>
      <div class="order-detail-value">${value || '—'}</div>
    </div>
  `;
}

function deliveryLink() {
  const base = window.location.origin + window.location.pathname.replace(/dashboard\.html$/, 'delivery-form.html');
  return `${base}?business=${encodeURIComponent(business?.slug || '')}`;
}

function firstName() {
  return profile?.first_name || currentUser?.email?.split('@')[0] || 'there';
}

function setText(selector, value) {
  const target = el(selector);
  if (target) target.textContent = value;
}

function emptyRow(cols, message) {
  return `<tr><td colspan="${cols}" style="padding:1.2rem; color:#6a6a6a; text-align:center;">${escapeHtml(message)}</td></tr>`;
}

function orderTableRow(order, includeCost = false) {
  const link = trackingLink(order);
  return `
    <tr class="order-clickable" onclick="openOrderDetails('${order.id}')">
      <td><strong><button type="button" class="order-detail-link" onclick="event.stopPropagation(); openOrderDetails('${order.id}')">${escapeHtml(order.order_number)}</button></strong></td>
      <td>${escapeHtml(routeText(order))}</td>
      <td>${escapeHtml(paymentLabels[order.payment_type] || 'Delivery')}</td>
      ${includeCost ? `<td>${money(order.delivery_fee)}</td>` : ''}
      <td>${formatDate(order.created_at)}</td>
      <td><span class="status-badge ${statusClass(order.order_status)}">${escapeHtml(statusLabel(order.order_status))}</span></td>
      ${includeCost ? `<td>${link ? `<a href="${escapeHtml(link)}" target="_blank" onclick="event.stopPropagation()" style="color:#2a9d8f; font-weight:700;">Track</a>` : '—'}</td>` : ''}
    </tr>
  `;
}

function orderCard(order) {
  const link = trackingLink(order);
  return `
    <div class="order-card order-clickable" onclick="openOrderDetails('${order.id}')">
      <div class="order-card-top">
        <span class="order-card-id">${escapeHtml(order.order_number)}</span>
        <span class="status-badge ${statusClass(order.order_status)}">${escapeHtml(statusLabel(order.order_status))}</span>
      </div>
      <div class="order-card-route">${escapeHtml(routeText(order))}</div>
      <div class="order-card-meta">
        <span>${escapeHtml(paymentLabels[order.payment_type] || 'Delivery')}</span>
        <span>${formatDate(order.created_at)}</span>
      </div>
      <div class="order-card-cost">${money(order.delivery_fee)}${link ? ` · <a href="${escapeHtml(link)}" target="_blank" onclick="event.stopPropagation()" style="color:#2a9d8f;">Track</a>` : ''} · <button type="button" class="order-detail-link" onclick="event.stopPropagation(); openOrderDetails('${order.id}')">View details</button></div>
    </div>
  `;
}

window.openOrderDetails = function(orderId) {
  const order = orders.find(item => item.id === orderId);
  const modal = el('#orderDetailModal');
  const content = el('#orderDetailContent');
  if (!order || !modal || !content) return;

  const link = trackingLink(order);
  const map = mapsLink(order);
  const notes = customerNotesParts(order);
  const payment = paymentLabels[order.payment_type] || order.payment_type || 'Delivery';
  const status = statusLabel(order.order_status);
  const amountToCollect = order.payment_type === 'prepaid'
    ? 0
    : order.payment_type === 'delivery_only'
      ? Number(order.delivery_fee || 0)
      : Number(order.cod_amount || 0) + Number(order.delivery_fee || 0);

  content.innerHTML = `
    <div class="order-detail-head">
      <div>
        <div class="order-detail-title">${escapeHtml(order.order_number)}</div>
        <div class="order-detail-sub">${escapeHtml(status)} · ${escapeHtml(formatDate(order.created_at))}</div>
      </div>
      <span class="status-badge ${statusClass(order.order_status)}">${escapeHtml(status)}</span>
    </div>
    <div class="order-detail-grid">
      ${detailItem('Customer', escapeHtml(order.customer_name || ''))}
      ${detailItem('Phone', escapeHtml(order.customer_phone || ''))}
      ${detailItem('Payment Type', escapeHtml(payment))}
      ${detailItem('Amount to Collect', escapeHtml(money(amountToCollect)))}
      ${detailItem('COD Amount', escapeHtml(money(order.cod_amount)))}
      ${detailItem('Delivery Fee', escapeHtml(money(order.delivery_fee)))}
      ${detailItem('Zone Status', escapeHtml(order.zone_status || 'pending'))}
      ${detailItem('Order Status', escapeHtml(status))}
      ${detailItem('Package', escapeHtml(notes.packageText || 'Not entered'), true)}
      ${detailItem('Delivery Address', escapeHtml(order.delivery_address || 'Location pending'), true)}
      ${detailItem('House / Apt', escapeHtml(order.house_number || ''))}
      ${detailItem('Street', escapeHtml(order.street_name || ''))}
      ${detailItem('Area', escapeHtml(order.area_name || ''))}
      ${detailItem('GPS', order.latitude && order.longitude ? escapeHtml(order.latitude + ', ' + order.longitude) : '')}
      ${detailItem('Notes', escapeHtml(notes.extraNotes || 'None'), true)}
    </div>
    <div class="order-detail-actions">
      ${map ? `<a class="btn btn-primary" href="${escapeHtml(map)}" target="_blank">Open Location</a>` : ''}
      ${link ? `<a class="btn btn-ghost" href="${escapeHtml(link)}" target="_blank">Track Order</a>` : ''}
    </div>
  `;

  modal.classList.add('active');
};

window.closeOrderDetails = function() {
  el('#orderDetailModal')?.classList.remove('active');
};

function renderOverview() {
  const month = new Date().toISOString().slice(0, 7);
  const thisMonth = orders.filter(order => String(order.created_at || '').slice(0, 7) === month);
  const active = orders.filter(order => activeStatuses.includes(order.order_status));
  const delivered = thisMonth.filter(order => order.order_status === 'delivered');

  const heading = el('#panel-overview .section-heading');
  if (heading?.childNodes?.[0]) heading.childNodes[0].nodeValue = `Good day, ${firstName()}! 👋 `;
  setText('#panel-overview .section-sub', `Here is a live snapshot for ${business?.business_name || 'your business'}.`);

  const statValues = all('#panel-overview .stat-value');
  const statNotes = all('#panel-overview .stat-note');
  if (statValues[0]) statValues[0].textContent = thisMonth.length;
  if (statValues[1]) statValues[1].textContent = active.length;
  if (statValues[2]) statValues[2].textContent = delivered.length;
  if (statValues[3]) statValues[3].textContent = orders.filter(order => order.order_status === 'zone_pending').length;
  if (statNotes[3]) statNotes[3].textContent = 'awaiting zone confirmation';

  const activeCard = el('#panel-overview .overview-grid .card:nth-child(1)');
  if (activeCard) {
    activeCard.innerHTML = `<div class="card-title">🚚 Active Deliveries</div>` +
      (active.length
        ? active.slice(0, 4).map(order => `
          <div class="delivery-item">
            <div class="delivery-icon">📦</div>
            <div class="delivery-info">
              <div class="delivery-route">${escapeHtml(routeText(order))}</div>
              <div class="delivery-meta">Order ${escapeHtml(order.order_number)} · ${escapeHtml(paymentLabels[order.payment_type] || 'Delivery')}</div>
            </div>
            <div class="delivery-status"><span class="status-badge ${statusClass(order.order_status)}">${escapeHtml(statusLabel(order.order_status))}</span></div>
          </div>
        `).join('')
        : '<p style="color:#6a6a6a;">No active deliveries right now.</p>');
  }

  const alertCard = el('#panel-overview .overview-grid .card:nth-child(2)');
  if (alertCard) {
    alertCard.innerHTML = `<div class="card-title">🔔 Recent Alerts</div>` +
      (orders.length
        ? orders.slice(0, 5).map(order => `
          <div class="notif-item">
            <div class="notif-dot-icon"></div>
            <div>
              <div class="notif-text"><strong>${escapeHtml(order.order_number)}</strong> is ${escapeHtml(statusLabel(order.order_status))}.</div>
              <div class="notif-time">${formatDateTime(order.created_at)}</div>
            </div>
          </div>
        `).join('')
        : '<p style="color:#6a6a6a;">No order alerts yet.</p>');
  }

  const usageCard = el('#panel-overview > .card:last-child');
  if (usageCard) {
    usageCard.innerHTML = `
      <div class="card-title">📦 Account Status</div>
      <div style="display:flex; justify-content:space-between; font-size:0.88rem; color:#6a6a6a; margin-bottom:0.4rem;">
        <span>${escapeHtml(business?.business_name || 'Business account')}</span>
        <span>${escapeHtml(business?.status || 'active')}</span>
      </div>
      <div class="plan-progress-bar"><div class="plan-progress-fill" style="width:100%;"></div></div>
      <div style="font-size:0.8rem; color:#aaa; margin-top:0.3rem;">Plan usage will be calculated once billing cycles are enabled.</div>
    `;
  }
}

function renderActive() {
  const active = orders.filter(order => activeStatuses.includes(order.order_status));
  setText('#panel-active .section-sub', `${active.length} delivery${active.length === 1 ? '' : 'ies'} currently in progress.`);
  const tbody = el('#panel-active table tbody');
  if (tbody) tbody.innerHTML = active.length ? active.map(order => orderTableRow(order)).join('') : emptyRow(5, 'No active deliveries right now.');
  const cards = el('#panel-active .order-cards');
  if (cards) cards.innerHTML = active.length ? active.map(orderCard).join('') : '<p style="color:#6a6a6a;">No active deliveries right now.</p>';
  const badge = el('[data-panel="active"] .nav-badge');
  if (badge) badge.textContent = active.length;
}

function renderHistory() {
  const history = orders.filter(order => !activeStatuses.includes(order.order_status));
  const tbody = el('#panel-history table tbody');
  if (tbody) tbody.innerHTML = history.length ? history.map(order => orderTableRow(order, true)).join('') : emptyRow(7, 'No completed or past deliveries yet.');
  const cards = el('#panel-history .order-cards');
  if (cards) cards.innerHTML = history.length ? history.map(orderCard).join('') : '<p style="color:#6a6a6a;">No completed or past deliveries yet.</p>';
}

function renderCod() {
  const codOrders = orders.filter(order => ['cod', 'delivery_only'].includes(order.payment_type));
  const rows = codOrders.map(order => {
    const packageAmount = Number(order.cod_amount || 0);
    const deliveryFee = Number(order.delivery_fee || 0);
    const collected = order.payment_type === 'cod' ? packageAmount + deliveryFee : deliveryFee;
    const status = order.order_status === 'delivered' ? 'Collected' : 'Pending Collection';
    return `
      <tr>
        <td style="padding:0.9rem 1rem; font-family:'Courier New',monospace; font-size:0.85rem; color:#2a9d8f;">${escapeHtml(order.order_number)}</td>
        <td style="padding:0.9rem 1rem;">${escapeHtml(order.customer_name)}</td>
        <td style="padding:0.9rem 1rem; text-align:right;">${money(packageAmount)}</td>
        <td style="padding:0.9rem 1rem; text-align:right;">${money(deliveryFee)}</td>
        <td style="padding:0.9rem 1rem; text-align:right; font-weight:700; color:#2a9d8f;">${money(collected)}</td>
        <td style="padding:0.9rem 1rem;">${formatDate(order.created_at)}</td>
        <td style="padding:0.9rem 1rem; text-align:center;"><span style="padding:0.3rem 0.8rem; background:#fff3cd; color:#856404; border-radius:20px; font-size:0.78rem; font-weight:700;">${status}</span></td>
      </tr>
    `;
  });
  const tbody = el('#panel-cod-records table tbody');
  if (tbody) tbody.innerHTML = rows.length ? rows.join('') : emptyRow(7, 'No COD or delivery-fee collections yet.');

  const month = new Date().toISOString().slice(0, 7);
  const monthCod = codOrders.filter(order => String(order.created_at || '').slice(0, 7) === month);
  const total = monthCod.reduce((sum, order) => sum + (order.payment_type === 'cod' ? Number(order.cod_amount || 0) + Number(order.delivery_fee || 0) : Number(order.delivery_fee || 0)), 0);
  const pending = monthCod.filter(order => order.order_status !== 'delivered').reduce((sum, order) => sum + (order.payment_type === 'cod' ? Number(order.cod_amount || 0) + Number(order.delivery_fee || 0) : Number(order.delivery_fee || 0)), 0);
  const summary = el('#panel-cod-records .card > div:last-child');
  if (summary) {
    summary.innerHTML = `
      <div style="font-size:0.9rem; color:#4a4a4a;">Total COD / delivery fee this month: <strong style="color:#0d2b28; font-size:1.1rem;">${money(total)}</strong></div>
      <div style="font-size:0.9rem; color:#4a4a4a;">Still pending: <strong style="color:#e07a3a;">${money(pending)}</strong></div>
    `;
  }
}

function renderRemittance() {
  const clientRecords = remittanceRecords.filter(record => record.business_client_id === business?.id && record.status !== 'cancelled');
  const total = clientRecords.reduce((sum, record) => sum + Number(record.amount || 0), 0);
  const bank = clientRecords.filter(record => record.method === 'bank_transfer').reduce((sum, record) => sum + Number(record.amount || 0), 0);
  const cash = clientRecords.filter(record => record.method === 'cash').reduce((sum, record) => sum + Number(record.amount || 0), 0);
  setText('#remitTotal', money(total));
  setText('#remitOnline', money(bank));
  setText('#remitCash', money(cash));
  const tbody = el('#panel-remittance table tbody');
  if (tbody) {
    tbody.innerHTML = clientRecords.length ? clientRecords.map(record => `
      <tr>
        <td style="padding:0.9rem 1rem; border-bottom:1px solid #f5f5f5;">${formatDate(record.paid_at || record.created_at)}</td>
        <td style="padding:0.9rem 1rem; border-bottom:1px solid #f5f5f5; font-size:0.82rem; color:#6a6a6a;">${escapeHtml((record.order_ids || []).length ? (record.order_ids || []).join(', ') : 'Linked orders')}</td>
        <td style="padding:0.9rem 1rem; border-bottom:1px solid #f5f5f5; text-align:right; font-weight:700; color:#2a9d8f;">${money(record.amount)}</td>
        <td style="padding:0.9rem 1rem; border-bottom:1px solid #f5f5f5;"><span style="padding:0.25rem 0.7rem; background:#e8f5f3; color:#2a9d8f; border-radius:10px; font-size:0.78rem; font-weight:700;">${escapeHtml(String(record.method || '').replaceAll('_', ' '))}</span></td>
        <td style="padding:0.9rem 1rem; border-bottom:1px solid #f5f5f5; font-size:0.85rem; color:#6a6a6a;">${escapeHtml(record.reference || '—')}</td>
        <td style="padding:0.9rem 1rem; border-bottom:1px solid #f5f5f5; text-align:center;"><span style="padding:0.3rem 0.8rem; background:#d4edda; color:#155724; border-radius:20px; font-size:0.78rem; font-weight:700;">${escapeHtml(record.status || 'paid')}</span></td>
      </tr>
    `).join('') : emptyRow(6, 'No remittance records have been posted yet.');
  }
}

function renderFailed() {
  const failed = orders.filter(order => failedStatuses.includes(order.order_status));
  const tbody = el('#panel-failed table tbody');
  if (!tbody) return;
  tbody.innerHTML = failed.length ? failed.map(order => `
    <tr>
      <td style="padding:0.9rem 1rem; font-family:'Courier New',monospace; font-size:0.85rem; color:#2a9d8f;">${escapeHtml(order.order_number)}</td>
      <td style="padding:0.9rem 1rem;">${escapeHtml(order.customer_name)}</td>
      <td style="padding:0.9rem 1rem;">${escapeHtml(order.area_name || '—')}</td>
      <td style="padding:0.9rem 1rem;">${formatDate(order.updated_at || order.created_at)}</td>
      <td style="padding:0.9rem 1rem; font-size:0.88rem; color:#6a6a6a;">Contact VirtuDrop to confirm next steps</td>
      <td style="padding:0.9rem 1rem; text-align:center;"><span style="padding:0.3rem 0.8rem; background:#fde8e8; color:#8b2020; border-radius:20px; font-size:0.78rem; font-weight:700;">${escapeHtml(statusLabel(order.order_status))}</span></td>
      <td style="padding:0.9rem 1rem; text-align:center;"><a href="contact.html" style="color:#2a9d8f; font-weight:700;">Contact</a></td>
    </tr>
  `).join('') : emptyRow(7, 'No failed or rescheduled deliveries.');
}

function renderNotifications() {
  const card = el('#panel-notifications .card');
  if (!card) return;
  setText('#panel-notifications .section-sub', `${Math.min(orders.length, 5)} recent alert${orders.length === 1 ? '' : 's'}.`);
  card.innerHTML = orders.length
    ? orders.slice(0, 8).map(order => `
      <div class="notif-item">
        <div class="notif-dot-icon"></div>
        <div>
          <div class="notif-text"><strong>${escapeHtml(order.order_number)}</strong> is ${escapeHtml(statusLabel(order.order_status))} for ${escapeHtml(order.customer_name || 'your customer')}.</div>
          <div class="notif-time">${formatDateTime(order.updated_at || order.created_at)}</div>
        </div>
      </div>
    `).join('')
    : '<p style="color:#6a6a6a;">No notifications yet.</p>';
}

function renderPlan() {
  const plan = el('#panel-plan .plan-display');
  if (plan) {
    plan.innerHTML = `
      <div class="plan-highlight">
        <div class="plan-highlight-tier">📦 Business Account</div>
        <div class="plan-highlight-name">${escapeHtml(business?.business_name || 'VirtuDrop Client')}</div>
        <div class="plan-highlight-price"><strong>${escapeHtml(business?.status || 'active')}</strong></div>
        <div style="margin-top:1rem; font-size:0.85rem; color:rgba(255,255,255,0.55); line-height:1.6;">
          Delivery link: ${escapeHtml(business?.slug || '')}<br>
          Pricing is confirmed by VirtuDrop based on your active plan and zones.
        </div>
      </div>
      <div class="plan-usage">
        <div class="plan-usage-label">Orders This Month</div>
        <div class="plan-usage-count">${orders.filter(order => String(order.created_at || '').slice(0, 7) === new Date().toISOString().slice(0, 7)).length}</div>
        <div class="plan-progress-bar" style="margin:0.8rem 0 0.4rem;">
          <div class="plan-progress-fill" style="width:100%;"></div>
        </div>
        <div style="font-size:0.82rem; color:#aaa;">Plan limits will show here once billing cycles are enabled.</div>
      </div>
    `;
  }
}

function renderSettings() {
  setText('#settEmail', currentUser?.email || '');
  const first = el('#settFirstName');
  const last = el('#settLastName');
  const email = el('#settEmail');
  const phone = el('#settPhone');
  if (first) first.value = profile?.first_name || '';
  if (last) last.value = profile?.last_name || '';
  if (email) email.value = currentUser?.email || '';
  if (phone) phone.value = profile?.phone || '';
}

function renderDeliveryLink() {
  const display = el('#clientLinkDisplay');
  if (display) display.textContent = deliveryLink();
}

function activeReportControls() {
  const activePanel = el('.panel.active') || document;
  return {
    period: activePanel.querySelector('[id$="ReportPeriod"]') || el('#businessReportPeriod'),
    start: activePanel.querySelector('[id$="ReportStart"]') || el('#businessReportStart'),
    end: activePanel.querySelector('[id$="ReportEnd"]') || el('#businessReportEnd'),
    summary: activePanel.querySelector('[id$="ReportSummary"]') || el('#businessReportSummary')
  };
}

function reportDateRange() {
  const controls = activeReportControls();
  const period = controls.period?.value || 'all';
  let start = period === 'all' ? '' : (controls.start?.value || '');
  let end = period === 'all' ? '' : (controls.end?.value || '');
  const now = new Date();
  if (period === 'day' && !start) start = now.toISOString().slice(0, 10);
  if (period === 'week' && !start) {
    const first = new Date(now);
    first.setDate(now.getDate() - now.getDay());
    start = first.toISOString().slice(0, 10);
  }
  if (period === 'month' && !start) start = now.toISOString().slice(0, 7) + '-01';
  if (period === 'year' && !start) start = now.getFullYear() + '-01-01';
  if (period !== 'all' && period !== 'custom' && !end) end = now.toISOString().slice(0, 10);
  return { period, start, end, controls };
}

function showReportError(message) {
  const summary = activeReportControls().summary;
  if (summary) {
    summary.textContent = message;
    summary.style.color = '#8b2020';
  }
  if (window.vdNotify) {
    window.vdNotify('Export Validation', message, 'error');
  } else {
    alert(message);
  }
}

function clearReportError() {
  const summary = activeReportControls().summary;
  if (summary) summary.style.color = '';
}

function validateReportFilters() {
  const { period, start, end, controls } = reportDateRange();
  clearReportError();
  if (period === 'all') {
    if (controls.start) controls.start.value = '';
    if (controls.end) controls.end.value = '';
    return true;
  }
  if (period === 'custom') {
    if (!start || !end) {
      showReportError('For Custom exports, choose both a start date and an end date.');
      return false;
    }
  }
  if (start && end && start > end) {
    showReportError('Start date cannot be after end date.');
    return false;
  }
  return true;
}

function inReportRange(value) {
  const { start, end } = reportDateRange();
  const date = localDate(value);
  if (start && date < start) return false;
  if (end && date > end) return false;
  return true;
}

function filteredReportOrders() {
  return orders.filter(order => inReportRange(order.updated_at || order.created_at));
}

function filteredReportRemittances() {
  return remittanceRecords.filter(record => record.business_client_id === business?.id && inReportRange(record.paid_at || record.created_at));
}

function syncBusinessReportDateInputs() {
  document.querySelectorAll('[id$="ReportPeriod"]').forEach(periodSelect => {
    const prefix = periodSelect.id.replace('ReportPeriod', '');
    const start = document.getElementById(`${prefix}ReportStart`);
    const end = document.getElementById(`${prefix}ReportEnd`);
    const allTime = periodSelect.value === 'all';
    const useDates = !allTime;
    if (start) {
      start.disabled = !useDates;
      start.required = periodSelect.value === 'custom';
      if (allTime) start.value = '';
    }
    if (end) {
      end.disabled = !useDates;
      end.required = periodSelect.value === 'custom';
      if (allTime) end.value = '';
    }
  });
}
window.syncBusinessReportDateInputs = syncBusinessReportDateInputs;

document.addEventListener('change', event => {
  if (event.target?.id?.endsWith('ReportPeriod')) {
    syncBusinessReportDateInputs();
  }
});

window.applyBusinessReportFilters = function() {
  syncBusinessReportDateInputs();
  if (!validateReportFilters()) return;
  const count = filteredReportOrders().length;
  const summary = activeReportControls().summary;
  if (summary) {
    summary.style.color = '';
    summary.textContent = `${count} order${count === 1 ? '' : 's'} match the selected report period.`;
  }
};

function reportSheetData(title, headers, rows) {
  const { period, start, end } = reportDateRange();
  return [
    [`VirtuDrop ${title}`],
    ['Business', business?.business_name || 'Business Client'],
    ['Period', period],
    ['Date Range', period === 'all' ? 'All time' : `${start || 'Start'} to ${end || 'End'}`],
    ['Exported', new Date().toLocaleString('en-TT')],
    [],
    headers,
    ...rows
  ];
}

function ensureXlsxReady() {
  if (window.XLSX) return true;
  const message = 'The XLSX export library did not load. Make sure this page has internet access, then hard refresh and try again.';
  const summary = activeReportControls().summary;
  if (summary) {
    summary.textContent = message;
    summary.style.color = '#8b2020';
  }
  if (window.vdNotify) {
    window.vdNotify('Export Not Ready', message, 'error');
  } else {
    alert(message);
  }
  return false;
}

function exportRowsToXlsx(title, sheetName, headers, rows) {
  if (!ensureXlsxReady()) return;
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(reportSheetData(title, headers, rows));
  ws['!cols'] = headers.map(() => ({ wch: 20 }));
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, `VirtuDrop-${sheetName}-${new Date().toISOString().slice(0, 10)}.xlsx`);
}

function addReportSheet(wb, title, sheetName, headers, rows) {
  const ws = XLSX.utils.aoa_to_sheet(reportSheetData(title, headers, rows));
  ws['!cols'] = headers.map(() => ({ wch: 20 }));
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
}

function orderExportRows() {
  return filteredReportOrders().map(order => [
    order.order_number,
    order.customer_name,
    order.customer_phone,
    routeText(order),
    paymentLabels[order.payment_type] || order.payment_type,
    Number(order.delivery_fee || 0),
    Number(order.cod_amount || 0),
    statusLabel(order.order_status),
    formatDate(order.created_at)
  ]);
}

function codExportRows() {
  return filteredReportOrders().filter(order => ['cod', 'delivery_only'].includes(order.payment_type)).map(order => [
    order.order_number,
    order.customer_name,
    paymentLabels[order.payment_type] || order.payment_type,
    Number(order.cod_amount || 0),
    Number(order.delivery_fee || 0),
    collectionAmount(order),
    clientPayout(order),
    order.order_status === 'delivered' ? 'Collected' : 'Pending Collection',
    formatDate(order.created_at)
  ]);
}

function remittanceExportRows() {
  return filteredReportRemittances().map(record => [
    formatDate(record.paid_at || record.created_at),
    Number(record.amount || 0),
    String(record.method || '').replaceAll('_', ' '),
    record.reference || '',
    record.status || 'paid',
    (record.order_ids || []).join(', ')
  ]);
}

window.exportBusinessReport = function(type) {
  syncBusinessReportDateInputs();
  if (!validateReportFilters()) return;
  const orderHeaders = ['Order', 'Customer', 'Phone', 'Route', 'Payment', 'Delivery Fee', 'Collected Amount', 'Status', 'Created'];
  const codHeaders = ['Order', 'Customer', 'Payment', 'Collected Amount', 'Delivery Fee', 'Driver Collected', 'Client Payout', 'Status', 'Created'];
  const remitHeaders = ['Date', 'Amount', 'Method', 'Reference', 'Status', 'Linked Orders'];

  if (type === 'orders') {
    exportRowsToXlsx('Order Report', 'Orders', orderHeaders, orderExportRows());
    return;
  }
  if (type === 'cod') {
    exportRowsToXlsx('COD Report', 'COD', codHeaders, codExportRows());
    return;
  }
  if (type === 'remittance') {
    exportRowsToXlsx('Remittance Report', 'Remittance', remitHeaders, remittanceExportRows());
    return;
  }

  if (!ensureXlsxReady()) return;
  const wb = XLSX.utils.book_new();
  addReportSheet(wb, 'Order Report', 'Orders', orderHeaders, orderExportRows());
  addReportSheet(wb, 'COD Report', 'COD', codHeaders, codExportRows());
  addReportSheet(wb, 'Remittance Report', 'Remittance', remitHeaders, remittanceExportRows());
  XLSX.writeFile(wb, `VirtuDrop-All-Data-${new Date().toISOString().slice(0, 10)}.xlsx`);
};

function renderAll() {
  renderOverview();
  renderActive();
  renderHistory();
  renderCod();
  renderRemittance();
  renderFailed();
  renderNotifications();
  renderPlan();
  renderSettings();
  renderDeliveryLink();
}

async function loadBusinessData() {
  const { data: authData } = await supabase.auth.getUser();
  currentUser = authData?.user;
  if (!currentUser) {
    showLoggedOutGate();
    return;
  }

  const { data: profileData, error: profileError } = await supabase
    .from('profiles')
    .select('id, role, first_name, last_name, phone, status')
    .eq('id', currentUser.id)
    .single();

  if (profileError || profileData?.role !== 'business' || profileData?.status !== 'active') {
    await supabase.auth.signOut();
    window.vdNotify('Account Pending', 'Your business account is not active yet. Please contact VirtuDrop.', 'warning');
    window.location.href = 'auth.html';
    return;
  }

  profile = profileData;

  const { data: businessData, error: businessError } = await supabase
    .from('business_clients')
    .select('id, business_name, slug, status')
    .eq('profile_id', currentUser.id)
    .single();

  if (businessError || !businessData) {
    throw businessError || new Error('Business profile not found.');
  }

  business = businessData;

  const [{ data: orderData, error: orderError }, { data: remitData, error: remitError }] = await Promise.all([
    supabase
      .from('orders')
      .select('id, order_number, customer_name, customer_phone, delivery_address, house_number, street_name, area_name, maps_link, latitude, longitude, payment_type, cod_amount, delivery_fee, zone_status, order_status, tracking_token, customer_notes, created_at, updated_at')
      .eq('business_client_id', business.id)
      .order('created_at', { ascending: false }),
    supabase
      .from('remittance_records')
      .select('id, business_client_id, amount, order_ids, method, reference, notes, status, paid_at, created_at')
      .eq('business_client_id', business.id)
      .order('paid_at', { ascending: false })
  ]);

  if (orderError) throw orderError;
  if (remitError) {
    console.warn('Business remittance records could not load:', remitError);
    remittanceRecords = [];
  } else {
    remittanceRecords = remitData || [];
  }
  orders = orderData || [];
  renderAll();
  syncBusinessReportDateInputs();
}

function getLocationPayload() {
  const gpsResult = el('#gpsResult');
  const mapsLink = el('#mapsLink')?.value.trim() || '';
  const houseNumber = el('#houseNum')?.value.trim() || '';
  const streetName = el('#streetName')?.value.trim() || '';
  const areaName = el('#areaName')?.value.trim() || '';

  if (activeLocTab === 'manual') {
    return {
      delivery_address: [houseNumber, streetName, areaName].filter(Boolean).join(', '),
      house_number: houseNumber || null,
      street_name: streetName,
      area_name: areaName,
      maps_link: null,
      latitude: null,
      longitude: null
    };
  }

  const hasGps = gpsResult?.dataset.lat && gpsResult?.dataset.lng;
  return {
    delivery_address: mapsLink || (hasGps ? 'GPS location captured by business' : ''),
    house_number: null,
    street_name: null,
    area_name: null,
    maps_link: mapsLink || null,
    latitude: hasGps ? Number(gpsResult.dataset.lat) : null,
    longitude: hasGps ? Number(gpsResult.dataset.lng) : null
  };
}

function clearOrderValidation() {
  all('#orderForm .input').forEach(input => input.classList.remove('has-error'));
}

function markOrderInvalid(selector) {
  el(selector)?.classList.add('has-error');
}

function isValidMapsLink(value) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol)
      && /(^|\.)google\.[a-z.]+$|(^|\.)goo\.gl$|(^|\.)maps\.app\.goo\.gl$/i.test(url.hostname);
  } catch {
    return false;
  }
}

function validateOrderForm(payload, raw) {
  clearOrderValidation();
  const issues = [];

  if ((payload.customer_name || '').trim().length < 2) {
    markOrderInvalid('#recipientName');
    issues.push('Enter the customer name.');
  }

  if ((raw.phoneDigits || '').length !== 7) {
    markOrderInvalid('#recipientPhone');
    issues.push('Enter a valid 7-digit customer phone number.');
  }

  if ((raw.packageDescription || '').length < 2) {
    markOrderInvalid('#packageDesc');
    issues.push('Enter the package description.');
  }

  if ((raw.packageDescription || '').length > 200) {
    markOrderInvalid('#packageDesc');
    issues.push('Keep the package description under 200 characters.');
  }

  if (!raw.paymentValue) {
    markOrderInvalid('#paymentType');
    issues.push('Select the payment type.');
  }

  if (activeLocTab === 'manual') {
    if ((payload.street_name || '').trim().length < 3) {
      markOrderInvalid('#streetName');
      issues.push('Enter the street or building name.');
    }
    if ((payload.area_name || '').trim().length < 2) {
      markOrderInvalid('#areaName');
      issues.push('Enter the delivery area.');
    }
  }

  if (activeLocTab === 'share') {
    if (!payload.maps_link && !payload.latitude) {
      markOrderInvalid('#mapsLink');
      issues.push('Paste a Google Maps link, use current location, or enter the address manually.');
    } else if (payload.maps_link && !isValidMapsLink(payload.maps_link)) {
      markOrderInvalid('#mapsLink');
      issues.push('Paste a valid Google Maps link.');
    }
  }

  if (raw.paymentValue === 'cod' && (!Number.isFinite(Number(payload.cod_amount)) || Number(payload.cod_amount) <= 0)) {
    markOrderInvalid('#codAmount');
    issues.push('Enter the COD amount the driver should collect.');
  }

  if ((raw.specialNotes || '').length > 500) {
    markOrderInvalid('#specialNotes');
    issues.push('Keep special instructions under 500 characters.');
  }

  if (issues.length) {
    document.querySelector('#orderForm .has-error')?.closest('.form-group')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return issues[0];
  }

  return '';
}

async function submitBusinessOrder(event) {
  event?.preventDefault?.();
  event?.stopImmediatePropagation?.();
  if (isSubmittingBusinessOrder) return;
  isSubmittingBusinessOrder = true;
  if (!business) {
    window.vdNotify('Dashboard Loading', 'Your business dashboard is still loading or did not load your business account. Press Ctrl + F5, log in again, and try once more.', 'warning');
    return;
  }

  const submitBtn = el('#submitOrderBtn');
  const originalText = submitBtn?.textContent || '✅ Submit Order';
  const paymentValue = el('#paymentType')?.value || '';
  const phoneDigits = el('#recipientPhone')?.value.replace(/\D/g, '') || '';
  const locationPayload = getLocationPayload();
  const packageDescription = el('#packageDesc')?.value.trim() || '';
  const specialNotes = el('#specialNotes')?.value.trim() || '';

  const requestData = {
    business_client_id: business.id,
    customer_name: el('#recipientName')?.value.trim() || '',
    customer_phone: '868-' + phoneDigits,
    ...locationPayload,
    payment_type: paymentValue ? paymentMap[paymentValue] : '',
    cod_amount: paymentValue === 'cod' ? Number(el('#codAmount')?.value || 0) : 0,
    customer_notes: [`Package: ${packageDescription}`, specialNotes].filter(Boolean).join('\n') || null
  };

  const validationError = validateOrderForm(requestData, { paymentValue, packageDescription, specialNotes, phoneDigits });
  if (validationError) {
    window.vdNotify('Check This Order', validationError, 'warning');
    return;
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';
  }

  try {
    const { data, error } = await supabase.rpc('submit_delivery_request', { request_data: requestData });
    if (error) throw error;
    const result = Array.isArray(data) ? data[0] : data;
    el('#successModal .modal-icon').textContent = '✅';
    el('#successModal h3').textContent = 'Order Submitted!';
    el('#successModal p').innerHTML = `Order <strong>${escapeHtml(result?.order_number || 'Submitted')}</strong> has been received and is waiting for zone confirmation.`;
    el('#successModal').classList.add('active');
    el('#orderForm').reset();
    window.resetOrderForm();
    await loadBusinessData();
  } catch (error) {
    console.error('Business order submit error:', error);
    window.vdNotify('Order Not Submitted', `Sorry, this order could not be submitted. ${error?.message || 'Please try again or contact VirtuDrop.'}`, 'error');
  } finally {
    isSubmittingBusinessOrder = false;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
    }
  }
}

window.switchPanel = function(id) {
  const target = document.getElementById('panel-' + id);
  if (!target) return;
  all('.panel').forEach(panel => panel.classList.remove('active'));
  all('.nav-item').forEach(item => item.classList.remove('active'));
  target.classList.add('active');
  document.querySelector(`[data-panel="${id}"]`)?.classList.add('active');
  setText('#pageTitle', panelTitles[id] || id);
  closeSidebar();
  window.scrollTo(0, 0);
};

window.closeModal = function() {
  el('#successModal')?.classList.remove('active');
  window.switchPanel('active');
};

window.resetOrderForm = function() {
  const gpsResult = el('#gpsResult');
  if (gpsResult) {
    gpsResult.style.display = 'none';
    gpsResult.textContent = '';
    delete gpsResult.dataset.lat;
    delete gpsResult.dataset.lng;
  }
  clearOrderValidation();
  el('#codAmountBlock')?.style.setProperty('display', 'none');
  const street = el('#streetName');
  const area = el('#areaName');
  if (street) street.required = false;
  if (area) area.required = false;
};

window.switchLocTab = function(tab, btn) {
  activeLocTab = tab;
  all('.loc-panel').forEach(panel => panel.style.display = 'none');
  all('.loc-tab').forEach(button => {
    button.style.background = 'transparent';
    button.style.color = '#4a4a4a';
  });
  const panel = el('#loc-' + tab);
  if (panel) panel.style.display = 'block';
  if (btn) {
    btn.style.background = '#0d2b28';
    btn.style.color = '#ffffff';
  }
  const street = el('#streetName');
  const area = el('#areaName');
  if (street) street.required = tab === 'manual';
  if (area) area.required = tab === 'manual';
};

window.useCurrentLocation = function() {
  const result = el('#gpsResult');
  if (!result) return;
  if (!navigator.geolocation) {
    result.style.display = 'block';
    result.style.background = '#fff3f3';
    result.textContent = '❌ Geolocation is not supported by this browser.';
    return;
  }
  result.style.display = 'block';
  result.style.background = '#e8f5f3';
  result.textContent = '📍 Detecting your location...';
  navigator.geolocation.getCurrentPosition(
    position => {
      result.dataset.lat = position.coords.latitude.toFixed(6);
      result.dataset.lng = position.coords.longitude.toFixed(6);
      result.textContent = `📍 Location detected: ${result.dataset.lat}, ${result.dataset.lng}. Zone will be confirmed by VirtuDrop.`;
    },
    () => {
      result.style.background = '#fff3f3';
      result.textContent = '❌ Could not access location. Please paste a Google Maps link or enter the address manually.';
    }
  );
};

window.copyLink = async function() {
  const link = el('#clientLinkDisplay')?.textContent.trim() || deliveryLink();
  await navigator.clipboard.writeText(link);
  const confirm = el('#copyConfirm');
  if (confirm) {
    confirm.textContent = '✓ Link copied to clipboard!';
    confirm.style.display = 'block';
    setTimeout(() => confirm.style.display = 'none', 2500);
  }
};

window.shareLink = function() {
  const link = el('#clientLinkDisplay')?.textContent.trim() || deliveryLink();
  if (navigator.share) navigator.share({ title: 'VirtuDrop Delivery Link', url: link });
  else window.copyLink();
};

window.filterRemit = function(period, btn) {
  all('.remit-filter').forEach(button => {
    button.style.background = '#fff';
    button.style.color = '#4a4a4a';
    button.style.borderColor = '#e0e0e0';
  });
  if (btn) {
    btn.style.background = '#2a9d8f';
    btn.style.color = '#fff';
    btn.style.borderColor = '#2a9d8f';
  }
};

function closeSidebar() {
  el('#sidebar')?.classList.remove('open');
  el('#sidebarOverlay')?.classList.remove('active');
}

function bindUi() {
  all('[data-panel]').forEach(button => {
    button.addEventListener('click', () => window.switchPanel(button.dataset.panel));
  });

  el('#mobileMenuBtn')?.addEventListener('click', () => {
    el('#sidebar')?.classList.add('open');
    el('#sidebarOverlay')?.classList.add('active');
  });
  el('#sidebarOverlay')?.addEventListener('click', closeSidebar);

  setText('#topbarDate', new Date().toLocaleDateString('en-TT', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }));

  el('#recipientPhone')?.addEventListener('input', event => {
    let value = event.target.value.replace(/\D/g, '');
    if (value.length > 3) value = value.slice(0, 3) + '-' + value.slice(3, 7);
    event.target.value = value;
  });

  function syncAmountField() {
    const paymentValue = el('#paymentType')?.value || '';
    const block = el('#codAmountBlock');
    const amount = el('#codAmount');
    const label = block?.querySelector('label');
    if (!block || !amount) return;

    block.style.display = paymentValue === 'all-online' ? 'none' : 'flex';
    amount.disabled = paymentValue === 'all-online';
    amount.required = paymentValue === 'cod';
    if (paymentValue === 'all-online') amount.value = '';
    if (label) {
      label.textContent = paymentValue === 'pkg-online'
        ? 'Delivery Fee to Collect (TTD)'
        : 'Amount to Collect (TTD)';
    }
    amount.placeholder = paymentValue === 'pkg-online' ? 'e.g. 40.00' : 'e.g. 350.00';
  }

  el('#paymentType')?.addEventListener('change', syncAmountField);
  syncAmountField();

  const darkToggle = el('#darkModeToggle');
  if (localStorage.getItem('vd-dark') === 'true') {
    document.body.classList.add('dark-mode');
    if (darkToggle) darkToggle.checked = true;
  }
  darkToggle?.addEventListener('change', () => {
    document.body.classList.toggle('dark-mode', darkToggle.checked);
    localStorage.setItem('vd-dark', darkToggle.checked);
  });

  window.submitBusinessOrder = submitBusinessOrder;
  el('#orderForm')?.addEventListener('submit', submitBusinessOrder);
  el('#submitOrderBtn')?.addEventListener('click', submitBusinessOrder);
  window.resetOrderForm();

  const logout = el('.logout-btn');
  if (logout) {
    logout.onclick = async () => {
      await supabase.auth.signOut();
      window.location.href = 'auth.html';
    };
  }
}

bindUi();
loadBusinessData().catch(error => {
  console.error('Business dashboard load error:', error);
  window.vdNotify('Dashboard Not Loaded', 'Could not load your business dashboard. Please log in again or contact VirtuDrop.', 'error');
});
