import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { calculateOrderMoney, financialRequestFields, moneyLabel, validateManualAddress, validatePickupLocation } from './vd-order-money.js?v=20260624-split-cod-1';

const SUPABASE_URL = 'https://vgmzzavxhuarlacnvnoz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZnbXp6YXZ4aHVhcmxhY252bm96Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2Mjk4NTksImV4cCI6MjA5NDIwNTg1OX0.7-YKlwLrhUYUYbiii93ZvgX01TxVephApDNCP50Rl54';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
window.supabase = supabase;

// ── Config ────────────────────────────────────────────────────────
const REMOTE_ZONE_CODE = 'REMOTE';
const COVERED_ZONE_CODES = new Set(['A', 'B', 'C', 'D']);
const STANDARD_FEES = { standard: 40, extended: 50 };
const EXTENDED_AREA_NAMES = new Set([
  'wallerfield', 'cumuto', 'guanapo', 'heights of guanapo', 'lopinot', 'surrey village',
  'arena', 'gran couva', 'todds road', 'todds road station', 'las lomas', 'esmeralda',
  'madras', 'st helena', 'st helena eastern sections', 'orange grove',
  'point fortin', 'oropouche', 'san francique', 'la brea', 'aripero', 'rousillac',
  'carenage', 'chaguaramas', 'chaguaramus', 'paramin'
]);

let bizEstimateTimer = null;
let latestBizEstimate = null;
let zonesPromise = null;

function withTimeout(promise, ms, fallback) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise(resolve => {
      timer = setTimeout(() => resolve(fallback), ms);
    })
  ]);
}

function normaliseZoneText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\bsaint\b/g, 'st')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function zoneAreaVariants(area) {
  const raw = String(area || '');
  const withoutParen = raw.replace(/\([^)]*\)/g, ' ');
  const withoutQualifier = withoutParen.replace(/\b(proper|north side|south side)\b/gi, ' ');
  return [...new Set([
    raw,
    withoutParen,
    withoutQualifier,
    ...raw.split('/'),
    ...withoutParen.split('/'),
    ...withoutQualifier.split('/')
  ].map(normaliseZoneText).filter(value => value.length >= 3))];
}

function areaMatches(input, area) {
  const text = normaliseZoneText(input);
  if (!text) return false;
  return zoneAreaVariants(area).some(target => {
    if (!target) return false;
    if (text.includes(target)) return true;
    const targetTokens = target.split(' ').filter(token => token.length > 2);
    return targetTokens.length > 1 && targetTokens.every(token => text.includes(token));
  });
}

async function loadEstimateZones() {
  if (!zonesPromise) {
    zonesPromise = (async () => {
      let result = await supabase
        .from('zones')
        .select('id, code, name, region, active, zone_areas(area_name, rate_band)')
        .eq('active', true)
        .order('code');
      if (result.error) {
        result = await supabase
          .from('zones')
          .select('id, code, name, region, active, zone_areas(area_name)')
          .eq('active', true)
          .order('code');
      }
      if (result.error) throw result.error;
      return result.data || [];
    })();
  }
  return zonesPromise;
}

function extractLatLngFromMapsUrl(url) {
  try {
    const decoded = decodeURIComponent(String(url || ''));
    const patterns = [
      /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
      /[?&](?:q|query|ll)=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
      /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,
      /(-?\d+\.\d+),\s*(-?\d+\.\d+)/
    ];
    for (const pattern of patterns) {
      const match = decoded.match(pattern);
      if (match) return { lat: Number(match[1]), lng: Number(match[2]) };
    }
  } catch {}
  return null;
}

function extractTextFromMapsUrl(url) {
  try {
    const parsed = new URL(String(url || ''), window.location.origin);
    const query = parsed.searchParams.get('q') || parsed.searchParams.get('query');
    if (query && !/^-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?$/.test(query)) {
      return query.replace(/\+/g, ' ');
    }
    const placeMatch = parsed.pathname.match(/\/(?:place|search)\/([^/@]+)/i);
    if (placeMatch) return decodeURIComponent(placeMatch[1]).replace(/\+/g, ' ');
  } catch {}
  return '';
}

function collectOsmText(data) {
  if (!data) return '';
  const address = data.address || {};
  return [
    data.display_name,
    data.name,
    address.road,
    address.neighbourhood,
    address.suburb,
    address.village,
    address.town,
    address.city,
    address.county,
    address.state,
    address.postcode,
    address.country
  ].filter(Boolean).join(' ');
}

async function reverseGeocodeWithOpenStreetMap(lat, lng) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&addressdetails=1`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return '';
    return collectOsmText(await res.json());
  } catch {
    return '';
  } finally {
    clearTimeout(timeout);
  }
}

async function geocodeAddressWithOpenStreetMap(address) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1&countrycodes=tt&q=${encodeURIComponent(address)}`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return '';
    const data = await res.json();
    return collectOsmText(Array.isArray(data) ? data[0] : data);
  } catch {
    return '';
  } finally {
    clearTimeout(timeout);
  }
}

async function reverseGeocode(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '';
  return reverseGeocodeWithOpenStreetMap(lat, lng);
}

async function geocodeAddress(address) {
  if (!address) return '';
  const osmText = await geocodeAddressWithOpenStreetMap(address);
  return [address, osmText].filter(Boolean).join(' ');
}

function matchZoneFromText(zones, text) {
  for (const zone of zones) {
    const areas = zone.zone_areas || [];
    const matchedArea = areas.find(area => areaMatches(text, area.area_name));
    if (matchedArea) return { zone, matchedArea };
  }
  return null;
}

function classifyZoneMatch(match) {
  if (!match?.zone) {
    return {
      status: 'remote',
      fee: null,
      zoneCode: REMOTE_ZONE_CODE,
      zoneName: 'Remote / Special Route',
      region: 'Manual Review',
      matchedArea: '',
      message: 'Outside listed zones - quote required'
    };
  }

  const code = String(match.zone.code || '').toUpperCase();
  const matchedAreaName = match.matchedArea?.area_name || '';
  const rateBand = match.matchedArea?.rate_band || (EXTENDED_AREA_NAMES.has(normaliseZoneText(matchedAreaName)) ? 'extended' : 'standard');
  if (code === REMOTE_ZONE_CODE || rateBand === 'remote' || !COVERED_ZONE_CODES.has(code)) {
    return {
      status: 'remote',
      fee: null,
      zoneCode: code,
      zoneName: match.zone.name || 'Remote / Special Route',
      region: match.zone.region || 'Manual Review',
      matchedArea: matchedAreaName,
      message: 'Remote / special route - quote required'
    };
  }

  return {
    status: rateBand === 'extended' ? 'extended' : 'standard',
    fee: STANDARD_FEES[rateBand] || STANDARD_FEES.standard,
    zoneCode: code,
    zoneName: match.zone.name || `Zone ${code}`,
    region: match.zone.region || 'Listed Zone',
    matchedArea: matchedAreaName,
    rateBand,
    message: rateBand === 'extended' ? 'Extended delivery area' : (match.zone.region || 'Standard delivery area')
  };
}

async function estimateDeliveryZone({
  houseNumber = '',
  streetName = '',
  areaName = '',
  mapsLink = '',
  latitude = null,
  longitude = null
}) {
  const debug = {
    hasCoordinates: Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude)),
    hasMapsLink: Boolean(mapsLink),
    source: '',
    addressFound: false,
    zonesLoaded: false
  };
  const manualText = [houseNumber, streetName, areaName].filter(Boolean).join(' ');
  if (streetName || areaName) {
    const addressError = validateManualAddress(streetName, areaName);
    if (addressError) {
      return {
        status: 'unknown',
        fee: null,
        zoneCode: '',
        zoneName: '',
        region: '',
        matchedArea: '',
        sourceText: manualText,
        label: 'Valid street required',
        debug: { ...debug, source: 'manual', addressFound: false },
        message: addressError
      };
    }
  }
  let sourceText = manualText;
  let sourceLabel = areaName || streetName || '';
  if (sourceText) debug.source = 'manual';

  if (!sourceText && Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude))) {
    debug.source = 'gps';
    sourceText = await withTimeout(reverseGeocode(Number(latitude), Number(longitude)), 10000, '');
    sourceLabel = sourceText;
  }

  if (!sourceText && mapsLink) {
    debug.source = 'maps-link';
    const coords = extractLatLngFromMapsUrl(mapsLink);
    if (coords) {
      debug.hasCoordinates = true;
      sourceText = await withTimeout(reverseGeocode(coords.lat, coords.lng), 10000, '');
      sourceLabel = sourceText;
    } else {
      sourceText = extractTextFromMapsUrl(mapsLink);
      sourceLabel = sourceText;
      if (sourceText) {
        sourceText = [sourceText, await withTimeout(geocodeAddress(sourceText), 10000, '')].filter(Boolean).join(' ');
      }
    }
  }
  debug.addressFound = Boolean(sourceText);

  if (!sourceText) {
    const shortMapsLink = /(^|\.)maps\.app\.goo\.gl$|(^|\.)goo\.gl$/i.test(new URL(mapsLink || window.location.href, window.location.origin).hostname || '');
    return {
      status: 'unknown',
      fee: null,
      zoneCode: '',
      zoneName: '',
      region: '',
      matchedArea: '',
      sourceText: '',
      label: 'Location could not be identified',
      debug,
      message: shortMapsLink
        ? 'Short Google Maps links cannot be read here. Use current location or paste a full Google Maps link.'
        : 'Enter an area or use GPS to estimate'
    };
  }

  const zones = await withTimeout(loadEstimateZones(), 7000, null);
  if (!zones) {
    return {
      status: 'unknown',
      fee: null,
      zoneCode: '',
      zoneName: '',
      region: '',
      matchedArea: '',
      sourceText,
      label: sourceLabel || sourceText,
      debug,
      message: 'Address found, but zone data could not be loaded. Try again.'
    };
  }
  debug.zonesLoaded = true;

  const match = matchZoneFromText(zones, sourceText);
  return {
    ...classifyZoneMatch(match),
    sourceText,
    debug,
    label: match?.matchedArea?.area_name || sourceLabel || sourceText
  };
}

function formatEstimateRows({ estimate, paymentType, packageValue }) {
  const rows = [];
  const settlement = el('#clientFeeSettlement')?.value || null;
  const pickupRequired = Boolean(el('#pickupRequired')?.checked);
  const pickupParcelCount = Number(el('#pickupParcelCount')?.value || 1);
  const pickupFeeSettlement = el('#pickupFeeSettlement')?.value || null;
  const money = calculateOrderMoney({
    paymentOption: paymentType,
    packageValue,
    deliveryFee: estimate.fee,
    clientFeeSettlement: settlement,
    pickupRequired,
    pickupParcelCount,
    pickupFeeSettlement
  });

  if (estimate.status === 'unknown') {
    rows.push(['Delivery Fee', 'Unable to estimate']);
  } else {
    rows.push(['Delivery Fee', estimate.fee !== null ? `$${Number(estimate.fee).toFixed(2)}` : 'Quote required']);
  }
  rows.push(['Zone', estimate.zoneCode ? `${estimate.zoneName} - ${estimate.region}` : estimate.message]);
  if (estimate.status === 'unknown' && estimate.debug) {
    rows.push(['Location Source', estimate.debug.source || 'none']);
    rows.push(['Coordinates', estimate.debug.hasCoordinates ? 'Captured' : 'Not available']);
    rows.push(['Address Lookup', estimate.debug.addressFound ? 'Found address text' : 'No address returned']);
    rows.push(['Zone Data', estimate.debug.zonesLoaded ? 'Loaded' : 'Not loaded']);
  }

  if ((paymentType === 'cod' || paymentType === 'cod-client-delivery') && money.packageValue > 0) {
    rows.push(['Package Value', moneyLabel(money.packageValue)]);
    rows.push(['Customer Pays', moneyLabel(money.customerAmountDue)]);
    rows.push(['Driver Collects', moneyLabel(money.driverAmountToCollect)]);
    if (paymentType === 'cod-client-delivery') {
      rows.push(['Business Owes VirtuDrop', moneyLabel(estimate.fee)]);
      rows.push(['Settlement', settlement === 'deduct_from_remittance' ? 'Deduct from remittance' : 'Pay separately']);
    }
  } else if (paymentType === 'pkg-online') {
    rows.push(['Customer Pays', moneyLabel(money.customerAmountDue)]);
    rows.push(['Driver Collects', moneyLabel(money.driverAmountToCollect)]);
  } else if (paymentType === 'all-online') {
    rows.push(['Customer Pays Driver', '$0.00']);
    rows.push(['Business Owes VirtuDrop', moneyLabel(estimate.fee)]);
    rows.push(['Settlement', settlement === 'deduct_from_remittance' ? 'Deduct from remittance' : 'Pay separately']);
  }
  if (pickupRequired) {
    rows.push(['Pickup', money.pickupFee > 0 ? moneyLabel(money.pickupFee) : 'Free (5 or more packages)']);
    if (money.pickupFee > 0) rows.push(['Pickup Settlement', pickupFeeSettlement === 'deduct_from_remittance' ? 'Deduct from remittance' : 'Pay separately']);
  }

  return rows;
}

