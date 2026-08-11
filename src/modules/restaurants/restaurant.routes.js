const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { z } = require("zod");
const pool = require("../../db/pool");
const auth = require("../../middlewares/auth");
const rbac = require("../../middlewares/rbac");
const { platformApprover } = require("../../middlewares/platformApprover");
const tenantScope = require("../../middlewares/tenant");
const { enrichBrowseMenuItems, parseMenuItemDescription } = require("../../utils/menuItemDescription");
const {
  resolveMenuItemUploadPath,
  resolveMenuItemDiskPath,
  uploadFileExists,
  normalizeStoredUploadPath,
} = require("../../utils/menuUploadIndex");
const { uploadDir } = require("../../config/uploads");
const {
  attachDistanceKm,
  parseCoord,
  CUSTOMER_ORDER_RADIUS_KM,
  filterRestaurantsWithinCustomerRadius,
  evaluateCustomerRestaurantRadius,
} = require("../../utils/geo");
const { parseStructuredAddressFromBody } = require("../../utils/structuredAddress");
const { VENDOR_TYPE_KEYS, getVendorTypeLabel, getVendorTypeConfig } = require("../../config/vendorTypes");

function resolveRestaurantAddressFromRequest(body) {
  const structured = parseStructuredAddressFromBody(body);
  if (structured.ok) return structured.data;
  return { ok: false, errors: structured.errors };
}

function enrichRestaurantAddressFields(row) {
  if (!row) return row;
  return {
    ...row,
    address_village: row.address_village ?? null,
    address_city: row.address_city ?? null,
    address_district: row.address_district ?? null,
    address_state: row.address_state ?? null,
    address_country: row.address_country ?? "India",
    address_pincode: row.address_pincode ?? null,
  };
}

const router = express.Router();
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

async function streamMenuItemImageFile(req, res, { restaurantId, itemId }) {
  const rid = Number(restaurantId);
  const iid = Number(itemId);
  if (!Number.isFinite(rid) || rid <= 0 || !Number.isFinite(iid) || iid <= 0) {
    return res.status(400).json({ message: "Valid restaurant and item id required" });
  }

  const [rows] = await pool.execute(
    "SELECT id, name, description FROM menu_items WHERE id = ? AND restaurant_id = ? AND is_active = 1 LIMIT 1",
    [iid, rid]
  );
  if (!rows.length) return res.status(404).json({ message: "Menu item not found" });

  const meta = parseMenuItemDescription(rows[0].description);
  const webPath = resolveMenuItemUploadPath(rows[0].name, meta.imageUrl);
  const diskPath = resolveMenuItemDiskPath(webPath);
  if (!diskPath) return res.status(404).json({ message: "Image file not found" });

  return res.sendFile(diskPath);
}
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    const safeBase = (path.basename(file.originalname, ext) || "file").replace(/[^a-zA-Z0-9-_]/g, "-");
    cb(null, `${Date.now()}-${safeBase}${ext}`);
  },
});
const upload = multer({ storage });
let hasMenuItemsIsAvailableColumnCache = null;
let hasIsOnlineColumnCache = null;

