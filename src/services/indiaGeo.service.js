/**
 * India-first geocoding: Mappls (MapmyIndia) → Google Maps → OpenStreetMap (India-biased).
 * Used by delivery-style apps in India for better address coverage.
 */

const MAPPLS_REV = "https://search.mappls.com/search/address/rev-geocode";
const MAPPLS_GEO = "https://search.mappls.com/search/address/geocode";
const MAPPLS_SUGGEST = "https://search.mappls.com/search/places/autosuggest/json";
const MAPPLS_PLACE = "https://search.mappls.com/search/places/data";

function pickMapProvider() {
  const mappls = String(process.env.MAPPLS_ACCESS_TOKEN || "").trim();
  if (mappls) return { provider: "mappls", mapplsToken: mappls };
  const google = String(process.env.GOOGLE_MAPS_API_KEY || "").trim();
  if (google) return { provider: "google", googleMapsKey: google };
  return { provider: "osm" };
}

function formatIndianAddress(parts) {
  return parts.filter(Boolean).join(", ");
}

function parseMapplsReverse(data) {
  if (!data || typeof data !== "object") return null;
  const results = data.results || data.data || data.response || data;
  const row = Array.isArray(results) ? results[0] : results;
  if (!row || typeof row !== "object") return null;

  const lat = Number(row.lat ?? row.latitude ?? row.copLatitude);
  const lng = Number(row.lng ?? row.longitude ?? row.copLongitude ?? row.lon);
  const address =
    row.formatted_address ||
    row.placeAddress ||
    row.place_address ||
    row.address ||
    row.street_address ||
    (row.houseNumber || row.houseName
      ? formatIndianAddress([
          [row.houseNumber, row.houseName].filter(Boolean).join(" "),
          row.street || row.road,
          row.subLocality || row.sublocality,
          row.locality || row.city,
          row.district,
          row.state,
          row.pincode,
        ])
      : null);

  if (!address && !Number.isFinite(lat)) return null;
  return {
    address: String(address || "").trim(),
    latitude: Number.isFinite(lat) ? lat : null,
    longitude: Number.isFinite(lng) ? lng : null,
    provider: "mappls",
  };
}

function parseMapplsGeocode(data) {
  const parsed = parseMapplsReverse(data);
  if (parsed?.address) return parsed;
  const cop = data?.copResults || data?.cop_results;
  if (cop && typeof cop === "object") {
    return parseMapplsReverse({ results: [cop] });
  }
  return null;
}

function parseMapplsSuggest(data) {
  const out = [];
  const lists = [
    ...(Array.isArray(data?.suggestedLocations) ? data.suggestedLocations : []),
    ...(Array.isArray(data?.userAddedLocations) ? data.userAddedLocations : []),
  ];
  for (const item of lists) {
    const label = item.placeName || item.place_name || item.keyword;
    const address = item.placeAddress || item.place_address || label;
    if (!label && !address) continue;
    out.push({
      id: item.eLoc || item.eloc || `${label}-${address}`,
      label: String(label || address).trim(),
      address: String(address || label).trim(),
      eLoc: item.eLoc || item.eloc || null,
      latitude: item.latitude != null ? Number(item.latitude) : null,
      longitude: item.longitude != null ? Number(item.longitude) : null,
    });
  }
  return out.slice(0, 8);
}

function parseGoogleGeocode(data) {
  const hit = data?.results?.[0];
  if (!hit) return null;
  const loc = hit.geometry?.location;
  const lat = Number(loc?.lat);
  const lng = Number(loc?.lng);
  const address = hit.formatted_address || "";
  if (!address && !Number.isFinite(lat)) return null;
  return {
    address: address.trim(),
    latitude: Number.isFinite(lat) ? lat : null,
    longitude: Number.isFinite(lng) ? lng : null,
    provider: "google",
  };
}

function parseGoogleAutocomplete(data) {
  return (data?.predictions || []).slice(0, 8).map((p) => ({
    id: p.place_id,
    label: p.structured_formatting?.main_text || p.description,
    address: p.description,
    placeId: p.place_id,
    latitude: null,
    longitude: null,
  }));
}

function parseNominatimSearch(data) {
  if (!Array.isArray(data)) return [];
  return data.slice(0, 8).map((hit) => ({
    id: String(hit.place_id || hit.osm_id || hit.display_name),
    label: (hit.display_name || "").split(",").slice(0, 2).join(",").trim(),
    address: hit.display_name,
    latitude: Number(hit.lat),
    longitude: Number(hit.lon),
  }));
}

function parseNominatimReverse(data) {
  if (!data || typeof data !== "object") return null;
  const lat = Number(data.lat);
  const lng = Number(data.lon);
  const address = data.display_name || "";
  if (!address) return null;
  return {
    address: address.trim(),
    latitude: Number.isFinite(lat) ? lat : null,
    longitude: Number.isFinite(lng) ? lng : null,
    provider: "osm",
  };
}

async function mapplsReverse(lat, lng, token) {
  const url = `${MAPPLS_REV}?lat=${lat}&lng=${lng}&region=IND&lang=en&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return parseMapplsReverse(await res.json());
}

async function mapplsForward(address, token) {
  const url = `${MAPPLS_GEO}?address=${encodeURIComponent(address)}&region=IND&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return parseMapplsGeocode(await res.json());
}

async function mapplsSuggest(query, token, location) {
  let url = `${MAPPLS_SUGGEST}?query=${encodeURIComponent(query)}&access_token=${encodeURIComponent(token)}`;
  if (location?.latitude != null && location?.longitude != null) {
    url += `&location=${location.latitude},${location.longitude}`;
  }
  const res = await fetch(url);
  if (!res.ok) return [];
  return parseMapplsSuggest(await res.json());
}

