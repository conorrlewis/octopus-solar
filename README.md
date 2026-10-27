# Octopus energy & solar dashboard

A local dashboard for your Octopus Energy half-hourly usage, plus a solar + battery model. Python 3.9+, standard library only; the front end is plain JavaScript and SVG with no build step.

    python3 server.py          # opens http://127.0.0.1:8765

Click **Connection** and enter your API key (`sk_live_…`) and account number (`A-XXXXXXXX`) from octopus.energy → Account → Personal details → API access. They are saved to `config.json` (owner-only permissions, git-ignored) and used only for calls to api.octopus.energy. `http://127.0.0.1:8765/?demo=1` shows synthetic data. Fetched data is cached in `cache.json` (also git-ignored).

## What it shows

- **Usage:** usage and spend over time, peak vs off-peak, a calendar you can click to filter every chart, typical day, weekday-by-hour heatmap, biggest days. Home / EV / Both filter; EV charging is detected from sustained high half-hourly draw.
- **Solar and battery:** modelled generation per roof (orientation, pitch, shade factor, irradiance Kk), a battery model (solar surplus, off-peak grid charging, summer export), before/after example bills, a battery and panel-count comparison, finance, and a 25-year outlook with panel and battery degradation and a price trend taken from your own tariff history.

## Assumptions to check

Solar output is a model (a typical UK seasonal curve adjusted for roof orientation and pitch), not a weather forecast. The panel and battery presets (JA Solar 455 W, Fox ESS EVO 5 / EVO 10), the quoted system prices, the £400-per-extra-panel cost, the roof 2 shade factor and the 2% a year battery fade are inputs you should replace with your own figures. Battery export income only applies if your export tariff allows it.
