import { calculateOrderMoney, moneyLabel, validateManualAddress } from './vd-order-money.js?v=20260624-split-cod-1';

const REMOTE_ZONE_CODE = 'REMOTE';
const COVERED_ZONE_CODES = new Set(['A', 'B', 'C', 'D']);
const STANDARD_FEES = { standard: 40, extended: 50 };
const DELIVERY_DISCLAIMER = 'Delivery rates are based on general service areas. Exact pricing may vary for locations significantly outside the normal route or with difficult access. We are happy to confirm the applicable fee before delivery.';
const REMOTE_DELIVERY_MESSAGE = 'Remote Area - Delivery from TT$60. Final fee to be confirmed.';
const EXTENDED_AREA_NAMES = new Set([
  'wallerfield', 'cumuto', 'guanapo', 'heights of guanapo', 'lopinot', 'surrey village',
  'arena', 'gran couva', 'todds road', 'todds road station', 'las lomas', 'esmeralda',
  'madras', 'st helena', 'st helena eastern sections', 'orange grove',
  'point fortin', 'oropouche', 'san francique', 'la brea', 'aripero', 'rousillac',
  'carenage', 'chaguaramas', 'chaguaramus', 'paramin'
]);
const YD_HARVEST_IDENTIFIERS = new Set([
  'ydharvest',
  'ydharvestltd',
  'ydharvestlimited'
]);
const YD_HARVEST_RATE_ROWS = [
  ['rate_band', 'standard', 35, 'YD Harvest primary zones'],
  ['area', 'Wallerfield', 45, 'YD Harvest East'],
  ['area', 'Cumuto', 55, 'YD Harvest East'],
  ['area', 'San Rafael', 45, 'YD Harvest East'],
  ['area', 'Brazil', 45, 'YD Harvest East'],
  ['area', 'San Chiquito', 55, 'YD Harvest East'],
  ['area', 'Oropouche', 55, 'YD Harvest listed East/South area'],
  ['area', 'Oropuche', 55, 'YD Harvest listed East/South spelling alias'],
  ['area', 'Guanapo', 55, 'YD Harvest East'],
  ['area', 'Heights of Guanapo', 55, 'YD Harvest East'],
  ['area', 'Lopinot', 55, 'YD Harvest East'],
  ['area', 'Surrey Village', 45, 'YD Harvest East - verify exact area during zone confirmation'],
  ['area', 'Arena', 45, 'YD Harvest Central'],
  ['area', 'Gran Couva', 45, 'YD Harvest Central - some areas'],
  ['area', 'Gran Couva Some Areas', 45, 'YD Harvest Central - some areas'],
  ['area', 'Todds Road', 45, 'YD Harvest Central'],
  ['area', 'Todds Road Station', 45, 'YD Harvest Central - verify exact area during zone confirmation'],
  ['area', 'Las Lomas', 45, 'YD Harvest Central'],
  ['area', 'Esmeralda', 35, 'YD Harvest Central'],
  ['area', 'Madras', 45, 'YD Harvest Central'],
  ['area', 'St. Helena Eastern Sections', 45, 'YD Harvest Central'],
  ['area', 'St Helena Eastern Sections', 45, 'YD Harvest Central'],
  ['area', 'Chickland', 45, 'YD Harvest Central'],
  ['area', 'Point Fortin', 65, 'YD Harvest South'],
  ['area', 'San Francique', 55, 'YD Harvest South'],
  ['area', 'La Brea', 55, 'YD Harvest South'],
  ['area', 'Aripero', 55, 'YD Harvest South'],
  ['area', 'Rousillac', 55, 'YD Harvest South'],
  ['area', 'Fyzabad', 55, 'YD Harvest South'],
  ['area', 'Williamsville', 45, 'YD Harvest South'],
  ['area', 'Indian Walk', 55, 'YD Harvest South'],
  ['area', 'Barrackpore', 55, 'YD Harvest South'],
  ['area', 'Siparia', 65, 'YD Harvest South'],
  ['area', 'Carenage', 45, 'YD Harvest West'],
  ['area', 'Chaguaramas', 55, 'YD Harvest West'],
  ['area', 'Chaguaramus', 55, 'YD Harvest West spelling alias'],
  ['area', 'Paramin', 55, 'YD Harvest West - minimum; confirm higher fee where needed'],
  ['area', 'Paramin Some Areas', 55, 'YD Harvest West - minimum; confirm higher fee where needed']
].map(([match_type, match_value, delivery_fee, rate_note]) => ({
  match_type,
  match_value,
  delivery_fee,
  rate_note
}));

