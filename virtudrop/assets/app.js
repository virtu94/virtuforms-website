
(function () {
  const toggle = document.querySelector('[data-mobile-toggle]');
  const links = document.querySelector('[data-nav-links]');
  if (toggle && links) {
    toggle.addEventListener('click', () => links.classList.toggle('open'));
  }

  // Tabs for login/register (if present)
  const tabButtons = document.querySelectorAll('[data-tab]');
  const panels = document.querySelectorAll('[data-panel]');
  function activate(name) {
    tabButtons.forEach(b => b.setAttribute('aria-selected', b.dataset.tab === name ? 'true' : 'false'));
    panels.forEach(p => p.hidden = p.dataset.panel !== name);
  }
  tabButtons.forEach(b => b.addEventListener('click', () => activate(b.dataset.tab)));

  // Basic form UX: prevent submit and show message (front-end only)
  document.querySelectorAll('form[data-mock-submit]').forEach(form => {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const out = form.querySelector('[data-form-status]');
      if (out) {
        out.textContent = 'Submitted (demo only). Connect this form to your backend/API when ready.';
        out.hidden = false;
      } else {
        alert('Submitted (demo only).');
      }
    });
  });

  // Default tab on auth page
  const defaultTab = document.body.dataset.defaultTab;
  if (defaultTab && tabButtons.length) activate(defaultTab);
})();
