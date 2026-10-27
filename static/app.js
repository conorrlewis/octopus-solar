'use strict';
const $ = (s, el = document) => el.querySelector(s);
const esc = Charts.esc;

/* ------------------------------------------------------------ settings ---- */
// Defaults from the datasheets: Fox ESS EVO 10 (10.24 kWh, 95% DoD = 9.73 kWh usable; 97.3% PV->battery and
// 96.4% battery->AC efficiency, ~93% round trip; AC power depends on the inverter variant, 3.7-10 kW)
// and JA Solar JAM54D41 455 W panels (1% first-year then 0.4%/yr degradation).
const QUOTE_PANELS = 11; // the Octopus quote: 11 x JA Solar 455 W panels, estimated at 4,359 kWh a year
// Roofs (arrays). Roof 1 reproduces the Octopus quote (11 panels, Kk 871 -> 4,359 kWh); roof 2 is off until it has panels.
// Orientation is degrees from due south (side says east or west); Kk is the MCS irradiance figure in kWh per kWp a year.
// 11 panels fit on the SW roof; any more go on the shadier opposite (NE) roof. Roof 2's shade factor of 0.85 is a placeholder.
const DEF_ROOFS = [{ panels: QUOTE_PANELS, max: QUOTE_PANELS, az: 50, side: 'W', tilt: 37, shade: 1, kk: 871 },
  { panels: 0, max: 20, az: 130, side: 'E', tilt: 37, shade: 0.85, kk: 600 }];
const compass = (az, side) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((((180 + (side === 'W' ? az : -az)) % 360) + 360) % 360 / 45) % 8];
const DEF = { panelW: 455, panelPrice: 400, annual: 4359, panels: QUOTE_PANELS, exportRate: 12, battery: 9.73, cost: 11497, lat: 52, lon: -1.5,
  evThr: 1.4, peak: 34.27, offpeak: 6.6, standing: 50.75, gridCharge: 'winter', batExport: 'summer', batKw: 5, batKwCharge: 5, batEff: 94, batModel: 'evo10', deg: 0.4, escal: 0, term: 10, apr: 4.9, batDeg: 2, trend: 'h2', exportEscal: 0 };
// Fox ESS datasheets: usable = nominal kWh x 95% depth of discharge; round trip = PV->battery x battery->AC efficiency
// (EVO 5: 95.4% x 94.5% = 90%; EVO 10: 97.3% x 96.4% = 94%). The EVO 5 ships with the 3.68 kW inverter, the EVO 10 with 5 kW.
const PRODUCTS = {
  // warrMWh: Fox ESS UK battery warranty v4.5 keeps >=70% of nominal capacity for 12 years or until this energy throughput.
  evo5: { name: 'Fox EVO 5', battery: 4.86, batKw: 3.68, batEff: 90, cost: 10109, warrMWh: 23.99 }, // system prices quoted by the user
  evo10: { name: 'Fox EVO 10', battery: 9.73, batKw: 5, batEff: 94, cost: 11497, warrMWh: 47.88 },
  // Tesla Powerwall 3 (datasheet): 13.5 kWh, up to 11.04 kW AC output but charging is limited to 5 kW; 89% solar->battery->home
  // efficiency; 10-year warranty (the datasheet gives no throughput limit). Price quoted by the user, incl. the 11.04 kW inverter.
  pw3: { name: 'Tesla Powerwall 3', battery: 13.5, batKw: 11.04, batKwCharge: 5, batEff: 89, cost: 14160, warrMWh: null },
};
function loadCfg() {
  const saved = JSON.parse(localStorage.getItem('octo.cfg') || '{}'), cfg = Object.assign({}, DEF, saved);
  cfg.roofs = DEF_ROOFS.map((d, i) => Object.assign({}, d, (saved.roofs || [])[i] || {}));
  return cfg;
}
const S = {
  cfg: loadCfg(),
  range: localStorage.getItem('octo.range') || '365',
  group: 'auto',
  scope: localStorage.getItem('octo.scope') || 'home', // which load the charts and solar model cover: home | ev | both
  days: +(localStorage.getItem('octo.days') || 365),
  demo: localStorage.getItem('octo.demo') === '1',
  selDay: null, raw: null, D: null, calMonth: null, billSel: 'avg', calMetric: 'load', genUnit: localStorage.getItem('octo.genUnit') || 'kwh', sel: null, anchor: null, // sel = {from, to} picked on the calendar; overrides the preset range
};
const saveCfg = () => localStorage.setItem('octo.cfg', JSON.stringify(S.cfg));

/* ------------------------------------------------------------- helpers ---- */
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const nf = (v, d = 0) => v.toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d });
const kwh = (v, d = 1) => nf(v, Math.abs(v) >= 100 ? 0 : d) + ' kWh';
const gbp = v => (v < 0 ? '-' : '') + '£' + nf(Math.abs(v), Math.abs(v) >= 1000 ? 0 : 2);
const pct = v => nf(v * 100, 0) + '%';
const pad = n => String(n).padStart(2, '0');
const hhLabel = i => pad(i >> 1) + ':' + (i & 1 ? '30' : '00');
const SCOPE = { home: ['home usage', 'Home'], ev: ['EV charging', 'EV'], both: ['home + EV usage', 'Home + EV'] };
const FIELDS = ['kwh', 'home', 'ev', 'cost', 'costHome', 'costEv', 'off', 'offCost', 'gen', 'self', 'selfPeak',
  'exp', 'imp', 'after', 'expInc', 'standing', 'load', 'lcost', 'loff', 'loffCost', 'bg', 'gch', 'direct', 'impPeak', 'impOff', 'bx', 'bxInc', 'pcost', 'pafter', 'vDirect', 'vBatSol', 'vBg', 'cGridOff', 'cGridPeak', 'cCharge',
  'kPeakB', 'kHomeOffB', 'kCarB', 'kPeakA', 'kHomeOffA', 'kCarA', 'full'];
const sum = (arr, f) => arr.reduce((a, d) => a + d[f], 0);
const totals = arr => { const t = { n: arr.length }; FIELDS.forEach(f => { t[f] = sum(arr, f); }); return t; };
function ranges(flags) {
  const out = []; let s = -1;
  flags.forEach((f, i) => { if (f && s < 0) s = i; if ((!f || i === flags.length - 1) && s >= 0) { out.push([s, f ? i : i - 1]); s = -1; } });
  return out;
}
function longDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  return DOW[(new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7] + ' ' + d + ' ' + MON[m - 1] + ' ' + y;
}

/* ------------------------------------------------------------ ingestion --- */
function ingest(raw) {
  S.raw = raw;
  const n = raw.consumption.length;
  S.t = new Float64Array(n); S.kwh = new Float64Array(n); S.hh = new Uint8Array(n); S.dow = new Uint8Array(n);
  S.date = new Array(n);
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hourCycle: 'h23', year: 'numeric',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
  const wd = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  raw.consumption.forEach((r, i) => {
    S.t[i] = r[0]; S.kwh[i] = r[1];
    const p = {}; for (const x of fmt.formatToParts(new Date(r[0]))) p[x.type] = x.value;
    S.date[i] = p.year + '-' + p.month + '-' + p.day;
    S.hh[i] = (+p.hour) * 2 + (+p.minute >= 30 ? 1 : 0);
    S.dow[i] = wd[p.weekday];
  });
}

/* --------------------------------------------------------- solar model ---- */
// Share of annual PV output by month for a typical UK south-facing array (~35° tilt).
const SHARE = [2.7, 4.8, 8.5, 11.5, 13.3, 13.3, 13.2, 11.6, 9.5, 6.0, 3.5, 2.1];
const RAD = Math.PI / 180, FD = 0.4; // FD: share of diffuse light; tuned so a pitched roof 130° from south yields ~60% of a south roof
// Clear-sky plane-of-array irradiance (relative units) for a panel facing psi (radians from south, west positive), tilted beta.
function poaIrr(doy, h, lat, lon, psi, beta) {
  const dec = 23.44 * RAD * Math.sin(2 * Math.PI * (284 + doy) / 365), phi = lat * RAD, H = (h + lon / 15 - 12) * 15 * RAD;
  const sinE = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H);
  if (sinE <= 0.02) return 0;
  const east = -Math.cos(dec) * Math.sin(H), north = Math.cos(phi) * Math.sin(dec) - Math.sin(phi) * Math.cos(dec) * Math.cos(H);
  const dni = Math.pow(0.7, Math.pow(1 / sinE, 0.678));
  const cosT = Math.sin(beta) * (-Math.sin(psi)) * east + Math.sin(beta) * (-Math.cos(psi)) * north + Math.cos(beta) * sinE;
  return dni * Math.max(0, cosT) + FD / (1 - FD) * dni * sinE * (1 + Math.cos(beta)) / 2;
}
const _cache = {};
function dayEnergies(lat, lon, psi, beta) {
  const key = [lat, lon, psi, beta].join(), hit = _cache[key]; if (hit) return hit;
  const E = new Float64Array(367);
  for (let d = 1; d <= 366; d++) { let t = 0; for (let k = 0; k < 48; k++) t += poaIrr(d, (k + 0.5) / 2, lat, lon, psi, beta); E[d] = t; }
  return (_cache[key] = E);
}
const yearSum = E => { let t = 0; for (let d = 1; d <= 365; d++) t += E[d]; return t; };
// Typical UK monthly output shape for a south-facing ~35° roof, as a daily curve that sums to 1 over a year.
const MD = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const baseDayShare = (() => {
  const mid = []; let cum = 0; MD.forEach(d => { mid.push(cum + d / 2); cum += d; });
  const daily = SHARE.map((v, i) => v / 100 / MD[i]), out = new Float64Array(367);
  for (let d = 1; d <= 366; d++) {
    let k = -1; mid.forEach((m, i) => { if (m <= d) k = i; });
    let a, b, ma, mb;
    if (k < 0) { a = 11; b = 0; ma = mid[11] - 365; mb = mid[0]; }
    else if (k === 11) { a = 11; b = 0; ma = mid[11]; mb = mid[0] + 365; }
    else { a = k; b = k + 1; ma = mid[k]; mb = mid[k + 1]; }
    out[d] = daily[a] + (daily[b] - daily[a]) * (d - ma) / (mb - ma);
  }
  const t = yearSum(out); for (let d = 1; d <= 366; d++) out[d] /= t;
  return out;
})();
// Output of one roof per kWh of annual yield: seasonal curve from the UK shape adjusted for the roof's
// orientation and pitch, and a within-day curve from the sun's angle to the panels (east roofs peak early, west late).
function makeRoofNorm(lat, lon, az, side, tilt) {
  const psi = (side === 'E' ? -az : az) * RAD, beta = tilt * RAD;
  const E = dayEnergies(lat, lon, psi, beta), Er = dayEnergies(lat, lon, 0, 35 * RAD), share = new Float64Array(367);
  let tot = 0; for (let d = 1; d <= 366; d++) { share[d] = Er[d] ? baseDayShare[d] * E[d] / Er[d] : 0; if (d <= 365) tot += share[d]; }
  for (let d = 1; d <= 366; d++) share[d] /= tot || 1;
  return ms => {
    const d = new Date(ms + 15 * 60000), y = d.getUTCFullYear();
    const doy = Math.floor((Date.UTC(y, d.getUTCMonth(), d.getUTCDate()) - Date.UTC(y, 0, 0)) / 864e5);
    return E[doy] ? share[doy] * poaIrr(doy, d.getUTCHours() + d.getUTCMinutes() / 60, lat, lon, psi, beta) / E[doy] : 0;
  };
}
// Estimated Kk (kWh per kWp a year) from orientation and pitch; calibrated so 50° from south at 37° gives the quoted 870.
function kkEstimate(lat, lon, az, tilt) {
  return Math.round(947 * yearSum(dayEnergies(lat, lon, az * RAD, tilt * RAD)) / yearSum(dayEnergies(lat, lon, 0, 35 * RAD)));
}
const roofYield = r => S.cfg.panelW / 1000 * r.kk * r.shade; // kWh a year from one panel on this roof
function syncCfg() {
  const c = S.cfg;
  c.panels = c.roofs.reduce((a, r) => a + r.panels, 0);
  c.kwp = c.panels * c.panelW / 1000;
  c.annual = c.roofs.reduce((a, r) => a + r.panels * roofYield(r), 0);
  if ($('#aGen')) $('#aGen').value = nf(c.annual, 0);
  c.roofs.forEach((r, k) => {
    const e = $(`#r${k + 1}gen`); if (e) e.value = nf(r.panels * roofYield(r), 0);
    const nm = $(`#r${k + 1}n`); if (nm) nm.textContent = `Roof ${k + 1} · ${compass(r.az, r.side)}`;
  });
}
function syncCost() {
  if (PRODUCTS[S.cfg.batModel]) { S.cfg.cost = PRODUCTS[S.cfg.batModel].cost + (S.cfg.panels - QUOTE_PANELS) * S.cfg.panelPrice; $('#aCost').value = Math.round(S.cfg.cost); }
}

