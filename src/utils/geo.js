/** Haversine distance in kilometres between two WGS84 points. */
function haversineKm(lat1, lon1, lat2, lon2) {
  const a1 = Number(lat1);
  const o1 = Number(lon1);
  const a2 = Number(lat2);
  const o2 = Number(lon2);
  if (![a1, o1, a2, o2].every((n) => Number.isFinite(n))) return null;
  const R = 6371;
  const dLat = ((a2 - a1) * Math.PI) / 180;
  const dLon = ((o2 - o1) * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a1 * Math.PI) / 180) * Math.cos((a2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  return Math.round(R * c * 10) / 10;
}

function parseCoord(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function hasCoords(lat, lng) {
  return parseCoord(lat) != null && parseCoord(lng) != null;
}

function attachDistanceKm(rows, customerLat, customerLng, options = {}) {
  const latKey = options.latKey || "latitude";
  const lngKey = options.lngKey || "longitude";
  const cLat = parseCoord(customerLat);
  const cLng = parseCoord(customerLng);
  return (rows || []).map((row) => {
    const distance_km = hasCoords(cLat, cLng) && hasCoords(row[latKey], row[lngKey])
      ? haversineKm(cLat, cLng, row[latKey], row[lngKey])
      : null;
    return { ...row, distance_km };
  });
}

/** Max distance (km) from customer location to order from a restaurant (browse + checkout). */
const CUSTOMER_ORDER_RADIUS_KM = 15;

/** Max distance (metres) for partner to mark an order delivered at the customer pin. */
const DELIVERY_ARRIVAL_RADIUS_M = 120;

/** Max distance (metres) for partner to mark picked up at the restaurant. */
const RESTAURANT_PICKUP_RADIUS_M = 50;

function haversineMeters(lat1, lon1, lat2, lon2) {
  const km = haversineKm(lat1, lon1, lat2, lon2);
  if (km == null) return null;
  return Math.round(km * 1000);
}

function proximityCheck(partnerLat, partnerLng, targetLat, targetLng, radiusM) {
  const pLat = parseCoord(partnerLat);
  const pLng = parseCoord(partnerLng);
  const tLat = parseCoord(targetLat);
  const tLng = parseCoord(targetLng);
  if (pLat == null || pLng == null || tLat == null || tLng == null) {
    return {
      atLocation: false,
      distanceM: null,
      missingPartnerCoords: pLat == null || pLng == null,
      missingTargetCoords: tLat == null || tLng == null,
      radiusM,
    };
  }
  const distanceM = haversineMeters(pLat, pLng, tLat, tLng);
  return {
    atLocation: distanceM != null && distanceM <= radiusM,
    distanceM,
    missingPartnerCoords: false,
    missingTargetCoords: false,
    radiusM,
  };
}

function isWithinDeliveryRadius(partnerLat, partnerLng, customerLat, customerLng, radiusM = DELIVERY_ARRIVAL_RADIUS_M) {
  const r = proximityCheck(partnerLat, partnerLng, customerLat, customerLng, radiusM);
  return {
    atLocation: r.atLocation,
    distanceM: r.distanceM,
    missingPartnerCoords: r.missingPartnerCoords,
    missingCustomerCoords: r.missingTargetCoords,
    radiusM: r.radiusM,
  };
}

function isWithinRestaurantPickupRadius(
  partnerLat,
  partnerLng,
  restaurantLat,
  restaurantLng,
  radiusM = RESTAURANT_PICKUP_RADIUS_M
) {
  const r = proximityCheck(partnerLat, partnerLng, restaurantLat, restaurantLng, radiusM);
  return {
    atLocation: r.atLocation,
    distanceM: r.distanceM,
    missingPartnerCoords: r.missingPartnerCoords,
    missingRestaurantCoords: r.missingTargetCoords,
    radiusM: r.radiusM,
  };
}

function isWithinCustomerOrderRadiusKm(distanceKm, maxKm = CUSTOMER_ORDER_RADIUS_KM) {
  const d = Number(distanceKm);
  if (!Number.isFinite(d) || d < 0) return false;
  return d <= maxKm;
}

/** Keep only rows with distance_km within the customer order radius (requires prior attachDistanceKm). */
function filterRestaurantsWithinCustomerRadius(
  rows,
  customerLat,
  customerLng,
  maxKm = CUSTOMER_ORDER_RADIUS_KM
) {
  const cLat = parseCoord(customerLat);
  const cLng = parseCoord(customerLng);
  if (cLat == null || cLng == null) return rows || [];
  return (rows || []).filter((row) => isWithinCustomerOrderRadiusKm(row.distance_km, maxKm));
}

/**
 * Whether a customer may order from this restaurant at the given location.
 * @returns {{ allowed: boolean, reason: string|null, message: string|null, distance_km: number|null }}
 */
function evaluateCustomerRestaurantRadius(
  restaurant,
  customerLat,
  customerLng,
  maxKm = CUSTOMER_ORDER_RADIUS_KM
) {
  const cLat = parseCoord(customerLat);
  const cLng = parseCoord(customerLng);
  if (cLat == null || cLng == null) {
    return {
      allowed: false,
      reason: "LOCATION_REQUIRED",
      message: "Set your delivery location to see and order from nearby restaurants.",
      distance_km: null,
      order_radius_km: maxKm,
    };
  }
  const rLat = parseCoord(restaurant?.latitude ?? restaurant?.lat);
  const rLng = parseCoord(restaurant?.longitude ?? restaurant?.lng);
  if (rLat == null || rLng == null) {
    return {
      allowed: false,
      reason: "RESTAURANT_LOCATION_MISSING",
      message: "This restaurant is not available for orders in your area.",
      distance_km: null,
      order_radius_km: maxKm,
    };
  }
  const distance_km = haversineKm(cLat, cLng, rLat, rLng);
  if (distance_km == null || distance_km > maxKm) {
    const shown = distance_km != null ? `${distance_km} km` : "too far";
    return {
      allowed: false,
      reason: "OUT_OF_ORDER_RADIUS",
      message: `This restaurant is ${shown} away. You can only order from restaurants within ${maxKm} km.`,
      distance_km: distance_km ?? null,
      order_radius_km: maxKm,
    };
  }
  return {
    allowed: true,
    reason: null,
    message: null,
    distance_km,
    order_radius_km: maxKm,
  };
}

module.exports = {
  haversineKm,
  haversineMeters,
  parseCoord,
  hasCoords,
  attachDistanceKm,
  CUSTOMER_ORDER_RADIUS_KM,
  isWithinCustomerOrderRadiusKm,
  filterRestaurantsWithinCustomerRadius,
  evaluateCustomerRestaurantRadius,
  DELIVERY_ARRIVAL_RADIUS_M,
  RESTAURANT_PICKUP_RADIUS_M,
  isWithinDeliveryRadius,
  isWithinRestaurantPickupRadius,
};
