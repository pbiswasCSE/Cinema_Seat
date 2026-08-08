const express = require("express");
const { pool } = require("../db");
const config = require("../config");
const router = express.Router();

// POST /bookings  { show_seat_id, user_ref }
// Zero-oversell guarantee: single atomic UPDATE ... WHERE status='AVAILABLE'.
// Under 100 concurrent requests for the same seat, Postgres row-locking
// ensures exactly one UPDATE succeeds; the rest see rowCount === 0.
router.post("/", async (req, res) => {
  const { show_seat_id, user_ref } = req.body;
  if (!show_seat_id || !user_ref) {
    return res.status(400).json({ error: "show_seat_id and user_ref required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const held = await client.query(
      `UPDATE show_seats
       SET status = 'HELD', hold_expires_at = now() + ($1 || ' seconds')::interval, held_by = $2
       WHERE id = $3 AND status = 'AVAILABLE'
       RETURNING id, hold_expires_at`,
      [config.HOLD_TTL_SECONDS, user_ref, show_seat_id]
    );

    if (held.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "seat not available" });
    }

    const priceRow = await client.query(
      `SELECT s.price_cents FROM show_seats ss
       JOIN showtimes s ON s.id = ss.showtime_id WHERE ss.id = $1`,
      [show_seat_id]
    );

    const booking = await client.query(
      `INSERT INTO bookings (show_seat_id, user_ref, status)
       VALUES ($1, $2, 'PENDING_PAYMENT') RETURNING id, status, created_at`,
      [show_seat_id, user_ref]
    );

    await client.query("COMMIT");
    res.status(201).json({
      ...booking.rows[0],
      price_cents: priceRow.rows[0].price_cents,
      hold_expires_at: held.rows[0].hold_expires_at,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "internal error" });
  } finally {
    client.release();
  }
});

router.get("/:id", async (req, res) => {
  const result = await pool.query(
    `SELECT b.*, p.status AS payment_status
     FROM bookings b LEFT JOIN payments p ON p.booking_id = b.id
     WHERE b.id = $1`,
    [req.params.id]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "not found" });
  res.json(result.rows[0]);
});

module.exports = router;