/* ------------------------------------------------------------- compute ---- */
function compute() {
  syncCfg();
  const R = S.raw, c = S.cfg, n = S.t.length;
  const rate = new Float64Array(n), off = new Uint8Array(n), ev = new Float64Array(n), isEv = new Uint8Array(n);

  // 1. unit rates (p/kWh): Octopus API rates, else fallback peak/off-peak window
  // Standard tariffs give a full time-of-day schedule. Intelligent Octopus Go gives flat day and
  // night rates, with night applying 23:30-05:30 (smart-charge slots are handled with the EV below).
  const seek = list => { let k = 0; return t => {
    while (k < list.length && list[k][1] !== null && list[k][1] <= t) k++;
    const r = list[k]; return r && r[0] <= t ? r[2] : null; }; };
  const std = seek(R.rates), dayR = seek(R.day || []), nightR = seek(R.night || []);
  let fromApi = 0;
  for (let i = 0; i < n; i++) {
    const t = S.t[i], inWindow = S.hh[i] === 47 || S.hh[i] < 11;
    const sv = std(t), dv = dayR(t), nv = nightR(t);
    let v = sv;
    if (v === null && dv !== null && nv !== null) v = inWindow ? nv : dv;
    if (v !== null) { rate[i] = v; fromApi++; }
    else rate[i] = inWindow ? c.offpeak : c.peak;
  }
  let min = Infinity, max = 0;
  for (let i = 0; i < n; i++) { if (rate[i] < min) min = rate[i]; if (rate[i] > max) max = rate[i]; }
  const tou = max / min > 1.5;
  for (let i = 0; i < n; i++) off[i] = tou && rate[i] <= min + 0.25 * (max - min) ? 1 : 0;

  // 2. EV detection: runs of >=2 slots over the threshold (+ ramp-up/down slots either side)
  const thr = c.evThr;
  for (let i = 0; i < n;) {
    if (S.kwh[i] < thr) { i++; continue; }
    let j = i; while (j < n && S.kwh[j] >= thr) j++;
    if (j - i >= 2) {
      for (let k = i; k < j; k++) isEv[k] = 1;
      if (i > 0 && S.kwh[i - 1] >= 0.6 * thr) isEv[i - 1] = 1;
      if (j < n && S.kwh[j] >= 0.6 * thr) isEv[j] = 1;
    }
    i = j;
  }
  for (let i = 0; i < n; i++) {
    if (!isEv[i]) continue;
    ev[i] = Math.max(0, S.kwh[i] - 0.1);
    if (tou && !off[i]) { rate[i] = min; off[i] = 1; } // smart-charge dispatch is billed off-peak
  }

  // Forward-looking prices: the latest peak and off-peak rates in your data. Solar and battery savings use
  // these (what you'd pay now), while the usage charts keep the rates you actually paid at the time.
  let peakNow = c.peak, offNow = c.offpeak, gotP = false, gotO = false;
  for (let i = n - 1; i >= 0 && !(gotP && gotO); i--) {
    if (off[i]) { if (!gotO) { offNow = rate[i]; gotO = true; } } else if (!gotP) { peakNow = rate[i]; gotP = true; }
  }
  if (!tou) offNow = peakNow;
  const prate = new Float64Array(n);
  for (let i = 0; i < n; i++) prate[i] = off[i] ? offNow : peakNow;

  // 3. the load in scope (Home / EV / Both) is what solar is modelled against
  const load = new Float64Array(n);
  for (let i = 0; i < n; i++) load[i] = S.scope === 'ev' ? ev[i] : S.scope === 'home' ? S.kwh[i] - ev[i] : S.kwh[i];

  // 4. modelled solar, then an optional battery, simulated chronologically
  const rg = c.roofs.map(r => ({ norm: makeRoofNorm(c.lat, c.lon, r.az, r.side, r.tilt), per: roofYield(r) }));
  const gPer = rg.map(() => new Float64Array(n)); // one panel on each roof
  const g = new Float64Array(n), month = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    month[i] = +S.date[i].slice(5, 7);
    rg.forEach((r, k) => { const v = r.norm(S.t[i]) * r.per; gPer[k][i] = v; g[i] += v * c.roofs[k].panels; });
  }
  const WINTER = [0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1, 1]; // index = month number: Oct-Mar
  const SUMMER = [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0]; // Apr-Sep
  // Exporting the battery only pays if the export rate beats the cost of off-peak power after losses.
  const arbOK = (eff) => tou && c.exportRate * eff / 100 > offNow;
  // The battery model for a given generation profile `gs` (so other panel counts can be modelled the same way).
  const makeModel = gs => {
  // Looking ahead through each peak-rate stretch: `rem[i]` is the shortfall still to come after slot i
  // (net of surplus solar that would refill the battery for free) and `tgt[i]` is what the battery
  // should hold at the start of the stretch. This is a forecast with hindsight.
  const tgt = new Float64Array(n), rem = new Float64Array(n);
  { let next = 0, def = 0, sur = 0, inRun = false;
    for (let i = n - 1; i >= 0; i--) {
      if (!off[i]) { rem[i] = Math.max(0, def - sur * 0.9); def += Math.max(0, load[i] - gs[i]); sur += Math.max(0, gs[i] - load[i]); inRun = true; }
      else { if (inRun) { next = Math.max(0, def - sur * 0.9); def = sur = 0; inRun = false; } tgt[i] = next; }
    } }
  // mode: 'off' = solar-charged battery only, 'winter' / 'all' = also charge from the grid off-peak.
  // expMode: 'summer' / 'all' = fill the battery off-peak and sell what home use won't need back at the export rate.
  return (cap, mode, expMode = 'off', kw = c.batKw, effPct = c.batEff, kwC = c.batKwCharge) => {
    const r = { self: new Float64Array(n), direct: new Float64Array(n), bg: new Float64Array(n), exp: new Float64Array(n),
      imp: new Float64Array(n), gch: new Float64Array(n), bx: new Float64Array(n) };
    const maxSlot = kw / 2, maxC = Math.min(kwC, kw) / 2, eff = Math.sqrt(effPct / 100), canExport = arbOK(effPct); let socS = 0, socG = 0;
    const drain = (take) => { const tot = socS + socG, shG = tot ? socG / tot : 0; socG -= take * shG; socS -= take * (1 - shG); return shG; };
    for (let i = 0; i < n; i++) {
      const dh = Math.min(gs[i], load[i]); let surplus = gs[i] - dh, delS = 0, delG = 0, chgG = 0, ex = 0;
      if (cap > 0) {
        const m = month[i];
        const expOn = canExport && (expMode === 'all' || (expMode === 'summer' && SUMMER[m]));
        // surplus solar tops the battery up (only as far as later home use needs while exporting)
        const limit = expOn ? Math.min(cap, rem[i] / eff) : cap;
        const chg = Math.max(0, Math.min(surplus, (limit - socS - socG) / eff, maxC));
        socS += chg * eff; surplus -= chg;
        // cheap-rate grid charging
        if (tou && off[i] && (expOn || mode === 'all' || mode === 'full' || (mode === 'winter' && WINTER[m]))) {
          const want = expOn || mode === 'full' ? cap : Math.min(cap, tgt[i] / eff), have = socS + socG;
          if (have < want) { chgG = Math.min((want - have) / eff, maxC); socG += chgG * eff; }
        }
        if (!tou || !off[i]) {
          // cover household load, then sell what is left above the reserve
          const tot = socS + socG, dis = Math.min(load[i] - dh, tot * eff, maxSlot);
          if (dis > 0) { const shG = drain(dis / eff); delG = dis * shG; delS = dis * (1 - shG); }
          if (expOn) {
            const have = socS + socG, res = rem[i] / eff;
            ex = Math.min(Math.max(0, have - res) * eff, Math.max(0, maxSlot - dis));
            if (ex > 0) drain(ex / eff);
          }
        }
      }
      r.direct[i] = dh; r.self[i] = dh + delS; r.bg[i] = delG; r.exp[i] = surplus + ex; r.bx[i] = ex; r.gch[i] = chgG;
      r.imp[i] = load[i] - dh - delS - delG + chgG;
    }
    return r;
  };
  };
  const sim = makeModel(g);
  const gridMode = c.gridCharge === 'off' ? 'off' : c.gridCharge;
  const { self, direct, bg, exp, imp, gch, bx } = sim(c.battery, gridMode, c.batExport);
  const genTotal = g.reduce((a, v) => a + v, 0), annualise = genTotal ? c.annual / genTotal : 0;
  const saving = r => { let v = 0; for (let i = 0; i < n; i++) v += (load[i] - r.imp[i]) * prate[i] / 100 + r.exp[i] * c.exportRate / 100; return v * annualise; };
  const sum1 = a => a.reduce((x, y) => x + y, 0);
  // compare the two real products (each with its own inverter and efficiency), plus any custom setup
  const base = saving(sim(0, 'off'));
  const options = Object.values(PRODUCTS).map(p => ({ name: `${p.name} (${nf(p.battery, 1)} kWh, ${p.batKw} kW)`, short: p.name, cap: p.battery, kw: p.batKw, eff: p.batEff, kwC: p.batKwCharge || p.batKw, warrMWh: p.warrMWh, price: p.cost + (c.panels - QUOTE_PANELS) * c.panelPrice }));
  if (c.batModel === 'custom' && c.battery > 0) options.push({ name: `Custom (${nf(c.battery, 1)} kWh, ${c.batKw} kW)`, short: 'Custom', cap: c.battery, kw: c.batKw, kwC: c.batKwCharge, eff: c.batEff, price: +c.cost || 0 });
  const scen = options.map(o => {
    const run = (mode, ex) => sim(o.cap, mode, ex, o.kw, o.eff, o.kwC);
    const bat = run('off'), win = run('winter'), ex = run('winter', 'summer'), all = run('all');
    // energy leaving the battery a year (to the house plus anything sold), for the warranty throughput check
    const thruOf = r => (sum1(r.bg) + sum1(r.self) - sum1(r.direct) + sum1(r.bx)) * annualise;
    const cr = sim(o.cap, gridMode, c.batExport, o.kw, o.eff, o.kwC), nr = sim(o.cap, gridMode, 'off', o.kw, o.eff, o.kwC);
    // peak-rate electricity still bought: with your settings, and if the battery is simply filled to 100% every night
    const peakOf = r => { let v = 0; for (let i = 0; i < n; i++) if (!off[i]) v += r.imp[i]; return v * annualise; };
    const fr = sim(o.cap, 'full', 'off', o.kw, o.eff, o.kwC);
    return { ...o, cfg: saving(cr), thru: thruOf(cr), thruNoSell: thruOf(nr), peakCfg: peakOf(cr), peakFull: peakOf(fr), base, bat: saving(bat), win: saving(win), ex: saving(ex), all: saving(all),
      winKwh: sum1(win.bg) * annualise, exKwh: sum1(ex.bx) * annualise };
  });
  // How many panels? Generation scales with panel count, so rerun the same model on a scaled profile.
  // Fill roof 1 up to its capacity first, then put the rest on roof 2.
  const cap1 = c.roofs[0].max || QUOTE_PANELS, y1 = roofYield(c.roofs[0]), y2 = roofYield(c.roofs[1]);
  const panelCounts = [...new Set([4, 6, 8, 10, QUOTE_PANELS, 12, 14, 16, 18, 20, c.panels])].filter(x => x > 0).sort((a, b) => a - b);
  const panelRes = panelCounts.map(np => {
    const n1 = Math.min(np, cap1), n2 = np - n1;
    const same = n1 === c.roofs[0].panels && n2 === c.roofs[1].panels;
    const gs = same ? g : g.map((_, i) => n1 * gPer[0][i] + n2 * gPer[1][i]), mdl = same ? sim : makeModel(gs);
    const solarOnly = saving(mdl(0, 'off')), run = c.battery > 0 ? mdl(c.battery, gridMode, c.batExport, c.batKw, c.batEff, c.batKwCharge) : mdl(0, 'off');
    const full = c.battery > 0 ? saving(run) : solarOnly;
    let used = 0, made = 0; for (let i = 0; i < n; i++) { used += run.self[i]; made += gs[i]; }
    return { np, n1, n2, kwp: np * c.panelW / 1000, gen: n1 * y1 + n2 * y2, solarOnly, full, selfPct: made ? used / made : 0 };
  });
  // The next 25 years, year by year: panels fade, the battery loses capacity, and unit rates follow the chosen trend
  // (from your own tariff's rate history, or a custom %). Each year reruns the model with that year's output, capacity and prices.
  const hist = R.history || [];
  const hg = k => hist.length > k && hist[k].peak > 0 ? Math.pow(hist[0].peak / hist[k].peak, 1 / k) - 1 : null;
  const trendG = { flat: 0, h1: hg(1), h2: hg(2), h3: hg(3), custom: c.escal / 100 }[c.trend];
  const gU = trendG == null ? 0 : trendG, gE = c.exportEscal / 100;
  const finOpts = options.filter(o => o.price > 0), yearsCfg = [], yearsBy = {};
  finOpts.forEach(o => { yearsBy[o.name] = []; });
  for (let k = 0; k < 25; k++) {
    const kp = Math.max(0, 1 - c.deg / 100 * k), kb = Math.max(0.3, 1 - c.batDeg / 100 * k);
    const mdl = k === 0 ? sim : makeModel(g.map(v => v * kp));
    const pk = peakNow * Math.pow(1 + gU, k), of = offNow * Math.pow(1 + gU, k), ex = c.exportRate * Math.pow(1 + gE, k);
    const val = r => { let v = 0; for (let i = 0; i < n; i++) v += (load[i] - r.imp[i]) * (off[i] ? of : pk) / 100 + r.exp[i] * ex / 100; return v * annualise; };
    yearsCfg.push(val(mdl(c.battery * kb, gridMode, c.batExport, c.batKw, c.batEff, c.batKwCharge)));
    finOpts.forEach(o => yearsBy[o.name].push(val(mdl(o.cap * kb, gridMode, c.batExport, o.kw, o.eff, o.kwC))));
  }
  // 5. per-day aggregates
  const standing = R.standing; let si = 0;
  const stand = t => {
    while (si < standing.length && standing[si][1] !== null && standing[si][1] <= t) si++;
    const r = standing[si]; return r && r[0] <= t ? r[2] : c.standing;
  };
  const days = []; let cur = null;
  for (let i = 0; i < n; i++) {
    if (!cur || cur.date !== S.date[i]) {
      cur = { date: S.date[i], i0: i, n: 0, dow: S.dow[i], standing: stand(S.t[i]), rawStand: stand(S.t[i]) };
      FIELDS.forEach(f => { if (f !== 'standing') cur[f] = 0; });
      days.push(cur);
    }
    const e = rate[i] / 100, home = S.kwh[i] - ev[i];
    cur.i1 = i + 1; cur.n++;
    cur.kwh += S.kwh[i]; cur.home += home; cur.ev += ev[i];
    cur.cost += S.kwh[i] * e; cur.costEv += ev[i] * e; cur.costHome += home * e;
    if (off[i]) { cur.off += S.kwh[i]; cur.offCost += S.kwh[i] * e; }
    cur.gen += g[i]; cur.self += self[i]; cur.exp += exp[i]; cur.imp += imp[i];
    cur.load += load[i]; cur.lcost += load[i] * e;
    { // whole-house kWh by rate band, before and after solar (the part of the house outside the Home/EV/Both scope is unchanged)
      const fi = imp[i] + S.kwh[i] - load[i];
      if (off[i]) {
        cur.kHomeOffB += home; cur.kCarB += ev[i];
        const car = Math.min(ev[i], Math.max(0, fi - gch[i]));
        cur.kCarA += car; cur.kHomeOffA += Math.max(0, fi - gch[i] - car);
      } else { cur.kPeakB += S.kwh[i]; cur.kPeakA += fi; }
    }
    cur.pcost += load[i] * prate[i] / 100; cur.pafter += imp[i] * prate[i] / 100;
    { const pe = prate[i] / 100; // £ value of each source at today's prices
      cur.vDirect += direct[i] * pe; cur.vBatSol += (self[i] - direct[i]) * pe; cur.vBg += bg[i] * pe; cur.cCharge += gch[i] * pe;
      if (off[i]) cur.cGridOff += (imp[i] - gch[i]) * pe; else cur.cGridPeak += imp[i] * pe; }
    cur.bg += bg[i]; cur.gch += gch[i]; cur.direct += direct[i]; cur.bx += bx[i]; cur.bxInc += bx[i] * c.exportRate / 100;
    if (off[i]) cur.impOff += imp[i]; else cur.impPeak += imp[i];
    if (off[i]) { cur.loff += load[i]; cur.loffCost += load[i] * e; }
    if (!off[i]) cur.selfPeak += self[i] + bg[i];
    cur.after += imp[i] * e; cur.expInc += exp[i] * c.exportRate / 100;
  }
  days.forEach(d => { d.full = d.n >= 44 ? 1 : 0; if (d.n < 44 || S.scope === 'ev') d.standing = 0; else d.standing /= 100; });
  S.D = { rate, off, ev, load, g, self, exp, imp, days, scen, base, panelRes, yearsCfg, yearsBy, trendInfo: { gU, gE, hist, h: [hg(1), hg(2), hg(3)] }, standNow: days[days.length - 1].rawStand, peakAvg: peakNow, offAvg: offNow, min, max, tou, apiRates: fromApi > n * 0.5 };
  if (!S.selDay || !days.some(d => d.date === S.selDay)) {
    const full = days.filter(d => d.n >= 46); S.selDay = (full[full.length - 1] || days[days.length - 1]).date;
  }
}