async function mapplsPlaceByEloc(eLoc, token) {
  const url = `${MAPPLS_PLACE}/${encodeURIComponent(eLoc)}?access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  return parseMapplsGeocode(data) || parseMapplsReverse(data);
}

async function googleReverse(lat, lng, key) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${encodeURIComponent(key)}&language=en&region=in`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  if (data.status !== "OK") return null;
  return parseGoogleGeocode(data);
}

async function googleForward(address, key) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&components=country:IN&key=${encodeURIComponent(key)}&language=en&region=in`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  if (data.status !== "OK") return null;
  return parseGoogleGeocode(data);
}

async function googleSuggest(query, key) {
  const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(query)}&components=country:in&key=${encodeURIComponent(key)}&language=en`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  if (data.status !== "OK" && data.status !== "ZERO_RESULTS") return [];
  return parseGoogleAutocomplete(data);
}

async function googlePlaceDetail(placeId, key) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?place_id=${encodeURIComponent(placeId)}&key=${encodeURIComponent(key)}&language=en`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  if (data.status !== "OK") return null;
  return parseGoogleGeocode(data);
}

async function osmReverse(lat, lng) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1&accept-language=en`;
  const res = await fetch(url, { headers: { "User-Agent": "Feeasto/1.0 (location-picker)" } });
  if (!res.ok) return null;
  return parseNominatimReverse(await res.json());
}

async function osmForward(address) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}&countrycodes=in&limit=1&addressdetails=1`;
  const res = await fetch(url, { headers: { "User-Agent": "Feeasto/1.0 (location-picker)" } });
  if (!res.ok) return null;
  const hits = await res.json();
  const hit = hits?.[0];
  if (!hit) return null;
  return {
    address: hit.display_name,
    latitude: Number(hit.lat),
    longitude: Number(hit.lon),
    provider: "osm",
  };
}

async function osmSuggest(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=in&limit=8&addressdetails=0`;
  const res = await fetch(url, { headers: { "User-Agent": "Feeasto/1.0 (location-picker)" } });
  if (!res.ok) return [];
  return parseNominatimSearch(await res.json());
}

async function reverseGeocode(latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { address: "", latitude: null, longitude: null, provider: "none" };
  }

  const mappls = String(process.env.MAPPLS_ACCESS_TOKEN || "").trim();
  if (mappls) {
    const hit = await mapplsReverse(lat, lng, mappls);
    if (hit?.address) return hit;
  }

  const google = String(process.env.GOOGLE_MAPS_API_KEY || "").trim();
  if (google) {
    const hit = await googleReverse(lat, lng, google);
    if (hit?.address) return hit;
  }

  const osm = await osmReverse(lat, lng);
  if (osm?.address) return osm;

  return {
    address: `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
    latitude: lat,
    longitude: lng,
    provider: "coordinates",
  };
}

async function forwardGeocode(address) {
  const q = String(address || "").trim();
  if (q.length < 3) return null;

  const mappls = String(process.env.MAPPLS_ACCESS_TOKEN || "").trim();
  if (mappls) {
    const hit = await mapplsForward(q, mappls);
    if (hit?.latitude != null) return hit;
  }

  const google = String(process.env.GOOGLE_MAPS_API_KEY || "").trim();
  if (google) {
    const hit = await googleForward(q, google);
    if (hit?.latitude != null) return hit;
  }

  return osmForward(q);
}

async function autocomplete(query, location = {}) {
  const q = String(query || "").trim();
  if (q.length < 2) return { suggestions: [], provider: pickMapProvider().provider };

  const mappls = String(process.env.MAPPLS_ACCESS_TOKEN || "").trim();
  if (mappls) {
    const suggestions = await mapplsSuggest(q, mappls, location);
    if (suggestions.length) return { suggestions, provider: "mappls" };
  }

  const google = String(process.env.GOOGLE_MAPS_API_KEY || "").trim();
  if (google) {
    const suggestions = await googleSuggest(q, google);
    if (suggestions.length) return { suggestions, provider: "google" };
  }

  const suggestions = await osmSuggest(q);
  return { suggestions, provider: "osm" };
}

async function resolveSuggestion(suggestion) {
  if (!suggestion) return null;
  if (suggestion.latitude != null && suggestion.longitude != null) {
    return {
      address: suggestion.address || suggestion.label,
      latitude: Number(suggestion.latitude),
      longitude: Number(suggestion.longitude),
      provider: suggestion.provider || pickMapProvider().provider,
    };
  }

  const mappls = String(process.env.MAPPLS_ACCESS_TOKEN || "").trim();
  if (mappls && suggestion.eLoc) {
    const hit = await mapplsPlaceByEloc(suggestion.eLoc, mappls);
    if (hit) return { ...hit, address: hit.address || suggestion.address };
  }

  const google = String(process.env.GOOGLE_MAPS_API_KEY || "").trim();
  if (google && suggestion.placeId) {
    const hit = await googlePlaceDetail(suggestion.placeId, google);
    if (hit) return hit;
  }

  const addr = suggestion.address || suggestion.label;
  if (addr) return forwardGeocode(addr);
  return null;
}

function getGeoConfigForClient() {
  const cfg = pickMapProvider();
  return {
    /** Leaflet/OSM map tiles in the popup (no API key). */
    mapProvider: "leaflet",
    /** Backend geocoding/search provider. */
    geocodeProvider: cfg.provider,
    provider: cfg.provider,
    labels: {
      mappls: "Mappls (MapmyIndia)",
      google: "Google Maps",
      osm: "OpenStreetMap",
    },
    hint: null,
  };
}

module.exports = {
  pickMapProvider,
  getGeoConfigForClient,
  reverseGeocode,
  forwardGeocode,
  autocomplete,
  resolveSuggestion,
};
