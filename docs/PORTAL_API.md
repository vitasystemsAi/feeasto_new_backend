# Customer Admin Management Portal — API

Base URL: `http://localhost:5000/api/v1/portal`

Interactive docs: `http://localhost:5000/api-docs` (extend OpenAPI as needed).

## Authentication

| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/login` | Email, password, optional `rememberMe` |
| POST | `/auth/refresh` | `{ refreshToken }` |
| POST | `/auth/logout` | Bearer token required |
| POST | `/auth/forgot-password` | `{ email }` |
| POST | `/auth/reset-password` | `{ email, token, password }` |
| GET | `/auth/me` | Profile + permissions |

**Roles:** `SUPER_ADMIN`, `ADMIN` (full access), `CUSTOMER_ADMIN` (permission-scoped).

## Protected modules (Bearer JWT)

| Module | Base paths |
|--------|------------|
| Dashboard | `GET /dashboard` |
| Customers | `GET /customers`, `GET /customers/:id`, `PATCH /customers/:id/status` |
| Restaurants | `GET /restaurants`, `PATCH .../activate`, `PATCH .../deactivate`, `PUT .../priority` |
| Trending | `GET /trending/food`, `PUT /trending/food/manual`, `GET /trending/restaurants`, `PUT /trending/restaurants/manual`, `POST /trending/sync` |
| Ads | `GET/POST /ads`, `PATCH/DELETE /ads/:id` |
| Reviews | `GET /reviews`, `PATCH /reviews/:id/moderate` |
| Search analytics | `GET /search-analytics?type=FOOD\|RESTAURANT&range=today\|week\|month&limit=10\|25\|50` |
| Reports | `GET /reports/:type?format=json\|csv` — types: `customers`, `restaurants`, `orders`, `revenue` |
| Audit logs | `GET /audit-logs?page&limit` |
| Customer admins | `GET/POST /customer-admins`, `PUT /customer-admins/:id/permissions` (super only) |
| Notifications | `GET/POST /notifications` |

## Public (customer app)

| Method | Path |
|--------|------|
| GET | `/public/trending/food` |
| GET | `/public/trending/restaurants` |
| GET | `/public/ads?type=HOMEPAGE_BANNER` |
| POST | `/public/ads/:id/impression` |
| POST | `/public/ads/:id/click` |
| POST | `/public/search` | `{ keyword, searchType }` |

## Pagination

List endpoints accept `page` (default 1) and `limit` (default 20, max 100).

## Permissions keys

`dashboard`, `customers`, `restaurants`, `trending`, `ads`, `reviews`, `search_analytics`, `reports`, `audit_logs`, `settings`, `customer_admins`
