// VirtuFinds TT — store settings shared by every storefront page.
// Values are edited in the admin Settings tab (table: vf_settings) and read here.

const DEFAULTS = {
  store_name: 'VirtuFinds TT',
  store_phone: '+1-868-797-3543',
  store_whatsapp: '+1-868-797-3543',
  store_email: 'virtufindstt@gmail.com',
  store_address: null,
  accept_orders: true,
  cod_enabled: true
};

let cached = null;

export function phoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

// "+1-868-797-3543" -> "(868) 797-3543"
export function prettyPhone(value) {
  const d = phoneDigits(value);
  const local = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
  return local.length === 10 ? '(' + local.slice(0, 3) + ') ' + local.slice(3, 6) + '-' + local.slice(6) : String(value || '');
}

export function whatsappLink(settings, text) {
  const base = 'https://wa.me/' + phoneDigits(settings.store_whatsapp);
  return text ? base + '?text=' + encodeURIComponent(text) : base;
}

export async function loadVfSettings(sb, opts) {
  if (cached && !(opts && opts.fresh)) return cached;
  cached = (async function () {
    try {
      const res = await sb.from('vf_settings').select('*').eq('id', 1).maybeSingle();
      if (res.error || !res.data) return Object.assign({}, DEFAULTS);
      const merged = Object.assign({}, DEFAULTS);
      Object.keys(res.data).forEach(function (k) {
        if (res.data[k] !== null && res.data[k] !== undefined && res.data[k] !== '') merged[k] = res.data[k];
      });
      return merged;
    } catch (e) {
      console.warn('[vf-settings] could not load settings, using defaults:', e);
      return Object.assign({}, DEFAULTS);
    }
  })();
  return cached;
}

// Wire up the page: header/hero "WhatsApp Us" buttons and the contact page cards.
async function applyToPage() {
  if (typeof sb === 'undefined') return;
  const s = await loadVfSettings(sb);
  const wa = whatsappLink(s, 'Hi VirtuFinds! I have a question.');

  document.querySelectorAll('a[href="#whatsapp"]').forEach(function (a) {
    if (a.closest('.contact-method')) return;
    a.href = wa;
    a.target = '_blank';
    a.rel = 'noopener';
  });

  const card = function (heading) {
    return Array.from(document.querySelectorAll('.contact-method')).find(function (el) {
      const h = el.querySelector('h3');
      return h && h.textContent.trim() === heading;
    });
  };
  const fill = function (el, href, text, note) {
    if (!el) return;
    const link = el.querySelector('.contact-method__value');
    const noteEl = el.querySelector('.contact-method__note');
    if (link) { link.href = href; link.textContent = text; if (href.indexOf('http') === 0) { link.target = '_blank'; link.rel = 'noopener'; } }
    if (noteEl && note) noteEl.textContent = note;
  };
  fill(card('WhatsApp Support'), wa, prettyPhone(s.store_whatsapp), 'Chat with us on WhatsApp');
  fill(card('Call Us'), 'tel:+' + phoneDigits(s.store_phone), prettyPhone(s.store_phone), 'Call us directly');
  fill(card('Email Us'), 'mailto:' + s.store_email, s.store_email, 'We reply as soon as we can');
}

applyToPage().catch(function (e) { console.warn('[vf-settings]', e); });
