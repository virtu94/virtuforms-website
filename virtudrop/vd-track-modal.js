/**
 * vd-track-modal.js
 * VirtuDrop — Track Order Popup
 *
 * Provides window.vdTrackOrder(orderNumber, trackingToken)
 * Shows a popup modal with the same status card as track.html.
 * Works on desktop and mobile. No redirect to track.html.
 *
 * Usage:
 *   <script src="vd-track-modal.js"></script>
 *   vdTrackOrder('VD260601-001', 'abc123token');
 *
 * Requires: Supabase client already initialised as window.supabase
 *           OR pass your own supabase instance via vdTrackOrder(orderNumber, token, supabaseClient)
 */

(function () {

  /* ── Supabase lazy-init ───────────────────────────────────────── */
  function getSupabase(override) {
    if (override) return override;
    if (window.supabase && typeof window.supabase.rpc === 'function') return window.supabase;
    // Fallback: create a minimal client if the global isn't available
    console.warn('[vd-track-modal] No supabase instance found on window.supabase');
    return null;
  }

  /* ── Status definitions (mirrors track.html) ─────────────────── */
  const STATUS = {
    zone_pending:      { label: 'Request Received',  icon: '📋', badge: 'received',    step: 0, message: 'Your order has been received and is waiting for zone confirmation.' },
    confirmed:         { label: 'Confirmed',          icon: '✅', badge: 'received',    step: 0, message: 'Your delivery has been confirmed and is waiting for driver assignment.' },
    assigned:          { label: 'Driver Assigned',    icon: '📦', badge: 'collected',   step: 1, message: 'A driver has been assigned to your order.' },
    out_for_delivery:  { label: 'Out for Delivery',   icon: '🚚', badge: 'out',         step: 2, message: 'Your package is out for delivery today. The driver will contact you shortly.' },
    delivered:         { label: 'Delivered',          icon: '✅', badge: 'delivered',   step: 3, message: 'Your package has been delivered successfully.' },
    failed:            { label: 'Failed Attempt',     icon: '❌', badge: 'failed',      step: 3, message: 'A delivery attempt was made but was unsuccessful. Please contact the seller or VirtuDrop.' },
    rescheduled:       { label: 'Rescheduled',        icon: '🔄', badge: 'rescheduled', step: 3, message: 'Your delivery has been rescheduled to the next available cycle.' },
  };

  const STEP_LABELS = ['Received', 'Driver Assigned', 'Out for Delivery', 'Delivered'];

  /* ── CSS injected once ───────────────────────────────────────── */
  function injectStyles() {
    if (document.getElementById('vd-track-modal-style')) return;
    const s = document.createElement('style');
    s.id = 'vd-track-modal-style';
    s.textContent = `
      /* Overlay */
      .vd-track-overlay {
        position: fixed;
        inset: 0;
        z-index: 10000;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 1rem;
        background: rgba(13, 43, 40, 0.70);
        backdrop-filter: blur(3px);
        -webkit-backdrop-filter: blur(3px);
        overflow-y: auto;
      }
      .vd-track-overlay.show { display: flex; }

      /* Modal shell */
      .vd-track-modal {
        position: relative;
        width: min(600px, 100%);
        background: #f8f9fa;
        border-radius: 18px;
        box-shadow: 0 24px 60px rgba(13, 43, 40, 0.35);
        overflow: hidden;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        animation: vdTrackSlideIn 0.3s ease-out;
        margin: auto;
      }

      @keyframes vdTrackSlideIn {
        from { opacity: 0; transform: translateY(20px) scale(0.97); }
        to   { opacity: 1; transform: translateY(0)    scale(1);    }
      }

      /* Close button */
      .vd-track-close {
        position: absolute;
        top: 1rem; right: 1rem;
        width: 32px; height: 32px;
        background: rgba(255,255,255,0.15);
        border: none; border-radius: 50%;
        color: rgba(255,255,255,0.8);
        font-size: 1.1rem; line-height: 1;
        cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        transition: background 0.2s;
        z-index: 2;
      }
      .vd-track-close:hover { background: rgba(255,255,255,0.25); color: #fff; }

      /* Loading state */
      .vd-track-loading {
        padding: 3rem 2rem;
        text-align: center;
        color: #4a4a4a;
        background: #fff;
      }
      .vd-track-spinner {
        width: 36px; height: 36px;
        border: 3px solid #e0e0e0;
        border-top-color: #2a9d8f;
        border-radius: 50%;
        animation: vdTrackSpin 0.7s linear infinite;
        margin: 0 auto 1rem;
      }
      @keyframes vdTrackSpin { to { transform: rotate(360deg); } }

      /* Error state */
      .vd-track-error {
        background: #fff3f3;
        border-left: 4px solid #e05555;
        border-radius: 12px;
        padding: 1.5rem;
        margin: 1.5rem;
        font-size: 0.95rem;
        color: #8b2020;
        line-height: 1.7;
      }
      .vd-track-error a { color: #2a9d8f; font-weight: 600; text-decoration: none; }

      /* ── Status card (mirrors track.html .status-card) ── */
      .vd-track-status-card {
        background: #0d2b28;
        padding: 2rem;
      }

      .vd-track-card-top {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        margin-bottom: 1.5rem;
        flex-wrap: wrap;
        gap: 1rem;
      }

      .vd-track-order-id-label {
        font-size: 0.72rem; font-weight: 700;
        text-transform: uppercase; letter-spacing: 1px;
        color: rgba(255,255,255,0.4); margin-bottom: 0.3rem;
      }
      .vd-track-order-id-value {
        font-size: 1.1rem; font-weight: 700;
        color: #14d4ae; font-family: 'Courier New', monospace;
      }

      .vd-track-status-badge {
        padding: 0.4rem 1rem; border-radius: 20px;
        font-size: 0.82rem; font-weight: 700;
      }
      .vd-track-status-badge.received    { background: rgba(42,157,143,0.2);  color: #14d4ae; }
      .vd-track-status-badge.collected   { background: rgba(255,193,7,0.2);   color: #ffc107; }
      .vd-track-status-badge.out         { background: rgba(33,150,243,0.2);  color: #64b5f6; }
      .vd-track-status-badge.delivered   { background: rgba(76,175,80,0.2);   color: #81c784; }
      .vd-track-status-badge.failed      { background: rgba(244,67,54,0.2);   color: #ef9a9a; }
      .vd-track-status-badge.rescheduled { background: rgba(255,152,0,0.2);   color: #ffb74d; }

      /* Progress bar */
      .vd-track-progress { margin-bottom: 1.5rem; }
      .vd-track-prog-steps {
        display: flex; align-items: flex-start;
        position: relative; gap: 0;
      }
      .vd-track-prog-steps::before {
        content: '';
        position: absolute; top: 14px; left: 14px; right: 14px;
        height: 2px; background: rgba(255,255,255,0.12); z-index: 0;
      }
      .vd-track-prog-fill {
        position: absolute; top: 14px; left: 14px;
        height: 2px; background: linear-gradient(90deg, #14d4ae, #2a9d8f);
        z-index: 1; transition: width 0.6s ease;
      }
      .vd-track-prog-step {
        flex: 1; display: flex; flex-direction: column; align-items: center;
        text-align: center; position: relative; z-index: 2;
      }
      .vd-track-prog-dot {
        width: 28px; height: 28px; border-radius: 50%;
        border: 2px solid rgba(255,255,255,0.2);
        background: rgba(255,255,255,0.05);
        display: flex; align-items: center; justify-content: center;
        font-size: 0.7rem; margin-bottom: 0.5rem;
        transition: all 0.4s ease;
      }
      .vd-track-prog-dot.done    { background: #14d4ae; border-color: #14d4ae; color: #0d2b28; font-weight: 700; }
      .vd-track-prog-dot.current { background: #2a9d8f; border-color: #2a9d8f; color: #ffffff; font-weight: 700;
                                   animation: vdTrackPulse 1.5s ease-in-out infinite; }
      @keyframes vdTrackPulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.75;transform:scale(1.1)} }

      .vd-track-prog-label { font-size: 0.65rem; color: rgba(255,255,255,0.45); line-height: 1.3; max-width: 60px; }
      .vd-track-prog-label.done    { color: #14d4ae; font-weight: 600; }
      .vd-track-prog-label.current { color: #ffffff;  font-weight: 600; }

      /* Detail rows */
      .vd-track-details { display: flex; flex-direction: column; gap: 0.6rem; }
      .vd-track-detail-row {
        display: flex; justify-content: space-between; align-items: center;
        padding: 0.6rem 0; border-bottom: 1px solid rgba(255,255,255,0.06);
        font-size: 0.88rem;
      }
      .vd-track-detail-row:last-child { border-bottom: none; }
      .vd-track-detail-key   { color: rgba(255,255,255,0.45); }
      .vd-track-detail-value { color: #ffffff; font-weight: 600; text-align: right; }
      .vd-track-detail-value.accent { color: #14d4ae; }

      /* Footer bar */
      .vd-track-footer {
        background: #ffffff;
        padding: 1.2rem 2rem;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        flex-wrap: wrap;
      }
      .vd-track-footer-msg {
        font-size: 0.82rem;
        color: #6a6a6a;
        line-height: 1.5;
      }
      .vd-track-footer-btn {
        display: inline-flex; align-items: center; gap: 0.4rem;
        padding: 0.65rem 1.2rem;
        background: #2a9d8f; color: #ffffff;
        border: none; border-radius: 8px;
        font-family: inherit; font-size: 0.88rem; font-weight: 700;
        cursor: pointer; text-decoration: none;
        transition: background 0.2s;
        white-space: nowrap;
        flex-shrink: 0;
      }
      .vd-track-footer-btn:hover { background: #238277; }
      .vd-track-footer-btn.ghost {
        background: transparent; color: #2a9d8f;
        border: 2px solid #2a9d8f;
      }
      .vd-track-footer-btn.ghost:hover { background: #f0f9f8; }

      /* ── Mobile ────────────────────────────────────────────── */
      @media (max-width: 520px) {
        .vd-track-overlay { padding: 0; align-items: flex-end; }
        .vd-track-modal {
          width: 100%;
          border-radius: 18px 18px 0 0;
          max-height: 92vh;
          overflow-y: auto;
          animation: vdTrackSlideUp 0.3s ease-out;
        }
        @keyframes vdTrackSlideUp {
          from { transform: translateY(100%); }
          to   { transform: translateY(0); }
        }
        .vd-track-status-card { padding: 1.5rem; }
        .vd-track-prog-label { font-size: 0.6rem; max-width: 50px; }
        .vd-track-footer { flex-direction: column; align-items: stretch; }
        .vd-track-footer-btn { width: 100%; justify-content: center; }
      }
    `;
    document.head.appendChild(s);
  }

  /* ── Build the status card HTML ──────────────────────────────── */
  function buildCardHTML(order) {
    const st = STATUS[order.order_status] || STATUS.zone_pending;
    const step = st.step;
    const prog = step / 3 * 100;

    const progressSteps = STEP_LABELS.map((label, i) => {
      const isDone = i < step || (order.order_status === 'delivered' && i === 3);
      const isCurrent = i === step && order.order_status !== 'delivered';
      const dotClass   = isDone ? 'done' : isCurrent ? 'current' : '';
      const labelClass = isDone ? 'done' : isCurrent ? 'current' : '';
      return `
        <div class="vd-track-prog-step">
          <div class="vd-track-prog-dot ${dotClass}">${isDone ? '✓' : i + 1}</div>
          <div class="vd-track-prog-label ${labelClass}">${label}</div>
        </div>`;
    }).join('');

    const date = order.created_at
      ? new Date(order.created_at).toLocaleDateString('en-TT', { day: 'numeric', month: 'short', year: 'numeric' })
      : '—';

    return `
      <div class="vd-track-status-card">
        <div class="vd-track-card-top">
          <div>
            <div class="vd-track-order-id-label">Order ID</div>
            <div class="vd-track-order-id-value">${escHtml(order.order_number)}</div>
          </div>
          <span class="vd-track-status-badge ${st.badge}">${st.icon} ${st.label}</span>
        </div>

        <div class="vd-track-progress">
          <div class="vd-track-prog-steps">
            <div class="vd-track-prog-fill" style="width: calc(${prog}% - 28px);"></div>
            ${progressSteps}
          </div>
        </div>

        <div class="vd-track-details">
          <div class="vd-track-detail-row">
            <span class="vd-track-detail-key">Customer</span>
            <span class="vd-track-detail-value">${escHtml(order.customer_name || 'Customer')}</span>
          </div>
          <div class="vd-track-detail-row">
            <span class="vd-track-detail-key">Client / Business</span>
            <span class="vd-track-detail-value">${escHtml(order.business_name || 'VirtuDrop Client')}</span>
          </div>
          <div class="vd-track-detail-row">
            <span class="vd-track-detail-key">Delivery Area</span>
            <span class="vd-track-detail-value accent">${escHtml(order.area_name || 'To be confirmed')}</span>
          </div>
          <div class="vd-track-detail-row">
            <span class="vd-track-detail-key">Order Date</span>
            <span class="vd-track-detail-value">${date}</span>
          </div>
          <div class="vd-track-detail-row">
            <span class="vd-track-detail-key">Status</span>
            <span class="vd-track-detail-value" style="font-size:0.82rem; font-weight:400; color:rgba(255,255,255,0.65); text-align:right;">${escHtml(st.message)}</span>
          </div>
        </div>
      </div>
    `;
  }

  /* ── Helpers ─────────────────────────────────────────────────── */
  function escHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ── DOM: ensure overlay exists ──────────────────────────────── */
  function ensureOverlay() {
    let overlay = document.getElementById('vdTrackOverlay');
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = 'vdTrackOverlay';
    overlay.className = 'vd-track-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Order Tracking');
    overlay.innerHTML = `<div class="vd-track-modal" id="vdTrackModal"></div>`;
    document.body.appendChild(overlay);

    // Close on backdrop click
    overlay.addEventListener('click', e => {
      if (e.target === overlay) closeTrackModal();
    });

    // Close on Escape
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && overlay.classList.contains('show')) closeTrackModal();
    });

    return overlay;
  }

  function closeTrackModal() {
    const overlay = document.getElementById('vdTrackOverlay');
    if (overlay) overlay.classList.remove('show');
  }

  function setModalContent(html) {
    const modal = document.getElementById('vdTrackModal');
    if (modal) modal.innerHTML = html;
  }

  /* ── Track page URL helper ───────────────────────────────────── */
  function trackPageUrl(orderNumber, token) {
    const base = window.location.href.replace(/[^/]*\.html.*$/, 'track.html');
    const params = new URLSearchParams();
    if (orderNumber) params.set('order', orderNumber);
    if (token) params.set('token', token);
    return `${base}?${params.toString()}`;
  }

  /* ── Phone-based lookup (used by homepage widget) ───────────── */
  window._vdTrackModalHelpers = {
    ensureTrackModalForPhone: async function(orderNumber, phone) {
      injectStyles();
      const overlay = ensureOverlay();

      setModalContent(`
        <button class="vd-track-close" onclick="document.getElementById('vdTrackOverlay').classList.remove('show')" aria-label="Close">✕</button>
        <div class="vd-track-loading">
          <div class="vd-track-spinner"></div>
          <p style="font-weight:600; color:#0d2b28;">Looking up your order…</p>
        </div>
      `);
      overlay.classList.add('show');

      const sb = getSupabase();
      if (!sb) {
        setModalContent(`
          <button class="vd-track-close" onclick="document.getElementById('vdTrackOverlay').classList.remove('show')" aria-label="Close">✕</button>
          <div class="vd-track-error">⚠️ <strong>Unable to connect.</strong> Please try refreshing the page.</div>
        `);
        return;
      }

      try {
        const { data, error } = await sb.rpc('public_track_order', {
          p_order_number:   orderNumber || null,
          p_customer_phone: phone       || null,
          p_tracking_token: null,
        });

        if (error) throw error;
        const order = Array.isArray(data) ? data[0] : data;

        if (!order) {
          setModalContent(`
            <button class="vd-track-close" onclick="document.getElementById('vdTrackOverlay').classList.remove('show')" aria-label="Close">✕</button>
            <div class="vd-track-error">❌ <strong>Order not found.</strong> Please check your phone number and Order ID, or <a href="contact.html">contact us</a>.</div>
          `);
          return;
        }

        const fullTrackUrl = trackPageUrl(orderNumber, order.tracking_token);

        setModalContent(`
          <button class="vd-track-close" onclick="document.getElementById('vdTrackOverlay').classList.remove('show')" aria-label="Close">✕</button>
          ${buildCardHTML(order)}
          <div class="vd-track-footer">
            <p class="vd-track-footer-msg">Last updated: ${order.updated_at ? new Date(order.updated_at).toLocaleString('en-TT') : '—'}</p>
            <div style="display:flex; gap:0.6rem; flex-wrap:wrap;">
              <button class="vd-track-footer-btn ghost" onclick="document.getElementById('vdTrackOverlay').classList.remove('show')">Close</button>
              <a class="vd-track-footer-btn" href="${escHtml(fullTrackUrl)}" target="_blank">Open Full Page ↗</a>
            </div>
          </div>
        `);

      } catch (err) {
        console.error('[vd-track-modal] Phone lookup error:', err);
        setModalContent(`
          <button class="vd-track-close" onclick="document.getElementById('vdTrackOverlay').classList.remove('show')" aria-label="Close">✕</button>
          <div class="vd-track-error">❌ <strong>Something went wrong.</strong> ${escHtml(err.message || 'Please try again.')} <a href="contact.html">Contact us</a> if the problem persists.</div>
        `);
      }
    }
  };

  /* ── Main public function ────────────────────────────────────── */
  window.vdTrackOrder = async function (orderNumber, trackingToken, supabaseOverride) {
    injectStyles();
    const overlay = ensureOverlay();

    // Show loading state
    setModalContent(`
      <button class="vd-track-close" onclick="document.getElementById('vdTrackOverlay').classList.remove('show')" aria-label="Close">✕</button>
      <div class="vd-track-loading">
        <div class="vd-track-spinner"></div>
        <p style="font-weight:600; color:#0d2b28;">Loading order details…</p>
      </div>
    `);
    overlay.classList.add('show');

    const sb = getSupabase(supabaseOverride);
    if (!sb) {
      setModalContent(`
        <button class="vd-track-close" onclick="document.getElementById('vdTrackOverlay').classList.remove('show')" aria-label="Close">✕</button>
        <div class="vd-track-error">⚠️ <strong>Unable to connect.</strong> Please try refreshing the page.</div>
      `);
      return;
    }

    try {
      const { data, error } = await sb.rpc('public_track_order', {
        p_order_number:    orderNumber  || null,
        p_customer_phone:  null,
        p_tracking_token:  trackingToken || null,
      });

      if (error) throw error;

      const order = Array.isArray(data) ? data[0] : data;

      if (!order) {
        setModalContent(`
          <button class="vd-track-close" onclick="document.getElementById('vdTrackOverlay').classList.remove('show')" aria-label="Close">✕</button>
          <div class="vd-track-error">❌ <strong>Order not found.</strong> Please check your details or <a href="contact.html">contact us</a>.</div>
        `);
        return;
      }

      const fullTrackUrl = trackPageUrl(orderNumber, trackingToken);

      setModalContent(`
        <button class="vd-track-close" onclick="document.getElementById('vdTrackOverlay').classList.remove('show')" aria-label="Close">✕</button>
        ${buildCardHTML(order)}
        <div class="vd-track-footer">
          <p class="vd-track-footer-msg">Last updated: ${order.updated_at ? new Date(order.updated_at).toLocaleString('en-TT') : '—'}</p>
          <div style="display:flex; gap:0.6rem; flex-wrap:wrap;">
            <button class="vd-track-footer-btn ghost" onclick="document.getElementById('vdTrackOverlay').classList.remove('show')">Close</button>
            <a class="vd-track-footer-btn" href="${escHtml(fullTrackUrl)}" target="_blank">Open Full Page ↗</a>
          </div>
        </div>
      `);

    } catch (err) {
      console.error('[vd-track-modal] Lookup error:', err);
      setModalContent(`
        <button class="vd-track-close" onclick="document.getElementById('vdTrackOverlay').classList.remove('show')" aria-label="Close">✕</button>
        <div class="vd-track-error">❌ <strong>Something went wrong.</strong> ${escHtml(err.message || 'Please try again.')} <a href="contact.html">Contact us</a> if the problem persists.</div>
      `);
    }
  };

}());
