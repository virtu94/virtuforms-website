// VirtuFinds TT — bank transfer panel for the checkout success screen.
// Shows the bank details, the exact amount and reference, and lets the
// customer upload a screenshot of their payment (or send it on WhatsApp).

const BANK_DETAILS = [
  ['Bank', 'Scotiabank'],
  ['Account name', 'VirtuForms Ltd'],
  ['Account type', 'Business Checking'],
  ['Branch', 'Chaguanas'],
  ['Transit code', '60525'],
  ['Account number', '2424468']
];

const PROOF_BUCKET = 'vf-payment-proofs';
const MAX_PROOF_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}

export function removeBankTransferPanel(root) {
  var existing = root.querySelector('.vf-bank-panel');
  if (existing) existing.remove();
}

export function showBankTransferPanel(opts) {
  var sb = opts.sb;
  var root = opts.root;
  var orderNumber = opts.orderNumber;
  var phone = opts.phone;
  var amountDue = opts.amountDue;
  var whatsappNumber = opts.whatsappNumber;

  removeBankTransferPanel(root);

  var amountText = typeof amountDue === 'number' ? '$' + amountDue.toFixed(2) : 'To be confirmed with you on WhatsApp';
  var waText = 'Hi VirtuFinds! Here is my proof of payment for order ' + orderNumber +
    (typeof amountDue === 'number' ? ' (' + amountText + ')' : '') + '.';

  var rows = BANK_DETAILS.map(function (r) {
    return '<div style="display:flex;justify-content:space-between;gap:12px;padding:4px 0;"><span style="color:var(--grey-500,#6b7280);">' +
      escapeHtml(r[0]) + '</span><strong>' + escapeHtml(r[1]) + '</strong></div>';
  }).join('');

  var panel = document.createElement('div');
  panel.className = 'vf-bank-panel';
  panel.style.cssText = 'text-align:left;border:1px solid var(--grey-200,#e5e7eb);border-radius:12px;padding:14px 16px;margin:0 0 16px;font-size:0.9rem;';
  panel.innerHTML =
    '<h4 style="margin:0 0 8px;font-size:1rem;">Pay by bank transfer</h4>' +
    rows +
    '<div style="display:flex;justify-content:space-between;gap:12px;padding:4px 0;"><span style="color:var(--grey-500,#6b7280);">Amount to transfer</span><strong>' + escapeHtml(amountText) + '</strong></div>' +
    '<div style="display:flex;justify-content:space-between;gap:12px;padding:4px 0;"><span style="color:var(--grey-500,#6b7280);">Reference</span><strong>' + escapeHtml(orderNumber) + '</strong></div>' +
    '<p style="margin:10px 0 12px;font-size:0.85rem;color:var(--grey-500,#6b7280);">Use your order number as the payment reference, then send us proof of payment so we can confirm your order.</p>' +
    '<label class="btn btn--outline btn--block" style="display:block;text-align:center;cursor:pointer;margin-bottom:8px;">Upload payment screenshot' +
    '<input type="file" class="vf-proof-input" accept="image/*,application/pdf" style="display:none;"></label>' +
    '<div class="vf-proof-status" role="status" aria-live="polite" style="min-height:1.2em;font-size:0.85rem;margin-bottom:8px;"></div>' +
    '<a class="btn btn--whatsapp" target="_blank" rel="noopener" href="https://wa.me/' + encodeURIComponent(whatsappNumber) + '?text=' + encodeURIComponent(waText) +
    '" style="display:block;text-align:center;padding:10px 16px;border-radius:8px;font-size:0.9rem;font-weight:600;text-decoration:none;">Or send it on WhatsApp</a>';

  var anchor = root.querySelector('#modalTrackingId');
  if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(panel, anchor);
  else root.appendChild(panel);

  var input = panel.querySelector('.vf-proof-input');
  var status = panel.querySelector('.vf-proof-status');

  input.addEventListener('change', async function () {
    var file = input.files && input.files[0];
    if (!file) return;
    status.style.color = '';

    if (ALLOWED_TYPES.indexOf(file.type) === -1) {
      status.style.color = '#c0392b';
      status.textContent = 'Please choose an image (JPG, PNG, WebP) or a PDF.';
      input.value = '';
      return;
    }
    if (file.size > MAX_PROOF_BYTES) {
      status.style.color = '#c0392b';
      status.textContent = 'That file is too large. Please keep it under 5MB.';
      input.value = '';
      return;
    }

    status.textContent = 'Uploading...';
    input.disabled = true;
    try {
      var ext = (file.name.split('.').pop() || 'jpg').replace(/[^A-Za-z0-9]/g, '').toLowerCase().slice(0, 5) || 'jpg';
      var rand = Math.random().toString(36).slice(2, 10);
      var path = orderNumber + '/' + Date.now() + '-' + rand + '.' + ext;

      var up = await sb.storage.from(PROOF_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
      if (up.error) throw up.error;

      var attach = await sb.rpc('vf_attach_payment_proof', {
        p_order_number: orderNumber,
        p_phone: phone,
        p_path: path
      });
      if (attach.error) throw attach.error;

      status.style.color = '#1e7e34';
      status.textContent = 'Thank you! We received your proof of payment and will confirm your order shortly.';
    } catch (err) {
      console.error('Proof upload failed:', err);
      status.style.color = '#c0392b';
      status.textContent = 'Upload failed. Please try again or send the screenshot on WhatsApp.';
      input.disabled = false;
      input.value = '';
    }
  });
}