async function ensureIsOnlineColumn() {
  if (hasIsOnlineColumnCache === true) return true;
  const [rows] = await pool.execute(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'restaurants' AND COLUMN_NAME = 'is_online' LIMIT 1`
  );
  if (rows.length > 0) {
    hasIsOnlineColumnCache = true;
    return true;
  }
  try {
    await pool.execute(
      "ALTER TABLE restaurants ADD COLUMN is_online TINYINT(1) NOT NULL DEFAULT 1 AFTER is_active"
    );
    hasIsOnlineColumnCache = true;
    return true;
  } catch (error) {
    if (error?.code === "ER_DUP_FIELDNAME") {
      hasIsOnlineColumnCache = true;
      return true;
    }
    return false;
  }
}

function customerLocationFromQuery(req) {
  return {
    customerLat: parseCoord(req.query.customerLat ?? req.query.lat),
    customerLng: parseCoord(req.query.customerLng ?? req.query.lng),
  };
}

async function loadRestaurantCoords(restaurantId) {
  try {
    const [[row]] = await pool.execute(
      `SELECT id, latitude, longitude FROM restaurants
       WHERE id = ? AND approval_status = 'APPROVED' AND is_active = 1 LIMIT 1`,
      [restaurantId]
    );
    return row || null;
  } catch (error) {
    if (error?.code !== "ER_BAD_FIELD_ERROR") throw error;
    return null;
  }
}

/** CUSTOMER browse/order: enforce 15 km radius when customer coordinates are sent. */
async function enforceCustomerOrderRadius(req, res, restaurantId) {
  if (req.user?.role !== "CUSTOMER") return true;
  const { customerLat, customerLng } = customerLocationFromQuery(req);
  const row = await loadRestaurantCoords(restaurantId);
  if (!row) {
    res.status(404).json({ message: "Restaurant not found." });
    return false;
  }
  const check = evaluateCustomerRestaurantRadius(row, customerLat, customerLng);
  if (!check.allowed) {
    const status = check.reason === "LOCATION_REQUIRED" ? 400 : 403;
    res.status(status).json({
      message: check.message,
      code: check.reason,
      distance_km: check.distance_km,
      order_radius_km: check.order_radius_km ?? CUSTOMER_ORDER_RADIUS_KM,
    });
    return false;
  }
  return true;
}

async function canBrowseRestaurant(restaurantId, userId) {
  await ensureIsOnlineColumn();
  const [approved] = await pool.execute(
    `SELECT id FROM restaurants
     WHERE id = ? AND approval_status = 'APPROVED' AND is_active = 1 AND is_online = 1
     LIMIT 1`,
    [restaurantId]
  );
  if (approved.length) return true;
  if (!userId) return false;
  const [sub] = await pool.execute(
    `SELECT id FROM subscription_subscribers
     WHERE restaurant_id = ? AND user_id = ? AND status IN ('ACTIVE','PAUSED')
     LIMIT 1`,
    [restaurantId, userId]
  );
  return sub.length > 0;
}

async function ensureMenuItemsIsAvailableColumn() {
  if (hasMenuItemsIsAvailableColumnCache === true) return true;

  const [rows] = await pool.execute(
    `SELECT 1
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'menu_items'
       AND COLUMN_NAME = 'is_available'
     LIMIT 1`
  );

  if (rows.length > 0) {
    hasMenuItemsIsAvailableColumnCache = true;
    return true;
  }

  // Auto-migrate legacy databases so availability toggle works without manual SQL.
  try {
    await pool.execute("ALTER TABLE menu_items ADD COLUMN is_available TINYINT(1) NOT NULL DEFAULT 1");
    hasMenuItemsIsAvailableColumnCache = true;
    return true;
  } catch (error) {
    if (error?.code === "ER_DUP_FIELDNAME") {
      hasMenuItemsIsAvailableColumnCache = true;
      return true;
    }
    hasMenuItemsIsAvailableColumnCache = false;
    return false;
  }
}

router.post(
  "/onboard",
  auth(),
  rbac("OWNER"),
  upload.fields([
    { name: "companyRegistrationCertificate", maxCount: 1 },
    { name: "tradeLicense", maxCount: 1 },
    { name: "fssaiLicense", maxCount: 1 },
    { name: "gstRegistration", maxCount: 1 },
    { name: "restaurantPhotos", maxCount: 6 },
    { name: "restaurantLogo", maxCount: 1 },
  ]),
  async (req, res) => {
  try {
  const schema = z.object({
    name: z.string().min(2),
    slug: z.string().min(2),
    description: z.string().optional(),
    address: z.string().min(8).optional(),
    village: z.string().optional(),
    city: z.string().optional(),
    district: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional(),
    pincode: z.string().optional(),
    latitude: z.coerce.number().min(-90).max(90).optional(),
    longitude: z.coerce.number().min(-180).max(180).optional(),
    companyRegistrationNumber: z.string().optional(),
    tradeLicenseNumber: z.string().optional(),
    fssaiNumber: z.string().optional(),
    gstNumber: z.string().optional(),
    businessType: z.enum(VENDOR_TYPE_KEYS).optional().default("restaurant"),
    vendorConfig: z.string().optional(), // JSON string from FormData
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => {
        const field = issue.path?.[0] || "field";
        return `${field}: ${issue.message}`;
      })
      .join("; ");
    return res.status(400).json({ message, errors: parsed.error.issues });
  }

  const getFileUrl = (fieldName) => {
    const file = req.files?.[fieldName]?.[0];
    return file ? `/uploads/${file.filename}` : null;
  };
  const photoUrls = (req.files?.restaurantPhotos || []).map((file) => `/uploads/${file.filename}`);
  const compliancePayload = {
    documents: {
      companyRegistrationCertificate: getFileUrl("companyRegistrationCertificate"),
      tradeLicense: getFileUrl("tradeLicense"),
      fssaiLicense: getFileUrl("fssaiLicense"),
      gstRegistration: getFileUrl("gstRegistration"),
    },
    numbers: {
      companyRegistrationNumber: parsed.data.companyRegistrationNumber || null,
      tradeLicenseNumber: parsed.data.tradeLicenseNumber || null,
      fssaiNumber: parsed.data.fssaiNumber || null,
      gstNumber: parsed.data.gstNumber || null,
    },
    photos: photoUrls,
    logo: getFileUrl("restaurantLogo"),
  };
  // In early-stage onboarding we allow missing compliance docs; admins can still reject on verification.

  const { name, slug, description, businessType = "restaurant" } = parsed.data;
  const businessTypeLabel = getVendorTypeLabel(businessType);
  // Parse vendor config: custom overrides merged over type defaults
  let vendorConfigObj = getVendorTypeConfig(businessType);
  if (parsed.data.vendorConfig) {
    try {
      const supplied = JSON.parse(parsed.data.vendorConfig);
      vendorConfigObj = { ...vendorConfigObj, ...supplied };
    } catch { /* ignore malformed JSON */ }
  }
  const addrResolved = resolveRestaurantAddressFromRequest({ ...parsed.data, ...req.body });
  if (!addrResolved || addrResolved.ok === false) {
    return res.status(400).json({
      message: "Valid address is required (village, city, district, state, pincode).",
      errors: addrResolved?.errors,
    });
  }
  const address = addrResolved.formattedAddress;
  const lat = addrResolved.latitude ?? parseCoord(parsed.data.latitude);
  const lng = addrResolved.longitude ?? parseCoord(parsed.data.longitude);
  let result;
  try {
    [result] = await pool.execute(
      `INSERT INTO restaurants (tenant_id, name, slug, description, address,
       address_village, address_city, address_district, address_state, address_country, address_pincode,
       latitude, longitude, owner_user_id, kyc_document_url, approval_status, business_type, business_type_label, vendor_config)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
      [
        req.user.tenantId ? Number(req.user.tenantId) : null,
        name,
        slug,
        description || null,
        address,
        addrResolved.village,
        addrResolved.city || null,
        addrResolved.district || null,
        addrResolved.state || null,
        addrResolved.country,
        addrResolved.pincode || null,
        lat,
        lng,
        req.user.sub,
        JSON.stringify(compliancePayload),
        businessType,
        businessTypeLabel,
        JSON.stringify(vendorConfigObj),
      ]
    );
  } catch (error) {
    if (error?.code !== "ER_BAD_FIELD_ERROR") throw error;
    // Fallback: columns not yet applied
    [result] = await pool.execute(
      "INSERT INTO restaurants (tenant_id, name, slug, description, address, owner_user_id, kyc_document_url, approval_status) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING')",
      [
        req.user.tenantId ? Number(req.user.tenantId) : null,
        name,
        slug,
        description || null,
        address,
        req.user.sub,
        JSON.stringify(compliancePayload),
      ]
    );
  }
  return res.status(201).json({ id: result.insertId, message: "Vendor registration submitted for approval" });
} catch (error) {
  if (error?.code === "ER_DUP_ENTRY") {
    return res.status(409).json({
      message: "Restaurant slug already exists. Please use a different slug.",
      details: error.message,
    });
  }
  return res.status(500).json({
    message: "Failed to onboard restaurant.",
    details: error?.message || "Unknown server error",
  });
}
}
);