/* --------------------------------------------------------------- views ---- */
const viewDays = () => {
  const d = S.D.days;
  if (S.sel) { const v = d.filter(x => x.date >= S.sel.from && x.date <= S.sel.to); if (v.length) return v; }
  return S.range === 'all' ? d : d.slice(-Math.min(d.length, +S.range));
};
function groupKey(date, unit) {
  if (unit === 'day') return date;
  if (unit === 'month') return date.slice(0, 7);
  const [y, m, d] = date.split('-').map(Number), dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - (dt.getUTCDay() + 6) % 7);
  return dt.toISOString().slice(0, 10);
}
function groupDays(days) {
  const unit = S.group !== 'auto' ? S.group : days.length <= 62 ? 'day' : days.length <= 200 ? 'week' : 'month';
  const map = new Map();
  for (const d of days) {
    const k = groupKey(d.date, unit);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(d);
  }
  const groups = [...map].map(([key, ds]) => {
    const t = totals(ds), [y, m, dd] = key.split('-');
    t.key = key; t.unit = unit;
    t.label = unit === 'month' ? MON[m - 1] + " '" + y.slice(2) : (+dd) + ' ' + MON[m - 1];
    t.title = unit === 'day' ? longDate(key) : unit === 'week' ? 'Week of ' + longDate(key) + ' · ' + ds.length + ' days'
      : MON[m - 1] + ' ' + y + ' · ' + ds.length + ' days';
    return t;
  });
  return { unit, groups };
}
// average per half-hour slot across a range of days (kW)
function dayProfile(days) {
  const sumK = { kwh: new Float64Array(48), home: new Float64Array(48), ev: new Float64Array(48),
    gen: new Float64Array(48), imp: new Float64Array(48), load: new Float64Array(48), off: new Float64Array(48), cnt: new Float64Array(48) };
  for (const d of days) for (let i = d.i0; i < d.i1; i++) {
    const h = S.hh[i];
    sumK.kwh[h] += S.kwh[i]; sumK.ev[h] += S.D.ev[i]; sumK.home[h] += S.kwh[i] - S.D.ev[i];
    sumK.gen[h] += S.D.g[i]; sumK.imp[h] += S.D.imp[i]; sumK.load[h] += S.D.load[i]; sumK.off[h] += S.D.off[i]; sumK.cnt[h]++;
  }
  const kw = a => Array.from(a, (v, h) => sumK.cnt[h] ? v / sumK.cnt[h] * 2 : 0);
  return { kwh: kw(sumK.kwh), home: kw(sumK.home), ev: kw(sumK.ev), gen: kw(sumK.gen), imp: kw(sumK.imp), load: kw(sumK.load),
    offFlags: Array.from(sumK.off, (v, h) => sumK.cnt[h] && v / sumK.cnt[h] > 0.5) };
}
const bandsFrom = flags => {
  const r = ranges(flags); let big = 0;
  r.forEach((x, i) => { if (x[1] - x[0] > r[big][1] - r[big][0]) big = i; });
  return r.map((x, i) => [x[0], x[1], i === big ? 'Off-peak' : '']);
};

