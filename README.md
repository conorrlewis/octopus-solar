# Octopus energy & solar dashboard

A local dashboard for your Octopus Energy half-hourly usage, plus a solar + battery designer that works for any Octopus customer: connect your API key and it finds your roof on a map, lays panels on it, and estimates the bill savings of any system you design. Python 3.9+, standard library only; the front end is plain JavaScript and SVG with no build step.

    python3 server.py          # opens http://127.0.0.1:8765

To open it from a phone or another computer on your home network, start it with `python3 server.py --lan` and use the `192.168.x.x` address it prints. Other devices can view the dashboard but cannot change the Octopus connection, which can only be changed from the computer running the server. Only devices on private network addresses are accepted. The first time, macOS asks whether Python may accept incoming connections: allow it.

Click **Connection** and enter your API key (`sk_live_…`) and account number (`A-XXXXXXXX`) from octopus.energy → Account → Personal details → API access. They are saved to `config.json` (owner-only permissions, git-ignored) and used only for calls to api.octopus.energy. `http://127.0.0.1:8765/?demo=1` shows synthetic data. Fetched data is cached in `cache.json` (also git-ignored).

## What it shows

- **Usage:** usage and spend over time, peak vs off-peak, a calendar you can click to filter every chart, typical day, weekday-by-hour heatmap, biggest days. Home / EV / Both filter; The Home / EV / Both filter and EV charging detection (sustained high half-hourly draw) only appear when your Octopus account has an EV or charger set up (a connected smart-charge device, or an Intelligent Octopus tariff); otherwise nothing is split out of your usage.
- **Design your solar system:** your address is read from your Octopus account and placed on a satellite map with your building outline (OpenStreetMap). Choose the roof type (pitched, hipped, lean-to, flat), ridge direction and pitch; panels are drawn on each roof face. Sliders for panels, panel wattage, battery size and inverter size update the estimated bill saving (a year, and over 25 years), your energy bill before and after, and what one more panel or kWh would add, instantly. The tool does **not** estimate what an installation costs: type your installer's price in and it draws cost against savings and gives payback.
- **Solar and battery detail:** modelled generation per roof face (compass direction, pitch, your latitude, the shading you pick: MCS categories 1.0 / 0.8 / 0.65 / 0.5), a battery model (solar surplus, off-peak grid charging, optional export), before/after example bills, battery and panel-count comparisons, finance, and a 25-year outlook with degradation and a price trend from your own tariff history.

## Privacy

To draw the map, the address on your Octopus account is sent to OpenStreetMap's Nominatim (the postcode alone goes to postcodes.io if that fails), and building outlines near it are requested from OpenStreetMap's Overpass API. The map images come from Esri (satellite) or OpenStreetMap, which see the area you are looking at. Your API key and usage never leave this computer except to Octopus. Lookups are cached in `property.json` (git-ignored). You can instead search for a postcode in the planner, and **Disconnect** deletes the cache.

## Comparing quotes

The **Compare quotes** card lets you enter installer proposals (provider, panels, panel size, battery, inverter, price) or copy your current design into the form, and save them. Each saved quote is scored on your own roof and usage (saving a year, payback, net gain after 25 years, price per kWp) next to your current design, and **Load** puts it on the sliders. Quotes are stored in this browser (`localStorage`) only. You can also type a single price into the planner to price your current design from a quote.

## System performance

The **System performance** card holds the loss assumptions that turn sunlight into usable power: system total losses, inverter losses, optimizer losses, an extra shading allowance and a plus-or-minus performance adjustment (defaults give about 940 kWh per kWp a year for a south-facing 35° roof in central England). Type in the figures from an installer's quote to match their numbers. For a quote's panel orientation, choose a lean-to roof and set the exact compass direction and pitch (for example 232° and 30°).

## Assumptions to check

Solar output is a model (a typical UK seasonal curve adjusted for each roof face's orientation, pitch and latitude), not a weather forecast. Panel layout assumes a 25 cm margin from roof edges and a standard 450 W module (1.13 m wide). The roof outline and ridge direction come from public map data and are guesses: check them on the map. Neighbouring buildings and trees are not detected, so set each face's shading yourself. Installation costs are never estimated: payback only appears when you enter a price. The inverter limit is applied at 70% of its rating because the model is a smooth average-weather day. Battery export income only applies if your export tariff allows it.