function currentEstimateInput() {
  const gpsResult = el('#gpsResult');
  const hasGps = gpsResult?.dataset.lat && gpsResult?.dataset.lng;
  const useSharedLocation = activeLocTab !== 'manual';
  return {
    supabase,
    houseNumber: useSharedLocation ? '' : (el('#houseNum')?.value.trim() || ''),
    streetName: useSharedLocation ? '' : (el('#streetName')?.value.trim() || ''),
    areaName: useSharedLocation ? '' : (el('#areaName')?.value.trim() || ''),
    mapsLink: useSharedLocation && !hasGps ? (el('#mapsLink')?.value.trim() || '') : '',
    latitude: useSharedLocation && hasGps ? Number(gpsResult.dataset.lat) : null,
    longitude: useSharedLocation && hasGps ? Number(gpsResult.dataset.lng) : null
  };
}

function hasEstimateLocation(input) {
  return Boolean(input.areaName || input.streetName || input.mapsLink ||
    (Number.isFinite(input.latitude) && Number.isFinite(input.longitude)));
}

function renderEstimateBreakdown(target, rows) {
  if (!target) return;
  target.innerHTML = rows.map(([key, value]) => `
    <div style="display:flex; justify-content:space-between; font-size:0.82rem; padding:0.25rem 0; border-bottom:1px solid rgba(255,255,255,0.06); gap:1rem;">
      <span style="color:rgba(255,255,255,0.5);">${escapeHtml(key)}</span>
      <span style="color:#ffffff; font-weight:600; text-align:right;">${escapeHtml(value)}</span>
    </div>`).join('');
}

async function updateBizEstimate() {
  const block = el('#bizEstimateBlock');
  if (!block) return;
  const paymentType = el('#paymentType')?.value || '';
  if (!paymentType) { block.style.display = 'none'; return; }

  const estimateInput = currentEstimateInput();
  if (!hasEstimateLocation(estimateInput)) { block.style.display = 'none'; return; }

  block.style.display = '';
  setText('#bizEstimateAmount', 'Calculating...');
  setText('#bizEstimateRoute', 'Detecting zone...');
  const breakdownElPre = el('#bizEstimateBreakdown');
  if (breakdownElPre) breakdownElPre.innerHTML = '';

  clearTimeout(bizEstimateTimer);
  bizEstimateTimer = setTimeout(async () => {
    const amountEl = el('#bizEstimateAmount');
    const breakdownEl = el('#bizEstimateBreakdown');
    const routeEl = el('#bizEstimateRoute');
    try {
      const estimate = await withTimeout(estimateDeliveryZone(estimateInput), 16000, {
        status: 'unknown',
        fee: null,
        zoneCode: '',
        zoneName: '',
        region: '',
        matchedArea: '',
        sourceText: '',
        label: 'Location could not be identified',
        message: 'Location lookup timed out. Try again or enter the address manually.',
        debug: { source: 'timeout', hasCoordinates: false, addressFound: false, zonesLoaded: false }
      });
      latestBizEstimate = estimate;

      if (amountEl) {
        amountEl.textContent = estimate.fee !== null
          ? `$${Number(estimate.fee).toFixed(2)} TTD`
          : estimate.status === 'unknown' ? 'Location Needed' : 'Quote Required';
      }

      if (routeEl) {
        routeEl.textContent = estimate.zoneCode
          ? `${estimate.label} → ${estimate.zoneName} (${estimate.region})`
          : estimate.message;
      }

      const pkgVal = paymentType === 'cod' || paymentType === 'cod-client-delivery' ? (Number(el('#codAmount')?.value) || 0) : 0;
      renderEstimateBreakdown(breakdownEl, formatEstimateRows({ estimate, paymentType, packageValue: pkgVal }));

    } catch (err) {
      console.error('[VD Estimate] Error:', err);
      latestBizEstimate = null;
      if (amountEl) amountEl.textContent = 'Quote Required';
      if (routeEl) routeEl.textContent = 'Zone to be confirmed by VirtuDrop';
    }
  }, 600);
}
window.updateBizEstimate = updateBizEstimate;

// ── Payment field sync ────────────────────────────────────────────
window.vdSyncBusinessAmountField = function() {
  const paymentType = el('#paymentType')?.value || '';
  const block = el('#codAmountBlock');
  const label = el('#codAmountLabel');
  const settlementBlock = el('#clientFeeSettlementBlock');
  const settlement = el('#clientFeeSettlement');
  if (!block) return;
  if (paymentType === 'cod' || paymentType === 'cod-client-delivery') {
    block.style.display = '';
    if (label) label.textContent = 'Package Value (TTD)';
    el('#codAmount').placeholder = 'e.g. 350.00';
  } else if (paymentType === 'pkg-online') {
    block.style.display = 'none';
  } else if (paymentType === 'all-online') {
    block.style.display = 'none';
  } else {
    block.style.display = 'none';
  }
  if (settlementBlock) settlementBlock.style.display = paymentType === 'all-online' || paymentType === 'cod-client-delivery' ? '' : 'none';
  if (settlement) {
    settlement.required = paymentType === 'all-online' || paymentType === 'cod-client-delivery';
    if (paymentType !== 'all-online' && paymentType !== 'cod-client-delivery') settlement.value = '';
  }
  updateBizEstimate();
};


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

    function showDashboardLoadError(message = 'Your dashboard data could not be loaded. Reload the page after the database update is complete.') {
      document.body.style.margin = '0';
      document.body.style.display = 'block';
      document.body.style.minHeight = '100vh';
      document.body.style.background = '#f4f8f7';
      document.body.innerHTML = `
        <div style="min-height:100vh; display:flex; align-items:center; justify-content:center; background:#f4f8f7; padding:1.5rem; font-family:Inter, Arial, sans-serif;">
          <div style="width:min(480px,100%); background:#fff; border-radius:8px; box-shadow:0 12px 35px rgba(13,43,40,0.14); padding:2rem; text-align:center; border-top:4px solid #c94b4b;">
            <h1 style="margin:0 0 0.8rem; color:#0d2b28; font-size:1.55rem;">Dashboard unavailable</h1>
            <p style="margin:0 0 1.4rem; color:#4a4a4a; line-height:1.6;">${escapeHtml(message)}</p>
            <div style="display:flex; justify-content:center; gap:0.75rem; flex-wrap:wrap;">
              <button id="dashboardReloadBtn" type="button" style="border:0; border-radius:8px; background:#2a9d8f; color:#fff; padding:0.8rem 1.3rem; font-weight:700; cursor:pointer;">Reload</button>
              <button id="dashboardErrorLogoutBtn" type="button" style="border:1px solid #cbdad8; border-radius:8px; background:#fff; color:#0d2b28; padding:0.8rem 1.3rem; font-weight:700; cursor:pointer;">Log Out</button>
            </div>
          </div>
        </div>
      `;
      document.getElementById('dashboardReloadBtn')?.addEventListener('click', () => window.location.reload());
      document.getElementById('dashboardErrorLogoutBtn')?.addEventListener('click', async () => {
        await supabase.auth.signOut();
        window.location.href = 'auth.html';
      });
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
let remittancePeriod = 'week';
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

const paymentMap = { cod: 'cod', 'cod-client-delivery': 'cod', 'pkg-online': 'delivery_only', 'all-online': 'prepaid' };
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

function labelAddress(order) {
  return [order.house_number, order.street_name, order.area_name].filter(Boolean).join(', ')
    || order.delivery_address
    || order.maps_link
    || order.area_name
    || 'Address pending';
}

function labelCollectAmount(order) {
  if (order.financial_model_version >= 2) return Number(order.driver_amount_to_collect || 0);
  if (order.payment_type === 'prepaid') return 0;
  if (order.payment_type === 'delivery_only') return Number(order.delivery_fee || 0);
  return Number(order.cod_amount || 0) + Number(order.delivery_fee || 0);
}

window.printDeliveryLabel = function(orderId) {
  const order = orders.find(item => item.id === orderId);
  if (!order) return window.vdNotify('Label Not Printed', 'Order not found.', 'error');
  const popup = window.open('', '_blank', 'width=460,height=680');
  if (!popup) return window.vdNotify('Label Not Printed', 'Allow popups to print this label.', 'warning');
  const logoUrl = new URL('assets/logo.png', window.location.href).href;
  const collectAmount = labelCollectAmount(order);
  popup.document.write(`<!doctype html><html><head><title>Label ${escapeHtml(order.order_number)}</title><style>
    @page{size:4in 6in;margin:0.18in}
    *{box-sizing:border-box}
    body{margin:0;background:#fff;color:#000;font-family:Arial,Helvetica,sans-serif}
    .label{width:100%;min-height:5.6in;border:2px solid #000;padding:14px;display:flex;flex-direction:column;gap:10px}
    .top{display:flex;align-items:center;justify-content:space-between;border-bottom:2px solid #000;padding-bottom:8px}
    .logo{height:42px;max-width:150px;object-fit:contain;filter:grayscale(1) contrast(1.5)}
    .order{font-size:16px;font-weight:800;text-align:right}
    .section{border-bottom:1px solid #000;padding-bottom:8px}
    .k{font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}
    .v{font-size:18px;font-weight:800;margin-top:3px;line-height:1.2}
    .address{font-size:20px;line-height:1.25}
    .meta{display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px}
    .box{border:1px solid #000;padding:7px;min-height:42px}
    .note{margin-top:auto;font-size:10px;text-align:center;border-top:1px solid #000;padding-top:6px}
  </style></head><body onload="setTimeout(()=>window.print(),250)"><div class="label">
    <div class="top"><img class="logo" src="${logoUrl}" alt="VirtuDrop"><div class="order">${escapeHtml(order.order_number || '')}</div></div>
    <div class="section"><div class="k">Deliver To</div><div class="v">${escapeHtml(order.customer_name || '')}</div><div>${escapeHtml(order.customer_phone || '')}</div></div>
    <div class="section"><div class="k">Address</div><div class="address">${escapeHtml(labelAddress(order))}</div></div>
    <div class="meta">
      <div class="box"><div class="k">Client</div><strong>${escapeHtml(business?.business_name || 'Business Client')}</strong></div>
      <div class="box"><div class="k">Collect</div><strong>${escapeHtml(money(collectAmount))}</strong></div>
      <div class="box"><div class="k">Item / Ref</div>${escapeHtml(order.external_item_number || '—')}</div>
      <div class="box"><div class="k">Area</div>${escapeHtml(order.area_name || '—')}</div>
    </div>
    <div class="note">Incorrect or incomplete street information may delay VirtuDrop's 1-2 business day delivery service.</div>
  </div></body></html>`);
  popup.document.close();
};

function formatDate(value) {
  if (!value) return '—';
  const dateValue = /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? `${value}T12:00:00` : value;
  return new Date(dateValue).toLocaleDateString('en-TT', { year: 'numeric', month: 'short', day: 'numeric' });
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
  if (order.financial_model_version >= 2 && order.driver_amount_to_collect !== null) {
    return Number(order.driver_amount_to_collect || 0);
  }
  if (order.payment_type === 'prepaid') return 0;
  if (order.payment_type === 'delivery_only') return Number(order.delivery_fee || 0);
  return Number(order.cod_amount || 0);
}

function clientPayout(order) {
  if (order.financial_model_version >= 2) return Number(order.remittance_net_amount ?? order.client_remittance_amount ?? 0);
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
    rescheduled: 'Rescheduled',
    cancelled: 'Cancelled',
    rejected: 'Rejected'
  };
  return labels[status] || String(status || 'Pending').replaceAll('_', ' ');
}