/* ----------------------------------------------------------------- UI ---- */
const cards = {};
function mkCard(parent, id, title, opts = {}) {
  const el = document.createElement('div');
  el.className = 'card ' + (opts.cls || '');
  el.innerHTML = `<div class="card-h"><div><h3>${title}</h3><div class="sub"></div></div>${opts.noTable ? '' : '<button class="tbtn" aria-pressed="false">View as table</button>'}</div>
    ${opts.extra || ''}<div class="legend"></div><div class="plot"></div><div class="ramp"></div><div class="tblwrap" hidden></div>`;
  $(parent).appendChild(el);
  const c = cards[id] = { el, sub: $('.sub', el), legend: $('.legend', el), plot: $('.plot', el), ramp: $('.ramp', el), tbl: $('.tblwrap', el) };
  const b = $('.tbtn', el);
  if (b) b.onclick = () => {
    const on = c.tbl.hidden;
    c.tbl.hidden = !on; c.plot.hidden = on; c.legend.hidden = on; c.ramp.hidden = on;
    b.textContent = on ? 'View as chart' : 'View as table';
  };
  return c;
}
function chart(id, sub, spec, tbl) {
  const c = cards[id];
  c.sub.textContent = sub || '';
  Charts.legend(c.legend, spec.series);
  Charts.cartesian(c.plot, spec);
  c.tbl.innerHTML = tbl || Charts.table(['', ...spec.series.map(s => s.name)],
    spec.labels.map((l, i) => [spec.tipTitles ? spec.tipTitles[i] : l, ...spec.series.map(s => (s.fmt || spec.valFmt)(s.values[i] || 0))]));
}
function tile(k, v, s, cls = '') {
  return `<div class="tile ${cls}"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
}

function buildLayout() {
  const U = '#usage', V = '#solar';
  mkCard(U, 'usage', 'Usage over time', { cls: 'wide' });
  mkCard(U, 'rates', 'Peak vs off-peak usage');
  mkCard(U, 'spend', 'Spend over time');
  mkCard(U, 'cal', 'Calendar', { cls: 'wide', noTable: true, extra:
    `<div class="daybar"><button class="btn" id="cPrev">‹</button><strong id="cMonth" style="min-width:110px;text-align:center"></strong><button class="btn" id="cNext">›</button>
      <select id="cMetric"><option value="load">Usage (kWh)</option><option value="cost">Cost incl. standing charge (£)</option><option value="peak">Peak-rate usage (kWh)</option><option value="off">Off-peak usage (kWh)</option><option value="save">Solar saving at today's prices (£)</option></select>
      <button class="btn" id="cSelMonth">Filter to this month</button><button class="btn ghost" id="cClear">Clear filter</button></div>` });
  mkCard(U, 'typical', 'A typical day');
  mkCard(U, 'heat', 'When the house is busy');
  mkCard(U, 'top', 'Biggest days', { cls: 'wide', noTable: true });

  const a = mkCard(V, 'assump', 'Your solar assumptions', { cls: 'wide', noTable: true });
  a.plot.innerHTML = `<div class="assump">
    <label>Panel size (W)<input id="aW" type="number" min="100" step="5"></label>
    <label>Estimated generation (kWh/yr)<input id="aGen" type="text" disabled></label>
    <label>Export rate (p/kWh)<input id="aExp" type="number" min="0" step="0.5"></label>
    <label>Battery<select id="aModel"><option value="evo10">Fox EVO 10 (9.7 kWh, 5 kW inverter)</option><option value="evo5">Fox EVO 5 (4.9 kWh, 3.68 kW inverter)</option><option value="pw3">Tesla Powerwall 3 (13.5 kWh, 11.04 kW inverter)</option><option value="custom">Custom</option></select></label>
    <label>Battery usable size (kWh, 0 = none)<input id="aBat" type="number" min="0" step="0.5"></label>
    <label>System cost (£)<input id="aCost" type="number" min="0" step="100" placeholder="for payback"></label>
    <label>Finance term (years, 0 = cash)<input id="aTerm" type="number" min="0" max="25" step="1"></label>
    <label>Finance APR (%)<input id="aApr" type="number" min="0" step="0.1"></label>
    <label>Energy price trend<select id="aTrend"><option value="flat">Flat (today's prices)</option><option value="h1">Last 12 months of your rate history</option><option value="h2">Last 2 years of your rate history</option><option value="h3">Last 3 years of your rate history</option><option value="custom">Custom % a year</option></select></label>
    <label>Charge battery from grid off-peak<select id="aGrid"><option value="off">No (solar only)</option><option value="winter">Winter months (Oct–Mar)</option><option value="all">All year</option></select></label>
    <label>Sell battery to grid at export rate<select id="aBx"><option value="off">No</option><option value="summer">Summer months (Apr–Sep)</option><option value="all">All year</option></select></label></div>
    <div class="roofs" id="roofs"></div>
    <p class="hint" id="trendHint"></p>
    <details><summary>Advanced</summary><div class="assump">
    <label>Latitude<input id="aLat" type="number" step="0.1"></label>
    <label>Longitude<input id="aLon" type="number" step="0.1"></label>
    <label>EV detection threshold (kWh per half hour)<input id="aEv" type="number" step="0.1" min="0.5"></label>
    <label>Fallback peak rate (p/kWh)<input id="aPeak" type="number" step="0.1"></label>
    <label>Fallback off-peak rate (p/kWh)<input id="aOff" type="number" step="0.1"></label>
    <label>Fallback standing charge (p/day)<input id="aStand" type="number" step="0.1"></label>
    <label>Cost per panel added or removed (£)<input id="aPP" type="number" step="10" min="0"></label>
    <label>Battery discharge power (kW)<input id="aKw" type="number" step="0.1" min="0.5"></label>
    <label>Battery charge power (kW)<input id="aKwC" type="number" step="0.1" min="0.5"></label>
    <label>Panel degradation (% a year)<input id="aDeg" type="number" step="0.1" min="0"></label>
    <label>Custom price change (% a year)<input id="aEsc" type="number" step="0.5"></label>
    <label>Export rate change (% a year)<input id="aXe" type="number" step="0.5"></label>
    <label>Battery capacity loss (% a year)<input id="aBd" type="number" step="0.1" min="0"></label>
    <label>Battery round-trip efficiency (%)<input id="aEff" type="number" step="1" min="50" max="100"></label></div>
    <p class="hint">Fallback rates are only used when Octopus tariff rates can't be fetched. The battery discharges only when power is at the peak rate. With grid charging on, it charges overnight at the off-peak rate only as far as tomorrow's shortfall after solar needs (it is assumed to forecast your usage well). Battery presets follow the Fox ESS datasheets: EVO 10 = 10.24 kWh × 95% depth of discharge = 9.73 kWh usable, 5 kW inverter, ~94% round trip; EVO 5 = 5.12 kWh = 4.86 kWh usable, 3.68 kW inverter, ~90% round trip. Panels follow the JA Solar 455 W datasheet (0.4% a year degradation); the quote is 11 panels for 4,359 kWh a year, and other panel counts scale that linearly. The £400 per panel added or removed is a placeholder, so replace it with your installer's figure. Battery capacity fades 2% a year by default (the datasheet's 6,000-cycle life is about 16 years of daily cycling; that is my estimate, not a datasheet figure). Selling to the grid fills the battery off-peak, covers your home use first, and exports the rest at the export rate; check your export tariff allows battery export.</p></details>`;
  const roofHtml = ['Roof 1', 'Roof 2'].map((nm, k) => `<div class="rn" id="r${k + 1}n">${nm}</div>
    <input id="r${k + 1}p" type="number" min="0" max="60" step="1"><input id="r${k + 1}max" type="number" min="0" max="60" step="1"><input id="r${k + 1}az" type="number" min="0" max="180" step="5">
    <select id="r${k + 1}side"><option value="E">East</option><option value="W">West</option></select>
    <input id="r${k + 1}tilt" type="number" min="0" max="90" step="1"><input id="r${k + 1}shade" type="number" min="0.1" max="1" step="0.01">
    <input id="r${k + 1}kk" type="number" min="100" max="1200" step="1"><input id="r${k + 1}gen" type="text" disabled>`).join('');
  $('#roofs').innerHTML = `<div class="rh"></div><div class="rh">Panels</div><div class="rh">Space (max panels)</div><div class="rh">Orientation (° from south)</div><div class="rh">Faces</div><div class="rh">Roof pitch (°)</div><div class="rh">Shade factor</div><div class="rh">Irradiance Kk (kWh/kWp)</div><div class="rh">Generation (kWh/yr)</div>${roofHtml}
    <p class="hint" style="grid-column:1/-1;margin:2px 0 0">0° = due south, 90° = east or west, 180° = north. Kk is the installer's irradiance figure; changing orientation or pitch re-estimates it, and you can overwrite it with the figure from your quote. Generation = panels × panel size × Kk × shade factor. Roof 1 matches the Octopus quote (11 panels, 4,359 kWh). The panel comparison fills roof 1 first, then roof 2; roof 2 is off at 0 panels.</p>`;
  let rtimer;
  S.cfg.roofs.forEach((r, k) => {
    for (const [suf, key] of Object.entries({ p: 'panels', max: 'max', az: 'az', side: 'side', tilt: 'tilt', shade: 'shade', kk: 'kk' })) {
      const el = $(`#r${k + 1}${suf}`); el.value = r[key];
      el.oninput = () => {
        r[key] = el.tagName === 'SELECT' ? el.value : (+el.value || 0);
        if (key === 'az' || key === 'tilt') { r.kk = kkEstimate(S.cfg.lat, S.cfg.lon, r.az, r.tilt); $(`#r${k + 1}kk`).value = r.kk; }
        syncCfg(); if (key === 'panels') syncCost(); saveCfg();
        clearTimeout(rtimer); rtimer = setTimeout(() => { compute(); render(); }, 200);
      };
    }
  });
  const bind = { aW: 'panelW', aPP: 'panelPrice', aExp: 'exportRate', aBat: 'battery', aCost: 'cost', aLat: 'lat', aLon: 'lon', aEv: 'evThr', aGrid: 'gridCharge', aBx: 'batExport', aKw: 'batKw', aKwC: 'batKwCharge', aDeg: 'deg', aEsc: 'escal', aXe: 'exportEscal', aBd: 'batDeg', aTrend: 'trend', aEff: 'batEff', aModel: 'batModel', aTerm: 'term', aApr: 'apr',
    aPeak: 'peak', aOff: 'offpeak', aStand: 'standing' };
  let timer;
  for (const [id, key] of Object.entries(bind)) {
    const inp = $('#' + id); inp.value = S.cfg[key];
    inp.oninput = () => {
      if (['battery', 'batKw', 'batKwCharge', 'batEff'].includes(key)) { S.cfg.batModel = 'custom'; $('#aModel').value = 'custom'; }
      const v = inp.tagName === 'SELECT' ? inp.value : inp.value === '' ? (key === 'cost' ? '' : DEF[key]) : +inp.value;
      S.cfg[key] = v;
      if (key === 'panelPrice' || key === 'panelW') { syncCfg(); if (key === 'panelPrice') syncCost(); }
      if (key === 'batModel' && PRODUCTS[v]) {
        Object.assign(S.cfg, { battery: PRODUCTS[v].battery, batKw: PRODUCTS[v].batKw, batKwCharge: PRODUCTS[v].batKwCharge || PRODUCTS[v].batKw, batEff: PRODUCTS[v].batEff });
        S.cfg.cost = PRODUCTS[v].cost + (S.cfg.panels - QUOTE_PANELS) * S.cfg.panelPrice; $('#aCost').value = Math.round(S.cfg.cost);
        $('#aBat').value = S.cfg.battery; $('#aKw').value = S.cfg.batKw; $('#aKwC').value = S.cfg.batKwCharge; $('#aEff').value = S.cfg.batEff;
      }
      saveCfg();
      clearTimeout(timer); timer = setTimeout(() => { compute(); render(); }, 200);
    };
  }
  const t = document.createElement('div'); t.className = 'card tilesrow'; t.innerHTML = '<div class="tiles" id="solarTiles"></div>';
  $(V).appendChild(t);
  mkCard(V, 'gen', 'Solar generation vs your usage', { cls: 'wide', extra:
    `<div class="daybar"><div class="seg" id="genUnit"><button data-v="kwh">kWh</button><button data-v="gbp">£ at today's prices</button></div></div>` });
  mkCard(V, 'bills', 'Example bills: before and after solar', { cls: 'wide', noTable: true, extra:
    `<div class="daybar"><label style="margin:0">Show <select id="billSel" style="display:inline-block;width:auto;margin-left:6px"></select></label></div><div id="billTbl"></div>` });
  $('#billSel').onchange = e => { S.billSel = e.target.value; renderBills(); };
  mkCard(V, 'sav', 'What it saves you');
  mkCard(V, 'solarDay', 'A typical day with solar');
  mkCard(V, 'insights', 'What this means for you', { noTable: true });
  mkCard(V, 'batcmp', 'Is a battery worth it?');
  mkCard(V, 'panels', 'How many panels?', { cls: 'wide' });
  mkCard(V, 'fin', 'Cost vs savings over 25 years', { cls: 'wide' });
  mkCard(V, 'dayx', 'Pick any day', { cls: 'wide', extra:
    '<div class="daybar"><button class="btn" id="dPrev">‹</button><input type="date" id="dPick"><button class="btn" id="dNext">›</button></div>' });
  $('#cPrev').onclick = () => { S.calMonth = shiftMonth(-1); renderCal(); };
  $('#cNext').onclick = () => { S.calMonth = shiftMonth(1); renderCal(); };
  $('#cMetric').value = S.calMetric;
  $('#cMetric').onchange = e => { S.calMetric = e.target.value; renderCal(); };
  const grid = cards.cal.plot;
  grid.addEventListener('pointermove', e => {
    const c = e.target.closest('[data-date]'); if (!c) return Charts.hideTip();
    const d = S.D.days.find(x => x.date === c.dataset.date), row = (k, v) => `<div class="tr"><span>${k}</span><b>${v}</b></div>`;
    Charts.showTip(`<div class="th">${longDate(d.date)}${d.n < 44 ? ' (partial day)' : ''}</div>` + row(SCOPE[S.scope][1] + ' usage', kwh(d.load)) +
      row('Home / EV', kwh(d.home) + ' / ' + kwh(d.ev)) + row('Off-peak / peak', kwh(d.loff) + ' / ' + kwh(d.load - d.loff)) +
      row('Cost incl. standing', gbp(d.lcost + d.standing)) + row('Solar (modelled)', kwh(d.gen)) +
      row('Solar saving', gbp(d.pcost - d.pafter + d.expInc)) + '<div class="tr tt"><span>Click to filter all charts to this day</span></div>', e);
  });
  grid.addEventListener('pointerleave', Charts.hideTip);
  // Click a day to filter every chart to it, then another day for a range; click a week total for that week.
  grid.addEventListener('click', e => {
    const w = e.target.closest('[data-from]');
    if (w) { setSel(w.dataset.from, w.dataset.to); return; }
    const c = e.target.closest('[data-date]'); if (!c) return;
    const date = c.dataset.date;
    if (S.sel && S.sel.from === S.sel.to && S.anchor === date) setSel(null);
    else if (S.sel && S.sel.from === S.sel.to && S.anchor) setSel(S.anchor < date ? S.anchor : date, S.anchor < date ? date : S.anchor);
    else { S.anchor = date; setSel(date, date); }
  });
  $('#cSelMonth').onclick = () => {
    const ds = S.D.days.filter(d => d.date.startsWith(S.calMonth)); setSel(ds[0].date, ds[ds.length - 1].date);
  };
  $('#cClear').onclick = () => setSel(null);
  const step = k => {
    const ds = S.D.days, i = ds.findIndex(d => d.date === S.selDay);
    S.selDay = ds[Math.min(ds.length - 1, Math.max(0, i + k))].date; renderDay();
  };
  $('#dPrev').onclick = () => step(-1); $('#dNext').onclick = () => step(1);
  $('#dPick').onchange = e => { if (S.D.days.some(d => d.date === e.target.value)) { S.selDay = e.target.value; renderDay(); } };
}

