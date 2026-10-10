# Antigravity Quota Bar

A lightweight status bar extension for Visual Studio Code and Google Antigravity IDE that monitors real-time remaining quota for both **Google Gemini** and **Claude** models.

---

## Features

- **Bottom Status Bar Indicator**: Displays current remaining quota in the format `$(sparkle) Gemini: 90% | $(hubot) Claude: 75%`.
- **Low Quota Warning**: Status bar highlights with warning styling when quota drops below the configurable threshold (default 20%).
- **Interactive Tooltip**: Hover over the quota bar to see model family breakdowns, individual window limits (5-hour and weekly), and reset countdown timers.
- **One-Click Refresh**: Click the status bar item to instantly re-query the local Antigravity Language Server.
- **Minimal Footprint**: Connects directly to the local language server process via Connect-RPC. Zero external dependencies, no telemetry, no webviews.

---

## Configuration

| Setting | Default | Description |
| :--- | :--- | :--- |
| `antigravityQuota.refreshIntervalMinutes` | `2` | Polling interval in minutes (minimum safe interval is 1 minute). |
| `antigravityQuota.lowThresholdPercent` | `20` | Threshold percentage below which the status bar shows a warning color. |

---

## Commands

| Command | Description |
| :--- | :--- |
| `Antigravity Quota: Refresh Model Quota` | Instantly queries and updates the quota bar. |