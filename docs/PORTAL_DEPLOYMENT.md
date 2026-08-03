# Customer Admin Portal — Deployment Guide

## Prerequisites

- Node.js 18+
- MySQL 8+ (same database as Feeasto)
- SMTP configured in `backend/.env` for password reset and email notifications

## Database

On API startup, `ensurePortalSchema()` creates/updates portal tables automatically.

Optional manual migration:

```bash
mysql -u root -p restaurant_saas < backend/database/migrations/012_customer_admin_portal.sql
```

## Backend

```bash
cd backend
cp .env.example .env
# Set JWT_SECRET, JWT_REFRESH_SECRET, MYSQL_*, SMTP_*, FRONTEND_URL
npm install
npm run dev
```

Portal mounts at `/api/v1/portal`. Trending auto-sync runs every **15 minutes**.

**Super admin access:** Use existing `ADMIN` or `SUPER_ADMIN` user from `DEFAULT_ADMIN_EMAIL` / platform seed.

**Create customer admin:** `POST /api/v1/portal/customer-admins` as super admin, or use the portal UI at `/portal/customer-admins`.

## Frontend

```bash
cd frontend
npm install
# Optional: VITE_API_URL=http://your-api:5000/api/v1
npm run dev
```

Portal URL: **http://localhost:5173/portal/login**

Production build:

```bash
cd frontend && npm run build
# Serve dist/ behind nginx; proxy /api to backend
```

## Security checklist

- Set strong `JWT_SECRET` and `JWT_REFRESH_SECRET` in production
- Enable HTTPS and set `FRONTEND_URL` to production origin
- Rate limiting is enabled in production (`RATE_LIMIT_MAX`)
- Do not commit `.env` files
- Uploads stored under `backend/uploads/portal-ads/`

## Customer app integration

Point customer home/explore to:

- `GET /api/v1/portal/public/trending/food`
- `GET /api/v1/portal/public/trending/restaurants`
- `GET /api/v1/portal/public/ads`
- `POST /api/v1/portal/public/search` on each search
