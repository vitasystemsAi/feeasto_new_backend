const express = require("express");
const auth = require("../../middlewares/auth");
const {
  fetchActiveAds,
  getCustomerAdLocation,
  recordAdImpression,
  recordAdClick,
} = require("../portal/services/customerAds");

const router = express.Router();

function clientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || null;
}

router.get("/ads", auth(false), async (req, res) => {
  try {
    let customerLocation = null;
    const qPin = String(req.query.pincode || "").trim();
    const qDist = String(req.query.district || "").trim();
    if (qPin || qDist) {
      customerLocation = { pincode: qPin || undefined, district: qDist || undefined };
    } else if (req.user?.sub) {
      customerLocation = await getCustomerAdLocation(req.user.sub);
    }
    const ads = await fetchActiveAds({
      adType: req.query.type || req.query.ad_type,
      customerLocation,
    });
    return res.json({ success: true, ads });
  } catch (err) {
    console.error("[customer] ads fetch failed:", err.message);
    return res.status(500).json({ success: false, message: "Failed to load ads", ads: [] });
  }
});

router.post("/ads/:id/impression", auth(false), async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid ad id" });
  try {
    await recordAdImpression(id, req.user?.sub || null, clientIp(req));
    return res.status(204).end();
  } catch (err) {
    console.error("[customer] impression failed:", err.message);
    return res.status(500).json({ message: "Failed to record impression" });
  }
});

router.post("/ads/:id/click", auth(false), async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ message: "Invalid ad id" });
  try {
    await recordAdClick(id, req.user?.sub || null, clientIp(req));
    return res.status(204).end();
  } catch (err) {
    console.error("[customer] click failed:", err.message);
    return res.status(500).json({ message: "Failed to record click" });
  }
});

module.exports = router;