/* -------------------------------------------------------------- render ---- */
function render() {
  const vd = viewDays(), T = totals(vd), nd = vd.length, c = S.cfg;
  const { unit, groups } = groupDays(vd);
  const per = { day: 'day', week: 'week', month: 'month' }[unit];
  const labels = groups.map(g => g.label), tipTitles = groups.map(g => g.title);
  const range = `${longDate(vd[0].date)} – ${longDate(vd[nd - 1].date)}`;

  // header chip for a calendar-picked range
  const chip = $('#selChip');
  chip.hidden = !S.sel;
  if (S.sel) chip.textContent = (S.sel.from === S.sel.to ? longDate(S.sel.from) : longDate(S.sel.from) + ' – ' + longDate(S.sel.to)) + '  ✕';
  $('#range').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(!S.sel && b.dataset.v === S.range)));

  // KPI tiles (first three follow the Home / EV / Both filter)
  const [scopeName, scopeShort] = SCOPE[S.scope], showH = S.scope !== 'ev', showE = S.scope !== 'home';
  const bill = T.lcost + T.standing;
  $('#kpis').innerHTML =
    tile(`Used · ${scopeShort}`, `${nf(T.load, 0)}<small>kWh</small>`, `${nf(T.load / nd, 1)} kWh a day over ${nd} days`) +
    tile(`Bill · ${scopeShort}`, gbp(bill), `${gbp(bill / nd)} a day` + (T.standing ? ` · ${gbp(T.standing)} standing charge` : ' · energy only')) +
    tile('Average unit price', T.load ? `${nf(T.lcost / T.load * 100, 1)}<small>p/kWh</small>` : '—',
      S.D.tou && T.load ? `${pct(T.loff / T.load)} at the off-peak rate` : 'Flat-rate tariff') +
    tile('EV charging', `${nf(T.ev, 0)}<small>kWh</small>`,
      T.ev ? `${gbp(T.costEv)} · ${nf(T.costEv / T.ev * 100, 1)}p/kWh · ${pct(T.ev / T.kwh)} of all usage` : 'No EV charging detected') +
    tile('Home (excluding EV)', `${nf(T.home / nd, 1)}<small>kWh/day</small>`, `${gbp(T.costHome / nd)} a day in energy`);

  // usage charts
  const homeS = (vals, type) => ({ name: 'Home', color: 'var(--c-home)', values: vals, type });
  const evS = (vals, type) => ({ name: 'EV charging', color: 'var(--c-ev)', values: vals, type });
  chart('usage', `${range} · ${scopeName} · per ${per}`, { title: 'Usage', labels, tipTitles, unit: 'kWh', valFmt: v => kwh(v, 1),
    series: [showH && homeS(groups.map(g => g.home)), showE && evS(groups.map(g => g.ev))].filter(Boolean) });
  const offKwh = groups.map(g => g.loff), peakKwh = groups.map(g => Math.max(0, g.load - g.loff));
  chart('rates', S.D.tou
      ? `${scopeName} by rate · off-peak ${nf(T.loff, 0)} kWh (${pct(T.load ? T.loff / T.load : 0)}, ${gbp(T.loffCost)}) · peak ${nf(T.load - T.loff, 0)} kWh (${pct(T.load ? 1 - T.loff / T.load : 0)}, ${gbp(T.lcost - T.loffCost)})`
      : 'Your tariff has a single rate, so everything counts as peak',
    { title: 'Peak vs off-peak', labels, tipTitles, unit: 'kWh', valFmt: v => kwh(v, 1),
      series: [{ name: 'Off-peak rate', color: 'var(--c-grid)', values: offKwh }, { name: 'Peak rate', color: 'var(--c-neutral)', values: peakKwh }] },
    Charts.table(['', 'Off-peak kWh', 'Peak kWh', 'Off-peak £', 'Peak £', 'Off-peak share'],
      groups.map(g => [g.title, kwh(g.loff), kwh(g.load - g.loff), gbp(g.loffCost), gbp(g.lcost - g.loffCost), pct(g.load ? g.loff / g.load : 0)])));
  chart('spend', `Energy cost by ${per}${showH ? ', with standing charge' : ''} · ${scopeName}`, { title: 'Spend', labels, tipTitles, unit: '£', yFmt: v => nf(v, v % 1 ? 1 : 0), valFmt: gbp,
    series: [showH && homeS(groups.map(g => g.costHome)), showE && evS(groups.map(g => g.costEv)),
      showH && { name: 'Standing charge', color: 'var(--c-neutral)', values: groups.map(g => g.standing) }].filter(Boolean) });
  const P = dayProfile(vd), hours = Array.from({ length: 48 }, (_, i) => i);
  chart('typical', 'Average power draw through the day · shaded = off-peak rate',
    { title: 'Typical day', labels: hours.map(hhLabel), unit: 'kW', height: 240, xTicks: [0, 6, 12, 18, 24, 30, 36, 42],
      valFmt: v => nf(v, 2) + ' kW', bands: bandsFrom(P.offFlags), stackTotal: false,
      series: [showH && homeS(P.home, 'line'), showE && evS(P.ev, 'line')].filter(Boolean) });

  // heatmap: home usage by weekday × hour
  const cell = Array.from({ length: 7 }, () => new Float64Array(24)), cnt = new Float64Array(7);
  for (const d of vd) {
    cnt[d.dow]++;
    for (let i = d.i0; i < d.i1; i++) cell[S.dow[i]][S.hh[i] >> 1] += S.D.load[i];
  }
  const hv = cell.map((r, d) => Array.from(r, v => cnt[d] ? v / cnt[d] : 0));
  const hs = { rows: DOW, cols: Array.from({ length: 24 }, (_, i) => pad(i)), values: hv, colTicks: [0, 3, 6, 9, 12, 15, 18, 21],
    label: 'Average ' + scopeName, fmt: v => nf(v, 2) + ' kWh', colTitle: c2 => pad(c2) + ':00–' + pad(c2 + 1) + ':00' };
  cards.heat.sub.textContent = `Average kWh per hour · ${scopeName} · darker = more`;
  Charts.heatmap(cards.heat.plot, hs, cards.heat.ramp);
  cards.heat.tbl.innerHTML = Charts.table(['Day', ...hs.cols.map(h => h + ':00')], hv.map((r, i) => [DOW[i], ...r.map(v => nf(v, 2))]));

  const top = [...vd].sort((a, b) => b.load - a.load).slice(0, 6);
  cards.top.sub.textContent = `Highest ${scopeName} in this period`;
  cards.top.plot.innerHTML = Charts.table(['Day', 'Usage', 'EV', 'Cost'],
    top.map(d => [longDate(d.date), kwh(d.load), kwh(d.ev), gbp(d.lcost + d.standing)]));

  renderSolar(vd, T, nd, groups, labels, tipTitles, per, P, hours);
  renderTrend();
  renderBills();
  renderDay();
  renderCal();
}

