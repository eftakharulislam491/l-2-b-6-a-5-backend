import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import passport from "passport";
import swaggerUi from "swagger-ui-express";

import "./app/config/passport";
import { openApiDocument } from "./app/docs/openapi";
import { globalErrorHandler } from "./app/middlewares/globalErrorHandler";
import notFound from "./app/middlewares/notFound";
import { router } from "./app/routes";

export const app = express();

const swaggerHandler = swaggerUi.setup(openApiDocument, { explorer: true });



app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(passport.initialize());

app.use(
  cors({
    origin: [
      process.env.FRONTEND_URL as string,
      "http://localhost:3000",
      "https://e-commerce-client-ten-tau.vercel.app",
      "*"
    ],
    credentials: true,
  }),
);
app.use(
  "/api/uploads",
  express.static("uploads", {
    maxAge: "7d",
    index: false,
    setHeaders: (res) => {
      res.set("X-Content-Type-Options", "nosniff");
    },
  }),
);

app.use(
  "/api-docs",
  swaggerUi.serve,
  swaggerHandler,
);

app.use("/api/api-docs", swaggerUi.serve, swaggerHandler);

app.use("/api", router);

app.get("/", (_, res) => {
  res.send({
    message: "Welcome to the APP, this is a E-Commerce API",
    success: true,
  });
});

app.use(globalErrorHandler);
app.use(notFound);
