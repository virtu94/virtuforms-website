import { calculateOrderMoney, moneyLabel, validateManualAddress } from './vd-order-money.js?v=20260624-split-cod-1';

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

function normalise(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\bsaint\b/g, 'st')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function areaVariants(area) {
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
  ].map(normalise).filter(value => value.length >= 3))];
}

function areaMatches(input, area) {
  const text = normalise(input);
  if (!text) return false;
  return areaVariants(area).some(target => {
    if (!target) return false;
    if (text.includes(target)) return true;
    const targetTokens = target.split(' ').filter(token => token.length > 2);
    return targetTokens.length > 1 && targetTokens.every(token => text.includes(token));
  });
}

async function loadZones(supabase) {
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
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
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

function classifyMatch(match) {
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
  const rateBand = match.matchedArea?.rate_band || (EXTENDED_AREA_NAMES.has(normalise(matchedAreaName)) ? 'extended' : 'standard');
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

export async function estimateDeliveryZone({
  supabase,
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
    sourceText = await withTimeout(
      reverseGeocode(Number(latitude), Number(longitude)),
      10000,
      ''
    ) || '';
    sourceLabel = sourceText;
  }

  if (!sourceText && mapsLink) {
    debug.source = 'maps-link';
    const coords = extractLatLngFromMapsUrl(mapsLink);
    if (coords) {
      debug.hasCoordinates = true;
      sourceText = await withTimeout(
        reverseGeocode(coords.lat, coords.lng),
        10000,
        ''
      ) || '';
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

  const zones = await withTimeout(loadZones(supabase), 7000, null);
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
    ...classifyMatch(match),
    sourceText,
    debug,
    label: match?.matchedArea?.area_name || sourceLabel || sourceText
  };
}

export function formatEstimateRows({
  estimate,
  paymentType,
  packageValue,
  clientFeeSettlement = null,
  pickupRequired = false,
  pickupParcelCount = 1,
  pickupFeeSettlement = null
}) {
  const rows = [];
  const money = calculateOrderMoney({
    paymentOption: paymentType,
    packageValue,
    deliveryFee: estimate.fee,
    clientFeeSettlement,
    pickupRequired,
    pickupParcelCount,
    pickupFeeSettlement
  });

  if (estimate.status === 'unknown') {
    rows.push(['Delivery Fee', 'Unable to estimate']);
  } else if (estimate.status === 'remote') {
    rows.push(['Delivery Fee', 'Quote required']);
  } else {
    rows.push(['Delivery Fee', `$${Number(estimate.fee).toFixed(2)}`]);
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
      rows.push(['Settlement', clientFeeSettlement === 'deduct_from_remittance' ? 'Deduct from remittance' : 'Pay separately']);
    }
  } else if (paymentType === 'pkg-online') {
    rows.push(['Customer Pays', moneyLabel(money.customerAmountDue)]);
    rows.push(['Driver Collects', moneyLabel(money.driverAmountToCollect)]);
  } else if (paymentType === 'all-online') {
    rows.push(['Customer Pays Driver', '$0.00']);
    rows.push(['Business Owes VirtuDrop', moneyLabel(estimate.fee)]);
    rows.push(['Settlement', clientFeeSettlement === 'deduct_from_remittance' ? 'Deduct from remittance' : 'Pay separately']);
  }
  if (pickupRequired) {
    rows.push(['Pickup', money.pickupFee > 0 ? moneyLabel(money.pickupFee) : 'Free (5 or more packages)']);
    if (money.pickupFee > 0) rows.push(['Pickup Settlement', pickupFeeSettlement === 'deduct_from_remittance' ? 'Deduct from remittance' : 'Pay separately']);
  }

  return rows;
}