function renderSolar(vd, T, nd, groups, labels, tipTitles, per, P, hours) {
  const c = S.cfg, all = S.D.days, A = totals(all);
  const [scopeName, scopeShort] = SCOPE[S.scope];
  const saved = (T.pcost - T.pafter) + T.expInc, billBefore = T.pcost + T.standing, billAfter = T.pafter + T.standing - T.expInc;
  const annualSave = A.gen ? ((A.pcost - A.pafter) + A.expInc) * c.annual / A.gen : 0;
  // 25-year outlook from the year-by-year model (panel and battery degradation, price trend)
  const yrs = Array.from({ length: 25 }, (_, i) => i + 1);
  const life = []; let cum = 0, payYear = null;
  for (const y of yrs) {
    const v = S.D.yearsCfg[y - 1];
    cum += v; life.push({ y, v, cum });
    if (payYear === null && c.cost > 0 && cum >= c.cost) payYear = y - 1 + (c.cost - (cum - v)) / v;
  }
  const payback = payYear;
  $('#solarTiles').innerHTML =
    tile('Solar generated (modelled)', `${nf(T.gen, 0)}<small>kWh</small>`, `${pct(T.gen / c.annual)} of a ${nf(c.annual)} kWh year · ${c.panels} × ${c.panelW} W = ${nf(c.kwp, 1)} kWp`) +
    tile('Used in your home', pct(T.gen ? T.self / T.gen : 0), `${kwh(T.self)} used · ${kwh(T.exp - T.bx)} exported` + (T.bx ? ` · +${kwh(T.bx)} from battery` : '')) +
    tile('Share of ' + scopeName + ' covered', pct(T.load ? (T.self + T.bg) / T.load : 0), `${kwh(Math.max(0, T.load - T.self - T.bg))} still bought from the grid`) +
    tile('Saved at today\'s prices', gbp(saved), `Bill ${gbp(billBefore)} → ${gbp(billAfter)}`) +
    tile('Projected saving per year', gbp(annualSave), `From ${all.length} days of your data${all.length < 330 ? ' (scaled to a full year)' : ''}`, 'hero') +
    tile('Payback', payback ? `${nf(payback, 1)}<small>years</small>` : '—', payback ? `On a ${gbp(c.cost)} system` : c.cost > 0 ? 'Not within 25 years' : 'Add a system cost above') +
    tile('Saved over 25 years', gbp(cum), `Panels −${c.deg}%/yr, battery −${c.batDeg}%/yr, unit rates ${S.D.trendInfo.gU ? (S.D.trendInfo.gU > 0 ? '+' : '') + nf(S.D.trendInfo.gU * 100, 1) + '%/yr' : 'flat'}`);

  // Supply stack: everything below the usage line is what meets your usage (solar, battery, grid);
  // anything above it is surplus sent to the grid. So a winter shortfall shows as battery / grid segments.
  const batOn = c.battery > 0, pounds = S.genUnit === 'gbp';
  const gv = (kf, pf) => groups.map(g => pounds ? pf(g) : kf(g));
  chart('gen', pounds
      ? `What each source is worth at today's prices: green and pink = bills avoided, grey and violet = still paid, amber = export income · per ${per}`
      : `How solar and the battery meet ${scopeName}, and what is left over · per ${per}${batOn ? ' · ' + nf(c.battery, 2) + ' kWh battery' : ''}`,
    { title: 'Solar vs usage', labels, tipTitles, unit: pounds ? '£' : 'kWh', yFmt: pounds ? (v => nf(v, v % 1 ? 1 : 0)) : undefined,
      valFmt: pounds ? gbp : (v => kwh(v, 1)), stackTotal: false, height: 290,
      series: [{ name: 'Solar used directly', color: 'var(--c-solar)', values: gv(g => g.direct, g => g.vDirect) },
        batOn && { name: 'Battery (stored solar)', color: 'var(--c-solar-soft)', values: gv(g => Math.max(0, g.self - g.direct), g => g.vBatSol) },
        batOn && { name: 'Battery (charged off-peak)', color: 'var(--c-batt)', values: gv(g => g.bg, g => g.vBg) },
        { name: 'Grid, off-peak rate', color: 'var(--c-grid)', values: gv(g => Math.max(0, g.impOff - g.gch), g => g.cGridOff) },
        { name: 'Grid, peak rate', color: 'var(--c-neutral)', values: gv(g => g.impPeak, g => g.cGridPeak) },
        { name: pounds ? 'Solar export income' : 'Solar exported', color: 'var(--c-export)', values: gv(g => Math.max(0, g.exp - g.bx), g => Math.max(0, g.expInc - g.bxInc)) },
        T.bx > 0 && { name: pounds ? 'Battery export income' : 'Battery sold to grid', color: 'var(--c-sold)', values: gv(g => g.bx, g => g.bxInc) },
        pounds && batOn && { name: 'Paid to charge battery off-peak', color: 'var(--c-batt-soft)', values: groups.map(g => g.cCharge) },
        { name: pounds ? scopeShort + ' usage, priced without solar' : scopeShort + ' usage', color: 'var(--c-home)', type: 'line', values: gv(g => g.load, g => g.pcost) }].filter(Boolean) });
  chart('sav', `Bill reduction by ${per}`,
    { title: 'Savings', labels, tipTitles, unit: '£', yFmt: v => nf(v, v % 1 ? 1 : 0), valFmt: gbp, totalLabel: 'Total saving',
      series: [{ name: 'Imports avoided', color: 'var(--c-solar)', values: groups.map(g => Math.max(0, g.pcost - g.pafter)) },
        { name: `Solar export income (${c.exportRate}p)`, color: 'var(--c-export)', values: groups.map(g => Math.max(0, g.expInc - g.bxInc)) },
        T.bx > 0 && { name: 'Battery export income', color: 'var(--c-batt)', values: groups.map(g => g.bxInc) }].filter(Boolean) });
  chart('solarDay', `Average day · ${scopeName} · shaded = off-peak rate`,
    { title: 'Typical day with solar', labels: hours.map(hhLabel), unit: 'kW', height: 240, xTicks: [0, 6, 12, 18, 24, 30, 36, 42],
      valFmt: v => nf(v, 2) + ' kW', bands: bandsFrom(P.offFlags), stackTotal: false,
      series: [{ name: scopeShort + ' usage', color: 'var(--c-home)', type: 'line', values: P.load },
        { name: 'Solar', color: 'var(--c-solar)', type: 'area', values: P.gen },
        { name: 'Imported after solar', color: 'var(--c-neutral)', type: 'line', dash: true, values: P.imp }] });
  const D = S.D;
  const sc = D.scen, cats = ['No battery', ...sc.map(x => x.name)];
  chart('batcmp', 'Projected £ saved per year: solar alone, plus what each battery adds',
    { title: 'Battery comparison', labels: cats, unit: '£', yFmt: v => nf(v, 0), valFmt: gbp, totalLabel: 'Total saving a year', height: 250,
      series: [{ name: 'Solar alone', color: 'var(--c-solar)', values: [D.base, ...sc.map(x => D.base)] },
        { name: 'Battery storing solar', color: 'var(--c-solar-soft)', values: [0, ...sc.map(x => Math.max(0, x.bat - D.base))] },
        { name: 'Off-peak charging, Oct–Mar', color: 'var(--c-grid)', values: [0, ...sc.map(x => Math.max(0, x.win - x.bat))] },
        { name: 'Summer export to grid', color: 'var(--c-batt)', values: [0, ...sc.map(x => Math.max(0, x.ex - x.win))] }] },
    Charts.table(['Battery', 'Solar alone', '+ stores solar', '+ off-peak Oct–Mar', '+ summer export', '+ off-peak all year (no export)', 'Sold to grid (summer)'],
      [['No battery', gbp(D.base), '', '', '', '', ''], ...sc.map(x => [x.name, gbp(D.base), gbp(x.bat), gbp(x.win), gbp(x.ex), gbp(x.all), kwh(x.exKwh, 0)])]));
  // Panel count comparison: saving by number of panels, with the marginal value of each extra panel
  const pr = D.panelRes, pcash = x => c.cost + (x.np - c.panels) * c.panelPrice, r1 = compass(c.roofs[0].az, c.roofs[0].side), r2 = compass(c.roofs[1].az, c.roofs[1].side);
  chart('panels', `Projected saving a year by total panels (first ${c.roofs[0].max} on the ${r1} roof, extras on the ${r2} roof) · ${c.battery > 0 ? nf(c.battery, 2) + ' kWh battery' : 'no battery'} · your quote is ${QUOTE_PANELS} panels`,
    { title: 'Panels', labels: pr.map(x => String(x.np)), tipTitles: pr.map(x => `${x.np} panels${x.n2 ? ` (${x.n1} ${r1} + ${x.n2} ${r2})` : ''} · ${nf(x.kwp, 1)} kWp · ${nf(x.gen, 0)} kWh a year`), unit: '£ a year', valFmt: gbp,
      yFmt: v => nf(v, 0), totalLabel: 'Total saving a year', height: 240,
      series: [{ name: 'Solar alone', color: 'var(--c-solar)', values: pr.map(x => x.solarOnly) },
        { name: 'Battery adds', color: 'var(--c-batt)', values: pr.map(x => Math.max(0, x.full - x.solarOnly)) }] },
    Charts.table(['Panels', 'kWp', 'kWh a year', 'Saving a year', 'Price'], pr.map(x => [x.np, nf(x.kwp, 2), nf(x.gen, 0), gbp(x.full), gbp(pcash(x))])));
  cards.panels.ramp.innerHTML = '<div class="tblwrap" style="max-height:none"><table><thead><tr><th>Panels</th><th>Total size</th><th>Generation</th><th>Used at home</th><th>Saving a year</th><th>Extra per added panel</th><th>Price</th><th>Cash payback</th></tr></thead><tbody>' +
    pr.map((x, i) => {
      const prev = pr[i - 1], marg = prev ? (x.full - prev.full) / (x.np - prev.np) : null;
      return `<tr${x.np === c.panels ? ' style="font-weight:650"' : ''}><td>${x.np}${x.n2 ? ` <small>(${x.n1} ${r1} + ${x.n2} ${r2})</small>` : ''}${x.np === c.panels ? ' ◂ selected' : x.np === QUOTE_PANELS ? ' (quote)' : ''}</td><td>${nf(x.kwp, 1)} kWp</td><td>${nf(x.gen, 0)} kWh</td><td>${pct(x.selfPct)}</td><td>${gbp(x.full)}</td><td>${marg === null ? '' : gbp(marg) + ' a year'}</td><td>${gbp(pcash(x))}</td><td>${x.full > 0 ? nf(pcash(x) / x.full, 1) + ' years' : ''}</td></tr>`;
    }).join('') + '</tbody></table></div>';
  // Finance: a loan at the quoted APR (monthly rate = (1+APR)^(1/12)-1), paid over `term` years, against yearly savings
  const finance = (price, years) => {
    const r = c.apr > 0 ? Math.pow(1 + c.apr / 100, 1 / 12) - 1 : 0, nM = Math.round(c.term * 12);
    const pmt = nM === 0 ? 0 : r ? price * r / (1 - Math.pow(1 + r, -nM)) : price / nM;
    let cum = 0, cumCash = 0, be = null, cash = null; const rows = [];
    for (const y of yrs) {
      const sv = years[y - 1];
      const pay = nM === 0 ? (y === 1 ? price : 0) : y <= c.term ? pmt * 12 : 0;
      const prev = cum, prevCash = cumCash; cum += sv - pay; cumCash += sv;
      rows.push({ y, sv, pay, cum });
      if (be === null && cum >= 0) be = y - 1 + (cum - prev ? -prev / (cum - prev) : 0);
      if (cash === null && cumCash >= price) cash = y - 1 + (sv ? (price - prevCash) / sv : 0);
    }
    return { pmt, nM, total: pmt * nM, interest: pmt * nM - price, rows, be, cash, net: cum };
  };
  const fo = D.scen.filter(x => x.price > 0).map(x => ({ ...x, f: finance(x.price, D.yearsBy[x.name]) }));
  const colours = ['var(--c-grid)', 'var(--c-batt)', 'var(--c-export)'];
  if (fo.length) {
    const yrLabel = v => v === null ? 'not within 25 years' : nf(v, 1) + ' years';
    const trow = (label, fn) => `<tr><td>${label}</td>${fo.map(x => `<td>${fn(x)}</td>`).join('')}</tr>`;
    cards.fin.ramp.innerHTML = '<div class="tblwrap" style="max-height:none"><table><thead><tr><th></th>' + fo.map(x => `<th>${esc(x.name)}</th>`).join('') + '</tr></thead><tbody>' +
      trow('System price', x => gbp(x.price)) +
      trow(c.term ? `Monthly payment (${c.term} years at ${c.apr}% APR)` : 'Paid up front', x => c.term ? gbp(x.f.pmt) : gbp(x.price)) +
      trow('Total repaid (of which interest)', x => c.term ? `${gbp(x.f.total)} (${gbp(x.f.interest)})` : gbp(x.price)) +
      trow('Saving in year 1 (your settings)', x => gbp(x.cfg) + ` (${gbp(x.cfg / 12)} a month)`) +
      trow('Saving minus payment, per month while paying', x => (x.cfg / 12 - x.f.pmt >= 0 ? '+' : '') + gbp(x.cfg / 12 - x.f.pmt)) +
      trow('Payback if bought in cash', x => yrLabel(x.f.cash)) +
      trow('Break-even on the finance deal', x => yrLabel(x.f.be)) +
      trow('Net position after 25 years', x => gbp(x.f.net)) +
      trow('Peak-rate electricity still bought a year (your settings)', x => `${nf(x.peakCfg, 0)} kWh · ${gbp(x.peakCfg * D.peakAvg / 100)}`) +
      trow('Peak-rate electricity still bought, battery filled to 100% every night', x => `${nf(x.peakFull, 0)} kWh · ${gbp(x.peakFull * D.peakAvg / 100)}`) +
      trow('Warranty: battery energy out a year (your settings)', x => `${nf(x.thru, 0)} kWh`) +
      trow('Warranty: throughput vs the datasheet limit over the warranty', x => x.warrMWh ? `${nf(x.thru * 12 / 1000, 1)} of ${x.warrMWh} MWh (${pct(x.thru * 12 / 1000 / x.warrMWh)})` : '—') +
      trow('Warranty: same, if you never sell to the grid', x => x.warrMWh ? `${nf(x.thruNoSell * 12 / 1000, 1)} of ${x.warrMWh} MWh (${pct(x.thruNoSell * 12 / 1000 / x.warrMWh)})` : '—') +
      trow('Warranty: capacity at year 12 vs 70% guarantee', x => `${pct(Math.max(0, 1 - c.batDeg / 100 * 12))} (assumed ${c.batDeg}% a year loss)`) +
      '</tbody></table></div>';
    chart('fin', `Cumulative £ after repayments: below zero you are still paying the system off · ${c.term ? c.term + '-year finance at ' + c.apr + '% APR' : 'bought in cash'} · panels −${c.deg}% a year, battery capacity −${c.batDeg}% a year, unit rates ${D.trendInfo.gU ? (D.trendInfo.gU > 0 ? '+' : '') + nf(D.trendInfo.gU * 100, 1) + '% a year' : 'held flat'}${D.trendInfo.gE ? ', export ' + (D.trendInfo.gE > 0 ? '+' : '') + nf(D.trendInfo.gE * 100, 1) + '% a year' : ''}`,
      { title: 'Cumulative position', labels: yrs.map(y => 'Yr ' + y), tipTitles: yrs.map(y => 'End of year ' + y), unit: '£', yFmt: v => nf(v, 0), valFmt: gbp,
        xTicks: [0, 4, 9, 14, 19, 24], height: 270, stackTotal: false,
        series: fo.map((x, i) => ({ name: x.short, color: colours[i % 3], type: 'line', values: x.f.rows.map(r => r.cum) })) },
      Charts.table(['Year', ...fo.flatMap(x => [x.short + ' saving', x.short + ' paid', x.short + ' cumulative'])],
        yrs.map((y, i) => ['Year ' + y, ...fo.flatMap(x => [gbp(x.f.rows[i].sv), gbp(x.f.rows[i].pay), gbp(x.f.rows[i].cum)])])));
  } else { cards.fin.plot.innerHTML = '<p class="hint">Enter a system cost above to see finance and payback.</p>'; }
  cards.insights.sub.textContent = 'Calculated from your data in this period';
  cards.insights.plot.innerHTML = '<ul class="insights">' + insights(vd, T, groups).map(i => `<li class="${i[0]}">${i[1]}</li>`).join('') + '</ul>';
}

