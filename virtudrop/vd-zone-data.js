export const DELIVERY_DISCLAIMER = 'Delivery rates are based on general service areas. Exact pricing may vary for locations significantly outside the normal route or with difficult access. We are happy to confirm the applicable fee before delivery.';
export const REMOTE_DELIVERY_MESSAGE = 'Remote Area - Delivery from TT$60. Final fee to be confirmed.';

const zoneRows = [
  ['A', 'A - Central', 'Central', 'standard', ['Balmain', 'Bonne Aventure', 'Brechin Castle', 'Calcutta No. 1, 2 & 3', 'Calcutta Settlement', 'California', 'Carapichaima', 'Carlsen Field', 'Caroni', 'Cedar Hill', 'Chaguanas', 'Charlieville', 'Chase Village', 'Chin Chin', 'Claxton Bay', 'Couva', 'Cunupia', 'Dow Village', 'Edinburgh 500', 'Edinburgh Gardens', 'Endeavour', 'Enterprise', 'Freeport', 'Jerningham Junction', 'Joyland', 'Lange Park', 'Longdenville', 'Mc Bean', 'Mission Road', 'Montrose', 'Munroe Road', 'Orange Valley', 'Palmiste (Chaguanas)', 'Phoenix Park', 'Pierre Road', 'Point Lisas', 'Preysal', 'Ragoo Road', 'Railway Road', 'Reform', 'Rodney Road', 'Southern Main Road', "St. Mary's Village", 'Union Village', 'Warren/Warren Village', 'Waterloo', 'Welcome Road']],
  ['B', 'B - South', 'South', 'standard', ['Battoo Avenue', 'Cipero Road', 'Cocoyea', 'Coffee Street', 'Corinth', 'Debe', 'Downtown San Fernando', 'Duncan Village', 'Embacadere', 'Golconda', 'Gulf View', 'Gasparillo North', 'Hermitage', 'La Romain', 'Macaulay', 'Marabella', 'Maraj Lands', 'Mon Repos', 'Palmiste', 'Paradise', 'Pleasantville', 'Pleasantville Extension', 'Romain Lands', 'San Fernando', 'St. Madeleine', 'Tarouba', 'Union Hall', 'Vistabella', 'Vistabella Heights']],
  ['C', 'C - East', 'East', 'standard', ['Arouca', 'Curepe', "D'Abadie", 'El Dorado', 'Five Rivers', 'Frederick Settlement', 'Kelly Village', 'La Horquetta', 'Macoya', 'Mausica', 'Mount Hope', "O'Meara", 'Oropune', 'Paradise', 'Piarco', 'St. Augustine', 'St. Augustine South', 'St. Helena', 'Tacarigua', 'Trincity', 'Trincity Industrial Estate', 'Tunapuna', 'Valsayn', 'Valsayn North/South', 'Arima up to approximately Tumpuna Road']],
  ['D', 'D - North/West', 'North/West', 'standard', ['Aranguez', 'Bamboo Settlement', 'Barataria', 'Champs Fleurs', 'El Socorro', 'El Socorro Extension', 'Federation Park', 'Mt. Lambert', 'Petit Bourg', 'Port of Spain', 'San Juan', "St. Ann's", 'St. Clair', 'Woodbrook', 'Locations up to approximately Mucurapo Road']],
  ['A', 'A - Central', 'Central', 'extended', ['Arena', 'Esmeralda (Inside)', 'Las Lomas', 'Madras', 'Orange Grove', 'St. Helena Eastern Sections', 'Todds Road', 'Todds Road Station', 'Accessible/main-road areas of Gran Couva']],
  ['B', 'B - South', 'South', 'extended', ['Brasso Caparo', 'Princes Town', 'Williamsville', 'Oropouche', 'San Francique', 'Accessible/main-road sections of Aripero']],
  ['C', 'C - East', 'East', 'extended', ['Arima beyond the standard boundary', 'Malabar', 'Santa Rosa', 'Guaico', 'Valencia', 'Wallerfield', 'Cumuto', 'Guanapo', 'Lopinot']],
  ['D', 'D - North/West', 'North/West', 'extended', ['Blue Basin', 'Blue Range', 'Boissiere', 'Cascade', 'Diamond Vale', 'Diego Martin', 'Glencoe', 'Lady Chancellor', 'Maraval', 'Moka', 'Petit Valley', 'St. James', 'Upper St. James', 'Westmoorings', 'Locations west of the standard Mucurapo boundary']],
  ['A', 'A - Central/Interior', 'Central/Interior', 'remote', ['Deep Gran Couva', 'Deep Arena', 'Tabaquite/interior', 'Other difficult-access Central locations']],
  ['B', 'B - South', 'South', 'remote', ['Barrackpore/interior', 'Penal Rock Road', "Brother's Road deep Fifth/Sixth Company", 'Aripero/Avocat interior', 'La Brea', 'Rousillac', 'Point Fortin', 'Other deep South locations']],
  ['C', 'C - East', 'East', 'remote', ['Sangre Grande', 'Heights of Guanapo', 'Surrey Village', 'Locations significantly beyond Valencia/Wallerfield']],
  ['D', 'D - North/West', 'North/West', 'remote', ['Carenage', 'Chaguaramas', 'Paramin', 'Difficult-access hillside/interior locations']]
];

const areaAliases = {
  'St. Augustine': ['Saint Augustine'],
  'St. Augustine South': ['Saint Augustine South'],
  'St. Helena': ['Saint Helena'],
  'St. Helena Eastern Sections': ['Saint Helena Eastern Sections'],
  "St. Ann's": ['St Anns', 'Saint Anns', "Saint Ann's"],
  'Mc Bean': ['McBean'],
  'Mt. Lambert': ['Mount Lambert'],
  'Gasparillo North': ['Gasparillo'],
  'Accessible/main-road areas of Gran Couva': ['Gran Couva'],
  'Arima up to approximately Tumpuna Road': ['Arima', 'Tumpuna Road'],
  'Arima beyond the standard boundary': ['Arima beyond Tumpuna', 'Arima Heights'],
  'Locations up to approximately Mucurapo Road': ['Mucurapo Road'],
  'Locations west of the standard Mucurapo boundary': ['West of Mucurapo', 'Mucurapo West']
};

export const DELIVERY_ZONE_DATA = zoneRows.reduce((zones, [code, name, region, rateBand, areas]) => {
  let zone = zones.find(item => item.code === code);
  if (!zone) {
    zone = { id: `local-${code}`, code, name, region, active: true, zone_areas: [] };
    zones.push(zone);
  }
  zone.zone_areas.push(...areas.map(areaName => ({
    id: `local-${code}-${rateBand}-${areaName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    area_name: areaName,
    rate_band: rateBand,
    zone_area_aliases: (areaAliases[areaName] || []).map(alias => ({ alias_name: alias, match_value: alias, street_hint: '', active: true }))
  })));
  return zones;
}, []);

export function cloneDeliveryZoneData() {
  return DELIVERY_ZONE_DATA.map(zone => ({
    ...zone,
    zone_areas: zone.zone_areas.map(area => ({
      ...area,
      zone_area_aliases: [...(area.zone_area_aliases || [])]
    }))
  }));
}

export function deliveryAreaOptions() {
  return DELIVERY_ZONE_DATA.flatMap(zone =>
    zone.zone_areas.map(area => ({
      zoneCode: zone.code,
      zoneName: zone.name,
      region: zone.region,
      areaName: area.area_name,
      rateBand: area.rate_band || 'standard'
    }))
  ).sort((a, b) => a.areaName.localeCompare(b.areaName));
}
