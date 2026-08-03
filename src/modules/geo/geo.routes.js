const express = require("express");
const { z } = require("zod");
const {
  getGeoConfigForClient,
  reverseGeocode,
  forwardGeocode,
  autocomplete,
  resolveSuggestion,
} = require("../../services/indiaGeo.service");

const router = express.Router();

router.get("/config", (_req, res) => {
  return res.json(getGeoConfigForClient());
});

router.get("/reverse", async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ message: "Valid lat and lng query parameters are required." });
  }
  try {
    const result = await reverseGeocode(lat, lng);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: "Reverse geocode failed.", details: error.message });
  }
});

router.get("/forward", async (req, res) => {
  const address = String(req.query.address || "").trim();
  if (address.length < 3) {
    return res.status(400).json({ message: "Address query must be at least 3 characters." });
  }
  try {
    const result = await forwardGeocode(address);
    if (!result) return res.status(404).json({ message: "No location found for this address." });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: "Geocode failed.", details: error.message });
  }
});

router.get("/autocomplete", async (req, res) => {
  const query = String(req.query.q || req.query.query || "").trim();
  const lat = req.query.lat != null ? Number(req.query.lat) : null;
  const lng = req.query.lng != null ? Number(req.query.lng) : null;
  if (query.length < 2) {
    return res.json({ suggestions: [], provider: getGeoConfigForClient().provider });
  }
  try {
    const location =
      Number.isFinite(lat) && Number.isFinite(lng) ? { latitude: lat, longitude: lng } : {};
    const result = await autocomplete(query, location);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: "Autocomplete failed.", details: error.message });
  }
});

router.post("/resolve", async (req, res) => {
  const schema = z.object({
    suggestion: z.object({}).passthrough(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  try {
    const result = await resolveSuggestion(parsed.data.suggestion);
    if (!result) return res.status(404).json({ message: "Could not resolve this place." });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: "Resolve failed.", details: error.message });
  }
});

module.exports = router;