function insights(vd, T, groups) {
  const c = S.cfg, out = [], D = S.D;
  const peakKwh = T.load - T.loff, peakRate = D.peakAvg;
  if (D.tou && T.load) {
    out.push(['', `<b>${pct(T.loff / T.load)}</b> of your ${SCOPE[S.scope][0]} (${kwh(T.loff)}) is bought at the cheap rate. At today's prices that is <b>${nf(D.offAvg, 1)}p</b> a kWh against <b>${nf(peakRate, 1)}p</b> at peak, so your ${kwh(peakKwh)} of peak-rate use costs about ${gbp(peakKwh * peakRate / 100)} over this period.`]);
  }
  if (T.gen && peakKwh) {
    const avoided = T.self + T.bg ? (T.pcost - T.pafter) / (T.self + T.bg) * 100 : 0;
    out.push(['good', `Solar${c.battery ? ' and the battery' : ''} would cover <b>${pct(T.selfPeak / peakKwh)}</b> of your peak-rate usage. Each kWh it displaces is worth <b>${nf(avoided, 1)}p</b>, against ${c.exportRate}p for a kWh exported. Daytime usage at home is what makes solar pay.`]);
  }
  if (T.gen) {
    out.push(['', `<b>${pct(T.self / T.gen)}</b> of generation is used directly in the home${c.battery ? ' (including battery)' : ''}; the other ${kwh(T.exp - T.bx)} is exported for ${gbp(T.expInc - T.bxInc)}.` +
      (c.battery ? '' : ' Set a battery size above to see how much more you could keep.')]);
  }
  if (T.ev > 1 && S.scope === 'home') {
    out.push(['ev', `<b>EV left out of the solar model.</b> It keeps charging overnight at the off-peak rate: ${kwh(T.ev)} costing ${gbp(T.costEv)} (${nf(T.costEv / T.ev * 100, 1)}p a kWh) in this period, the same with or without solar.`]);
  }
  if (T.ev > 1 && S.scope !== 'home' && T.gen) {
    out.push(['ev', `<b>Solar and EV charging barely overlap.</b> Overnight off-peak charging happens when there is no sun, so solar covers only ${pct(T.load ? T.self / T.load : 0)} of the ${SCOPE[S.scope][0]} here. Switch the filter to <b>Home</b> to see solar against household use alone.`]);
  }
  if (D.tou && D.scen.length) {
    const sc = D.scen.find(x => Math.abs(x.cap - c.battery) < 0.05) || D.scen[D.scen.length - 1];
    out.push(['good', `<b>Charging a battery off-peak:</b> a ${nf(sc.cap, 1)} kWh battery filled overnight at ~${nf(D.offAvg, 1)}p and used when solar falls short (power at ~${nf(D.peakAvg, 1)}p) would add about <b>${gbp(Math.max(0, sc.win - sc.bat))}</b> a year over Oct–Mar, shifting ${kwh(sc.winKwh, 0)} off peak. Charging all year adds ${gbp(Math.max(0, sc.all - sc.bat))}; just storing your own solar adds ${gbp(Math.max(0, sc.bat - D.base))}. Compare that to the battery's price to judge payback.`]);
  }
  if (D.tou && D.scen.length) {
    const sc = D.scen.find(x => Math.abs(x.cap - c.battery) < 0.05) || D.scen[D.scen.length - 1];
    const gain = Math.max(0, sc.ex - sc.win), perKwh = sc.exKwh ? gain / sc.exKwh * 100 : 0;
    out.push([gain > 1 ? 'good' : '', gain > 1
      ? `<b>Selling battery power in summer:</b> filling a ${nf(sc.cap, 1)} kWh battery overnight at ~${nf(D.offAvg, 1)}p and exporting what home use doesn't need at ${c.exportRate}p adds about <b>${gbp(gain)}</b> a year (${kwh(sc.exKwh, 0)} sold, ~${nf(perKwh, 1)}p profit per kWh after losses). It's a small, steady gain, and it only works if your export tariff permits battery export.`
      : `<b>Selling battery power to the grid</b> doesn't pay at an export rate of ${c.exportRate}p against ~${nf(D.offAvg, 1)}p off-peak power once battery losses are counted.`]);
  }
  const months = new Map();
  for (const d of vd) {
    const k = d.date.slice(0, 7); const m = months.get(k) || { k, s: 0, n: 0 };
    m.s += d.pcost - d.pafter + d.expInc; m.n++; months.set(k, m);
  }
  const full = [...months.values()].filter(m => m.n >= 25);
  if (full.length >= 3) {
    full.sort((a, b) => b.s - a.s);
    const f = m => MON[+m.k.slice(5) - 1] + ' ' + m.k.slice(0, 4);
    out.push(['', `Best month for solar: <b>${f(full[0])}</b> (${gbp(full[0].s)} saved). Worst: <b>${f(full[full.length - 1])}</b> (${gbp(full[full.length - 1].s)}).`]);
  }
  return out.length ? out : [['', 'Not enough data yet.']];
}

const CAL = {
  load: { f: d => d.load, fmt: v => nf(v, v < 10 ? 1 : 0), unit: ' kWh', pre: '' },
  cost: { f: d => d.lcost + d.standing, fmt: v => nf(v, 2), unit: '', pre: '£' },
  peak: { f: d => Math.max(0, d.load - d.loff), fmt: v => nf(v, v < 10 ? 1 : 0), unit: ' kWh', pre: '' },
  off: { f: d => d.loff, fmt: v => nf(v, v < 10 ? 1 : 0), unit: ' kWh', pre: '' },
  save: { f: d => d.pcost - d.pafter + d.expInc, fmt: v => nf(v, 2), unit: '', pre: '£' },
};
function setSel(from, to) {
  S.sel = from ? { from, to: to || from } : null;
  if (!from || from !== (to || from)) S.anchor = null;
  if (S.sel) { S.selDay = S.sel.from; if (S.sel.from < S.D.days[0].date) S.sel.from = S.D.days[0].date; }
  render();
}
function shiftMonth(k) {
  const months = [...new Set(S.D.days.map(d => d.date.slice(0, 7)))], i = months.indexOf(S.calMonth);
  return months[Math.min(months.length - 1, Math.max(0, i + k))];
}
function textOn(rgb) { const [r, g, b] = rgb.match(/\d+/g).map(Number); return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? '#0b0b0b' : '#ffffff'; }
function renderCal() {
  const D = S.D, m = CAL[S.calMetric], byDate = new Map(D.days.map(d => [d.date, d]));
  const months = [...new Set(D.days.map(d => d.date.slice(0, 7)))];
  if (!months.includes(S.calMonth)) S.calMonth = months[months.length - 1];
  const mi = months.indexOf(S.calMonth);
  $('#cPrev').disabled = mi <= 0; $('#cNext').disabled = mi >= months.length - 1;
  const [y, mo] = S.calMonth.split('-').map(Number);
  $('#cMonth').textContent = MON[mo - 1] + ' ' + y;
  const sorted = D.days.map(m.f).sort((a, b) => a - b), cap = Math.max(1e-9, sorted[Math.floor(sorted.length * 0.95)] || 1);
  const lead = (new Date(Date.UTC(y, mo - 1, 1)).getUTCDay() + 6) % 7, nDays = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  let html = DOW.map(d => `<div class="cal-h">${d}</div>`).join('') + '<div class="cal-h">Week</div>';
  let wk = 0, has = false, col = 0, total = 0, tdays = 0, wFrom = null, wTo = null;
  const inSel = date => S.sel && date >= S.sel.from && date <= S.sel.to;
  const flush = () => {
    html += has ? `<div class="cal-w pick${wFrom >= (S.sel ? S.sel.from : '~') && wTo <= (S.sel ? S.sel.to : '') ? ' sel' : ''}" data-from="${wFrom}" data-to="${wTo}" title="Filter to this week">${m.pre}${m.fmt(wk)}${m.unit}</div>` : '<div class="cal-w"></div>';
    wk = 0; has = false; col = 0; wFrom = wTo = null;
  };
  for (let i = 0; i < lead; i++) { html += '<div class="cal-c empty"></div>'; col++; }
  for (let day = 1; day <= nDays; day++) {
    const date = `${y}-${pad(mo)}-${pad(day)}`, d = byDate.get(date);
    if (d) {
      const v = m.f(d), bg = Charts.ramp(v / cap); wk += v; total += v; tdays++; has = true; wFrom = wFrom || date; wTo = date;
      html += `<div class="cal-c${inSel(date) ? ' sel' : ''}" data-date="${date}" style="background:${bg};color:${textOn(bg)}"><span class="n">${day}</span><span class="v">${m.pre}${m.fmt(v)}</span></div>`;
    } else html += `<div class="cal-c out"><span class="n">${day}</span></div>`;
    if (++col === 7) flush();
  }
  if (col > 0) { while (col < 7) { html += '<div class="cal-c empty"></div>'; col++; } flush(); }
  cards.cal.plot.innerHTML = `<div class="cal-grid">${html}</div>`;
  cards.cal.sub.textContent = `${SCOPE[S.scope][0]} · ${MON[mo - 1]} ${y}: ${m.pre}${m.fmt(total)}${m.unit} over ${tdays} days · click a day, then another, to filter every chart to that range (or click a week total)`;
  const stops = [0, 0.25, 0.5, 0.75, 1].map(t => Charts.ramp(t)).join(',');
  cards.cal.ramp.innerHTML = `<div class="rampbar" style="background:linear-gradient(90deg,${stops});max-width:420px"></div><div class="ramplab" style="max-width:420px"><span>${m.pre}0</span><span>${m.pre}${m.fmt(cap)}${m.unit}+</span></div>`;
}

