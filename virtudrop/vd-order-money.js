export const PAYMENT_ARRANGEMENTS = Object.freeze({
  cod: 'cod_customer_pays',
  'pkg-online': 'delivery_only_customer_pays',
  'all-online': 'client_pays_delivery'
});

export function normaliseAddressPart(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const KNOWN_DELIVERY_AREAS = new Set([
  'Chaguanas', 'Endeavour', 'Enterprise', 'Edinburgh 500', 'Edinburgh Gardens', 'Montrose',
  'Lange Park', 'Charlieville', 'Felicity', 'Felicity Hall', 'Cunupia', 'Freeport',
  'Calcutta Road', 'Calcutta Settlement', 'Orange Valley', 'Carlsen Field', 'Mc Bean',
  'Jerningham Junction', 'Chase Village', 'Waterloo', 'Carapichaima', 'St Marys Village',
  'Reform Village', 'Gasparillo', 'Bonne Aventure', 'Claxton Bay', 'Cedar Hill', 'Couva',
  'Point Lisas', 'Phoenix Park', 'Preysal', 'Gran Couva', 'Balmain', 'California', 'Dow Village',
  'Brechin Castle', 'Union Village', 'Spring Village', 'Macaulay', 'San Fernando', 'Marabella',
  'Tarouba', 'Maraj Lands', 'Vistabella', 'Pleasantville', 'Cocoyea', 'Gulf View', 'La Romain',
  'Palmiste', 'Rambert', 'Duncan Village', 'Penal', 'Debe', 'Barrackpore', 'Woodland',
  'New Grant', 'Tableland', 'Princes Town', 'Corinth', 'Golconda', 'Mon Repos', 'St Madeleine',
  'Hermitage', 'Fifth Company', 'Sixth Company', 'Piparo', 'Brasso Caparo', 'Williamsville',
  'Brothers Road', 'Brothers Settlement', 'Indian Walk', 'Valsayn', 'Curepe', 'St Augustine',
  'Tunapuna', 'Tacarigua', 'El Dorado', 'Trincity', 'Five Rivers', 'Arouca', "D'Abadie",
  'Maloney', 'Mausica', 'Piarco', 'Oropuna', 'Wallerfield', "O'Meara", 'Cumuto',
  'Sangre Grande', 'Sangre Grande Proper', 'Guaico', 'Valencia', 'Arima', 'Aranguez',
  'Carapo', 'La Horquetta', 'Malabar', 'Santa Rosa', 'Lopinot', 'Guanapo', 'Heights of Guanapo',
  'Caroni', 'St Helena', 'Kelly Village', 'Bamboo Village', 'El Socorro', 'Barataria',
  'San Juan', 'Champs Fleurs', 'Petit Bourg', 'Mt Lambert', 'Macoya', 'Port of Spain',
  'Woodbrook', 'St James', 'St Clair', 'Belmont', 'Laventille', 'Morvant', 'Cascade', 'Maraval',
  'Moka', 'Lady Chancellor', 'Diego Martin', 'Petit Valley', 'Glencoe', 'Westmoorings',
  'Blue Range', 'Blue Basin', 'Boissiere', 'Federation Park', "St Ann's", 'Santa Cruz',
  'Carenage', 'Chaguaramas'
].map(normaliseAddressPart));

export function validateManualAddress(streetName, areaName) {
  const street = normaliseAddressPart(streetName);
  const area = normaliseAddressPart(areaName);
  const streetWithoutSuffix = street.replace(/\s+(area|community|village)$/, '').trim();
  const invalidStreetValues = new Set(['na', 'n a', 'none', 'unknown', 'same', 'same as area']);

  if (street.length < 3) return 'Enter the actual street, road, building or landmark.';
  if (area.length < 2) return 'Enter the delivery area or community.';
  if (
    invalidStreetValues.has(street) ||
    street === area ||
    streetWithoutSuffix === area ||
    KNOWN_DELIVERY_AREAS.has(street) ||
    KNOWN_DELIVERY_AREAS.has(streetWithoutSuffix)
  ) {
    return 'Enter the actual street, road, building or landmark. The area name cannot be used as the street name.';
  }
  return '';
}

export function calculateOrderMoney({
  paymentOption,
  packageValue = 0,
  deliveryFee = null,
  pickupRequired = false,
  pickupParcelCount = 1,
  clientFeeSettlement = null
}) {
  const arrangement = PAYMENT_ARRANGEMENTS[paymentOption] || paymentOption || '';
  const packageAmount = Math.max(Number(packageValue) || 0, 0);
  const fee = deliveryFee === null || deliveryFee === undefined ? null : Math.max(Number(deliveryFee) || 0, 0);
  const pickupFee = pickupRequired && Number(pickupParcelCount || 1) < 5 ? 20 : 0;
  const clientPaysDelivery = arrangement === 'client_pays_delivery';

  let customerAmountDue = null;
  let driverAmountToCollect = null;
  if (fee !== null) {
    if (arrangement === 'cod_customer_pays') customerAmountDue = packageAmount + fee;
    else if (arrangement === 'delivery_only_customer_pays') customerAmountDue = fee;
    else customerAmountDue = 0;
    driverAmountToCollect = customerAmountDue;
  }

  return {
    financialModelVersion: 2,
    paymentArrangement: arrangement,
    deliveryFeePayer: clientPaysDelivery ? 'client' : 'customer',
    clientFeeSettlement: clientPaysDelivery ? (clientFeeSettlement || 'pay_separately') : null,
    packageValue: packageAmount,
    deliveryFee: fee,
    pickupFee,
    customerAmountDue,
    driverAmountToCollect,
    clientAmountDue: pickupFee + (clientPaysDelivery ? (fee || 0) : 0),
    clientRemittanceAmount: arrangement === 'cod_customer_pays' ? packageAmount : 0
  };
}

export function financialRequestFields(money) {
  return {
    financial_model_version: money.financialModelVersion,
    payment_arrangement: money.paymentArrangement,
    delivery_fee_payer: money.deliveryFeePayer,
    client_fee_settlement: money.clientFeeSettlement,
    currency: 'TTD',
    customer_amount_due: money.customerAmountDue,
    driver_amount_to_collect: money.driverAmountToCollect,
    client_amount_due: money.clientAmountDue,
    client_remittance_amount: money.clientRemittanceAmount,
    pickup_fee: money.pickupFee
  };
}

export function moneyLabel(value) {
  return value === null || value === undefined ? 'To be quoted' : `$${Number(value).toFixed(2)}`;
}