function deliveryOutcomeLabel(order) {
  const labels = {
    delivered: 'Delivered',
    no_response: 'No Response',
    refused: 'Customer Refused',
    reschedule_requested: 'Reschedule Requested'
  };
  return labels[order?.delivery_outcome] || statusLabel(order?.order_status);
}

function parcelStatusLabel(status) {
  const labels = {
    legacy_untracked: 'Legacy / Not Tracked',
    awaiting_parcel: 'Awaiting Parcel',
    parcel_received: 'Parcel Received',
    sorted: 'Sorted',
    assigned: 'Assigned',
    handed_to_driver: 'Handed to Driver',
    delivered: 'Delivered',
    returned_to_hub: 'Returned to Hub',
    held_for_client_instructions: 'Held for Instructions',
    redelivery_scheduled: 'Redelivery Scheduled',
    returned_to_client: 'Returned to Client'
  };
  return labels[status] || String(status || 'Awaiting Parcel').replaceAll('_', ' ');
}

function pickupStatusLabel(status) {
  const labels = {
    requested: 'Pickup Requested',
    assigned: 'Pickup Scheduled',
    picked_up: 'Picked Up',
    arrived_at_hub: 'Arrived at VirtuDrop Hub',
    cancelled: 'Pickup Cancelled'
  };
  return labels[status] || 'Pickup Requested';
}

function statusClass(status) {
  if (status === 'delivered') return 'delivered';
  if (status === 'out_for_delivery') return 'out';
  if (status === 'failed' || status === 'rescheduled') return 'failed';
  if (status === 'rejected' || status === 'cancelled') return 'failed';
  return 'picked-up';
}

function routeText(order) {
  return order.area_name || order.delivery_address || order.maps_link || 'Zone pending';
}

function customerDisplayName(order) {
  return order.customer_name || 'Customer name pending';
}

function orderLocationSummary(order) {
  return order.area_name || order.delivery_address || (order.maps_link ? 'Google Maps pin provided' : 'Location pending');
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
  const valueClass = label === 'Customer' ? 'order-detail-value business-customer-name' : 'order-detail-value';
  return `
    <div class="order-detail-item${full ? ' full' : ''}">
      <div class="order-detail-label">${escapeHtml(label)}</div>
      <div class="${valueClass}">${value || '—'}</div>
    </div>
  `;
}

function businessTrackingBubble(order) {
  const trackedStatuses = ['assigned', 'out_for_delivery', 'delivered', 'failed', 'rescheduled'];
  let step = 0;
  let label = 'Request Received';
  let message = 'The order is being prepared for delivery.';
  if (order.order_status === 'cancelled') {
    step = 0;
    label = 'Cancelled';
    message = order.rejection_reason ? `This order was cancelled: ${order.rejection_reason}` : 'This order was cancelled.';
  } else if (!trackedStatuses.includes(order.order_status) && order.parcel_status === 'awaiting_parcel') {
    label = 'Awaiting Parcel';
    message = 'VirtuDrop has not checked in the parcel yet.';
  } else if (!trackedStatuses.includes(order.order_status) && order.parcel_status === 'parcel_received') {
    label = 'Package Received';
    message = 'The parcel has been received and checked in.';
  } else if (order.redelivery_status === 'scheduled') {
    step = 1; label = 'Redelivery Scheduled'; message = 'VirtuDrop has scheduled another delivery attempt.';
  } else if (order.parcel_status === 'returned_to_hub') {
    step = 1; label = 'Returned to Hub'; message = 'The undelivered parcel is back at VirtuDrop and awaiting instructions.';
  } else if (order.parcel_status === 'held_for_client_instructions') {
    step = 1; label = order.return_to_client_status === 'ready' ? 'Return to Client Ready' : 'Held for Instructions';
    message = order.return_to_client_status === 'ready' ? 'The parcel is ready to be returned to the business client.' : 'VirtuDrop is holding the parcel while the next action is confirmed.';
  } else if (order.parcel_status === 'returned_to_client') {
    step = 3; label = 'Returned to Client'; message = 'The parcel was returned to the business client.';
  } else if (order.order_status === 'assigned') {
    step = 1; label = 'Driver Assigned'; message = 'A driver has been assigned to this delivery.';
  } else if (order.order_status === 'out_for_delivery') {
    step = 2; label = 'Out for Delivery'; message = 'The parcel is out for delivery.';
  } else if (order.order_status === 'delivered') {
    step = 3; label = 'Delivered'; message = 'The parcel was delivered successfully.';
  } else if (order.order_status === 'failed') {
    step = 3;
    label = deliveryOutcomeLabel(order);
    message = order.delivery_outcome === 'no_response'
      ? 'The driver could not reach the customer at the delivery location.'
      : order.delivery_outcome === 'refused'
        ? 'The customer refused to accept the parcel.'
        : 'The delivery attempt was unsuccessful.';
  } else if (order.order_status === 'rescheduled') {
    step = 3; label = deliveryOutcomeLabel(order); message = 'Admin is arranging the next delivery attempt.';
  }
  const labels = ['Received', 'Driver Assigned', 'Out for Delivery', 'Delivered'];
  const delivered = order.order_status === 'delivered';
  const steps = labels.map((stepLabel, index) => {
    const done = index < step || (delivered && index === 3);
    const current = index === step && !delivered;
    return `<div class="business-track-step"><div class="business-track-dot ${done ? 'done' : current ? 'current' : ''}">${done ? '✓' : index + 1}</div><div class="business-track-label ${done ? 'done' : current ? 'current' : ''}">${stepLabel}</div></div>`;
  }).join('');
  const width = Math.max(0, Math.min(step, 3)) / 3 * 75;
  return `
    <div class="business-track-bubble">
      <div class="business-track-top">
        <div><div class="business-track-title">Order Tracking</div><div class="business-track-message">${escapeHtml(message)}</div></div>
        <span class="status-badge ${statusClass(order.order_status)}">${escapeHtml(label)}</span>
      </div>
      ${order.scheduled_delivery_date ? `<div class="business-track-message"><strong>Scheduled delivery:</strong> ${escapeHtml(formatDate(order.scheduled_delivery_date))}</div>` : ''}
      <div class="business-track-steps"><div class="business-track-fill" style="width:${width}%"></div>${steps}</div>
    </div>`;
}

function deliveryLink() {
  const base = window.location.origin + window.location.pathname.replace(/dashboard\.html$/, 'delivery-form.html');
  return `${base}?business=${encodeURIComponent(business?.slug || '')}`;
}

function firstName() {
  return profile?.first_name || business?.business_name?.split(/\s+/)[0] || currentUser?.email?.split('@')[0] || 'there';
}

