const express = require("express");
const config = require("./config");
const healthRoutes = require("./routes/health.routes");
const bookingsRoutes = require("./routes/bookings.routes");
const paymentsRoutes = require("./routes/payments.routes");
const otpRoutes = require("./routes/otp.routes");
const catalogRoutes = require("./routes/catalog.routes");
const { startHoldSweeper } = require("./holdSweeper");

const app = express();

// CORS: allow the frontend (served from a different origin) to call this API.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-Mock-Force, X-Signature");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
})

// Capture raw body for HMAC signature verification on webhooks.
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// Health mounted first, never touches db/gateway — always green.
app.use("/health", healthRoutes);
app.use("/bookings", bookingsRoutes);
app.use("/", paymentsRoutes); // /bookings/:id/pay, /webhooks/payment
app.use("/", otpRoutes); // /bookings/:id/otp/*, /webhooks/otp
app.use("/", catalogRoutes); // /movies, /showtimes/:id/seats

app.listen(config.PORT, () => {
  console.log(`CinemaSeat backend listening on :${config.PORT}`);
  startHoldSweeper();
});
