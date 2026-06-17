const CENTRAL_ZONE_CODE = 'A';
const REMOTE_ZONE_CODE = 'REMOTE';
const STANDARD_FEES = { central: 40, other: 50 };

let zonesPromise = null;
let googleMapsPromise = null;

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
  return [...new Set([
    raw,
    withoutParen,
    ...raw.split('/'),
    ...withoutParen.split('/')
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
    zonesPromise = supabase
      .from('zones')
      .select('id, code, name, region, active, zone_areas(area_name)')
      .eq('active', true)
      .order('code')
      .then(({ data, error }) => {
        if (error) throw error;
        return data || [];
      });
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

function collectGeocoderText(results) {
  const parts = [];
  for (const result of results || []) {
    if (result.formatted_address) parts.push(result.formatted_address);
    for (const comp of result.address_components || []) {
      if (comp.long_name) parts.push(comp.long_name);
      if (comp.short_name) parts.push(comp.short_name);
    }
  }
  return [...new Set(parts.filter(Boolean))].join(' ');
}

function loadGoogleMapsApi(googleApiKey) {
  if (window.google?.maps?.Geocoder) return Promise.resolve(true);
  if (!googleApiKey) return Promise.resolve(false);
  if (googleMapsPromise) return googleMapsPromise;

  googleMapsPromise = new Promise(resolve => {
    const callback = `vdGoogleMapsReady_${Date.now()}`;
    let settled = false;
    function finish(value) {
      if (settled) return;
      settled = true;
      delete window[callback];
      resolve(value);
    }

    window[callback] = () => {
      finish(Boolean(window.google?.maps?.Geocoder));
    };

    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(googleApiKey)}&callback=${callback}`;
    script.async = true;
    script.defer = true;
    script.onerror = () => {
      finish(false);
    };
    document.head.appendChild(script);

    setTimeout(() => finish(false), 3000);
  });

  return googleMapsPromise;
}

async function geocodeWithGoogleMaps(request, googleApiKey) {
  const ready = await loadGoogleMapsApi(googleApiKey);
  if (!ready) return '';

  return new Promise(resolve => {
    const geocoder = new google.maps.Geocoder();
    geocoder.geocode(request, (results, status) => {
      if (status === 'OK') resolve(collectGeocoderText(results));
      else resolve('');
    });
  });
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

async function reverseGeocode(lat, lng, googleApiKey) {
  if (!googleApiKey || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const mapsText = await geocodeWithGoogleMaps({ location: { lat, lng }, region: 'TT' }, googleApiKey);
  if (mapsText) return mapsText;

  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${googleApiKey}&region=tt`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status === 'OK') return collectGeocoderText(data.results);
  } catch {}

  return reverseGeocodeWithOpenStreetMap(lat, lng);
}

async function geocodeAddress(address, googleApiKey) {
  if (!address) return '';
  const mapsText = await geocodeWithGoogleMaps({ address, region: 'TT' }, googleApiKey);
  if (mapsText) return mapsText;

  const osmText = await geocodeAddressWithOpenStreetMap(address);
  return [address, osmText].filter(Boolean).join(' ');
}

function matchZoneFromText(zones, text) {
  for (const zone of zones) {
    const areas = zone.zone_areas || [];
    const matchedArea = areas.find(area => areaMatches(text, area.area_name));
    if (matchedArea) return { zone, matchedArea: matchedArea.area_name };
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
  if (code === REMOTE_ZONE_CODE) {
    return {
      status: 'remote',
      fee: null,
      zoneCode: code,
      zoneName: match.zone.name || 'Remote / Special Route',
      region: match.zone.region || 'Manual Review',
      matchedArea: match.matchedArea || '',
      message: 'Remote / special route - quote required'
    };
  }

  if (code === CENTRAL_ZONE_CODE) {
    return {
      status: 'central',
      fee: STANDARD_FEES.central,
      zoneCode: code,
      zoneName: match.zone.name || 'Zone A',
      region: match.zone.region || 'Central Region',
      matchedArea: match.matchedArea || '',
      message: 'Central Region'
    };
  }

  return {
    status: 'listed_non_central',
    fee: STANDARD_FEES.other,
    zoneCode: code,
    zoneName: match.zone.name || `Zone ${code}`,
    region: match.zone.region || 'Listed Zone',
    matchedArea: match.matchedArea || '',
    message: match.zone.region || 'Listed delivery zone'
  };
}

export async function estimateDeliveryZone({
  supabase,
  googleApiKey,
  houseNumber = '',
  streetName = '',
  areaName = '',
  mapsLink = '',
  latitude = null,
  longitude = null
}) {
  const zones = await loadZones(supabase);
  const manualText = [houseNumber, streetName, areaName].filter(Boolean).join(' ');

  let sourceText = manualText;
  let sourceLabel = areaName || streetName || '';

  if (!sourceText && Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude))) {
    sourceText = await reverseGeocode(Number(latitude), Number(longitude), googleApiKey) || '';
    sourceLabel = sourceText;
  }

  if (!sourceText && mapsLink) {
    const coords = extractLatLngFromMapsUrl(mapsLink);
    if (coords) {
      sourceText = await reverseGeocode(coords.lat, coords.lng, googleApiKey) || '';
      sourceLabel = sourceText;
    } else {
      sourceText = extractTextFromMapsUrl(mapsLink);
      sourceLabel = sourceText;
      if (sourceText) {
        sourceText = [sourceText, await geocodeAddress(sourceText, googleApiKey)].filter(Boolean).join(' ');
      }
    }
  }

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
      message: shortMapsLink
        ? 'Short Google Maps links cannot be read here. Use current location or paste a full Google Maps link.'
        : 'Enter an area or use GPS to estimate'
    };
  }

  const match = matchZoneFromText(zones, sourceText);
  return {
    ...classifyMatch(match),
    sourceText,
    label: match?.matchedArea || sourceLabel || sourceText
  };
}

export function formatEstimateRows({ estimate, paymentType, packageValue }) {
  const rows = [];
  const packageAmount = Number(packageValue || 0);

  if (estimate.status === 'unknown') {
    rows.push(['Delivery Fee', 'Unable to estimate']);
  } else if (estimate.status === 'remote') {
    rows.push(['Delivery Fee', 'Quote required']);
  } else {
    rows.push(['Delivery Fee', `$${Number(estimate.fee).toFixed(2)}`]);
  }

  rows.push(['Zone', estimate.zoneCode ? `${estimate.zoneName} - ${estimate.region}` : estimate.message]);

  if (paymentType === 'cod' && packageAmount > 0) {
    rows.push(['Package Value', `$${packageAmount.toFixed(2)}`]);
    rows.push(['Driver Collects', estimate.fee !== null ? `$${(packageAmount + estimate.fee).toFixed(2)}` : 'To be quoted']);
  } else if (paymentType === 'pkg-online') {
    rows.push(['Driver Collects', estimate.fee !== null ? `$${Number(estimate.fee).toFixed(2)} (delivery fee)` : 'To be quoted']);
  } else if (paymentType === 'all-online') {
    rows.push(['Driver Collects', 'Nothing']);
  }

  return rows;
}
