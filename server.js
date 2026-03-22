const express = require("express");
const path = require("path");

const app = express();
const port = Number(process.env.PORT || 3000);
const ESPN_URL =
  process.env.ESPN_LEADERBOARD_URL ||
  "https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard";

app.use(express.static(path.join(__dirname)));

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
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