let zonesPromise = null;
const businessRatesPromises = new Map();
const businessIdentityPromises = new Map();

function withTimeout(promise, ms, fallback) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise(resolve => {
      timer = setTimeout(() => resolve(fallback), ms);
    })
  ]);
}

function hasUsableCoordinate(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
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

function normaliseIdentifier(value) {
  return normalise(value).replace(/\s+/g, '');
}

function isYdHarvestIdentity(identity = {}) {
  return [
    identity.business_name,
    identity.businessName,
    identity.slug,
    identity.businessSlug
  ].some(value => YD_HARVEST_IDENTIFIERS.has(normaliseIdentifier(value)));
}

async function loadBusinessIdentity(supabase, businessClientId) {
  if (!businessClientId) return null;
  if (!businessIdentityPromises.has(businessClientId)) {
    businessIdentityPromises.set(businessClientId, (async () => {
      const result = await supabase
        .from('business_clients')
        .select('business_name, slug')
        .eq('id', businessClientId)
        .maybeSingle();

      if (result.error) {
        console.warn('Business identity could not be loaded:', result.error);
        return null;
      }

      return result.data || null;
    })());
  }
  return businessIdentityPromises.get(businessClientId);
}

function mergeBusinessRates(primaryRates, secondaryRates) {
  const merged = [];
  const seen = new Set();

  for (const rate of [...primaryRates, ...secondaryRates]) {
    const key = `${rate.match_type}:${normalise(rate.match_value)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(rate);
  }

  return merged;
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

function zoneAreaAliasNames(area = {}) {
  return (area.zone_area_aliases || area.aliases || [])
    .flatMap(alias => [alias.match_value || alias.alias_name, alias.street_hint])
    .filter(Boolean);
}

function areaSearchVariants(area) {
  return [
    ...areaVariants(typeof area === 'string' ? area : area?.area_name),
    ...zoneAreaAliasNames(area).flatMap(value => areaVariants(value))
  ];
}

function textMatchesAnyAreaVariant(input, variants) {
  const text = normalise(input);
  if (!text) return false;
  return variants.some(target => scoreVariantMatch(text, target, 200) > 0);
}

function normalizedTokens(value) {
  return normalise(value).split(' ').filter(Boolean);
}

function phraseInText(text, value) {
  const textTokens = normalizedTokens(text);
  const targetTokens = normalizedTokens(value);
  if (!textTokens.length || !targetTokens.length || targetTokens.length > textTokens.length) return false;

  for (let index = 0; index <= textTokens.length - targetTokens.length; index += 1) {
    if (targetTokens.every((token, offset) => textTokens[index + offset] === token)) return true;
  }

  return false;
}

function scoreVariantMatch(text, value, baseScore) {
  const target = normalise(value);
  if (!text || !target) return 0;
  if (text === target) return baseScore + 80;
  if (phraseInText(text, target)) return baseScore + Math.min(target.length, 40);

  const targetTokens = target.split(' ').filter(token => token.length > 2);
  if (targetTokens.length > 1 && targetTokens.every(token => phraseInText(text, token))) {
    return baseScore - 25 + targetTokens.length;
  }

  return 0;
}

function scoreAreaMatch(input, area = {}) {
  const text = normalise(input);
  if (!text) return { score: 0, matchedAlias: null };

  let bestScore = 0;
  let matchedAlias = null;

  for (const variant of areaVariants(area.area_name || area)) {
    bestScore = Math.max(bestScore, scoreVariantMatch(text, variant, 300));
  }

  for (const alias of area.zone_area_aliases || area.aliases || []) {
    const aliasValue = alias.match_value || alias.alias_name;
    for (const variant of areaVariants(aliasValue)) {
      const score = scoreVariantMatch(text, variant, 240);
      if (score > bestScore) {
        bestScore = score;
        matchedAlias = alias;
      }
    }

    if (alias.street_hint) {
      for (const variant of areaVariants(alias.street_hint)) {
        const score = scoreVariantMatch(text, variant, 120);
        if (score > bestScore) {
          bestScore = score;
          matchedAlias = alias;
        }
      }
    }
  }

  return { score: bestScore, matchedAlias };
}

function areaMatches(input, area) {
  return scoreAreaMatch(input, area).score > 0;
}

function matchedZoneAreaAlias(input, area = {}) {
  return scoreAreaMatch(input, area).matchedAlias;
}

async function loadZones(supabase) {
  if (!zonesPromise) {
    zonesPromise = (async () => {
      let result = await supabase
        .from('zones')
        .select('id, code, name, region, active, zone_areas(id, area_name, rate_band, zone_area_aliases(alias_name, match_value, street_hint, active))')
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

async function loadBusinessDeliveryRates(supabase, businessClientId, businessIdentity = {}) {
  if (!businessClientId) return [];
  if (!businessRatesPromises.has(businessClientId)) {
    businessRatesPromises.set(businessClientId, (async () => {
      const identity = isYdHarvestIdentity(businessIdentity)
        ? businessIdentity
        : await loadBusinessIdentity(supabase, businessClientId);
      const fixedRates = isYdHarvestIdentity(identity)
        ? YD_HARVEST_RATE_ROWS
        : [];
      const result = await supabase
        .from('business_delivery_rates')
        .select('match_type, match_value, delivery_fee, rate_note')
        .eq('business_client_id', businessClientId)
        .eq('active', true)
        .order('match_type');

      if (result.error) {
        console.warn('Business delivery rates could not be loaded:', result.error);
        return fixedRates;
      }

      return mergeBusinessRates(fixedRates, result.data || []);
    })());
  }
  return businessRatesPromises.get(businessClientId);
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

async function resolveGoogleLocation(supabase, payload) {
  const functionsUrl = supabase?.functionsUrl ||
    'https://vgmzzavxhuarlacnvnoz.supabase.co/functions/v1';
  const response = await fetch(
    functionsUrl + '/resolve-google-location',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: 'sb_publishable_riDvZH96FeYGnF0bLYQErg_tlRv71CX'
      },
      body: JSON.stringify(payload)
    }
  );

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const error = new Error(
      data?.message ||
      'Google location lookup returned HTTP ' + response.status + '.'
    );
    error.status = response.status;
    console.error('Location Edge Function error:', error);
    throw error;
  }

  if (!data?.success) {
    return null;
  }

  return data;
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
  let bestMatch = null;
  for (const zone of zones) {
    const areas = zone.zone_areas || [];
    for (const area of areas) {
      const { score, matchedAlias } = scoreAreaMatch(text, area);
      if (score > (bestMatch?.score || 0)) {
        bestMatch = { zone, matchedArea: area, matchedAlias, score };
      }
    }
  }
  return bestMatch;
}

function classifyMatch(match) {
  if (!match?.zone) {
    return {
      status: 'unknown',
      fee: null,
      zoneCode: '',
      zoneName: '',
      region: '',
      matchedArea: '',
      feeLabel: '',
      message: 'Manual confirmation required. We could not match this location to a listed delivery area.'
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
      feeLabel: 'From $60 TTD',
      message: REMOTE_DELIVERY_MESSAGE
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
    feeLabel: `$${Number(STANDARD_FEES[rateBand] || STANDARD_FEES.standard).toFixed(2)} TTD`,
    message: rateBand === 'extended' ? 'Extended delivery area' : (match.zone.region || 'Standard delivery area'),
    disclaimer: DELIVERY_DISCLAIMER
  };
}

function applyBusinessRate(estimate, rates, sourceText) {
  if (!estimate || !Array.isArray(rates) || !rates.length) {
    return estimate;
  }

  const areaRate = rates.find(rate =>
    rate.match_type === "area" &&
    (
      areaMatches(sourceText, rate.match_value) ||
      areaMatches(estimate.matchedArea, rate.match_value)
    )
  );
  const bandRate = rates.find(rate =>
    estimate.fee !== null &&
    rate.match_type === "rate_band" &&
    normalise(rate.match_value) === normalise(estimate.status)
  );
  const rate = areaRate || bandRate;

  if (!rate) return estimate;

  return {
    ...estimate,
    fee: Number(rate.delivery_fee),
    rateBand: "override",
    businessRateApplied: true,
    businessRateMatch: rate.match_value,
    businessRateNote: rate.rate_note || "",
    status: areaRate && estimate.fee === null ? 'business_area' : estimate.status,
    zoneCode: areaRate && estimate.fee === null ? '' : estimate.zoneCode,
    zoneName: areaRate && estimate.fee === null ? '' : estimate.zoneName,
    region: areaRate && estimate.fee === null ? '' : estimate.region,
    message: rate.rate_note || estimate.message
  };
}

export async function estimateDeliveryZone({
  supabase,
  businessClientId = null,
  houseNumber = '',
  streetName = '',
  areaName = '',
  mapsLink = '',
  latitude = null,
  longitude = null,
  businessName = '',
  businessSlug = ''
}) {
  const debug = {
    hasCoordinates: hasUsableCoordinate(latitude) && hasUsableCoordinate(longitude),
    hasMapsLink: Boolean(mapsLink),
    source: '',
    addressFound: false,
    zonesLoaded: false,
    locationError: ''
  };
  const hasCoordinateInput = hasUsableCoordinate(latitude) && hasUsableCoordinate(longitude);
  const hasMapsInput = Boolean(mapsLink);
  const hasManualInput = Boolean(streetName || areaName);
  const shouldUseManualAddress = hasManualInput || (!hasCoordinateInput && !hasMapsInput);
  const manualText = shouldUseManualAddress
    ? [houseNumber, streetName, areaName].filter(Boolean).join(' ')
    : '';

  if (shouldUseManualAddress && (streetName || areaName)) {
    const addressError = validateManualAddress(streetName, areaName);
    if (addressError) {
      debug.locationError = addressError;
    }
  }

    let sourceText = '';
    let sourceLabel = shouldUseManualAddress ? (areaName || streetName || '') : '';
    let resolvedAddress = null;

    if (manualText) {
      debug.source = 'manual';
      sourceText = manualText;
      sourceLabel = areaName || streetName || manualText;
    }

    if (
      !sourceText &&
      hasUsableCoordinate(latitude) &&
      hasUsableCoordinate(longitude)
    ) {
      debug.source = 'gps';

      try {
        resolvedAddress = await withTimeout(
          resolveGoogleLocation(supabase, {
            latitude: Number(latitude),
            longitude: Number(longitude)
          }),
          15000,
          null
        );
      } catch (error) {
        console.warn('Google GPS resolution failed:', error);
        debug.locationError = error?.message || 'Google GPS resolution failed.';
      }

      if (resolvedAddress) {
        sourceText =
          resolvedAddress.searchText ||
          resolvedAddress.formattedAddress ||
          '';

        sourceLabel =
          resolvedAddress.areaName ||
          resolvedAddress.formattedAddress ||
          '';
      } else {
        sourceText = await withTimeout(
          reverseGeocode(Number(latitude), Number(longitude)),
          10000,
          ''
        ) || '';

        sourceLabel = sourceText;
      }
    }

    if (!sourceText && mapsLink) {
      debug.source = 'maps-link';

      try {
        resolvedAddress = await withTimeout(
          resolveGoogleLocation(supabase, {
            mapsLink
          }),
          15000,
          null
        );
      } catch (error) {
        console.warn('Google Maps link resolution failed:', error);
        debug.locationError = error?.message || 'Google Maps link resolution failed.';
      }

      if (resolvedAddress) {
        debug.hasCoordinates = true;

        sourceText =
          resolvedAddress.searchText ||
          resolvedAddress.formattedAddress ||
          '';

        sourceLabel =
          resolvedAddress.areaName ||
          resolvedAddress.formattedAddress ||
          '';
      } else {
        const coords = extractLatLngFromMapsUrl(mapsLink);
        const readableMapsText = coords ? '' : extractTextFromMapsUrl(mapsLink);

        if (coords) {
          debug.hasCoordinates = true;

          sourceText = await withTimeout(
            reverseGeocode(coords.lat, coords.lng),
            10000,
            ''
          ) || '';

          sourceLabel = sourceText;
        } else if (readableMapsText) {
          sourceText = [
            readableMapsText,
            await withTimeout(
              geocodeAddress(readableMapsText),
              10000,
              ''
            )
          ].filter(Boolean).join(' ');
          sourceLabel = readableMapsText;
        }
      }
    }

    debug.addressFound = Boolean(sourceText);


  if (!sourceText) {
  const coordinatesMessage = debug.hasCoordinates
    ? 'Coordinates were captured, but address lookup failed. Enter the street and area manually so we can calculate the delivery fee.'
    : 'The Google Maps location could not be identified. Check the link or enter the address manually.';

  return {
    status: 'unknown',
    fee: null,
    zoneCode: '',
    zoneName: '',
    region: '',
    matchedArea: '',
    sourceText: '',
    label: 'Location could not be identified',
    resolvedAddress: null,
    debug,
    message: coordinatesMessage
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

    if (resolvedAddress && match?.matchedArea?.area_name) {
      resolvedAddress.areaName = match.matchedArea.area_name;
      if (!resolvedAddress.streetName && match.matchedAlias) {
        resolvedAddress.streetName = match.matchedAlias.street_hint || match.matchedAlias.alias_name || match.matchedAlias.match_value || '';
      }
    }

    const estimate = {
      ...classifyMatch(match),
      sourceText,
      resolvedAddress,
      debug,
      label:
        match?.matchedArea?.area_name ||
        sourceLabel ||
        sourceText
    };

    const fixedBusinessRates = isYdHarvestIdentity({
      businessName,
      businessSlug
    })
      ? YD_HARVEST_RATE_ROWS
      : [];
    const businessRates = await withTimeout(
      loadBusinessDeliveryRates(supabase, businessClientId, {
        businessName,
        businessSlug
      }),
      5000,
      fixedBusinessRates
    );

    return applyBusinessRate(estimate, businessRates, sourceText);

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
    rows.push(['Delivery Fee', 'Manual confirmation required']);
  } else if (estimate.status === 'remote') {
    rows.push(['Delivery Fee', estimate.feeLabel || (estimate.fee !== null ? '$' + Number(estimate.fee).toFixed(2) : 'From $60 TTD')]);
  } else {
    rows.push(['Delivery Fee', estimate.feeLabel || `$${Number(estimate.fee).toFixed(2)} TTD`]);
  }

  rows.push(["Zone", estimate.zoneCode ? estimate.zoneName + " - " + estimate.region : estimate.message]);
  if (estimate.status === 'remote') {
    rows.push(['Confirmation', estimate.message]);
  } else if (estimate.disclaimer) {
    rows.push(['Note', estimate.disclaimer]);
  }
  if (estimate.businessRateApplied) {
    rows.push(["Business Rate", estimate.businessRateNote || "Matched " + estimate.businessRateMatch]);
  }
  if (estimate.status === 'unknown' && estimate.debug) {
    rows.push(['Location Source', estimate.debug.source || 'none']);
    rows.push(['Coordinates', estimate.debug.hasCoordinates ? 'Captured' : 'Not available']);
    rows.push(['Address Lookup', estimate.debug.addressFound ? 'Found address text' : 'No address returned']);
    if (estimate.debug.locationError) {
      rows.push(['Lookup Error', estimate.debug.locationError]);
    }
    rows.push(['Zone Data', estimate.debug.zonesLoaded ? 'Loaded' : 'Not loaded']);
  }

  if (!paymentType) return rows;

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
