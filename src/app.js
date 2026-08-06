const express = require("express");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const swaggerUi = require("swagger-ui-express");
const YAML = require("yaml");
const createRouter = require("./routes");
const env = require("./config/env");

function isNativeAppOrigin(origin) {
  // Capacitor Android/iOS WebView origins (androidScheme: https → https://localhost)
  return (
    /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin) ||
    /^capacitor:\/\/localhost$/i.test(origin) ||
    /^ionic:\/\/localhost$/i.test(origin)
  );
}

function isDevFrontendOrigin(origin) {
  if (!origin || env.nodeEnv === "production") return false;
  return isNativeAppOrigin(origin);
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (origin === env.frontendUrl) return true;
  if (isDevFrontendOrigin(origin)) return true;
  // Always allow Capacitor native app shells so mobile APKs can call the API.
  if (isNativeAppOrigin(origin)) return true;
  return false;
}

function createApp(io) {
  const app = express();

  app.use(
    helmet({
      // Allow frontend app (different origin/port) to display uploaded files.
      crossOriginResourcePolicy: { policy: "cross-origin" },
    })
  );
  app.use(
    cors({
      origin(origin, callback) {
        if (isAllowedOrigin(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error(`CORS blocked for origin: ${origin}`));
      },
      credentials: true,
    })
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use(morgan("dev"));
  // Global limiter: 200/15min was too easy to hit during local dev (HMR, many parallel calls).
  // Development: disabled. Production: configurable via RATE_LIMIT_MAX (default 2500 per 15 min per IP).
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: Number(process.env.RATE_LIMIT_MAX || 2500),
      standardHeaders: true,
      legacyHeaders: false,
      skip: () => env.nodeEnv !== "production",
    })
  );
  const { uploadDir: uploadsPrimary } = require("./config/uploads");
  const uploadsLegacy = path.join(__dirname, "uploads");
  app.use("/uploads", express.static(uploadsPrimary));
  app.use("/uploads", express.static(uploadsLegacy));
  app.use("/uploads/subscriptions", express.static(path.join(uploadsPrimary, "subscriptions")));

  const openApiPath = path.join(__dirname, "..", "docs", "openapi.yaml");
  const openApiContent = fs.readFileSync(openApiPath, "utf8");
  const openApiDoc = YAML.parse(openApiContent);
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(openApiDoc));

  app.use("/api/v1", createRouter(io));

  app.use((err, _req, res, _next) => {
    return res.status(500).json({ message: "Unexpected error", details: err.message });
  });

  return app;
}

module.exports = createApp;
