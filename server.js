import express from "express";

const app = express();
app.use(express.json());

/**
 * ======================================
 * CONFIG
 * ======================================
 */
const SHADOW_MODE = true;

// Score tuning (kan ændres uden at bryde API)
const SCORE_START = 100;
const SCORE_MIN = 0;
const SCORE_MAX = 100;

const PENALTIES = {
  OVERLAP: 5,
  LATE_CANCEL: 10,
  NO_SHOW: 25,
};

const LATE_CANCEL_THRESHOLD_MINUTES = 120;

/**
 * ======================================
 * IN-MEMORY STORE (v1)
 * ======================================
 * Senere: PostgreSQL
 */
const behaviorStore = new Map();

/**
 * ======================================
 * HELPERS
 * ======================================
 */
function getOrCreateBehavior(identifier) {
  if (!behaviorStore.has(identifier)) {
    behaviorStore.set(identifier, {
      identifier,
      score: SCORE_START,
      overlap_count: 0,
      late_cancel_count: 0,
      no_show_count: 0,
      last_event_at: null,
      updated_at: new Date().toISOString(),
    });
  }
  return behaviorStore.get(identifier);
}

function clampScore(score) {
  return Math.max(SCORE_MIN, Math.min(SCORE_MAX, score));
}

function confidenceFromScore(score) {
  if (score >= 80) return "HIGH";
  if (score >= 50) return "MEDIUM";
  return "LOW";
}

/**
 * ======================================
 * HEALTH
 * ======================================
 */
app.get("/health", (req, res) => {
  res.json({ status: "OK" });
});

/**
 * ======================================
 * CHECK ENDPOINT
 * ======================================
 * Bruges af platforme ved bookingforsøg
 */
app.post("/check", (req, res) => {
  try {
    const {
      platform_id,
      identifier,
      start_time,
      end_time,
      existing_bookings = [],
    } = req.body;

    if (!platform_id || !identifier || !start_time || !end_time) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const start = new Date(start_time);
    const end = new Date(end_time);

    let overlapDetected = false;

    for (const booking of existing_bookings) {
      const bStart = new Date(booking.start_time);
      const bEnd = new Date(booking.end_time);

      if (start < bEnd && end > bStart) {
        overlapDetected = true;
        break;
      }
    }

    const behavior = getOrCreateBehavior(identifier);
    const flags = [];

    if (overlapDetected) {
      behavior.overlap_count += 1;
      behavior.score -= PENALTIES.OVERLAP;
      flags.push("MULTI_ACTIVE_BOOKINGS");
    }

    behavior.score = clampScore(behavior.score);
    behavior.last_event_at = new Date().toISOString();
    behavior.updated_at = new Date().toISOString();

    return res.json({
      status: "OK",
      shadow: SHADOW_MODE,
      signal: overlapDetected ? "OVERLAP_OBSERVED" : "CLEAR",
      behavior: {
        score: behavior.score,
        confidence: confidenceFromScore(behavior.score),
        flags,
      },
    });
  } catch (err) {
    console.error("CHECK ERROR", err);
    // Fail-open
    return res.json({
      status: "OK",
      shadow: true,
      signal: "ERROR_IGNORED",
    });
  }
});

/**
 * ======================================
 * EVENT ENDPOINT
 * ======================================
 * Platforme kan sende events (cancel / no-show)
 */
app.post("/event", (req, res) => {
  try {
    const { identifier, event_type, minutes_before_start } = req.body;

    if (!identifier || !event_type) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const behavior = getOrCreateBehavior(identifier);

    if (event_type === "LATE_CANCEL") {
      if (
        typeof minutes_before_start === "number" &&
        minutes_before_start < LATE_CANCEL_THRESHOLD_MINUTES
      ) {
        behavior.late_cancel_count += 1;
        behavior.score -= PENALTIES.LATE_CANCEL;
      }
    }

    if (event_type === "NO_SHOW") {
      behavior.no_show_count += 1;
      behavior.score -= PENALTIES.NO_SHOW;
    }

    behavior.score = clampScore(behavior.score);
    behavior.last_event_at = new Date().toISOString();
    behavior.updated_at = new Date().toISOString();

    return res.json({
      status: "OK",
      shadow: SHADOW_MODE,
      behavior: {
        score: behavior.score,
        confidence: confidenceFromScore(behavior.score),
      },
    });
  } catch (err) {
    console.error("EVENT ERROR", err);
    // Fail-open
    return res.json({ status: "OK", shadow: true });
  }
});

/**
 * ======================================
 * START
 * ======================================
 */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ClearSlot running on port ${PORT}`);
});
