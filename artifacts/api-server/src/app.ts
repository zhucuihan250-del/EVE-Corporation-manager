import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool } from "@workspace/db";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

const PgStore = connectPgSimple(session);

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

app.use(cors({
  origin: true,
  credentials: true,
}));
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
      createTableIfMissing: true,
    }),
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  }),
);

app.use("/api", router);

export default app;
