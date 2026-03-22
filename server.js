const express = require("express");
const fs = require("fs/promises");
const path = require("path");

const app = express();
const port = Number(process.env.PORT || 3000);
const ESPN_URL =
  process.env.ESPN_LEADERBOARD_URL ||
  "https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard";
const DATA_DIR = path.join(__dirname, "data");
const DATA_PATH = path.join(DATA_DIR, "state.json");

const DEFAULT_STATE = {
  groups: { 1: [], 2: [], 3: [], 4: [], 5: [] },
  entries: [],
  bonus: [],
  settings: {},
};

let writeQueue = Promise.resolve();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname)));

function safeStateShape(state) {
  if (!state || typeof state !== "object") return { ...DEFAULT_STATE };
  const groups = state.groups && typeof state.groups === "object" ? state.groups : DEFAULT_STATE.groups;
  const entries = Array.isArray(state.entries) ? state.entries : [];
  const bonus = Array.isArray(state.bonus) ? state.bonus : [];
  const settings = state.settings && typeof state.settings === "object" ? state.settings : {};
  return {
    groups: {
      1: Array.isArray(groups["1"] ?? groups[1]) ? [...(groups["1"] ?? groups[1])] : [],
      2: Array.isArray(groups["2"] ?? groups[2]) ? [...(groups["2"] ?? groups[2])] : [],
      3: Array.isArray(groups["3"] ?? groups[3]) ? [...(groups["3"] ?? groups[3])] : [],
      4: Array.isArray(groups["4"] ?? groups[4]) ? [...(groups["4"] ?? groups[4])] : [],
      5: Array.isArray(groups["5"] ?? groups[5]) ? [...(groups["5"] ?? groups[5])] : [],
    },
    entries,
    bonus,
    settings,
  };
}

async function readState() {
  try {
    const raw = await fs.readFile(DATA_PATH, "utf8");
    return safeStateShape(JSON.parse(raw));
  } catch (error) {
    if (error && error.code === "ENOENT") return { ...DEFAULT_STATE };
    throw error;
  }
}

async function writeState(state) {
  const nextState = safeStateShape(state);
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(DATA_PATH, JSON.stringify(nextState), "utf8");
  return nextState;
}

function enqueueWrite(task) {
  writeQueue = writeQueue.then(task, task);
  return writeQueue;
}

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get("/api/state", async (_req, res) => {
  try {
    const state = await readState();
    return res.json(state);
  } catch (error) {
    return res.status(500).json({ error: "Failed to read state", detail: String(error) });
  }
});

app.put("/api/state", async (req, res) => {
  const payload = req.body || {};
  const allowedKeys = ["groups", "entries", "bonus", "settings"];
  const hasAny = allowedKeys.some((k) => Object.prototype.hasOwnProperty.call(payload, k));
  if (!hasAny) {
    return res.status(400).json({ error: "Provide at least one of groups, entries, bonus, settings." });
  }

  try {
    const updated = await enqueueWrite(async () => {
      const current = await readState();
      const merged = {
        groups: Object.prototype.hasOwnProperty.call(payload, "groups") ? payload.groups : current.groups,
        entries: Object.prototype.hasOwnProperty.call(payload, "entries") ? payload.entries : current.entries,
        bonus: Object.prototype.hasOwnProperty.call(payload, "bonus") ? payload.bonus : current.bonus,
        settings: Object.prototype.hasOwnProperty.call(payload, "settings") ? payload.settings : current.settings,
      };
      return writeState(merged);
    });
    return res.json(updated);
  } catch (error) {
    return res.status(500).json({ error: "Failed to persist state", detail: String(error) });
  }
});

app.get("/api/espn", async (_req, res) => {
  try {
    const response = await fetch(ESPN_URL, {
      headers: { "User-Agent": "golf-sweepstake/1.0" },
    });
    if (!response.ok) {
      return res.status(response.status).json({ error: `ESPN HTTP ${response.status}` });
    }
    const data = await response.json();
    return res.json(data);
  } catch (error) {
    return res.status(502).json({ error: "Failed to fetch ESPN data", detail: String(error) });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(port, () => {
  console.log(`Golf Sweep running on port ${port}`);
});