function renderSidebarAccount() {
  const businessName = business?.business_name || 'Business Account';
  const nameEl = el('.user-name');
  const planEl = el('.user-plan');
  const avatarEl = el('.user-avatar');

  if (nameEl) nameEl.textContent = businessName;
  if (planEl) planEl.textContent = 'Business Account';
  if (avatarEl) {
    avatarEl.textContent = businessName
      .split(/\s+/)
      .map(part => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || 'VD';
  }
}

function setText(selector, value) {
  const target = el(selector);
  if (target) target.textContent = value;
}

function emptyRow(cols, message) {
  return `<tr><td colspan="${cols}" style="padding:1.2rem; color:#6a6a6a; text-align:center;">${escapeHtml(message)}</td></tr>`;
}

function orderTableRow(order, includeCost = false) {
  const editButton = canBusinessEditOrder(order)
    ? `<button type="button" class="order-detail-link" onclick="event.stopPropagation(); openBusinessOrderEdit('${order.id}')">Edit</button>`
    : '';
  const cancelButton = canBusinessCancelOrder(order)
    ? `<button type="button" class="order-detail-link" style="color:#e05555;" onclick="event.stopPropagation(); cancelBusinessOrder('${order.id}')">Cancel Order</button>`
    : '';
  return `
    <tr class="order-clickable" onclick="openOrderDetails('${order.id}')">
      <td><strong><button type="button" class="order-detail-link" onclick="event.stopPropagation(); openOrderDetails('${order.id}')">${escapeHtml(order.order_number)}</button></strong></td>
      <td><div class="business-customer-name">${escapeHtml(customerDisplayName(order))}</div><div class="business-order-location">${escapeHtml(orderLocationSummary(order))}</div></td>
      <td>${escapeHtml(paymentLabels[order.payment_type] || 'Delivery')}</td>
      ${includeCost ? `<td>${money(order.delivery_fee)}</td>` : ''}
      <td>${formatDate(order.created_at)}</td>
      <td><span class="status-badge ${statusClass(order.order_status)}">${escapeHtml(deliveryOutcomeLabel(order))}</span></td>
      <td>
        <button type="button" class="order-detail-link" onclick="event.stopPropagation(); openOrderDetails('${order.id}')">Details</button>
        · <button type="button" class="order-detail-link" onclick="event.stopPropagation(); printDeliveryLabel('${order.id}')">Print Label</button>
        ${editButton ? ` · ${editButton}` : ''}
        ${cancelButton ? ` · ${cancelButton}` : ''}
      </td>
    </tr>
  `;
}

function orderCard(order) {
  return `
    <div class="order-card order-clickable" onclick="openOrderDetails('${order.id}')">
      <div class="order-card-top">
        <span class="order-card-id">${escapeHtml(order.order_number)}</span>
        <span class="status-badge ${statusClass(order.order_status)}">${escapeHtml(deliveryOutcomeLabel(order))}</span>
      </div>
      <div class="order-card-route">${escapeHtml(customerDisplayName(order))}</div>
      <div class="business-order-location">${escapeHtml(orderLocationSummary(order))}</div>
      <div class="order-card-meta">
        <span>${escapeHtml(paymentLabels[order.payment_type] || 'Delivery')}</span>
        <span>${formatDate(order.created_at)}</span>
      </div>
      <div style="font-size:0.78rem; color:#6a6a6a; margin-top:0.35rem;">Parcel: ${escapeHtml(parcelStatusLabel(order.parcel_status))}</div>
      ${order.pickup_required ? `<div style="font-size:0.78rem; color:#2a6f68; margin-top:0.2rem;">${escapeHtml(pickupStatusLabel(order.pickup_status))}${order.pickup_scheduled_date ? ` · ${escapeHtml(formatDate(order.pickup_scheduled_date))}` : ''}</div>` : ''}
      <div class="order-card-cost">
        ${money(order.delivery_fee)} · <button type="button" class="order-detail-link" onclick="event.stopPropagation(); openOrderDetails('${order.id}')">View details</button>
        · <button type="button" class="order-detail-link" onclick="event.stopPropagation(); printDeliveryLabel('${order.id}')">Print label</button>
        ${canBusinessEditOrder(order) ? ` · <button type="button" class="order-detail-link" onclick="event.stopPropagation(); openBusinessOrderEdit('${order.id}')">Edit</button>` : ''}
        ${canBusinessCancelOrder(order) ? ` · <button type="button" class="order-detail-link" style="color:#e05555;" onclick="event.stopPropagation(); cancelBusinessOrder('${order.id}')">Cancel order</button>` : ''}
      </div>
    </div>
  `;
}

window.openOrderDetails = function(orderId) {
  const order = orders.find(item => item.id === orderId);
  const modal = el('#orderDetailModal');
  const content = el('#orderDetailContent');
  if (!order || !modal || !content) return;

  const map = mapsLink(order);
  const notes = customerNotesParts(order);
  const payment = paymentLabels[order.payment_type] || order.payment_type || 'Delivery';
  const status = deliveryOutcomeLabel(order);
  const amountToCollect = order.financial_model_version >= 2
    ? Number(order.driver_amount_to_collect || 0)
    : order.payment_type === 'prepaid'
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
      ${order.external_item_number ? detailItem('Item Number', escapeHtml(order.external_item_number)) : ''}
      ${detailItem('Payment Type', escapeHtml(payment))}
      ${detailItem('Amount to Collect', escapeHtml(money(amountToCollect)))}
      ${detailItem('Package Value', escapeHtml(money(order.package_value || order.cod_amount)))}
      ${detailItem('Delivery Fee', escapeHtml(money(order.delivery_fee)))}
      ${detailItem('Customer Total', escapeHtml(money(order.customer_amount_due)))}
      ${detailItem('Driver Collects', escapeHtml(money(order.driver_amount_to_collect)))}
      ${detailItem('Collection Status', escapeHtml(String(order.payment_status || 'pending').replaceAll('_', ' ')))}
      ${order.payment_type === 'cod' ? detailItem('Remittance Status', escapeHtml(String(order.remittance_status || 'pending').replaceAll('_', ' '))) : ''}
      ${order.payment_type === 'cod' ? detailItem('Gross Remittance', escapeHtml(money(order.remittance_gross_amount ?? order.client_remittance_amount))) : ''}
      ${order.payment_type === 'cod' ? detailItem('Fee Deductions', escapeHtml(money(order.remittance_deductions_amount))) : ''}
      ${order.payment_type === 'cod' ? detailItem('Net Remittance', escapeHtml(money(order.remittance_net_amount ?? order.client_remittance_amount))) : ''}
      ${order.delivery_fee_payer ? detailItem('Delivery Paid By', escapeHtml(order.delivery_fee_payer === 'client' ? 'Business client' : 'Customer')) : ''}
      ${order.client_fee_settlement ? detailItem('Business Settlement', escapeHtml(order.client_fee_settlement === 'deduct_from_remittance' ? 'Deduct from remittance' : 'Pay separately')) : ''}
      ${order.pickup_required ? detailItem('Pickup', `${escapeHtml(String(order.pickup_parcel_count || 1))} parcel(s) · ${escapeHtml(money(order.pickup_fee))}`, true) : ''}
      ${order.pickup_required ? detailItem('Pickup Contact', `${escapeHtml(order.pickup_contact_name || '')} · ${escapeHtml(order.pickup_contact_phone || '')}`, true) : ''}
      ${order.pickup_required ? detailItem('Pickup Address / Window', `${escapeHtml(order.pickup_address || order.pickup_maps_link || [order.pickup_business_name, order.pickup_street_name, order.pickup_area_name].filter(Boolean).join(', ') || (order.pickup_latitude && order.pickup_longitude ? `${order.pickup_latitude}, ${order.pickup_longitude}` : ''))} · ${escapeHtml(order.pickup_window || '')}`, true) : ''}
      ${order.pickup_required ? detailItem('Pickup Status', escapeHtml(pickupStatusLabel(order.pickup_status))) : ''}
      ${order.pickup_required && order.pickup_scheduled_date ? detailItem('Scheduled Pickup', `${escapeHtml(formatDate(order.pickup_scheduled_date))} · ${escapeHtml(order.pickup_scheduled_window || order.pickup_window || '')}`) : ''}
      ${order.pickup_cancellation_reason ? detailItem('Pickup Cancellation', escapeHtml(order.pickup_cancellation_reason), true) : ''}
      ${detailItem('Zone Status', escapeHtml(order.zone_status || 'pending'))}
      ${detailItem('Order Status', escapeHtml(status))}
      ${detailItem('Parcel Status', escapeHtml(parcelStatusLabel(order.parcel_status)))}
      ${order.delivery_outcome ? detailItem('Latest Delivery Outcome', escapeHtml(deliveryOutcomeLabel(order))) : ''}
      ${order.delivery_attempt_count ? detailItem('Delivery Attempts', escapeHtml(String(order.delivery_attempt_count))) : ''}
      ${order.delivery_outcome_notes ? detailItem('Driver Outcome Notes', escapeHtml(order.delivery_outcome_notes), true) : ''}
      ${order.redelivery_requested_date ? detailItem('Customer Preferred Redelivery', escapeHtml(formatDate(order.redelivery_requested_date))) : ''}
      ${order.redelivery_status ? detailItem('Redelivery Status', escapeHtml(String(order.redelivery_status).replaceAll('_', ' '))) : ''}
      ${order.redelivery_fee > 0 ? detailItem('Redelivery Fee', `${escapeHtml(money(order.redelivery_fee))} · ${escapeHtml(order.redelivery_fee_payer === 'client' ? 'Business client pays' : order.redelivery_fee_payer === 'customer' ? 'Customer pays' : 'Payer pending')}`) : ''}
      ${order.redelivery_fee_settlement ? detailItem('Redelivery Settlement', escapeHtml(order.redelivery_fee_settlement === 'deduct_from_remittance' ? 'Deduct from remittance' : 'Pay separately')) : ''}
      ${order.holding_type ? detailItem('Holding Arrangement', escapeHtml(order.holding_type === 'extra_stock' ? 'Approved extra stock' : `Standard hold${order.hold_until ? ` until ${formatDate(order.hold_until)}` : ''}`)) : ''}
      ${order.return_to_client_status ? detailItem('Return to Client', `${escapeHtml(String(order.return_to_client_status).replaceAll('_', ' '))} · ${escapeHtml(money(order.return_to_client_fee))}`) : ''}
      ${order.return_management_notes ? detailItem('Return Notes', escapeHtml(order.return_management_notes), true) : ''}
      ${order.delivery_proof_confirmed_at ? detailItem('Delivery Proof', `Driver confirmed handover · ${escapeHtml(formatDateTime(order.delivery_proof_confirmed_at))}`) : ''}
      ${order.delivery_collection_method ? detailItem('Collection', `${escapeHtml(String(order.delivery_collection_method).toUpperCase())} · ${escapeHtml(money(order.delivery_collected_amount))}`) : ''}
      ${order.delivery_return_required ? detailItem('Parcel Return', 'Awaiting return to VirtuDrop hub') : ''}
      ${order.delivery_returned_hub_at ? detailItem('Returned to Hub', escapeHtml(formatDateTime(order.delivery_returned_hub_at))) : ''}
      ${order.parcel_received_at ? detailItem('Parcel Received', escapeHtml(formatDateTime(order.parcel_received_at))) : ''}
      ${detailItem('Package', escapeHtml(notes.packageText || 'Not entered'), true)}
      ${order.rejection_reason ? detailItem('❌ Rejection Reason', `<span style="color:#e05555; font-weight:600;">${escapeHtml(order.rejection_reason)}</span>`, true) : ''}
      ${detailItem('Delivery Address', escapeHtml(order.delivery_address || 'Location pending'), true)}
      ${detailItem('House / Apt', escapeHtml(order.house_number || ''))}
      ${detailItem('Street', escapeHtml(order.street_name || ''))}
      ${detailItem('Area', escapeHtml(order.area_name || ''))}
      ${detailItem('GPS', order.latitude && order.longitude ? escapeHtml(order.latitude + ', ' + order.longitude) : '')}
      ${detailItem('Notes', escapeHtml(notes.extraNotes || 'None'), true)}
    </div>
    <div class="order-detail-actions">
      ${map ? `<a class="btn btn-primary" href="${escapeHtml(map)}" target="_blank">Open Location</a>` : ''}
      <button type="button" class="btn btn-ghost" onclick="printDeliveryLabel('${order.id}')">Print Label</button>
      ${canBusinessEditOrder(order) ? `<button type="button" class="btn btn-ghost" onclick="openBusinessOrderEdit('${order.id}')">Edit Order</button>` : ''}
      ${canBusinessCancelOrder(order) ? `<button type="button" class="btn btn-danger" onclick="cancelBusinessOrder('${order.id}')">Cancel Order</button>` : ''}
    </div>
    ${['returned_to_hub', 'held_for_client_instructions'].includes(order.parcel_status) && order.return_to_client_status !== 'ready' && order.redelivery_status !== 'scheduled' ? `
      <div class="business-track-bubble" style="margin-top:1rem;">
        <div class="business-track-title">Redelivery Payment</div>
        <div class="business-track-message">State who will pay if VirtuDrop schedules another delivery attempt.</div>
        <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:0.75rem; margin-top:0.85rem;">
          <label>Fee Payer<select id="businessRedeliveryPayer" class="input" onchange="syncBusinessRedeliverySettlement()"><option value="customer" ${order.redelivery_fee_payer === 'customer' ? 'selected' : ''}>Customer</option><option value="client" ${order.redelivery_fee_payer === 'client' ? 'selected' : ''}>Business Client</option></select></label>
          <label id="businessRedeliverySettlementWrap">Client Settlement<select id="businessRedeliverySettlement" class="input"><option value="deduct_from_remittance" ${order.redelivery_fee_settlement === 'deduct_from_remittance' ? 'selected' : ''}>Deduct from remittance</option><option value="pay_separately" ${order.redelivery_fee_settlement === 'pay_separately' ? 'selected' : ''}>Pay separately</option></select></label>
        </div>
        <button type="button" class="btn btn-primary" style="margin-top:0.85rem;" onclick="saveBusinessRedeliveryPayment('${order.id}')">Save Payment Choice</button>
      </div>` : ''}
    ${businessTrackingBubble(order)}
  `;

  modal.classList.add('active');
  syncBusinessRedeliverySettlement();
};

function canBusinessEditOrder(order) {
  return order
    && !['delivered', 'cancelled', 'rejected'].includes(order.order_status)
    && !['handed_to_driver', 'returned_to_client'].includes(order.parcel_status);
}

function canBusinessCancelOrder(order) {
  return order
    && !['delivered', 'cancelled', 'rejected'].includes(order.order_status)
    && !['handed_to_driver', 'delivered', 'returned_to_client'].includes(order.parcel_status);
}

function businessPaymentOption(order) {
  if (order.payment_arrangement === 'cod_client_pays_delivery') return 'cod-client-delivery';
  if (order.payment_arrangement === 'client_pays_delivery' || order.payment_type === 'prepaid') return 'all-online';
  if (order.payment_arrangement === 'delivery_only_customer_pays' || order.payment_type === 'delivery_only') return 'pkg-online';
  return 'cod';
}

function businessEditPayloadFromForm(orderId) {
  const paymentOption = el('#editPaymentType')?.value || '';
  const packageValue = paymentOption === 'cod' || paymentOption === 'cod-client-delivery' ? Number(el('#editPackageValue')?.value || 0) : 0;
  const pickupRequired = el('#editPickupRequired')?.value === 'yes';
  const pickupParcelCount = Number(el('#editPickupParcelCount')?.value || 1);
  const pickupFee = pickupRequired && pickupParcelCount < 5 ? 20 : 0;
  const clientPaysDelivery = paymentOption === 'all-online' || paymentOption === 'cod-client-delivery';
  const arrangementMap = {
    cod: 'cod_customer_pays',
    'cod-client-delivery': 'cod_client_pays_delivery',
    'pkg-online': 'delivery_only_customer_pays',
    'all-online': 'client_pays_delivery'
  };
  const customerNotes = [
    `Package: ${el('#editPackageDesc')?.value.trim() || ''}`,
    el('#editSpecialNotes')?.value.trim() || ''
  ].filter(Boolean).join('\n');
  return {
    customer_name: el('#editCustomerName')?.value.trim() || '',
    customer_phone: '868-' + String(el('#editCustomerPhone')?.value || '').replace(/\D/g, '').slice(-7),
    house_number: el('#editHouseNumber')?.value.trim() || null,
    street_name: el('#editStreetName')?.value.trim() || null,
    area_name: el('#editAreaName')?.value.trim() || null,
    maps_link: el('#editMapsLink')?.value.trim() || null,
    latitude: el('#editLatitude')?.value || null,
    longitude: el('#editLongitude')?.value || null,
    payment_type: paymentMap[paymentOption] || '',
    payment_arrangement: arrangementMap[paymentOption] || '',
    delivery_fee_payer: clientPaysDelivery ? 'client' : 'customer',
    client_fee_settlement: clientPaysDelivery ? (el('#editClientFeeSettlement')?.value || 'pay_separately') : null,
    package_value: packageValue,
    estimated_fee: el('#editEstimatedFee')?.value || null,
    pricing_rate_band: el('#editPricingRateBand')?.value || null,
    quote_status: el('#editEstimatedFee')?.value ? 'not_required' : 'required',
    pickup_required: pickupRequired,
    pickup_parcel_count: pickupRequired ? pickupParcelCount : null,
    pickup_fee: pickupFee,
    pickup_fee_settlement: pickupFee > 0 ? (el('#editPickupFeeSettlement')?.value || 'pay_separately') : null,
    pickup_contact_name: pickupRequired ? el('#editPickupContactName')?.value.trim() || null : null,
    pickup_contact_phone: pickupRequired ? el('#editPickupContactPhone')?.value.trim() || null : null,
    pickup_business_name: pickupRequired ? el('#editPickupBusinessName')?.value.trim() || null : null,
    pickup_street_name: pickupRequired ? el('#editPickupStreetName')?.value.trim() || null : null,
    pickup_area_name: pickupRequired ? el('#editPickupAreaName')?.value.trim() || null : null,
    pickup_maps_link: pickupRequired ? el('#editPickupMapsLink')?.value.trim() || null : null,
    pickup_latitude: pickupRequired ? el('#editPickupLatitude')?.value || null : null,
    pickup_longitude: pickupRequired ? el('#editPickupLongitude')?.value || null : null,
    pickup_window: pickupRequired ? el('#editPickupWindow')?.value.trim() || null : null,
    pickup_instructions: pickupRequired ? el('#editPickupInstructions')?.value.trim() || null : null,
    customer_notes: customerNotes
  };
}

function validateBusinessEditPayload(payload, paymentOption) {
  const phoneDigits = String(payload.customer_phone || '').replace(/\D/g, '');
  if ((payload.customer_name || '').length < 2) return 'Enter the customer name.';
  if (phoneDigits.length < 7) return 'Enter a valid customer phone number.';
  if (!paymentOption) return 'Select the payment type.';
  if (paymentOption === 'cod' && Number(payload.package_value || 0) <= 0) return 'Enter the COD package amount.';
  if (!payload.maps_link && !payload.latitude) {
    const addressError = validateManualAddress(payload.street_name, payload.area_name);
    if (addressError) return addressError;
  }
  const packageLine = String(payload.customer_notes || '').match(/^Package:\s*(.*)$/m)?.[1] || '';
  if (packageLine.trim().length < 2) return 'Enter the package description.';
  if (payload.pickup_required) {
    if (String(payload.pickup_contact_name || '').length < 2) return 'Enter the pickup contact name.';
    if (String(payload.pickup_contact_phone || '').replace(/\D/g, '').length < 7) return 'Enter a valid pickup phone number.';
    const hasPickupManual = Boolean(payload.pickup_street_name && payload.pickup_area_name);
    const hasPickupPin = Boolean(payload.pickup_maps_link || (payload.pickup_latitude && payload.pickup_longitude));
    if (!hasPickupManual && !hasPickupPin) return 'Enter pickup street and area, paste a pickup Google Maps link, or use current location for pickup.';
    if (payload.pickup_maps_link && !isValidMapsLink(payload.pickup_maps_link)) return 'Paste a valid pickup Google Maps link.';
    if (hasPickupManual) {
      const pickupError = validatePickupLocation(payload.pickup_street_name, payload.pickup_area_name);
      if (pickupError) return pickupError;
    }
    if (String(payload.pickup_window || '').length < 3) return 'Enter the pickup window.';
  }
  return '';
}

window.openBusinessOrderEdit = function(orderId) {
  const order = orders.find(item => item.id === orderId);
  const modal = el('#orderDetailModal');
  const content = el('#orderDetailContent');
  if (!order || !modal || !content) return;
  if (!canBusinessEditOrder(order)) {
    window.vdNotify('Order Cannot Be Edited', 'Contact VirtuDrop to amend this order because it is already in driver handover or completed.', 'warning');
    return;
  }
  const notes = customerNotesParts(order);
  const paymentOption = businessPaymentOption(order);
  content.innerHTML = `
    <div class="order-detail-head">
      <div><div class="order-detail-title">Edit ${escapeHtml(order.order_number)}</div><div class="order-detail-sub">Changes will return unassigned orders to zone review.</div></div>
      <span class="status-badge ${statusClass(order.order_status)}">${escapeHtml(statusLabel(order.order_status))}</span>
    </div>
    <div class="order-detail-grid">
      <label class="order-detail-item"><div class="order-detail-label">Customer Name</div><input class="input" id="editCustomerName" value="${escapeHtml(order.customer_name || '')}"></label>
      <label class="order-detail-item"><div class="order-detail-label">Customer Phone</div><input class="input" id="editCustomerPhone" value="${escapeHtml(String(order.customer_phone || '').replace(/^868-?/, ''))}"></label>
      <label class="order-detail-item full"><div class="order-detail-label">Package Description</div><textarea class="input" id="editPackageDesc">${escapeHtml(notes.packageText || order.external_item_number || '')}</textarea></label>
      <label class="order-detail-item"><div class="order-detail-label">Payment Type</div><select class="input" id="editPaymentType" onchange="syncBusinessEditPayment()"><option value="cod" ${paymentOption === 'cod' ? 'selected' : ''}>Customer pays package + delivery</option><option value="cod-client-delivery" ${paymentOption === 'cod-client-delivery' ? 'selected' : ''}>Customer pays package, business pays delivery</option><option value="pkg-online" ${paymentOption === 'pkg-online' ? 'selected' : ''}>Customer pays delivery only</option><option value="all-online" ${paymentOption === 'all-online' ? 'selected' : ''}>Business pays delivery</option></select></label>
      <label class="order-detail-item"><div class="order-detail-label">Package/COD Amount</div><input class="input" id="editPackageValue" type="number" min="0" step="0.01" value="${Number(order.package_value || order.cod_amount || 0).toFixed(2)}"></label>
      <label class="order-detail-item" id="editClientFeeWrap"><div class="order-detail-label">Client Settlement</div><select class="input" id="editClientFeeSettlement"><option value="pay_separately" ${order.client_fee_settlement === 'pay_separately' ? 'selected' : ''}>Pay separately</option><option value="deduct_from_remittance" ${order.client_fee_settlement === 'deduct_from_remittance' ? 'selected' : ''}>Deduct from remittance</option></select></label>
      <label class="order-detail-item"><div class="order-detail-label">Estimated Fee</div><input class="input" id="editEstimatedFee" type="number" min="0" step="0.01" value="${order.estimated_fee ?? ''}"></label>
      <label class="order-detail-item"><div class="order-detail-label">Rate Band</div><select class="input" id="editPricingRateBand"><option value="">Pending</option><option value="standard" ${order.pricing_rate_band === 'standard' ? 'selected' : ''}>Standard</option><option value="extended" ${order.pricing_rate_band === 'extended' ? 'selected' : ''}>Extended</option><option value="remote" ${order.pricing_rate_band === 'remote' ? 'selected' : ''}>Remote / Quote</option></select></label>
      <label class="order-detail-item"><div class="order-detail-label">House / Apt</div><input class="input" id="editHouseNumber" value="${escapeHtml(order.house_number || '')}"></label>
      <label class="order-detail-item"><div class="order-detail-label">Street / Building</div><input class="input" id="editStreetName" value="${escapeHtml(order.street_name || '')}"></label>
      <label class="order-detail-item"><div class="order-detail-label">Area</div><input class="input" id="editAreaName" value="${escapeHtml(order.area_name || '')}"></label>
      <label class="order-detail-item full"><div class="order-detail-label">Google Maps Pin / Link</div><input class="input" id="editMapsLink" value="${escapeHtml(order.maps_link || '')}"></label>
      <label class="order-detail-item"><div class="order-detail-label">Latitude</div><input class="input" id="editLatitude" type="number" step="any" value="${order.latitude ?? ''}"></label>
      <label class="order-detail-item"><div class="order-detail-label">Longitude</div><input class="input" id="editLongitude" type="number" step="any" value="${order.longitude ?? ''}"></label>
      <label class="order-detail-item full"><div class="order-detail-label">Notes</div><textarea class="input" id="editSpecialNotes">${escapeHtml(notes.extraNotes || '')}</textarea></label>
      <label class="order-detail-item"><div class="order-detail-label">Pickup Required</div><select class="input" id="editPickupRequired" onchange="syncBusinessEditPickup()"><option value="">No</option><option value="yes" ${order.pickup_required ? 'selected' : ''}>Yes</option></select></label>
      <label class="order-detail-item"><div class="order-detail-label">Pickup Parcels</div><input class="input" id="editPickupParcelCount" type="number" min="1" step="1" value="${Number(order.pickup_parcel_count || 1)}"></label>
      <div class="order-detail-item full" id="editPickupWrap">
        <div class="order-detail-grid">
          <label class="order-detail-item"><div class="order-detail-label">Pickup Contact</div><input class="input" id="editPickupContactName" value="${escapeHtml(order.pickup_contact_name || '')}"></label>
          <label class="order-detail-item"><div class="order-detail-label">Pickup Phone</div><input class="input" id="editPickupContactPhone" value="${escapeHtml(order.pickup_contact_phone || '')}"></label>
          <label class="order-detail-item"><div class="order-detail-label">Business Name</div><input class="input" id="editPickupBusinessName" value="${escapeHtml(order.pickup_business_name || '')}"></label>
          <label class="order-detail-item"><div class="order-detail-label">Pickup Street</div><input class="input" id="editPickupStreetName" value="${escapeHtml(order.pickup_street_name || '')}"></label>
          <label class="order-detail-item"><div class="order-detail-label">Pickup Area</div><input class="input" id="editPickupAreaName" value="${escapeHtml(order.pickup_area_name || '')}"></label>
          <label class="order-detail-item full"><div class="order-detail-label">Pickup Google Maps Link</div><input class="input" id="editPickupMapsLink" value="${escapeHtml(order.pickup_maps_link || '')}"></label>
          <label class="order-detail-item"><div class="order-detail-label">Pickup Latitude</div><input class="input" id="editPickupLatitude" type="number" step="any" value="${order.pickup_latitude ?? ''}"></label>
          <label class="order-detail-item"><div class="order-detail-label">Pickup Longitude</div><input class="input" id="editPickupLongitude" type="number" step="any" value="${order.pickup_longitude ?? ''}"></label>
          <button type="button" class="btn" style="grid-column:1 / -1;" onclick="useEditPickupCurrentLocation()">📍 Use Current Location for Pickup</button>
          <div id="editPickupGpsResult" class="order-detail-item full" style="display:none; background:#e8f5f3; color:#0d2b28;"></div>
          <label class="order-detail-item"><div class="order-detail-label">Pickup Window</div><input class="input" id="editPickupWindow" value="${escapeHtml(order.pickup_window || '')}"></label>
          <label class="order-detail-item"><div class="order-detail-label">Pickup Fee Settlement</div><select class="input" id="editPickupFeeSettlement"><option value="pay_separately" ${order.pickup_fee_settlement === 'pay_separately' ? 'selected' : ''}>Pay separately</option><option value="deduct_from_remittance" ${order.pickup_fee_settlement === 'deduct_from_remittance' ? 'selected' : ''}>Deduct from remittance</option></select></label>
          <label class="order-detail-item full"><div class="order-detail-label">Pickup Instructions</div><textarea class="input" id="editPickupInstructions">${escapeHtml(order.pickup_instructions || '')}</textarea></label>
        </div>
      </div>
    </div>
    <div class="order-detail-actions">
      <button type="button" class="btn btn-primary" onclick="saveBusinessOrderEdit('${order.id}')">Save Changes</button>
      <button type="button" class="btn btn-ghost" onclick="openOrderDetails('${order.id}')">Cancel</button>
    </div>
  `;
  modal.classList.add('active');
  syncBusinessEditPayment();
  syncBusinessEditPickup();
};

window.syncBusinessEditPayment = function() {
  const option = el('#editPaymentType')?.value || '';
  if (el('#editPackageValue')) el('#editPackageValue').disabled = option !== 'cod' && option !== 'cod-client-delivery';
  if (el('#editClientFeeWrap')) el('#editClientFeeWrap').style.display = option === 'all-online' || option === 'cod-client-delivery' ? '' : 'none';
};

window.syncBusinessEditPickup = function() {
  const enabled = el('#editPickupRequired')?.value === 'yes';
  if (el('#editPickupWrap')) el('#editPickupWrap').style.display = enabled ? '' : 'none';
};

window.saveBusinessOrderEdit = async function(orderId) {
  const paymentOption = el('#editPaymentType')?.value || '';
  const payload = businessEditPayloadFromForm(orderId);
  payload.pickup_required = el('#editPickupRequired')?.value === 'yes';
  const issue = validateBusinessEditPayload(payload, paymentOption);
  if (issue) return window.vdNotify('Order Not Updated', issue, 'warning');
  try {
    const { error } = await supabase.rpc('business_update_order_request', {
      p_order_id: orderId,
      p_request_data: payload
    });
    if (error) throw error;
    await loadBusinessData();
    openOrderDetails(orderId);
    if (window.vdNotify) {
      window.vdNotify('Order Updated', 'The order changes were saved.', 'success');
    }
  } catch (error) {
    window.vdNotify('Order Not Updated', error.message || 'Could not update this order.', 'error');
  }
};

window.cancelBusinessOrder = async function(orderId) {
  const order = orders.find(item => item.id === orderId);
  if (!order) return window.vdNotify('Order Not Cancelled', 'Order not found.', 'error');
  if (!canBusinessCancelOrder(order)) {
    window.vdNotify('Order Not Cancelled', 'This order can no longer be cancelled from the business dashboard. Contact VirtuDrop.', 'warning');
    return;
  }
  const confirmed = window.confirm(`Cancel order ${order.order_number}? This will remove it from active delivery work.`);
  if (!confirmed) return;
  const reason = window.prompt('Reason for cancellation', 'Cancelled by business client');
  if (reason === null) return;
  try {
    const { error } = await supabase.rpc('business_cancel_order', {
      p_order_id: orderId,
      p_reason: reason.trim() || 'Cancelled by business client'
    });
    if (error) throw error;
    await loadBusinessData();
    openOrderDetails(orderId);
    window.vdNotify('Order Cancelled', 'The order was cancelled and removed from active delivery work.', 'success');
  } catch (error) {
    window.vdNotify('Order Not Cancelled', error.message || 'Could not cancel this order.', 'error');
  }
};

window.syncBusinessRedeliverySettlement = function() {
  const wrap = el('#businessRedeliverySettlementWrap');
  if (wrap) wrap.style.display = el('#businessRedeliveryPayer')?.value === 'client' ? '' : 'none';
};

window.saveBusinessRedeliveryPayment = async function(orderId) {
  const payer = el('#businessRedeliveryPayer')?.value || '';
  const settlement = payer === 'client' ? el('#businessRedeliverySettlement')?.value || '' : null;
  try {
    const { error } = await supabase.rpc('business_set_redelivery_payment', {
      p_order_id: orderId,
      p_payer: payer,
      p_settlement: settlement
    });
    if (error) throw error;
    await loadBusinessData();
    openOrderDetails(orderId);
    if (typeof showToast === 'function') showToast('Redelivery payment choice saved.');
  } catch (error) {
    window.vdNotify('Payment Choice Not Saved', error.message || 'Could not save the redelivery payment choice.', 'error');
  }
};

window.closeOrderDetails = function() {
  el('#orderDetailModal')?.classList.remove('active');
};

function renderOverview() {
  const month = new Date().toISOString().slice(0, 7);
  const thisMonth = orders.filter(order => String(order.created_at || '').slice(0, 7) === month);
  const deliveredAll = orders.filter(order => order.order_status === 'delivered');
  const active = orders.filter(order => activeStatuses.includes(order.order_status));
  const deliveredThisMonth = thisMonth.filter(order => order.order_status === 'delivered');
  const pendingZone = orders.filter(order => order.order_status === 'zone_pending' || order.zone_status === 'pending');
  const pendingRemittance = orders
    .filter(order => order.payment_type === 'cod' && order.remittance_status === 'ready')
    .reduce((sum, order) => sum + clientPayout(order), 0);
  const clientFeesDue = orders
    .filter(order => !['cancelled', 'rejected'].includes(order.order_status))
    .reduce((sum, order) => sum + Number(order.client_amount_due || 0), 0);
  const remittedTotal = remittanceRecords
    .filter(record => record.business_client_id === business?.id && record.status !== 'void')
    .reduce((sum, record) => sum + Number(record.net_amount ?? record.amount ?? 0), 0);

  const heading = el('#panel-overview .section-heading');
  if (heading?.childNodes?.[0]) heading.childNodes[0].nodeValue = `Good day, ${firstName()}! 👋 `;
  setText('#panel-overview .section-sub', `Here is a live snapshot for ${business?.business_name || 'your business'}.`);

  const statLabels = all('#panel-overview .stat-label');
  const statValues = all('#panel-overview .stat-value');
  const statNotes = all('#panel-overview .stat-note');
  if (statLabels[0]) statLabels[0].textContent = 'Total Orders';
  if (statValues[0]) statValues[0].textContent = orders.length;
  if (statNotes[0]) statNotes[0].textContent = `${thisMonth.length} created this month`;
  if (statValues[1]) statValues[1].textContent = active.length;
  if (statValues[2]) statValues[2].textContent = deliveredAll.length;
  if (statNotes[2]) statNotes[2].textContent = `${deliveredThisMonth.length} completed this month`;
  if (statValues[3]) statValues[3].textContent = pendingZone.length;
  if (statNotes[3]) statNotes[3].textContent = 'awaiting zone confirmation';

  const activeCard = el('#panel-overview .overview-grid .card:nth-child(1)');
  if (activeCard) {
    activeCard.innerHTML = `<div class="card-title">🚚 Active Deliveries</div>` +
      (active.length
        ? active.slice(0, 4).map(order => `
          <div class="delivery-item">
            <div class="delivery-icon">📦</div>
            <div class="delivery-info">
              <div class="delivery-route">${escapeHtml(customerDisplayName(order))}</div>
              <div class="delivery-meta">Order ${escapeHtml(order.order_number)} · ${escapeHtml(orderLocationSummary(order))}</div>
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
      <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:0.8rem; font-size:0.9rem;">
        <div><div style="color:#6a6a6a;">Pending Remittance</div><strong style="color:#2a9d8f;">${money(pendingRemittance)}</strong></div>
        <div><div style="color:#6a6a6a;">Remitted</div><strong>${money(remittedTotal)}</strong></div>
        <div><div style="color:#6a6a6a;">Fees Owed</div><strong style="color:${clientFeesDue > 0 ? '#e07a3a' : '#0d2b28'};">${money(clientFeesDue)}</strong></div>
        <div><div style="color:#6a6a6a;">Status</div><strong>${escapeHtml(business?.status || 'active')}</strong></div>
      </div>
    `;
  }
}

function renderActive() {
  const active = orders.filter(order => activeStatuses.includes(order.order_status));
  setText('#panel-active .section-sub', `${active.length} delivery${active.length === 1 ? '' : 'ies'} currently in progress.`);
  const tbody = el('#panel-active table tbody');
  if (tbody) tbody.innerHTML = active.length ? active.map(order => orderTableRow(order)).join('') : emptyRow(6, 'No active deliveries right now.');
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
    const packageAmount = Number(order.package_value || order.cod_amount || 0);
    const deliveryFee = Number(order.delivery_fee || 0);
    const collected = collectionAmount(order);
    const status = order.remittance_status === 'paid' ? 'Remitted'
      : order.payment_status === 'reconciled' ? 'Reconciled / Ready'
        : order.payment_status === 'disputed' ? 'Disputed'
          : order.order_status === 'delivered' ? 'Awaiting Reconciliation' : 'Pending Collection';
    return `
      <tr>
        <td style="padding:0.9rem 1rem; font-family:'Courier New',monospace; font-size:0.85rem; color:#2a9d8f;">${escapeHtml(order.order_number)}</td>
        <td style="padding:0.9rem 1rem;"><span class="business-customer-name">${escapeHtml(order.customer_name)}</span></td>
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
  const total = monthCod.reduce((sum, order) => sum + collectionAmount(order), 0);
  const pending = monthCod.filter(order => order.order_status !== 'delivered').reduce((sum, order) => sum + collectionAmount(order), 0);
  const summary = el('#panel-cod-records .card > div:last-child');
  if (summary) {
    summary.innerHTML = `
      <div style="font-size:0.9rem; color:#4a4a4a;">Total COD / delivery fee this month: <strong style="color:#0d2b28; font-size:1.1rem;">${money(total)}</strong></div>
      <div style="font-size:0.9rem; color:#4a4a4a;">Still pending: <strong style="color:#e07a3a;">${money(pending)}</strong></div>
    `;
  }
}

function renderRemittance() {
  const now = new Date();
  const weekStart = new Date(now); weekStart.setHours(0, 0, 0, 0); weekStart.setDate(now.getDate() - now.getDay());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const clientRecords = remittanceRecords.filter(record => {
    if (record.business_client_id !== business?.id || record.status === 'void') return false;
    const paid = new Date(record.paid_at || record.created_at);
    if (remittancePeriod === 'week' && paid < weekStart) return false;
    if (remittancePeriod === 'month' && paid < monthStart) return false;
    return true;
  });
  const remittancePaidAmount = record => Number(record.net_amount ?? record.amount ?? 0);
  const total = clientRecords.reduce((sum, record) => sum + remittancePaidAmount(record), 0);
  const bank = clientRecords.filter(record => record.method === 'bank_transfer').reduce((sum, record) => sum + remittancePaidAmount(record), 0);
  const cash = clientRecords.filter(record => ['cash', 'office_cash_collection', 'next_pickup_cash'].includes(record.method)).reduce((sum, record) => sum + Number(record.net_amount ?? record.amount ?? 0), 0);
  setText('#remitTotal', money(total));
  setText('#remitOnline', money(bank));
  setText('#remitCash', money(cash));
  const tbody = el('#panel-remittance table tbody');
  if (tbody) {
    tbody.innerHTML = clientRecords.length ? clientRecords.map(record => `
      <tr>
        <td style="padding:0.9rem 1rem; border-bottom:1px solid #f5f5f5;">${formatDate(record.paid_at || record.created_at)}</td>
        <td style="padding:0.9rem 1rem; border-bottom:1px solid #f5f5f5; font-family:'Courier New',monospace;">${escapeHtml(record.batch_number || 'Remittance')}</td>
        <td style="padding:0.9rem 1rem; border-bottom:1px solid #f5f5f5; font-size:0.82rem; color:#6a6a6a;">${escapeHtml((record.order_numbers || record.order_ids || []).length ? (record.order_numbers || record.order_ids || []).join(', ') : 'Linked orders')}</td>
        <td style="padding:0.9rem 1rem; border-bottom:1px solid #f5f5f5; text-align:right;">${money(record.gross_amount ?? record.amount)}</td>
        <td style="padding:0.9rem 1rem; border-bottom:1px solid #f5f5f5; text-align:right; color:#e07a3a;">${money(record.deductions_amount)}</td>
        <td style="padding:0.9rem 1rem; border-bottom:1px solid #f5f5f5; text-align:right; font-weight:700; color:#2a9d8f;">${money(record.net_amount ?? record.amount)}</td>
        <td style="padding:0.9rem 1rem; border-bottom:1px solid #f5f5f5;"><span style="padding:0.25rem 0.7rem; background:#e8f5f3; color:#2a9d8f; border-radius:10px; font-size:0.78rem; font-weight:700;">${escapeHtml(String(record.method || '').replaceAll('_', ' '))}</span></td>
        <td style="padding:0.9rem 1rem; border-bottom:1px solid #f5f5f5; font-size:0.85rem; color:#6a6a6a;">${escapeHtml(record.reference || '—')}</td>
        <td style="padding:0.9rem 1rem; border-bottom:1px solid #f5f5f5; text-align:center;"><span style="padding:0.3rem 0.8rem; background:#d4edda; color:#155724; border-radius:20px; font-size:0.78rem; font-weight:700;">${escapeHtml(record.status || 'paid')}</span></td>
      </tr>
    `).join('') : emptyRow(9, 'No remittance records have been posted yet.');
  }
}

function renderFailed() {
  const failed = orders.filter(order => failedStatuses.includes(order.order_status));
  const tbody = el('#panel-failed table tbody');
  if (!tbody) return;
  tbody.innerHTML = failed.length ? failed.map(order => `
    <tr>
      <td style="padding:0.9rem 1rem; font-family:'Courier New',monospace; font-size:0.85rem; color:#2a9d8f;">${escapeHtml(order.order_number)}</td>
      <td style="padding:0.9rem 1rem;"><span class="business-customer-name">${escapeHtml(order.customer_name)}</span></td>
      <td style="padding:0.9rem 1rem;">${escapeHtml(order.area_name || '—')}</td>
      <td style="padding:0.9rem 1rem;">${formatDate(order.updated_at || order.created_at)}</td>
      <td style="padding:0.9rem 1rem; font-size:0.88rem; color:#6a6a6a;">${escapeHtml(order.delivery_outcome_notes || 'Contact VirtuDrop to confirm next steps')}${order.redelivery_requested_date ? ` · Preferred date: ${escapeHtml(formatDate(order.redelivery_requested_date))}` : ''}</td>
      <td style="padding:0.9rem 1rem; text-align:center;"><span style="padding:0.3rem 0.8rem; background:#fde8e8; color:#8b2020; border-radius:20px; font-size:0.78rem; font-weight:700;">${escapeHtml(deliveryOutcomeLabel(order))}</span></td>
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
    record.batch_number || '',
    Number(record.gross_amount ?? record.amount ?? 0),
    Number(record.deductions_amount || 0),
    Number(record.net_amount ?? record.amount ?? 0),
    String(record.method || '').replaceAll('_', ' '),
    record.reference || '',
    record.status || 'paid',
    (record.order_numbers || record.order_ids || []).join(', ')
  ]);
}

window.exportBusinessReport = function(type) {
  syncBusinessReportDateInputs();
  if (!validateReportFilters()) return;
  const orderHeaders = ['Order', 'Customer', 'Phone', 'Route', 'Payment', 'Delivery Fee', 'Collected Amount', 'Status', 'Created'];
  const codHeaders = ['Order', 'Customer', 'Payment', 'Collected Amount', 'Delivery Fee', 'Driver Collected', 'Client Payout', 'Status', 'Created'];
  const remitHeaders = ['Date', 'Batch', 'Gross COD', 'Deductions', 'Net Paid', 'Method', 'Reference', 'Status', 'Linked Orders'];

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
  loadNotificationBadge();
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
    window.vdNotify('Account Not Active', 'Your business account is not active. Please contact VirtuDrop.', 'warning');
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
  renderSidebarAccount();

  const [{ data: orderData, error: orderError }, { data: remitData, error: remitError }] = await Promise.all([
    supabase
      .from('orders')
      .select('id, order_number, external_item_number, financial_model_version, customer_name, customer_phone, delivery_address, house_number, street_name, area_name, maps_link, latitude, longitude, payment_type, payment_arrangement, delivery_fee_payer, client_fee_settlement, cod_amount, package_value, estimated_fee, delivery_fee, pricing_rate_band, customer_amount_due, driver_amount_to_collect, client_amount_due, client_remittance_amount, remittance_gross_amount, remittance_deductions_amount, remittance_net_amount, remittance_paid_amount, remittance_batch_id, pickup_required, pickup_parcel_count, pickup_fee, pickup_fee_settlement, pickup_contact_name, pickup_contact_phone, pickup_business_name, pickup_street_name, pickup_area_name, pickup_maps_link, pickup_latitude, pickup_longitude, pickup_address, pickup_window, pickup_instructions, pickup_scheduled_date, pickup_scheduled_window, pickup_picked_up_at, pickup_arrived_hub_at, pickup_cancelled_at, pickup_cancellation_reason, parcel_status, parcel_received_at, checked_in_parcel_count, parcel_weight_lbs, parcel_condition, parcel_checkin_notes, pickup_status, payment_status, remittance_status, scheduled_delivery_date, delivery_outcome, delivery_attempt_count, last_delivery_attempt_at, delivery_outcome_notes, redelivery_requested_date, delivery_proof_confirmed_at, delivery_return_required, delivery_returned_hub_at, delivery_collection_method, delivery_collected_amount, redelivery_status, redelivery_fee, redelivery_fee_payer, redelivery_fee_settlement, redelivery_scheduled_at, redelivery_notes, return_disposition, holding_type, hold_until, return_to_client_status, return_to_client_fee, return_to_client_settlement, return_to_client_requested_at, return_to_client_completed_at, return_management_notes, zone_status, order_status, tracking_token, customer_notes, driver_notes, admin_notes, rejection_reason, payment_confirmed_at, created_at, updated_at')
      .eq('business_client_id', business.id)
      .order('created_at', { ascending: false }),
    supabase.rpc('business_list_my_remittances')
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
    const addressError = validateManualAddress(payload.street_name, payload.area_name);
    if (addressError) {
      markOrderInvalid('#streetName');
      issues.push(addressError);
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

  if (['cod', 'cod-client-delivery'].includes(raw.paymentValue) && (!Number.isFinite(Number(payload.cod_amount)) || Number(payload.cod_amount) <= 0)) {
    markOrderInvalid('#codAmount');
    issues.push('Enter the COD amount the driver should collect.');
  }

  if (['all-online', 'cod-client-delivery'].includes(raw.paymentValue) && !raw.clientFeeSettlement) {
    markOrderInvalid('#clientFeeSettlement');
    issues.push('Choose whether the delivery fee will be deducted from remittance or paid separately.');
  }

  if (raw.pickupRequired) {
    if ((raw.pickupContactName || '').length < 2) issues.push('Enter the pickup contact name.');
    if ((raw.pickupPhoneDigits || '').length < 7) issues.push('Enter a valid pickup contact number.');
    const hasPickupManual = Boolean(raw.pickupStreetName && raw.pickupAreaName);
    const hasPickupPin = Boolean(raw.pickupMapsLink || raw.pickupHasGps);
    if (!hasPickupManual && !hasPickupPin) issues.push('Enter pickup street and area, paste a pickup Google Maps link, or use current location for pickup.');
    if (raw.pickupMapsLink && !isValidMapsLink(raw.pickupMapsLink)) issues.push('Paste a valid pickup Google Maps link.');
    if (hasPickupManual) {
      const pickupLocationError = validatePickupLocation(raw.pickupStreetName, raw.pickupAreaName);
      if (pickupLocationError) issues.push(pickupLocationError);
    }
    if ((raw.pickupWindow || '').length < 3) issues.push('Enter the available pickup window.');
    if (!Number.isInteger(raw.pickupParcelCount) || raw.pickupParcelCount < 1) issues.push('Enter a valid number of parcels for pickup.');
    if (raw.pickupParcelCount < 5 && !raw.pickupFeeSettlement) issues.push('Choose how the pickup fee will be paid.');
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
    isSubmittingBusinessOrder = false;
    return;
  }

  const submitBtn = el('#submitOrderBtn');
  const originalText = submitBtn?.textContent || '✅ Submit Order';
  const paymentValue = el('#paymentType')?.value || '';
  const phoneDigits = el('#recipientPhone')?.value.replace(/\D/g, '') || '';
  const locationPayload = getLocationPayload();
  const packageDescription = el('#packageDesc')?.value.trim() || '';
  const specialNotes = el('#specialNotes')?.value.trim() || '';
  const clientFeeSettlement = el('#clientFeeSettlement')?.value || null;
  const pickupRequired = Boolean(el('#pickupRequired')?.checked);
  const pickupParcelCount = Number(el('#pickupParcelCount')?.value || 1);
  const pickupFeeSettlement = el('#pickupFeeSettlement')?.value || null;
  const pickupHasGps = Boolean(el('#pickupLatitude')?.value && el('#pickupLongitude')?.value);
  const estimate = await estimateDeliveryZone(currentEstimateInput()).catch(error => {
    console.warn('Business submit estimate failed:', error);
    return latestBizEstimate;
  });

  const money = calculateOrderMoney({
    paymentOption: paymentValue,
    packageValue: paymentValue === 'cod' || paymentValue === 'cod-client-delivery' ? Number(el('#codAmount')?.value || 0) : 0,
    deliveryFee: estimate?.fee ?? null,
    clientFeeSettlement,
    pickupRequired,
    pickupParcelCount,
    pickupFeeSettlement
  });
  const requestData = {
    business_client_id: business.id,
    customer_name: el('#recipientName')?.value.trim() || '',
    customer_phone: '868-' + phoneDigits,
    ...locationPayload,
    payment_type: paymentValue ? paymentMap[paymentValue] : '',
    cod_amount: money.packageValue,
    package_value: money.packageValue,
    estimated_fee: estimate?.fee ?? null,
    pricing_rate_band: estimate?.rateBand || (estimate?.status === 'remote' ? 'remote' : null),
    quote_status: estimate?.fee === null ? 'required' : 'not_required',
    ...financialRequestFields(money),
    pickup_contact_name: pickupRequired ? el('#pickupContactName')?.value.trim() : null,
    pickup_contact_phone: pickupRequired ? el('#pickupContactPhone')?.value.trim() : null,
    pickup_business_name: pickupRequired ? el('#pickupBusinessName')?.value.trim() : null,
    pickup_street_name: pickupRequired ? el('#pickupStreetName')?.value.trim() : null,
    pickup_area_name: pickupRequired ? el('#pickupAreaName')?.value.trim() : null,
    pickup_maps_link: pickupRequired ? el('#pickupMapsLink')?.value.trim() || null : null,
    pickup_latitude: pickupRequired && pickupHasGps ? Number(el('#pickupLatitude')?.value) : null,
    pickup_longitude: pickupRequired && pickupHasGps ? Number(el('#pickupLongitude')?.value) : null,
    pickup_window: pickupRequired ? el('#pickupWindow')?.value.trim() : null,
    pickup_instructions: pickupRequired ? el('#pickupInstructions')?.value.trim() : null,
    customer_notes: [`Package: ${packageDescription}`, specialNotes].filter(Boolean).join('\n') || null
  };

  const validationError = validateOrderForm(requestData, {
    paymentValue,
    packageDescription,
    specialNotes,
    phoneDigits,
    clientFeeSettlement,
    pickupRequired,
    pickupParcelCount,
    pickupFeeSettlement,
    pickupContactName: el('#pickupContactName')?.value.trim() || '',
    pickupPhoneDigits: el('#pickupContactPhone')?.value.replace(/\D/g, '') || '',
    pickupStreetName: el('#pickupStreetName')?.value.trim() || '',
    pickupAreaName: el('#pickupAreaName')?.value.trim() || '',
    pickupMapsLink: el('#pickupMapsLink')?.value.trim() || '',
    pickupHasGps,
    pickupWindow: el('#pickupWindow')?.value.trim() || ''
  });
  if (validationError) {
    window.vdNotify('Check This Order', validationError, 'warning');
    isSubmittingBusinessOrder = false;
    return;
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';
  }

  try {
    const { data, error } = await supabase.rpc('submit_delivery_request_v2', { request_data: requestData });
    if (error) throw error;
    const result = Array.isArray(data) ? data[0] : data;
    el('#successModal .modal-icon').textContent = '✅';
    el('#successModal h3').textContent = 'Order Submitted!';
    el('#successModal p').innerHTML = `Order <strong>${escapeHtml(result?.order_number || 'Submitted')}</strong> has been received and is waiting for zone confirmation.`;
    el('#successModal').classList.add('active');
    el('#orderForm').reset();
    window.resetOrderForm();
    try {
      await loadBusinessData();
      const submittedOrder = orders.find(order => order.order_number === result?.order_number);
      if (submittedOrder && window.confirm(`Print delivery label for ${submittedOrder.order_number}?`)) {
        printDeliveryLabel(submittedOrder.id);
      }
    } catch (refreshError) {
      console.error('Business dashboard refresh error after submission:', refreshError);
      showDashboardLoadError('The order was submitted, but the dashboard could not refresh. Do not submit the same order again. Reload after the database update is complete.');
    }
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
  latestBizEstimate = null;
  el('#bizEstimateBlock')?.style.setProperty('display', 'none');
  clearOrderValidation();
  el('#codAmountBlock')?.style.setProperty('display', 'none');
  el('#pickupDetails')?.style.setProperty('display', 'none');
  const pickupGpsResult = el('#pickupGpsResult');
  if (pickupGpsResult) {
    pickupGpsResult.style.display = 'none';
    pickupGpsResult.textContent = '';
  }
  if (el('#pickupLatitude')) el('#pickupLatitude').value = '';
  if (el('#pickupLongitude')) el('#pickupLongitude').value = '';
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
  updateBizEstimate();
};

window.useCurrentLocation = function() {
  const result = el('#gpsResult');
  if (!result) return;
  activeLocTab = 'share';
  window.switchLocTab('share', document.querySelector('.loc-tab'));
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
    async position => {
      result.dataset.lat = position.coords.latitude.toFixed(6);
      result.dataset.lng = position.coords.longitude.toFixed(6);
      result.textContent = `📍 Location captured. Identifying address and zone...`;
      try {
        const estimate = await estimateDeliveryZone(currentEstimateInput());
        latestBizEstimate = estimate;
        const addressText = estimate.sourceText || estimate.label || 'address detected';
        result.textContent = estimate.zoneCode
          ? `📍 Location captured: ${addressText} - ${estimate.zoneName} (${estimate.region}).`
          : `📍 Location captured: ${addressText}. ${estimate.message}.`;
      } catch (error) {
        console.warn('GPS estimate failed:', error);
        result.textContent = `📍 Location detected: ${result.dataset.lat}, ${result.dataset.lng}. Zone will be confirmed by VirtuDrop.`;
      }
      updateBizEstimate();
    },
    error => {
      result.style.background = '#fff3f3';
      const needsSecureOrigin = location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(location.hostname);
      result.textContent = needsSecureOrigin
        ? '❌ Current location needs HTTPS in most browsers. Use the live secure site, paste a Google Maps link, or enter the address manually.'
        : `❌ Could not access location${error?.message ? `: ${error.message}` : ''}. Allow location permission, then try again.`;
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
  );
};

function capturePickupLocation({ resultSelector, latSelector, lngSelector }) {
  const result = el(resultSelector);
  if (!result) return;
  if (!navigator.geolocation) {
    result.style.display = 'block';
    result.style.background = '#fff3f3';
    result.textContent = '❌ Geolocation is not supported by this browser.';
    return;
  }
  result.style.display = 'block';
  result.style.background = '#e8f5f3';
  result.textContent = '📍 Detecting pickup location...';
  navigator.geolocation.getCurrentPosition(
    position => {
      const lat = position.coords.latitude.toFixed(6);
      const lng = position.coords.longitude.toFixed(6);
      if (el(latSelector)) el(latSelector).value = lat;
      if (el(lngSelector)) el(lngSelector).value = lng;
      result.textContent = `📍 Pickup location captured: ${lat}, ${lng}.`;
    },
    error => {
      result.style.background = '#fff3f3';
      const needsSecureOrigin = location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(location.hostname);
      result.textContent = needsSecureOrigin
        ? '❌ Current location needs HTTPS in most browsers. Use the live secure site or paste a pickup Google Maps link.'
        : `❌ Could not access pickup location${error?.message ? `: ${error.message}` : ''}. Allow location permission, then try again.`;
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
  );
}

window.usePickupCurrentLocation = function() {
  capturePickupLocation({
    resultSelector: '#pickupGpsResult',
    latSelector: '#pickupLatitude',
    lngSelector: '#pickupLongitude'
  });
};

window.useEditPickupCurrentLocation = function() {
  capturePickupLocation({
    resultSelector: '#editPickupGpsResult',
    latSelector: '#editPickupLatitude',
    lngSelector: '#editPickupLongitude'
  });
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
  remittancePeriod = ['week', 'month', 'all'].includes(period) ? period : 'week';
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
  renderRemittance();
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
    const settlementBlock = el('#clientFeeSettlementBlock');
    const settlement = el('#clientFeeSettlement');
    if (!block || !amount) return;

    block.style.display = paymentValue === 'cod' || paymentValue === 'cod-client-delivery' ? 'flex' : 'none';
    amount.disabled = paymentValue !== 'cod' && paymentValue !== 'cod-client-delivery';
    amount.required = paymentValue === 'cod' || paymentValue === 'cod-client-delivery';
    if (paymentValue !== 'cod' && paymentValue !== 'cod-client-delivery') amount.value = '';
    if (settlementBlock) settlementBlock.style.display = paymentValue === 'all-online' || paymentValue === 'cod-client-delivery' ? 'flex' : 'none';
    if (settlement) {
      settlement.required = paymentValue === 'all-online' || paymentValue === 'cod-client-delivery';
      if (paymentValue !== 'all-online' && paymentValue !== 'cod-client-delivery') settlement.value = '';
    }
    updateBizEstimate();
  }

  el('#paymentType')?.addEventListener('change', syncAmountField);
  el('#clientFeeSettlement')?.addEventListener('change', updateBizEstimate);
  el('#pickupRequired')?.addEventListener('change', event => {
    const enabled = event.target.checked;
    if (el('#pickupDetails')) el('#pickupDetails').style.display = enabled ? '' : 'none';
    updateBizEstimate();
  });
  el('#pickupParcelCount')?.addEventListener('input', () => {
    const count = Number(el('#pickupParcelCount')?.value || 1);
    if (el('#pickupFeeSettlementBlock')) el('#pickupFeeSettlementBlock').style.display = count >= 5 ? 'none' : '';
    updateBizEstimate();
  });
  el('#pickupFeeSettlement')?.addEventListener('change', updateBizEstimate);
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

  // Wire location inputs to estimate updater — use delegation so hidden panel inputs are covered
  document.addEventListener('input', event => {
    const id = event.target?.id;
    if (id === 'mapsLink' || id === 'areaName' || id === 'streetName' || id === 'houseNum' || id === 'codAmount') {
      if (id === 'streetName' || id === 'areaName') {
        const message = validateManualAddress(el('#streetName')?.value, el('#areaName')?.value);
        const error = el('#streetNameErr');
        if (error) {
          error.textContent = message;
          error.style.display = message && el('#streetName')?.value && el('#areaName')?.value ? 'block' : 'none';
        }
        el('#streetName')?.classList.toggle('has-error', Boolean(message && el('#streetName')?.value && el('#areaName')?.value));
      }
      updateBizEstimate();
    }
  });
  document.addEventListener('change', event => {
    const id = event.target?.id;
    if (id === 'paymentType') {
      window.vdSyncBusinessAmountField && window.vdSyncBusinessAmountField();
    }
  });

  const logout = el('#businessLogoutBtn');
  if (logout) {
    logout.onclick = async () => {
      localStorage.setItem('vd-explicit-logout', String(Date.now()));
      await supabase.auth.signOut();
      window.location.href = 'auth.html';
    };
  }
}

// ── Notification badge ────────────────────────────────────────────
async function loadNotificationBadge() {
  if (!profile?.id) return;
  try {
    const { data, error } = await supabase
      .from('notifications')
      .select('id', { count: 'exact' })
      .eq('profile_id', profile.id)
      .eq('read', false);
    if (error) return;
    const count = data?.length || 0;
    const badge = el('[data-panel="notifications"] .nav-badge');
    if (badge) {
      badge.textContent = count > 0 ? count : '';
      badge.style.display = count > 0 ? '' : 'none';
    }
    // Also update notification panel content
    const card = el('#panel-notifications .card');
    if (card && count > 0) {
      const { data: notifs } = await supabase
        .from('notifications')
        .select('id, message, type, read, created_at, order_id')
        .eq('profile_id', profile.id)
        .order('created_at', { ascending: false })
        .limit(20);
      if (notifs?.length) {
        card.innerHTML = notifs.map(n => `
          <div style="display:flex; gap:0.8rem; align-items:flex-start; padding:0.9rem; border-radius:10px; background:${n.read ? '#f8f9fa' : '#f0f9f8'}; margin-bottom:0.6rem; border-left:3px solid ${n.read ? '#e0e0e0' : '#2a9d8f'};">
            <span style="font-size:1.1rem; flex-shrink:0;">${n.type === 'error' ? '❌' : n.type === 'warning' ? '⚠️' : '📬'}</span>
            <div style="flex:1;">
              <div style="font-size:0.88rem; color:#1a1a1a; font-weight:${n.read ? '400' : '600'}; line-height:1.5;">${escapeHtml(n.message)}</div>
              <div style="font-size:0.75rem; color:#aaa; margin-top:0.2rem;">${formatDateTime(n.created_at)}</div>
            </div>
            ${!n.read ? `<button onclick="markNotifRead('${n.id}')" style="font-size:0.75rem; color:#2a9d8f; background:none; border:none; cursor:pointer; white-space:nowrap; padding:0;">Mark read</button>` : ''}
          </div>
        `).join('');
      }
    }
  } catch (err) {
    console.warn('Notification badge load error:', err);
  }
}

window.markNotifRead = async function(notifId) {
  await supabase.from('notifications').update({ read: true }).eq('id', notifId);
  loadNotificationBadge();
};

bindUi();
loadBusinessData().catch(error => {
  console.error('Business dashboard load error:', error);
  showDashboardLoadError();
});
