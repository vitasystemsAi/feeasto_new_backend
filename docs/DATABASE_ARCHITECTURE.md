# Feesto — Multi-Database Architecture

## Overview

The platform uses **three separate MySQL databases** with well-defined responsibilities.
No database shares tables with another; cross-database references are stored as plain
integer IDs (no foreign-key constraints across DBs).

```
┌─────────────────────────────────────────────────────────────────────┐
│                          MySQL Server                               │
│                                                                     │
│  ┌─────────────────────┐  ┌──────────────────┐  ┌───────────────┐  │
│  │  super_admin_saas   │  │  customer_saas   │  │restaurant_ABC │  │
│  │  (platform control) │  │  (all customers) │  │(per-vendor DB)│  │
│  └─────────────────────┘  └──────────────────┘  └───────────────┘  │
│                                                    restaurant_XYZ   │
│                                                    restaurant_...   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 1. `super_admin_saas` — Platform Control Plane

**Who uses it:** Only SUPER_ADMIN and ADMIN roles (platform team).  
**Who does NOT access it:** Customers, restaurant owners, delivery partners.

### Key Tables

| Table | Purpose |
|-------|---------|
| `platform_users` | SUPER_ADMIN and ADMIN accounts with bcrypt passwords |
| `tenants` | Registry of all approved restaurants; stores `db_name` (isolated DB name) |
| `restaurant_applications` | Vendor registration requests; approval workflow |
| `subscription_plans` | Platform-level subscription plan definitions |
| `restaurant_subscriptions` | Which plan each restaurant is on |
| `platform_category_catalog` | Browse categories shown to all customers |
| `advertisements` | Platform-wide and restaurant-specific ad banners |
| `trending_restaurants` | Curated trending list |
| `trending_food_items` | Curated trending items |
| `audit_logs` | All admin actions (approve, reject, etc.) |
| `platform_password_reset_otps` | Password reset for platform admin accounts |
| `portal_sessions` | Super-admin portal login sessions |

### Approval Flow

```
Vendor fills form (customer_saas.users OWNER account)
        │
        ▼
POST /api/v1/restaurants/onboard
  → Inserts into super_admin_saas.restaurant_applications
    with approval_status = 'PENDING'
        │
        ▼
Super-Admin logs in to platform dashboard
  → GET  /api/v1/admin/applications        (list pending)
  → GET  /api/v1/admin/applications/:id   (detail + KYC docs)
        │
    ┌───┴────────────────────┐
    ▼                        ▼
APPROVE                   REJECT
PATCH /admin/applications/:id/approve    PATCH /admin/applications/:id/reject
  │                                        │
  ▼                                        ▼
dbProvisioner.provisionRestaurantDb()   Sets approval_status = REJECTED
  1. CREATE DATABASE restaurant_<slug>    Writes audit_log
  2. Execute restaurant_template.sql
  3. Seed restaurant row + owner staff
  4. Update tenants with db_name
  5. Update restaurant_applications
  6. Write audit_log
```

---

## 2. `customer_saas` — Customer Registry

**Who uses it:** All customers and vendor-owners (for their personal account).  
**Who does NOT access it:** Super-admin (reads only by cross-DB ID lookup).

### Key Tables

| Table | Purpose |
|-------|---------|
| `users` | All CUSTOMER and OWNER accounts; email/phone + password |
| `registration_otps` | OTP codes for email/phone verification during sign-up |
| `password_reset_otps` | Password reset OTP codes |
| `refresh_tokens` | Persistent login tokens |
| `customer_saved_addresses` | Saved delivery addresses per customer |
| `customer_order_refs` | Lightweight cross-DB order history (links to restaurant DB) |
| `customer_favourites` | Wishlisted restaurants |
| `customer_notifications` | In-app notifications |
| `customer_subscriptions` | Subscription memberships |
| `customer_activity_logs` | Login / order / address events |

### Customer Registration Flow

```
Customer opens Register page
        │
        ▼
POST /api/v1/auth/register/request-otp
  { fullName, email, mobile, password }
  → Hashes password, stores OTP in customer_saas.registration_otps
  → Sends OTP email via SMTP
        │
        ▼
POST /api/v1/auth/register/verify-otp
  { email, otp, [homeAddress fields] }
  → Verifies OTP hash
  → Creates customer_saas.users row (role = 'CUSTOMER')
  → Optionally adds home address to customer_saved_addresses
  → Returns JWT (sub=userId, role=CUSTOMER)
