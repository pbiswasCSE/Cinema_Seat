const express = require("express");
const { pool } = require("../db");
const router = express.Router();

// GET /movies — browse movies with their showtimes
router.get("/movies", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.id, m.title, m.duration_minutes,
              json_agg(json_build_object(
                'showtime_id', s.id,
                'theatre_id', s.theatre_id,
                'theatre_name', t.name,
                'starts_at', s.starts_at,
                'price_cents', s.price_cents
              ) ORDER BY s.starts_at) AS showtimes
         FROM movies m
         JOIN showtimes s ON s.movie_id = m.id
         JOIN theatres t ON t.id = s.theatre_id
        GROUP BY m.id, m.title, m.duration_minutes
        ORDER BY m.title`
    );
    res.json(rows);
  } catch (err) {
    console.error("get movies error", err);
    res.status(500).json({ error: "internal error" });
  }
});

// GET /showtimes/:showtimeId/seats — live seat map for a show
router.get("/showtimes/:showtimeId/seats", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ss.id AS show_seat_id, s.row_label, s.seat_number,
              CASE WHEN ss.status = 'HELD' AND ss.hold_expires_at < now()
                   THEN 'AVAILABLE' ELSE ss.status END AS status
         FROM show_seats ss
         JOIN seats s ON s.id = ss.seat_id
        WHERE ss.showtime_id = $1
        ORDER BY s.row_label, s.seat_number`,
      [req.params.showtimeId]
    );
    if (rows.length === 0) return res.status(404).json({ error: "showtime not found or has no seats" });
    res.json({ showtime_id: req.params.showtimeId, seats: rows });
  } catch (err) {
    console.error("get seat map error", err);
    res.status(500).json({ error: "internal error" });
  }
});

module.exports = router;