const express = require("express");
const { pool } = require("../db");
const gateway = require("../gateway");
const router = express.Router();

// Applies a SUCCEEDED/FAILED/REFUNDED transition. Must run inside a transaction (client).
async function applyStatusTransition(client, { paymentId, bookingId, newStatus, currentStatus }) {
  if (currentStatus === newStatus) return; // already applied — idempotent no-op

  await client.query(`UPDATE payments SET status = $1 WHERE id = $2`, [newStatus, paymentId]);

  if (newStatus === "SUCCEEDED") {
    await client.query(`UPDATE bookings SET status = 'CONFIRMED' WHERE id = $1 AND status = 'PENDING_PAYMENT'`, [
      bookingId,
    ]);
    await client.query(
      `UPDATE show_seats SET status = 'BOOKED' WHERE id = (SELECT show_seat_id FROM bookings WHERE id = $1)`,
      [bookingId]
    );
  } else if (newStatus === "FAILED") {
    await client.query(`UPDATE bookings SET status = 'CANCELLED' WHERE id = $1 AND status = 'PENDING_PAYMENT'`, [
      bookingId,
    ]);
    await client.query(
      `UPDATE show_seats SET status = 'AVAILABLE', hold_expires_at = NULL, held_by = NULL
       WHERE id = (SELECT show_seat_id FROM bookings WHERE id = $1) AND status = 'HELD'`,
      [bookingId]
    );
  } else if (newStatus === "REFUNDED") {
    await client.query(`UPDATE bookings SET status = 'CANCELLED' WHERE id = $1`, [bookingId]);
  }
}

// POST /bookings/:id/pay
router.post("/bookings/:id/pay", async (req, res) => {
  const bookingId = req.params.id;

  const bRes = await pool.query(
    `SELECT b.id, b.status, ss.hold_expires_at, s.price_cents
     FROM bookings b
     JOIN show_seats ss ON ss.id = b.show_seat_id
     JOIN showtimes s ON s.id = ss.showtime_id
     WHERE b.id = $1`,
    [bookingId]
  );
  if (bRes.rowCount === 0) return res.status(404).json({ error: "booking not found" });
  const booking = bRes.rows[0];

  if (booking.status !== "PENDING_PAYMENT") {
    return res.status(409).json({ error: `booking is ${booking.status}` });
  }
  if (!booking.hold_expires_at || new Date(booking.hold_expires_at) < new Date()) {
    return res.status(409).json({ error: "hold expired, seat released" });
  }

  const payRes = await pool.query(
    `INSERT INTO payments (booking_id, amount_cents, status) VALUES ($1, $2, 'PENDING') RETURNING id`,
    [bookingId, booking.price_cents]
  );
  const paymentId = payRes.rows[0].id;

  const { status, data } = await gateway.charge({
    amount_cents: booking.price_cents,
    booking_id: bookingId,
    idempotencyKey: paymentId,
    forceHeader: req.get("X-Mock-Force"),
  });

  if (status !== 202 || !data.payment_id) {
    return res.status(502).json({ error: "gateway charge failed", detail: data });
  }

  await pool.query(`UPDATE payments SET gateway_payment_id = $1 WHERE id = $2`, [data.payment_id, paymentId]);

  // RECONCILIATION: the callback can race ahead of this very line (e.g. X-Mock-Force: race,
  // or under normal delay a retry-less duplicate). If the webhook already arrived and found
  // no matching payment, it was stored "orphaned" (payment_id IS NULL). Catch it up right now.
  try {
    const orphan = await pool.query(
      `SELECT event_id, status, raw_payload FROM payment_events
       WHERE payment_id IS NULL AND raw_payload->>'payment_id' = $1
       LIMIT 1`,
      [data.payment_id]
    );
    if (orphan.rowCount > 0) {
      const ev = orphan.rows[0];
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`UPDATE payment_events SET payment_id = $1 WHERE event_id = $2`, [
          paymentId,
          ev.event_id,
        ]);
        await applyStatusTransition(client, {
          paymentId,
          bookingId,
          newStatus: ev.status,
          currentStatus: "PENDING", // we just created it as PENDING above
        });
        await client.query("COMMIT");
        console.log(`reconciled orphaned event ${ev.event_id} for payment ${paymentId}`);
      } catch (err) {
        await client.query("ROLLBACK");
        console.error("reconciliation error", err);
      } finally {
        client.release();
      }
    }
  } catch (err) {
    console.error("reconciliation lookup failed", err);
  }

  res.status(202).json({ payment_id: paymentId, gateway_payment_id: data.payment_id, status: "PENDING" });
});

// POST /webhooks/payment  (gateway calls this)
router.post("/webhooks/payment", async (req, res) => {
  if (!gateway.verifySignature(req.rawBody, req.get("X-Signature"))) {
    return res.sendStatus(401);
  }

  const event = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const ins = await client.query(
      `INSERT INTO payment_events (event_id, status, raw_payload)
       VALUES ($1, $2, $3)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [event.event_id, event.status, event]
    );

    if (ins.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.sendStatus(200); // duplicate — ack quietly
    }

    const payRow = await client.query(`SELECT id, booking_id, status FROM payments WHERE gateway_payment_id = $1`, [
      event.payment_id,
    ]);

    if (payRow.rowCount === 0) {
      // Race: callback arrived before /pay linked gateway_payment_id.
      // Keep the event (payment_id stays NULL) so /pay's reconciliation step
      // can pick it up right after it links — do NOT lose this event.
      await client.query("COMMIT");
      return res.sendStatus(200);
    }

    const { id: paymentId, booking_id: bookingId, status: currentStatus } = payRow.rows[0];
    await client.query(`UPDATE payment_events SET payment_id = $1 WHERE event_id = $2`, [paymentId, event.event_id]);
    await applyStatusTransition(client, { paymentId, bookingId, newStatus: event.status, currentStatus });

    await client.query("COMMIT");
    res.sendStatus(200);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("payment webhook error", err);
    res.sendStatus(500);
  } finally {
    client.release();
  }
});

module.exports = router;