(function () {
  function ensureModal() {
    let overlay = document.getElementById('vdNotifyOverlay');
    if (overlay) return overlay;

    const style = document.createElement('style');
    style.textContent = `
      .vd-notify-overlay {
        position: fixed;
        inset: 0;
        z-index: 9999;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 1.25rem;
        background: rgba(13, 43, 40, 0.62);
      }
      .vd-notify-overlay.show { display: flex; }
      .vd-notify-card {
        width: min(440px, 100%);
        background: #ffffff;
        border-radius: 14px;
        box-shadow: 0 18px 45px rgba(13, 43, 40, 0.22);
        padding: 2rem;
        border-top: 4px solid #1F8F52;
        font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .vd-notify-card.error { border-top-color: #e05555; }
      .vd-notify-card.warning { border-top-color: #e07a3a; }
      .vd-notify-card.success { border-top-color: #1F8F52; }
      .vd-notify-title {
        margin: 0 0 0.75rem;
        color: #122C2A;
        font-size: 1.35rem;
        line-height: 1.25;
        font-weight: 800;
      }
      .vd-notify-message {
        margin: 0 0 1.5rem;
        color: #4a4a4a;
        font-size: 0.96rem;
        line-height: 1.65;
      }
      .vd-notify-actions {
        display: flex;
        justify-content: flex-end;
        gap: 0.75rem;
      }
      .vd-notify-btn {
        border: 0;
        border-radius: 10px;
        background: #1F8F52;
        color: #ffffff;
        padding: 0.8rem 1.35rem;
        font: inherit;
        font-weight: 750;
        cursor: pointer;
        min-width: 92px;
      }
      .vd-notify-btn:hover { background: #176B42; }
      @media (max-width: 520px) {
        .vd-notify-card { padding: 1.5rem; border-radius: 12px; }
        .vd-notify-actions { display: block; }
        .vd-notify-btn { width: 100%; }
      }
    `;
    document.head.appendChild(style);

    overlay = document.createElement('div');
    overlay.id = 'vdNotifyOverlay';
    overlay.className = 'vd-notify-overlay';
    overlay.innerHTML = `
      <div class="vd-notify-card" role="dialog" aria-modal="true" aria-labelledby="vdNotifyTitle">
        <h2 class="vd-notify-title" id="vdNotifyTitle">Notice</h2>
        <p class="vd-notify-message" id="vdNotifyMessage"></p>
        <div class="vd-notify-actions">
          <button class="vd-notify-btn" type="button" id="vdNotifyOk">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', event => {
      if (event.target === overlay) window.vdNotifyClose();
    });
    document.getElementById('vdNotifyOk').addEventListener('click', () => window.vdNotifyClose());
    return overlay;
  }

  window.vdNotifyClose = function () {
    const overlay = document.getElementById('vdNotifyOverlay');
    if (!overlay) return;
    overlay.classList.remove('show');
    const callback = overlay._vdCallback;
    overlay._vdCallback = null;
    if (typeof callback === 'function') callback();
  };

  window.vdNotify = function (title, message, type, onClose) {
    const overlay = ensureModal();
    const card = overlay.querySelector('.vd-notify-card');
    card.className = `vd-notify-card ${type || ''}`.trim();
    document.getElementById('vdNotifyTitle').textContent = title || 'Notice';
    document.getElementById('vdNotifyMessage').textContent = message || '';
    overlay._vdCallback = onClose || null;
    overlay.classList.add('show');
    document.getElementById('vdNotifyOk').focus();
  };
}());