```

### Owner (Vendor) Account Creation

A vendor first registers as a CUSTOMER, then is upgraded to OWNER when
they submit a restaurant application.  The platform can also create OWNER
accounts directly via the admin panel.

```
Customer account → (owner self-onboards) → role promoted to OWNER
                                         → application submitted
                                         → super-admin approves
                                         → restaurant DB provisioned
```

---

## 3. `restaurant_<slug>` — Per-Restaurant Database

**Who uses it:** The restaurant owner, managers, delivery partners of that outlet.  
**How it's created:** Automatically by `dbProvisioner.provisionRestaurantDb()` on approval.  
**Naming:** `restaurant_` + sanitised slug, e.g. `restaurant_biryani_house_ab3f`

### Key Tables (defined in `database/restaurant_template.sql`)

| Table | Purpose |
|-------|---------|
| `restaurant` | Single row — this restaurant's profile |
| `staff` | Owner / managers / delivery partners employed here |
| `menu_categories` | Menu sections |
| `menu_items` | Individual dishes / products |
| `restaurant_tables` | Seating tables + QR tokens |
| `reservations` | Table bookings |
| `orders` | All orders placed at this restaurant |
| `order_items` | Line items (snapshot of price at order time) |
| `payments` | Payment records, refund tracking |
| `invoices` | Invoice PDFs |
| `delivery_partners` | Partners associated with this restaurant |
| `deliveries` | Delivery assignments and handoff timestamps |
| `inventory_items` | Ingredients / stock items |
| `inventory_stock_entries` | Stock purchase log |
| `feedback` | Customer reviews |
| `complaints` | Customer complaints |
| `refunds` | Refund records |
| `restaurant_daily_tokens` | Daily queue token counter |
| `analytics_daily` | Aggregated daily stats |
| `restaurant_table_customers` | QR table guest sessions |
| `notification_log` | Outbound notification audit |

### Cross-Database References

Since MySQL cannot enforce foreign keys across databases, cross-DB links
are **plain integer IDs** stored as columns with a comment:

```sql
-- In restaurant_<slug>.orders:
customer_user_id BIGINT NOT NULL COMMENT 'FK → customer_saas.users.id'

-- In customer_saas.customer_order_refs:
restaurant_db    VARCHAR(100) NOT NULL  -- e.g. "restaurant_biryani_house_ab3f"
remote_order_id  BIGINT       NOT NULL  -- orders.id in that restaurant DB
```

The application layer joins these manually when needed (e.g. loading a
customer's full order history across multiple restaurants).

---

## 4. Connection Routing (`src/db/dbManager.js`)

```javascript
const { getSuperAdminPool, getCustomerPool, getRestaurantPool } = require('./db/dbManager');

// Platform admin operations
const pool = getSuperAdminPool();

// Customer registration / auth / profile
const pool = getCustomerPool();

// Restaurant-specific data (orders, menu, staff)
const pool = getRestaurantPool('restaurant_biryani_house_ab3f');
// Pools are cached — each DB name gets exactly one pool for the process lifetime.
```

The **tenant middleware** (`src/middlewares/tenant.js`) automatically:
1. Reads `tenantId` from JWT or `x-tenant-id` header
2. Looks up `tenants.db_name` in `super_admin_saas`
3. Attaches `req.restaurantDb` and `req.restaurantPool` to the request

---

## 5. Initial Setup

```bash
# 1. Create super_admin_saas and customer_saas databases
node backend/scripts/setup-multi-db.js

# 2. Start the API (also pings all three core DBs on boot)
npm run dev   # from backend/

# 3. Individual restaurant DBs are created automatically on approval
```

---

## 6. Environment Variables (no changes needed)

```env
MYSQL_HOST=localhost
MYSQL_PORT=3307
MYSQL_USER=root
MYSQL_PASSWORD=yourpassword
# MYSQL_DATABASE is now only used by the legacy shim (maps to super_admin_saas)
MYSQL_DATABASE=restaurant_saas
```

The `dbManager.js` hard-codes `super_admin_saas` and `customer_saas` as
database names. Restaurant database names are stored in `tenants.db_name`
and resolved at runtime.

---

## 7. Migration from Single-DB to Multi-DB

The existing `restaurant_saas` database is **not deleted** — it continues
to work via the `pool.js` backward-compatibility shim. New features use
the correct pool for each DB tier. Existing modules are migrated gradually:

| Module | Target DB |
|--------|-----------|
| `auth.routes.js` registration | `customer_saas` (via `authCustomer.js`) |
| `admin/vendorApproval.js` | `super_admin_saas` |
| `restaurants/` menu, orders | `restaurant_<slug>` (via `req.restaurantPool`) |
| Legacy code using `pool` | Still hits `super_admin_saas` (via shim) |