router.patch("/:restaurantId/verification", auth(), rbac("ADMIN", "SUPER_ADMIN"), platformApprover(), async (req, res) => {
  const schema = z.object({
    decision: z.enum(["APPROVED", "REJECTED"]),
    reason: z.string().max(500).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const restaurantId = Number(req.params.restaurantId);
  const [[restaurant]] = await pool.execute(
    "SELECT id, approval_status FROM restaurants WHERE id = ? LIMIT 1",
    [restaurantId]
  );
  if (!restaurant) return res.status(404).json({ message: "Restaurant not found" });
  if (restaurant.approval_status !== "PENDING") {
    return res.status(400).json({ message: "Only pending restaurants can be verified." });
  }

  await pool.execute("UPDATE restaurants SET approval_status = ? WHERE id = ?", [
    parsed.data.decision,
    restaurantId,
  ]);
  await pool.execute(
    "INSERT INTO audit_logs (actor_user_id, action_type, target_entity, target_id, meta_json) VALUES (?, ?, 'restaurant', ?, ?)",
    [
      req.user.sub,
      `RESTAURANT_${parsed.data.decision}`,
      restaurantId,
      JSON.stringify({ reason: parsed.data.reason || null }),
    ]
  );

  return res.json({
    message:
      parsed.data.decision === "APPROVED"
        ? "Restaurant approved successfully."
        : "Restaurant rejected successfully.",
  });
});

router.get("/", auth(false), async (req, res) => {
  await ensureIsOnlineColumn();
  const customerLat = parseCoord(req.query.customerLat ?? req.query.lat);
  const customerLng = parseCoord(req.query.customerLng ?? req.query.lng);
  const businessType = req.query.businessType ? String(req.query.businessType) : null;
  const params = [];
  let extraWhere = "";
  if (businessType) {
    extraWhere = "AND r.business_type = ?";
    params.push(businessType);
  }
  let rows;
  try {
    [rows] = await pool.execute(
      `SELECT r.id, r.name, r.slug, r.description, r.rating, r.approval_status, r.address,
              r.latitude, r.longitude, COALESCE(r.is_online, 1) AS is_online,
              COALESCE(r.business_type, 'restaurant') AS business_type,
              r.business_type_label, r.vendor_config,
              COALESCE(rp.priority_rank, 999) AS priority_rank
       FROM restaurants r
       LEFT JOIN restaurant_priorities rp
         ON rp.restaurant_id = r.id AND COALESCE(rp.is_active, 1) = 1
       WHERE r.approval_status = 'APPROVED' AND r.is_active = 1 ${extraWhere}
       ORDER BY COALESCE(rp.priority_rank, 999), r.name`,
      params
    );
  } catch (error) {
    if (error?.code !== "ER_BAD_FIELD_ERROR") throw error;
    [rows] = await pool.execute(
      `SELECT r.id, r.name, r.slug, r.description, r.rating, r.approval_status, r.address,
              COALESCE(rp.priority_rank, 999) AS priority_rank
       FROM restaurants r
       LEFT JOIN restaurant_priorities rp
         ON rp.restaurant_id = r.id AND COALESCE(rp.is_active, 1) = 1
       WHERE r.approval_status = 'APPROVED' AND r.is_active = 1
       ORDER BY COALESCE(rp.priority_rank, 999), r.name`
    );
  }
  let list = attachDistanceKm(rows, customerLat, customerLng);
  if (customerLat != null && customerLng != null) {
    list = filterRestaurantsWithinCustomerRadius(list, customerLat, customerLng);
  }
  return res.json(
    list.map((row) => ({
      ...row,
      order_radius_km: CUSTOMER_ORDER_RADIUS_KM,
      within_order_radius:
        customerLat != null && customerLng != null
          ? row.distance_km != null && Number(row.distance_km) <= CUSTOMER_ORDER_RADIUS_KM
          : null,
    }))
  );
});

/** Customer view of a restaurant (including when offline — not orderable). */
router.get(
  "/:restaurantId/preview",
  auth(),
  rbac("CUSTOMER", "DELIVERY_PARTNER", "OWNER", "MANAGER", "ADMIN", "SUPER_ADMIN"),
  async (req, res) => {
    await ensureIsOnlineColumn();
    const restaurantId = Number(req.params.restaurantId);
    if (!Number.isFinite(restaurantId) || restaurantId <= 0) {
      return res.status(400).json({ message: "Valid restaurantId is required" });
    }
    const customerLat = parseCoord(req.query.customerLat ?? req.query.lat);
    const customerLng = parseCoord(req.query.customerLng ?? req.query.lng);
    let row;
    try {
      [[row]] = await pool.execute(
        `SELECT id, name, slug, description, rating, approval_status, is_online, address, latitude, longitude
         FROM restaurants
         WHERE id = ? AND approval_status = 'APPROVED' AND is_active = 1
         LIMIT 1`,
        [restaurantId]
      );
    } catch (error) {
      if (error?.code !== "ER_BAD_FIELD_ERROR") throw error;
      [[row]] = await pool.execute(
        `SELECT id, name, slug, description, rating, approval_status, is_online, address
         FROM restaurants
         WHERE id = ? AND approval_status = 'APPROVED' AND is_active = 1
         LIMIT 1`,
        [restaurantId]
      );
    }
    if (!row) return res.status(404).json({ message: "Restaurant not found" });
    const [enriched] = attachDistanceKm([row], customerLat, customerLng);
    const radiusCheck = evaluateCustomerRestaurantRadius(enriched, customerLat, customerLng);
    if (req.user?.role === "CUSTOMER" && customerLat != null && customerLng != null && !radiusCheck.allowed) {
      const status = radiusCheck.reason === "LOCATION_REQUIRED" ? 400 : 403;
      return res.status(status).json({
        message: radiusCheck.message,
        code: radiusCheck.reason,
        distance_km: radiusCheck.distance_km,
        order_radius_km: radiusCheck.order_radius_km,
      });
    }
    return res.json({
      ...enriched,
      is_online: enriched.is_online !== 0 && enriched.is_online !== false,
      order_radius_km: CUSTOMER_ORDER_RADIUS_KM,
      within_order_radius: radiusCheck.allowed,
      distance_km: radiusCheck.distance_km ?? enriched.distance_km ?? null,
    });
  }
);

/** Read-only menu categories for approved restaurants (customers / delivery / browse). */
router.get(
  "/:restaurantId/browse/categories",
  auth(),
  rbac("CUSTOMER", "DELIVERY_PARTNER", "OWNER", "MANAGER", "ADMIN", "SUPER_ADMIN"),
  async (req, res) => {
    const restaurantId = Number(req.params.restaurantId);
    if (!Number.isFinite(restaurantId) || restaurantId <= 0) {
      return res.status(400).json({ message: "Valid restaurantId is required" });
    }
    const allowed = await canBrowseRestaurant(restaurantId, req.user?.sub);
    if (!allowed) return res.status(404).json({ message: "Restaurant not found" });
    if (!(await enforceCustomerOrderRadius(req, res, restaurantId))) return;
    const [rows] = await pool.execute(
      "SELECT id, name FROM menu_categories WHERE restaurant_id = ? ORDER BY name ASC",
      [restaurantId]
    );
    return res.json(rows);
  }
);

router.get(
  "/:restaurantId/browse/items",
  auth(),
  rbac("CUSTOMER", "DELIVERY_PARTNER", "OWNER", "MANAGER", "ADMIN", "SUPER_ADMIN"),
  async (req, res) => {
    const restaurantId = Number(req.params.restaurantId);
    if (!Number.isFinite(restaurantId) || restaurantId <= 0) {
      return res.status(400).json({ message: "Valid restaurantId is required" });
    }
    const allowed = await canBrowseRestaurant(restaurantId, req.user?.sub);
    if (!allowed) return res.status(404).json({ message: "Restaurant not found" });
    if (!(await enforceCustomerOrderRadius(req, res, restaurantId))) return;

    const hasIsAvailable = await ensureMenuItemsIsAvailableColumn();
    const [rows] = await pool.execute(
      `SELECT mi.id, mi.category_id, mi.name, mi.description, mi.price, mi.is_veg, ${
        hasIsAvailable ? "mi.is_available" : "1 AS is_available"
      }, mi.available_stock, mc.name AS category_name
       FROM menu_items mi
       INNER JOIN menu_categories mc ON mc.id = mi.category_id
       WHERE mi.restaurant_id = ? AND mi.is_active = 1
       ORDER BY mi.id DESC`,
      [restaurantId]
    );
    const enriched = await enrichBrowseMenuItems(pool, restaurantId, rows);
    return res.json(enriched);
  }
);

router.get(
  "/:restaurantId/browse/items/:itemId/image",
  auth(),
  rbac("CUSTOMER", "DELIVERY_PARTNER", "OWNER", "MANAGER", "ADMIN", "SUPER_ADMIN"),
  async (req, res) => {
    const restaurantId = Number(req.params.restaurantId);
    const allowed = await canBrowseRestaurant(restaurantId, req.user?.sub);
    if (!allowed) return res.status(404).json({ message: "Restaurant not found" });
    return streamMenuItemImageFile(req, res, {
      restaurantId,
      itemId: req.params.itemId,
    });
  }
);

router.get(
  "/menu/items/:itemId/image",
  auth(),
  tenantScope,
  rbac("OWNER", "MANAGER", "ADMIN", "SUPER_ADMIN"),
  async (req, res) => {
    const itemId = Number(req.params.itemId);
    const restaurantId = Number(req.query.restaurantId);
    if (!restaurantId) return res.status(400).json({ message: "restaurantId query is required" });

    const [[row]] = await pool.execute(
      "SELECT id FROM menu_items WHERE id = ? AND tenant_id = ? AND restaurant_id = ? LIMIT 1",
      [itemId, req.tenantId, restaurantId]
    );
    if (!row) return res.status(404).json({ message: "Menu item not found" });

    return streamMenuItemImageFile(req, res, { restaurantId, itemId });
  }
);

router.get("/my", auth(), rbac("OWNER"), async (req, res) => {
  await ensureIsOnlineColumn();
  let rows;
  try {
    [rows] = await pool.execute(
      `SELECT id, name, slug, description, rating, approval_status, kyc_document_url, is_online,
              address, address_village, address_city, address_district, address_state, address_country, address_pincode,
              latitude, longitude,
              COALESCE(business_type, 'restaurant') AS business_type, business_type_label, vendor_config
       FROM restaurants WHERE owner_user_id = ? ORDER BY id DESC`,
      [req.user.sub]
    );
  } catch (error) {
    if (error?.code !== "ER_BAD_FIELD_ERROR") throw error;
    [rows] = await pool.execute(
      `SELECT id, name, slug, description, rating, approval_status, kyc_document_url, is_online, address
       FROM restaurants WHERE owner_user_id = ? ORDER BY id DESC`,
      [req.user.sub]
    );
  }
  return res.json(rows.map(enrichRestaurantAddressFields));
});

router.patch("/my/:restaurantId/online", auth(), rbac("OWNER"), async (req, res) => {
  await ensureIsOnlineColumn();
  const restaurantId = Number(req.params.restaurantId);
  const schema = z.object({ isOnline: z.boolean() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const [[row]] = await pool.execute(
    "SELECT id, name FROM restaurants WHERE id = ? AND owner_user_id = ? LIMIT 1",
    [restaurantId, req.user.sub]
  );
  if (!row) return res.status(404).json({ message: "Restaurant not found." });

  await pool.execute("UPDATE restaurants SET is_online = ? WHERE id = ? AND owner_user_id = ?", [
    parsed.data.isOnline ? 1 : 0,
    restaurantId,
    req.user.sub,
  ]);

  return res.json({
    message: parsed.data.isOnline ? "Restaurant is now online." : "Restaurant is now offline.",
    isOnline: parsed.data.isOnline,
  });
});

router.patch(
  "/my/:restaurantId/logo",
  auth(),
  rbac("OWNER"),
  upload.single("restaurantLogo"),
  async (req, res) => {
    const restaurantId = Number(req.params.restaurantId);
    if (!Number.isFinite(restaurantId) || restaurantId <= 0) {
      return res.status(400).json({ message: "Valid restaurant id is required." });
    }
    const file = req.file;
    if (!file) {
      return res.status(400).json({ message: "Restaurant logo file is required." });
    }
    if (!String(file.mimetype || "").startsWith("image/")) {
      return res.status(400).json({ message: "Logo must be an image file (PNG, JPG, or WebP)." });
    }

    const [[row]] = await pool.execute(
      "SELECT id, kyc_document_url FROM restaurants WHERE id = ? AND owner_user_id = ? LIMIT 1",
      [restaurantId, req.user.sub]
    );
    if (!row) return res.status(404).json({ message: "Restaurant not found." });

    const logoPath = `/uploads/${file.filename}`;
    let compliance = {};
    if (row.kyc_document_url) {
      try {
        compliance = JSON.parse(row.kyc_document_url);
      } catch {
        compliance = {};
      }
    }
    compliance.logo = logoPath;

    await pool.execute(
      "UPDATE restaurants SET kyc_document_url = ? WHERE id = ? AND owner_user_id = ?",
      [JSON.stringify(compliance), restaurantId, req.user.sub]
    );

    return res.json({ message: "Logo updated.", logo: logoPath });
  }
);

router.patch(
  "/my/:restaurantId",
  auth(),
  rbac("OWNER"),
  upload.single("restaurantLogo"),
  async (req, res) => {
    const restaurantId = Number(req.params.restaurantId);
    if (!Number.isFinite(restaurantId) || restaurantId <= 0) {
      return res.status(400).json({ message: "Valid restaurant id is required." });
    }

    const schema = z.object({
      name: z.string().min(2),
      slug: z.string().min(2),
      description: z.string().optional(),
      address: z.string().min(8).max(500).optional(),
      village: z.string().optional(),
      city: z.string().optional(),
      district: z.string().optional(),
      state: z.string().optional(),
      country: z.string().optional(),
      pincode: z.string().optional(),
      latitude: z.coerce.number().min(-90).max(90).optional(),
      longitude: z.coerce.number().min(-180).max(180).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((issue) => {
          const field = issue.path?.[0] || "field";
          return `${field}: ${issue.message}`;
        })
        .join("; ");
      return res.status(400).json({ message, errors: parsed.error.issues });
    }

    const [[row]] = await pool.execute(
      "SELECT id, kyc_document_url FROM restaurants WHERE id = ? AND owner_user_id = ? LIMIT 1",
      [restaurantId, req.user.sub]
    );
    if (!row) return res.status(404).json({ message: "Restaurant not found." });

    const file = req.file;
    if (file && !String(file.mimetype || "").startsWith("image/")) {
      return res.status(400).json({ message: "Logo must be an image file (PNG, JPG, or WebP)." });
    }

    let compliance = {};
    if (row.kyc_document_url) {
      try {
        compliance = JSON.parse(row.kyc_document_url);
      } catch {
        compliance = {};
      }
    }
    if (file) {
      compliance.logo = `/uploads/${file.filename}`;
    }

    const description =
      parsed.data.description != null && String(parsed.data.description).trim() !== ""
        ? String(parsed.data.description).trim()
        : null;

    let address =
      parsed.data.address != null && String(parsed.data.address).trim() !== ""
        ? String(parsed.data.address).trim()
        : null;
    let addrResolved = null;
    const hasStructuredInput =
      parsed.data.city ||
      parsed.data.district ||
      parsed.data.state ||
      parsed.data.pincode ||
      parsed.data.village;
    if (hasStructuredInput) {
      addrResolved = resolveRestaurantAddressFromRequest({ ...parsed.data, ...req.body });
      if (!addrResolved || addrResolved.ok === false) {
        return res.status(400).json({
          message: "Invalid address fields.",
          errors: addrResolved?.errors,
        });
      }
      address = addrResolved.formattedAddress;
    }
    const lat =
      addrResolved?.latitude != null
        ? addrResolved.latitude
        : parseCoord(parsed.data.latitude);
    const lng =
      addrResolved?.longitude != null
        ? addrResolved.longitude
        : parseCoord(parsed.data.longitude);

    try {
      if (addrResolved) {
        await pool.execute(
          `UPDATE restaurants SET name = ?, slug = ?, description = ?, kyc_document_url = ?,
           address = COALESCE(?, address),
           address_village = COALESCE(?, address_village),
           address_city = COALESCE(?, address_city),
           address_district = COALESCE(?, address_district),
           address_state = COALESCE(?, address_state),
           address_country = COALESCE(?, address_country),
           address_pincode = COALESCE(?, address_pincode),
           latitude = COALESCE(?, latitude), longitude = COALESCE(?, longitude)
           WHERE id = ? AND owner_user_id = ?`,
          [
            parsed.data.name.trim(),
            parsed.data.slug.trim(),
            description,
            JSON.stringify(compliance),
            address,
            addrResolved.village,
            addrResolved.city,
            addrResolved.district,
            addrResolved.state,
            addrResolved.country,
            addrResolved.pincode,
            lat,
            lng,
            restaurantId,
            req.user.sub,
          ]
        );
      } else {
        await pool.execute(
          `UPDATE restaurants SET name = ?, slug = ?, description = ?, kyc_document_url = ?,
           address = COALESCE(?, address), latitude = COALESCE(?, latitude), longitude = COALESCE(?, longitude)
           WHERE id = ? AND owner_user_id = ?`,
          [
            parsed.data.name.trim(),
            parsed.data.slug.trim(),
            description,
            JSON.stringify(compliance),
            address,
            lat,
            lng,
            restaurantId,
            req.user.sub,
          ]
        );
      }
    } catch (error) {
      if (error?.code === "ER_BAD_FIELD_ERROR") {
        await pool.execute(
          "UPDATE restaurants SET name = ?, slug = ?, description = ?, kyc_document_url = ?, address = COALESCE(?, address) WHERE id = ? AND owner_user_id = ?",
          [
            parsed.data.name.trim(),
            parsed.data.slug.trim(),
            description,
            JSON.stringify(compliance),
            address,
            restaurantId,
            req.user.sub,
          ]
        );
      } else if (error?.code === "ER_DUP_ENTRY") {
        return res.status(409).json({
          message: "Restaurant type (slug) already exists. Please choose a different one.",
        });
      } else {
        throw error;
      }
    }

    return res.json({
      message: "Restaurant updated.",
      address,
      latitude: lat,
      longitude: lng,
    });
  }
);

router.get("/managed", auth(), rbac("OWNER", "MANAGER"), async (req, res) => {
  const headerRaw = req.headers["x-tenant-id"];
  const fromJwt = req.user?.tenantId;
  const raw = headerRaw !== undefined && headerRaw !== null && String(headerRaw).trim() !== "" ? headerRaw : fromJwt;
  let resolvedTenantId = null;
  if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
    const n = Number(raw);
    resolvedTenantId = Number.isFinite(n) ? n : null;
  }

  if (req.user.role === "MANAGER" && resolvedTenantId == null) {
    return res.status(400).json({ message: "Missing tenant context" });
  }

  await ensureIsOnlineColumn();
  const [rows] =
    req.user.role === "OWNER"
      ? await pool.execute(
          `SELECT id, name, slug, approval_status, kyc_document_url, tenant_id, is_online
           FROM restaurants
           WHERE owner_user_id = ? OR (? IS NOT NULL AND tenant_id = ?)
           ORDER BY id DESC`,
          [req.user.sub, resolvedTenantId, resolvedTenantId]
        )
      : await pool.execute(
          `SELECT id, name, slug, approval_status, kyc_document_url, tenant_id, is_online
           FROM restaurants
           WHERE tenant_id = ?
           ORDER BY id DESC`,
          [resolvedTenantId]
        );

  const items = (rows || []).map((r) => ({
    id: Number(r.id),
    name: r.name,
    slug: r.slug,
    approval_status: r.approval_status,
    kyc_document_url: r.kyc_document_url ?? null,
    tenant_id: r.tenant_id != null ? Number(r.tenant_id) : null,
    is_online: r.is_online !== 0 && r.is_online !== false,
  }));
  return res.json(items);
});

router.post("/menu/categories", auth(), tenantScope, rbac("OWNER", "MANAGER"), async (req, res) => {
  const schema = z.object({ restaurantId: z.number().int(), name: z.string().min(2) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const { restaurantId, name } = parsed.data;
  const [result] = await pool.execute(
    "INSERT INTO menu_categories (restaurant_id, tenant_id, name) VALUES (?, ?, ?)",
    [restaurantId, req.tenantId, name]
  );
  return res.status(201).json({ id: result.insertId, message: "Category created" });
});

router.get("/menu/categories", auth(), tenantScope, rbac("OWNER", "MANAGER", "ADMIN", "SUPER_ADMIN"), async (req, res) => {
  const restaurantId = Number(req.query.restaurantId);
  if (!restaurantId) return res.status(400).json({ message: "restaurantId is required" });

  const [rows] = await pool.execute(
    "SELECT id, name FROM menu_categories WHERE tenant_id = ? AND restaurant_id = ? ORDER BY id DESC",
    [req.tenantId, restaurantId]
  );
  return res.json(rows);
});

router.patch("/menu/categories/:categoryId", auth(), tenantScope, rbac("OWNER", "MANAGER"), async (req, res) => {
  const schema = z.object({ name: z.string().min(2) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const categoryId = Number(req.params.categoryId);
  if (!categoryId) return res.status(400).json({ message: "Valid categoryId is required" });

  const [result] = await pool.execute(
    "UPDATE menu_categories SET name = ? WHERE id = ? AND tenant_id = ?",
    [parsed.data.name, categoryId, req.tenantId]
  );
  if (result.affectedRows === 0) return res.status(404).json({ message: "Category not found" });
  return res.json({ message: "Category updated" });
});

router.delete("/menu/categories/:categoryId", auth(), tenantScope, rbac("OWNER", "MANAGER"), async (req, res) => {
  const categoryId = Number(req.params.categoryId);
  if (!categoryId) return res.status(400).json({ message: "Valid categoryId is required" });

  const [items] = await pool.execute(
    "SELECT id FROM menu_items WHERE category_id = ? AND tenant_id = ? LIMIT 1",
    [categoryId, req.tenantId]
  );
  if (items.length > 0) {
    return res.status(400).json({ message: "Cannot delete category with menu items. Move or delete items first." });
  }

  const [result] = await pool.execute("DELETE FROM menu_categories WHERE id = ? AND tenant_id = ?", [categoryId, req.tenantId]);
  if (result.affectedRows === 0) return res.status(404).json({ message: "Category not found" });
  return res.json({ message: "Category deleted" });
});

router.post("/menu/items", auth(), tenantScope, rbac("OWNER", "MANAGER"), upload.single("itemImage"), async (req, res) => {
  const schema = z.object({
    categoryId: z.coerce.number().int(),
    restaurantId: z.coerce.number().int(),
    name: z.string().min(2),
    description: z.string().optional(),
    imageUrl: z.string().max(1000).optional(),
    price: z.coerce.number().positive(),
    isVeg: z
      .union([z.boolean(), z.string()])
      .transform((value) => (typeof value === "string" ? value === "true" : value))
      .default(true),
    isAvailable: z
      .union([z.boolean(), z.string()])
      .transform((value) => (typeof value === "string" ? value === "true" : value))
      .default(true),
    availableStock: z.coerce.number().int().nonnegative().default(0),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const { categoryId, restaurantId, name, description, imageUrl, price, isVeg, isAvailable, availableStock } = parsed.data;
  const textDescription = (description || "").trim();
  const uploadedImageUrl = req.file ? `/uploads/${req.file.filename}` : "";
  const itemImageUrl = uploadedImageUrl || (imageUrl || "").trim();
  if (itemImageUrl && !uploadFileExists(itemImageUrl)) {
    return res.status(400).json({
      message: "Image file not found on server. Upload the image file again (do not paste an old path).",
    });
  }
  const storedDescription =
    textDescription || itemImageUrl
      ? JSON.stringify({ text: textDescription || null, imageUrl: itemImageUrl || null })
      : null;

  const hasIsAvailable = await ensureMenuItemsIsAvailableColumn();
  const [result] = hasIsAvailable
    ? await pool.execute(
        "INSERT INTO menu_items (tenant_id, restaurant_id, category_id, name, description, price, is_veg, is_available, available_stock) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [req.tenantId, restaurantId, categoryId, name, storedDescription, price, isVeg ? 1 : 0, isAvailable ? 1 : 0, availableStock]
      )
    : await pool.execute(
        "INSERT INTO menu_items (tenant_id, restaurant_id, category_id, name, description, price, is_veg, available_stock) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [req.tenantId, restaurantId, categoryId, name, storedDescription, price, isVeg ? 1 : 0, availableStock]
      );
  return res.status(201).json({
    id: result.insertId,
    message: "Menu item created",
    imageUrl: itemImageUrl || null,
  });
});

router.get("/menu/items", auth(), tenantScope, rbac("OWNER", "MANAGER", "ADMIN", "SUPER_ADMIN"), async (req, res) => {
  const restaurantId = Number(req.query.restaurantId);
  if (!restaurantId) return res.status(400).json({ message: "restaurantId is required" });

  const hasIsAvailable = await ensureMenuItemsIsAvailableColumn();
  const [rows] = await pool.execute(
    `SELECT mi.id, mi.category_id, mi.name, mi.description, mi.price, mi.is_veg, mi.is_active, ${
      hasIsAvailable ? "mi.is_available" : "1 AS is_available"
    }, mi.available_stock, mc.name AS category_name
     FROM menu_items mi
     INNER JOIN menu_categories mc ON mc.id = mi.category_id
     WHERE mi.tenant_id = ? AND mi.restaurant_id = ? AND mi.is_active = 1
     ORDER BY mi.name ASC, mi.id DESC`,
    [req.tenantId, restaurantId]
  );
  const enriched = await enrichBrowseMenuItems(pool, restaurantId, rows);
  return res.json(enriched);
});

router.post(
  "/:restaurantId/menu/sync-images",
  auth(),
  tenantScope,
  rbac("OWNER", "MANAGER"),
  async (req, res) => {
    const restaurantId = Number(req.params.restaurantId);
    if (!Number.isFinite(restaurantId) || restaurantId <= 0) {
      return res.status(400).json({ message: "Valid restaurantId is required" });
    }

    const force = String(req.query.force || "").toLowerCase() === "true" || req.query.force === "1";

    const [rows] = await pool.execute(
      "SELECT id, name, description FROM menu_items WHERE tenant_id = ? AND restaurant_id = ? AND is_active = 1",
      [req.tenantId, restaurantId]
    );

    let updated = 0;
    let verified = 0;
    const syncedAt = new Date().toISOString();

    for (const row of rows) {
      const meta = parseMenuItemDescription(row.description);
      const resolved = resolveMenuItemUploadPath(row.name, meta.imageUrl);
      const imageUrl = resolved || meta.imageUrl;
      if (!imageUrl) continue;

      verified += 1;
      const shouldUpdate = force || (resolved && resolved !== meta.imageUrl);
      if (!shouldUpdate) continue;

      const stored = JSON.stringify({
        text: meta.text || null,
        imageUrl: resolved || meta.imageUrl,
        imageSyncedAt: syncedAt,
      });
      const [result] = await pool.execute(
        "UPDATE menu_items SET description = ? WHERE id = ? AND tenant_id = ?",
        [stored, row.id, req.tenantId]
      );
      if (result.affectedRows > 0) updated += 1;
    }

    return res.json({
      updated,
      verified,
      total: rows.length,
      force,
      syncedAt: force ? syncedAt : null,
      message: force
        ? updated > 0
          ? `Refreshed ${updated} menu image(s).`
          : "No menu images to refresh."
        : updated > 0
          ? `Linked ${updated} menu item(s) to files in uploads.`
          : "No menu images could be matched to files in uploads.",
    });
  }
);

router.patch("/menu/items/:itemId", auth(), tenantScope, rbac("OWNER", "MANAGER"), upload.single("itemImage"), async (req, res) => {
  const schema = z.object({
    categoryId: z.coerce.number().int(),
    restaurantId: z.coerce.number().int(),
    name: z.string().min(2),
    description: z.string().optional(),
    imageUrl: z.string().max(1000).optional(),
    price: z.coerce.number().positive(),
    isVeg: z
      .union([z.boolean(), z.string()])
      .transform((value) => (typeof value === "string" ? value === "true" : value))
      .default(true),
    isAvailable: z
      .union([z.boolean(), z.string()])
      .transform((value) => (typeof value === "string" ? value === "true" : value))
      .default(true),
    availableStock: z.coerce.number().int().nonnegative().default(0),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const itemId = Number(req.params.itemId);
  if (!itemId) return res.status(400).json({ message: "Valid itemId is required" });

  const { categoryId, restaurantId, name, description, imageUrl, price, isVeg, isAvailable, availableStock } = parsed.data;
  const textDescription = (description || "").trim();
  const uploadedImageUrl = req.file ? `/uploads/${req.file.filename}` : "";
  let itemImageUrl = uploadedImageUrl || (imageUrl || "").trim();
  if (!itemImageUrl) {
    const [[existing]] = await pool.execute(
      "SELECT description FROM menu_items WHERE id = ? AND tenant_id = ? LIMIT 1",
      [itemId, req.tenantId]
    );
    const prev = parseMenuItemDescription(existing?.description);
    itemImageUrl = prev.imageUrl || "";
  }
  if (itemImageUrl && !uploadFileExists(itemImageUrl)) {
    return res.status(400).json({
      message: "Image file not found on server. Upload the image file again (do not paste an old path).",
    });
  }
  const storedDescription =
    textDescription || itemImageUrl
      ? JSON.stringify({ text: textDescription || null, imageUrl: itemImageUrl || null })
      : null;

  const hasIsAvailable = await ensureMenuItemsIsAvailableColumn();
  const [result] = hasIsAvailable
    ? await pool.execute(
        `UPDATE menu_items
         SET category_id = ?, restaurant_id = ?, name = ?, description = ?, price = ?, is_veg = ?, is_available = ?, available_stock = ?
         WHERE id = ? AND tenant_id = ?`,
        [categoryId, restaurantId, name, storedDescription, price, isVeg ? 1 : 0, isAvailable ? 1 : 0, availableStock, itemId, req.tenantId]
      )
    : await pool.execute(
        `UPDATE menu_items
         SET category_id = ?, restaurant_id = ?, name = ?, description = ?, price = ?, is_veg = ?, available_stock = ?
         WHERE id = ? AND tenant_id = ?`,
        [categoryId, restaurantId, name, storedDescription, price, isVeg ? 1 : 0, availableStock, itemId, req.tenantId]
      );
  if (result.affectedRows === 0) return res.status(404).json({ message: "Menu item not found" });
  return res.json({ message: "Menu item updated", imageUrl: itemImageUrl || null });
});

router.delete("/menu/items/:itemId", auth(), tenantScope, rbac("OWNER", "MANAGER"), async (req, res) => {
  const itemId = Number(req.params.itemId);
  if (!itemId) return res.status(400).json({ message: "Valid itemId is required" });

  try {
    const [result] = await pool.execute("DELETE FROM menu_items WHERE id = ? AND tenant_id = ?", [itemId, req.tenantId]);
    if (result.affectedRows === 0) return res.status(404).json({ message: "Menu item not found" });
    return res.json({ message: "Menu item deleted" });
  } catch (error) {
    // If menu item is referenced by order_items, keep history and hide from active menu instead.
    if (error?.code === "ER_ROW_IS_REFERENCED_2") {
      const [soft] = await pool.execute("UPDATE menu_items SET is_active = 0 WHERE id = ? AND tenant_id = ?", [itemId, req.tenantId]);
      if (soft.affectedRows === 0) return res.status(404).json({ message: "Menu item not found" });
      return res.json({ message: "Menu item archived because it is linked to existing orders" });
    }
    throw error;
  }
});

module.exports = router;
