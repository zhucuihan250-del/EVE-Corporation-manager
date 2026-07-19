import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "@workspace/db";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

// Trust the Replit reverse proxy so req.secure and req.ip are accurate.
// This is required for secure session cookies to work in the deployed environment.
app.set("trust proxy", 1);

const PgStore = connectPgSimple(session);
const isProduction = process.env.NODE_ENV === "production";
const serverDir = path.dirname(fileURLToPath(import.meta.url));
const frontendStaticDir = path.resolve(
  serverDir,
  "../../pap-tracker/dist/public",
);
const frontendIndexFile = path.join(frontendStaticDir, "index.html");

function parseAllowedOrigins(value: string | undefined): string[] {
  if (!value) return [];

  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => {
      try {
        return new URL(origin).origin;
      } catch {
        return origin.replace(/\/+$/, "");
      }
    });
}

const allowedOrigins = parseAllowedOrigins(
  process.env.CORS_ORIGIN ?? process.env.FRONTEND_URL,
);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.length === 0) {
        callback(null, true);
        return;
      }

      callback(null, allowedOrigins.includes(origin));
    },
    credentials: true,
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  throw new Error("SESSION_SECRET must be set");
}

app.use(
  session({
    store: new PgStore({
      pool,
    }),
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      // "auto" sets secure=true when the request arrives over HTTPS (respecting
      // the x-forwarded-proto header once trust proxy is enabled above).
      secure: "auto",
      httpOnly: true,
      sameSite: isProduction ? "none" : "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  }),
);

app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
app.use("/api", router);

if (isProduction) {
  if (existsSync(frontendIndexFile)) {
    app.use(express.static(frontendStaticDir, { index: false }));
    app.use((req, res, next) => {
      if (req.method !== "GET" || req.path.startsWith("/api")) {
        next();
        return;
      }

      res.sendFile(frontendIndexFile);
    });
  } else {
    logger.warn(
      { frontendStaticDir },
      "Frontend static assets not found; running API-only mode",
    );
  }
}

export default app;