function renderTrend() {
  const ti = S.D.trendInfo, h = ti.hist, sg = v => (v >= 0 ? '+' : '') + nf(v * 100, 1) + '%/yr';
  [['h1', 1], ['h2', 2], ['h3', 3]].forEach(([v, k]) => {
    const o = $(`#aTrend option[value="${v}"]`), g = ti.h[k - 1];
    o.disabled = g == null; o.textContent = `Last ${k === 1 ? '12 months' : k + ' years'} of your rate history` + (g == null ? ' (not available)' : ` (${sg(g)})`);
  });
  $('#aTrend').value = S.cfg.trend;
  $('#trendHint').innerHTML = h.length
    ? `Your tariff's average peak rate over 12 months: ${[...h].reverse().map(x => `${x.end.slice(0, 4)} ${nf(x.peak, 1)}p`).join(' → ')} (today's rate ${nf(S.D.peakAvg, 1)}p; off-peak ${[...h].reverse().map(x => nf(x.off, 1) + 'p').join(' → ')}). The trend % is applied to peak and off-peak rates every year from today's prices, and bills and savings in later years use them. Past rates fell after the 2022–23 energy crisis, so the longer the window the lower the trend.`
    : 'Your rate history is not available (demo data or Octopus could not be reached), so the trend options fall back to flat prices.';
}
function renderBills() {
  const D = S.D, c = S.cfg, pk = D.peakAvg, off = D.offAvg, sn = D.standNow / 100;
  const byMonth = new Map();
  for (const d of D.days) { const k = d.date.slice(0, 7); if (!byMonth.has(k)) byMonth.set(k, []); byMonth.get(k).push(d); }
  const months = [...byMonth].filter(([, ds]) => ds.reduce((a, d) => a + d.full, 0) >= 20).map(([k]) => k);
  const opts = [['avg', 'Average month (all your data)'], ['winter', 'Typical winter month (Dec–Feb)'], ['summer', 'Typical summer month (Jun–Aug)'],
    ...months.map(k => [k, MON[+k.slice(5) - 1] + ' ' + k.slice(0, 4)])];
  const sel = $('#billSel');
  if (!opts.some(o => o[0] === S.billSel)) S.billSel = 'avg';
  sel.innerHTML = opts.map(o => `<option value="${o[0]}"${o[0] === S.billSel ? ' selected' : ''}>${o[1]}</option>`).join('');

  // a bill (before / after solar) from a set of days, scaled by f; all at today's unit rates and standing charge
  const bill = (ds, f) => {
    const T = totals(ds), dayN = T.full * f, st = dayN * sn;
    const B = { peak: T.kPeakB * f, home: T.kHomeOffB * f, car: T.kCarB * f };
    const A = { peak: T.kPeakA * f, home: T.kHomeOffA * f, car: T.kCarA * f, chg: T.gch * f, sExp: (T.exp - T.bx) * f, bExp: T.bx * f };
    const before = B.peak * pk / 100 + (B.home + B.car) * off / 100 + st;
    const inc = (A.sExp + A.bExp) * c.exportRate / 100;
    const after = A.peak * pk / 100 + (A.home + A.car + A.chg) * off / 100 + st - inc;
    return { B, A, st, dayN, before, after, inc };
  };
  let ds, f;
  if (S.billSel === 'avg') ds = D.days;
  else if (S.billSel === 'winter') ds = D.days.filter(d => ['12', '01', '02'].includes(d.date.slice(5, 7)));
  else if (S.billSel === 'summer') ds = D.days.filter(d => ['06', '07', '08'].includes(d.date.slice(5, 7)));
  else ds = byMonth.get(S.billSel) || [];
  const full = ds.reduce((a, d) => a + d.full, 0);
  f = ['avg', 'winter', 'summer'].includes(S.billSel) ? (full ? 30.4375 / full : 0) : 1;
  const b = bill(ds, f), L = (kwhv, rate) => `${nf(kwhv, 0)} kWh · ${gbp(kwhv * rate / 100)}`, dash = '<span style="color:var(--muted)">—</span>';
  const row = (name, bef, aft, bold) => `<tr${bold ? ' style="font-weight:700"' : ''}><td>${name}</td><td>${bef}</td><td>${aft}</td></tr>`;
  const solarNote = S.scope === 'home' ? 'solar and battery cover home use only; the car carries on charging off-peak' : S.scope === 'ev' ? 'solar is modelled against the EV only' : 'solar is modelled against home and EV';
  $('#billTbl').innerHTML = `<table style="margin-top:10px"><thead><tr><th>${S.billSel === 'avg' || S.billSel === 'winter' || S.billSel === 'summer' ? 'Per month' : 'Month'} (${nf(b.dayN, b.dayN % 1 ? 1 : 0)} days)</th><th>Before solar</th><th>After solar + ${nf(c.battery, 1)} kWh battery</th></tr></thead><tbody>` +
    row(`Peak-rate electricity (${nf(pk, 1)}p/kWh)`, L(b.B.peak, pk), L(b.A.peak, pk)) +
    row(`Off-peak: home, overnight (${nf(off, 1)}p/kWh)`, L(b.B.home, off), L(b.A.home, off)) +
    row(`Off-peak: car charging (${nf(off, 1)}p/kWh)`, L(b.B.car, off), L(b.A.car, off)) +
    row(`Off-peak: charging the battery (${nf(off, 1)}p/kWh)`, dash, c.battery > 0 ? L(b.A.chg, off) : dash) +
    row(`Standing charge (${nf(b.dayN, b.dayN % 1 ? 1 : 0)} days × ${nf(D.standNow, 2)}p)`, gbp(b.st), gbp(b.st)) +
    row(`Export income: solar (${c.exportRate}p/kWh)`, dash, '−' + nf(b.A.sExp, 0) + ' kWh · ' + gbp(b.A.sExp * c.exportRate / 100)) +
    row(`Export income: battery (${c.exportRate}p/kWh)`, dash, c.batExport !== 'off' && b.A.bExp > 0.5 ? '−' + nf(b.A.bExp, 0) + ' kWh · ' + gbp(b.A.bExp * c.exportRate / 100) : dash) +
    row('Total bill', gbp(b.before), gbp(b.after), true) +
    row('You save', '', `${gbp(b.before - b.after)} (${b.before > 0 ? nf((b.before - b.after) / b.before * 100, 0) : 0}%)`, true) +
    `</tbody></table><p class="hint" style="margin:8px 0 0">At today's rates (${nf(pk, 1)}p peak, ${nf(off, 1)}p off-peak, ${nf(D.standNow, 2)}p a day). Overnight home and car use stay on the cheap rate either way; ${solarNote}. Prices before and after use the same usage, so the difference is purely solar and battery.</p>`;
  cards.bills.sub.textContent = '';

  // monthly bill, before vs after, for every month in your data
  const mm = months.map(k => { const ds2 = byMonth.get(k), bb = bill(ds2, 1); return { k, label: MON[+k.slice(5) - 1] + " '" + k.slice(2, 4), bb }; });
  chart('bills', 'Monthly bill at today\'s prices, with and without solar and battery (negative = you are paid more than you spend)',
    { title: 'Monthly bills', labels: mm.map(x => x.label), tipTitles: mm.map(x => MON[+x.k.slice(5) - 1] + ' ' + x.k.slice(0, 4)), unit: '£', valFmt: gbp, yFmt: v => nf(v, 0), height: 240, stackTotal: false,
      series: [{ name: 'Before solar', color: 'var(--c-neutral)', type: 'line', values: mm.map(x => x.bb.before) },
        { name: 'After solar + battery', color: 'var(--c-solar)', type: 'line', values: mm.map(x => x.bb.after) }] });
}

function renderDay() {
  const D = S.D, d = D.days.find(x => x.date === S.selDay); if (!d) return;
  $('#dPick').value = d.date;
  $('#dPick').min = D.days[0].date; $('#dPick').max = D.days[D.days.length - 1].date;
  const home = new Array(48).fill(0), ev = new Array(48).fill(0), gen = new Array(48).fill(0), off = new Array(48).fill(false);
  for (let i = d.i0; i < d.i1; i++) {
    const h = S.hh[i]; home[h] += S.kwh[i] - D.ev[i]; ev[h] += D.ev[i]; gen[h] += D.g[i]; off[h] = !!D.off[i];
  }
  const saved = (d.pcost - d.pafter) + d.expInc, showH = S.scope !== 'ev', showE = S.scope !== 'home';
  chart('dayx', `${longDate(d.date)} · kWh per half hour · ${SCOPE[S.scope][0]} ${kwh(d.load)} · solar would make ${kwh(d.gen)}, use ${kwh(d.self)} of it and save ${gbp(saved)}`,
    { title: 'Selected day', labels: Array.from({ length: 48 }, (_, i) => hhLabel(i)), unit: 'kWh', height: 260,
      xTicks: [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44], valFmt: v => nf(v, 2) + ' kWh', bands: bandsFrom(off), stackTotal: false,
      series: [showH && { name: 'Home', color: 'var(--c-home)', values: home }, showE && { name: 'EV charging', color: 'var(--c-ev)', values: ev },
        { name: 'Solar (modelled)', color: 'var(--c-solar)', type: 'line', values: gen }].filter(Boolean) });
}

/* ---------------------------------------------------------- data loading -- */
function notice(html) { const n = $('#msg'); n.hidden = !html; n.innerHTML = html || ''; }
async function loadData(refresh = false) {
  $('#source').textContent = 'Loading…';
  try {
    const q = new URLSearchParams({ days: S.days, demo: S.demo ? 1 : 0, refresh: refresh ? 1 : 0 });
    const res = await fetch('/api/data?' + q), body = await res.json();
    if (!res.ok) {
      if (body.error === 'not_configured') { $('#source').textContent = 'Not connected'; return openSetup(); }
      throw new Error(body.error);
    }
    ingest(body); compute();
    const m = body.meta, last = S.date[S.date.length - 1];
    $('#source').textContent = m.demo ? 'Demo data (synthetic)' : `${m.account} · to ${last}`;
    const warn = [...(m.warnings || [])];
    if (!m.demo && !S.D.apiRates) warn.push('Tariff rates could not be read from Octopus, so fallback rates from <em>Advanced</em> are being used.');
    if (m.demo) warn.push('You are looking at <strong>synthetic demo data</strong>. Click <em>Connection</em> to use your own account.');
    notice(warn.join('<br>'));
    render();
  } catch (e) {
    $('#source').textContent = 'Error';
    notice('Could not load data: ' + Charts.esc(e.message));
  }
}

/* ---------------------------------------------------------------- setup --- */
const dlg = $('#setup');
async function openSetup() {
  const st = await (await fetch('/api/status')).json();
  $('#disconnect').hidden = !st.configured;
  $('#account').value = st.account || '';
  $('#apiKey').value = ''; $('#apiKey').placeholder = st.configured ? '•••• ' + st.keyHint + ' (leave blank to keep)' : 'sk_live_…';
  $('#days').value = String(S.days);
  $('#setupErr').hidden = true;
  if (!dlg.open) dlg.showModal();
}
$('#conn').onclick = openSetup;
$('#closeSetup').onclick = () => dlg.close();
$('#useDemo').onclick = () => { S.demo = true; localStorage.setItem('octo.demo', '1'); dlg.close(); loadData(); };
$('#days').onchange = e => { S.days = +e.target.value; localStorage.setItem('octo.days', S.days); };
$('#saveConn').onclick = async () => {
  const err = $('#setupErr'); err.hidden = true;
  S.days = +$('#days').value; localStorage.setItem('octo.days', S.days);
  const key = $('#apiKey').value.trim();
  if (!key) { S.demo = false; localStorage.setItem('octo.demo', '0'); dlg.close(); return loadData(true); }
  $('#saveConn').disabled = true; $('#saveConn').textContent = 'Checking…';
  try {
    const res = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: key, account: $('#account').value }) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    S.demo = false; localStorage.setItem('octo.demo', '0'); dlg.close(); loadData(true);
  } catch (e) { err.textContent = e.message; err.hidden = false; }
  $('#saveConn').disabled = false; $('#saveConn').textContent = 'Connect';
};
$('#disconnect').onclick = async () => { await fetch('/api/disconnect', { method: 'POST', body: '{}' }); dlg.close(); loadData(); };

/* ------------------------------------------------------------- controls --- */
function seg(id, get, set) {
  const root = $(id);
  const sync = () => root.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === get())));
  root.onclick = e => { const b = e.target.closest('button'); if (b) { set(b.dataset.v); sync(); if (S.D) render(); } };
  sync();
}
seg('#range', () => S.sel ? null : S.range, v => { S.sel = null; S.anchor = null; S.range = v; localStorage.setItem('octo.range', v); });
seg('#group', () => S.group, v => { S.group = v; });
seg('#scope', () => S.scope, v => { S.scope = v; localStorage.setItem('octo.scope', v); if (S.D) compute(); });
$('#refresh').onclick = () => loadData(true);
$('#selChip').onclick = () => { S.sel = null; S.anchor = null; render(); };
function applyTheme(t) { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }
applyTheme(localStorage.getItem('octo.theme'));
$('#theme').onclick = () => {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark'; localStorage.setItem('octo.theme', next); applyTheme(next); Charts.redrawAll(); if (S.D) renderCal();
};
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { Charts.redrawAll(); if (S.D) renderCal(); });

if (new URLSearchParams(location.search).get('demo') === '1') S.demo = true;
if (new URLSearchParams(location.search).get('sel')) { const [a, b] = new URLSearchParams(location.search).get('sel').split(','); S.sel = { from: a, to: b || a }; S.calMonth = a.slice(0, 7); }
if (new URLSearchParams(location.search).get('unit')) S.genUnit = new URLSearchParams(location.search).get('unit');
if (new URLSearchParams(location.search).get('bill')) S.billSel = new URLSearchParams(location.search).get('bill');
if (new URLSearchParams(location.search).get('trend')) S.cfg.trend = new URLSearchParams(location.search).get('trend');
if (new URLSearchParams(location.search).get('bx')) S.cfg.batExport = new URLSearchParams(location.search).get('bx');
if (new URLSearchParams(location.search).get('range')) S.range = new URLSearchParams(location.search).get('range');
if (new URLSearchParams(location.search).get('bat')) S.cfg.battery = +new URLSearchParams(location.search).get('bat');
if (['home', 'ev', 'both'].includes(new URLSearchParams(location.search).get('scope'))) S.scope = new URLSearchParams(location.search).get('scope');
buildLayout();
seg('#genUnit', () => S.genUnit, v => { S.genUnit = v; localStorage.setItem('octo.genUnit', v); });
(async () => {
  const st = await (await fetch('/api/status')).json();
  if (!st.configured && !S.demo) { $('#source').textContent = 'Not connected'; openSetup(); } else loadData();
})();
