const CENTRAL_ZONE_CODE = 'A';
const REMOTE_ZONE_CODE = 'REMOTE';
const STANDARD_FEES = { central: 40, other: 50 };

let zonesPromise = null;

function normalise(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function areaMatches(input, area) {
  const text = normalise(input);
  const target = normalise(area);
  if (!text || !target) return false;
  return text.includes(target) || (target.includes(text) && text.length >= 4);
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

async function reverseGeocode(lat, lng, googleApiKey) {
  if (!googleApiKey || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${googleApiKey}&region=tt`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== 'OK') return null;

  const parts = [];
  for (const result of data.results || []) {
    if (result.formatted_address) parts.push(result.formatted_address);
    for (const comp of result.address_components || []) {
      if (comp.long_name) parts.push(comp.long_name);
      if (comp.short_name) parts.push(comp.short_name);
    }
  }

  return [...new Set(parts.filter(Boolean))].join(' ');
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
    }
  }

  if (!sourceText) {
    return {
      status: 'unknown',
      fee: null,
      zoneCode: '',
      zoneName: '',
      region: '',
      matchedArea: '',
      sourceText: '',
      label: 'Location could not be identified',
      message: 'Enter an area or use GPS to estimate'
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

  if (estimate.status === 'remote' || estimate.status === 'unknown') {
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
