'use strict';
/* The solar designer: finds your roof on a map, lays panels out on it, and works out the bill savings of any combination of panels, battery and
   inverter against your own half-hourly usage as the sliders move. The model itself (evalDesign, ...) is in app.js. It estimates bill
   savings only: it never guesses what an installation costs, and uses the price you enter. */
const Planner = (() => {
  // MCS overshading categories: how much of the sky a tree, chimney, dormer or neighbouring building blocks.
  const SHADING = [['none', 'No shading, or very little', 1], ['modest', 'Modest: shaded for part of the day', 0.8],
    ['significant', 'Significant: shaded for much of the day', 0.65], ['heavy', 'Heavy: shaded most of the day', 0.5]];
  const TYPES = { gable: 'Pitched (gable)', hip: 'Hipped', mono: 'Lean-to (one slope)', flat: 'Flat' };
  const DEFPITCH = { gable: 35, hip: 35, mono: 25, flat: 15 };
  const PD = { loc: null, locFor: null, poly: null, bid: null, foot: { w: 8, d: 5.5 }, type: 'gable', ridge: 90, pitch: 35, flat: 'south', mono: 180,
    portrait: true, shade: {}, off: {}, fits: {}, panels: 9, battery: 5, inverter: 3.7, touched: false };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const cap1 = s => s[0].toUpperCase() + s.slice(1);
  let P, B = [], map, el, faces = [], origin, last = null, settleT, geoMsg = '';
  const q = s => $(s, el);
  const save = () => localStorage.setItem('octo.plan', JSON.stringify(P));

  const HTML = `
  <div class="card wide"><div class="card-h"><div><h3><span class="step">A</span>Your roof</h3><div class="sub" id="pLoc">Locating your roof…</div></div></div>
    <div class="plan-grid">
      <div>
        <div class="map-wrap"><div id="pMap" class="roofmap"></div>
          <div class="map-ui"><button class="btn" id="pZi" aria-label="Zoom in">+</button><button class="btn" id="pZo" aria-label="Zoom out">−</button><button class="btn" id="pSat">Street map</button><button class="btn" id="pCentre" title="Back to the pin">Re-centre</button></div></div>
        <div class="map-attr">Imagery © Esri, Maxar, Earthstar Geographics · Maps and buildings © OpenStreetMap contributors. <b>Click your roof</b> (outlined in yellow) to use it; drag to move the map and more buildings load.</div>
        <form id="pFind" class="daybar"><input id="pQ" placeholder="Search a postcode or address" autocomplete="off"><button class="btn">Find</button><button class="btn ghost" type="button" id="pHome">Use my Octopus address</button></form>
      </div>
      <div class="plan-ctl">
        <div class="lab">Roof type</div><div class="seg" id="pType">${Object.entries(TYPES).map(([k, v]) => `<button data-v="${k}">${v}</button>`).join('')}</div>
        <div id="pFlatRow"><div class="lab">Flat roof layout</div><div class="seg" id="pFlat"><button data-v="south">Frames facing south</button><button data-v="ew">East–west pairs</button></div></div>
        <label id="pRidgeRow"><span id="pRidgeL">Ridge direction</span> <b id="pRidgeV"></b><input type="range" id="pRidge" min="0" max="179" step="1"></label>
        <label id="pMonoRow">Roof slopes towards <b id="pMonoV"></b><input type="range" id="pMono" min="0" max="359" step="1"></label>
        <label>Roof pitch <b id="pPitchV"></b><input type="range" id="pPitch" min="5" max="60" step="1"></label>
        <div class="lab">Panels</div><div class="seg" id="pOri"><button data-v="p">Portrait</button><button data-v="l">Landscape</button></div>
        <div id="pFootRow" class="assump" hidden><label>Roof width (m)<input id="pFw" type="number" min="3" max="30" step="0.5"></label><label>Roof depth (m)<input id="pFd" type="number" min="3" max="30" step="0.5"></label></div>
        <div class="lab">Roof faces</div><div id="pFaces"></div>
      </div>
    </div>
    <p class="hint" id="pRoofNote"></p></div>
  <div class="card wide"><div class="card-h"><div><h3><span class="step">B</span>Your system</h3><div class="sub">Move the sliders: the saving and cost update as you go, using your own half-hourly usage and tariff.</div></div></div>
    <div class="tiles" id="pTiles"></div>
    <div class="sliders">
      <div class="slrow"><div class="slh"><span>Solar panels</span><b id="pPanelsV"></b></div><div class="slw"><input type="range" id="pPanels" min="0" max="20" step="1"></div><div class="sls" id="pPanelsS"></div></div>
      <div class="slrow"><div class="slh"><span>Panel wattage</span><b id="pWV"></b></div><div class="slw"><input type="range" id="pW" min="350" max="650" step="5"></div><div class="sls">Higher-wattage panels fit fewer per roof but make more power from the same space.</div></div>
      <div class="slrow"><div class="slh"><span>Battery</span><b id="pBatV"></b></div><div class="slw"><input type="range" id="pBat" min="0" max="20" step="0.5"></div><div class="sls" id="pBatS"></div></div>
      <div class="slrow"><div class="slh"><span>Inverter</span><b id="pInvV"></b></div><div class="slw"><input type="range" id="pInv" min="2" max="12" step="0.1"></div><div class="sls" id="pInvS"></div></div>
    </div>
    <div class="assump">
      <label>Installer's price for this system (£)<input id="pQP" type="number" min="0" step="any" placeholder="optional: enter to see payback"></label>
    </div>
    <p class="hint" id="pQNote"></p>
    <div id="pCostBox" hidden><div class="legend" id="pCL"></div><div class="plot" id="pCP"></div></div>
    <p class="hint" id="pCostNote"></p></div>
  <div class="card wide"><div class="card-h"><div><h3><span class="step">C</span>Compare quotes</h3><div class="sub">Save installer proposals and compare them with each other and with your current design, all scored on your roof and usage. Saved in this browser only.</div></div></div>
    <form id="qForm" class="assump">
      <label>Provider<input id="qProv" placeholder="e.g. Octopus, a local installer" required></label>
      <label>Panels<input id="qN" type="number" min="0" step="any" required></label>
      <label>Panel size (W)<input id="qW" type="number" min="100" step="any" required></label>
      <label>Battery, usable (kWh)<input id="qB" type="number" min="0" step="any" required></label>
      <label>Inverter (kW)<input id="qV" type="number" min="1" step="any" required></label>
      <label>Battery round trip (%)<input id="qE" type="number" min="50" max="100" step="any" value="90" required></label>
      <label>Price (£)<input id="qP" type="number" min="1" step="any" required></label>
      <label>Notes<input id="qNote" placeholder="brands, installer's own estimate, anything to remember"></label>
    </form>
    <div class="row" style="margin-top:12px"><button class="btn primary" id="qSave">Save quote</button><button class="btn" id="qFill" type="button">Fill from my current design</button><button class="btn ghost" id="qClear" type="button">Clear form</button></div>
    <div class="tblwrap" id="qTable" style="max-height:none;margin-top:14px"></div></div>`;

  /* ----------------------------------------------------------- geometry ---- */
  function footprint() {
    if (P.poly) {
      const lats = P.poly.map(p => p[0]), lons = P.poly.map(p => p[1]);
      const o = { lat: (Math.min(...lats) + Math.max(...lats)) / 2, lon: (Math.min(...lons) + Math.max(...lons)) / 2 };
      return { origin: o, poly: P.poly.map(p => Roof.toLocal(o, p[0], p[1])) };
    }
    const u = Roof.bearingVec(P.ridge), v = Roof.bearingVec(P.ridge + 90), r = Roof.rect(P.foot.w, P.foot.d);
    return { origin: P.loc ? { lat: P.loc.lat, lon: P.loc.lon } : { lat: S.cfg.lat, lon: S.cfg.lon },
      poly: r.map(p => [u[0] * p[0] + v[0] * p[1], u[1] * p[0] + v[1] * p[1]]) };
  }
  const opts = () => ({ type: P.type, ridge: P.ridge, pitch: P.pitch, flat: P.flat, mono: P.mono, panelW: S.cfg.panelW, portrait: P.portrait });
  const colour = qual => `hsla(${Math.round(130 * clamp((qual - 0.5) / 0.45, 0, 1))},75%,50%,0.30)`;

  // Rebuild the roof faces after anything about the roof changes, and push them into the model.
  function rebuild() {
    const f = footprint(), c = S.cfg, ideal = kkEstimate(c.lat, c.lon, 0, 35);
    origin = f.origin;
    faces = Roof.build(f.poly, opts()).map((fc, k) => {
      const key = 'f' + k, lvl = P.shade[key] || 'none', sf = SHADING.find(x => x[0] === lvl)[2];
      const d = ((fc.az - 180 + 540) % 360) - 180, kk = kkEstimate(c.lat, c.lon, Math.abs(d), fc.tilt), shade = +(sf * fc.geom).toFixed(3);
      return Object.assign(fc, { key, lvl, side: d < 0 ? 'E' : 'W', azS: Math.abs(d), kk, shade, on: !P.off[key], q: kk * shade / ideal });
    });
    c.roofs = faces.map(fc => ({ name: Roof.compassShort(fc.az), az: fc.azS, side: fc.side, tilt: fc.tilt, kk: fc.kk, shade: fc.shade, max: fc.on ? (P.fits[fc.key] > 0 ? P.fits[fc.key] : fc.cap) : 0, panels: 0 }));
    if (!P.touched) { // until you move a slider: about 4 kWp, a 5 kWh battery and a 3.7 kW inverter, just a starting point
      P.panels = Math.min(c.roofs.reduce((a, r) => a + r.max, 0), Math.round(4000 / c.panelW)); P.battery = 5; P.inverter = 3.7;
    }
    drawFaces(); syncControls(); live(); settle();
  }

  function drawFaces() {
    const ae = document.activeElement; if (ae && q('#pFaces').contains(ae)) ae.blur(); // redrawing under a focused field makes the browser throw mid-update
    q('#pFaces').innerHTML = faces.map((fc, k) => `<div class="face${fc.on ? '' : ' off'}"><i style="background:${colour(fc.q).replace('0.30', '0.9')}"></i>
      <div class="fn"><b>${cap1(Roof.compassName(fc.az))}-facing</b> · ${Math.round(fc.az)}° · ${fc.tilt}° pitch
      <div class="fs">${Math.round(fc.q * 100)}% of the best roof (south, 35°) · layout fits ${fc.cap} · <span id="fc${k}">0</span> used${fc.geom < 1 ? ` · ${Math.round((1 - fc.geom) * 100)}% layout loss` : ''}</div></div>
      <select data-k="${fc.key}" aria-label="Shading">${SHADING.map(s => `<option value="${s[0]}"${s[0] === fc.lvl ? ' selected' : ''}>${s[1]} (×${s[2]})</option>`).join('')}</select>
      <label class="use"><input type="checkbox" data-u="${fc.key}"${fc.on ? ' checked' : ''}> Use</label>
      <label class="use">Room for <input type="number" min="0" max="200" step="1" data-f="${fc.key}" value="${P.fits[fc.key] > 0 ? P.fits[fc.key] : fc.cap}" title="Panels this face can hold. The layout estimate is cautious: raise it if your roof is bigger, and the slider extends to match."> panels</label></div>`).join('');
    const total = faces.reduce((a, fc) => a + fc.cap, 0);
    q('#pRoofNote').innerHTML = P.poly
      ? `Panels are laid out inside your building outline with a 25 cm margin from edges, ridges and hips. Yield comes from each face's compass direction and pitch for your latitude, then the shading you choose and a layout allowance (frames on a flat roof lose a little to row shading). The number of panels each face holds is an estimate: type your own under <em>Room for</em> if it is wrong, and the panel slider will extend to match. The outline is from OpenStreetMap and may be a little off; if the layout looks wrong, check the ridge direction and roof type.${total ? '' : ' <b>No panels fit this outline</b>: check the roof type.'}`
      : `No building outline was found, so a rectangle of the size you give is used. Click a building on the map if one is shown.`;
  }

  // paint each slider's filled portion
  const fillRanges = () => el.querySelectorAll('input[type=range]').forEach(r => r.style.setProperty('--p', ((+r.value - +r.min) / ((+r.max - +r.min) || 1) * 100) + '%'));
  function syncControls() {
    const t = P.type;
    $$seg('#pType', t); $$seg('#pFlat', P.flat); $$seg('#pOri', P.portrait ? 'p' : 'l');
    q('#pFlatRow').hidden = t !== 'flat';
    q('#pRidgeRow').hidden = t === 'mono' || (t === 'flat' && P.flat === 'south');
    q('#pRidgeL').textContent = t === 'flat' ? 'Row direction' : 'Ridge direction';
    q('#pMonoRow').hidden = t !== 'mono';
    q('#pRidge').value = P.ridge; q('#pRidgeV').textContent = `${Roof.compassShort(P.ridge)}–${Roof.compassShort(P.ridge + 180)} (${Math.round(P.ridge)}°)`;
    q('#pPitch').value = P.pitch; q('#pPitchV').textContent = P.pitch + '°';
    q('#pMono').value = P.mono; q('#pMonoV').textContent = `${Roof.compassShort(P.mono)} (${Math.round(P.mono)}°)`;
    q('#pFootRow').hidden = !!P.poly; q('#pFw').value = P.foot.w; q('#pFd').value = P.foot.d;
    q('#pW').value = S.cfg.panelW; q('#pWV').textContent = S.cfg.panelW + ' W each';
    q('#pQP').value = S.cfg.cost || '';
    fillRanges(); save();
  }
  const $$seg = (id, v) => q(id).querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === v)));

  /* -------------------------------------------------------------- live ---- */
  function layers() {
    const list = B.map(b => ({ id: b.id, ll: b.poly }));
    if (P.poly && !list.some(b => b.id === P.bid)) list.push({ id: P.bid || -1, ll: P.poly });
    const counts = S.cfg.roofs.map(r => r.panels);
    map.setLayers({ origin, pin: P.loc, buildings: list, selected: P.bid || -1,
      faces: faces.map((fc, k) => ({ poly: fc.poly, color: fc.on ? colour(fc.q) : 'rgba(120,120,120,.12)', slots: fc.on ? fc.slots : [], used: counts[k] })) });
  }

  // Everything that follows the three sliders, instantly: readouts, the map, and the saving and cost.
  function live() {
    const c = S.cfg, capTot = c.roofs.reduce((a, r) => a + r.max, 0);
    P.panels = clamp(Math.round(P.panels), 0, capTot);
    const counts = allocPanels(c.roofs, P.panels);
    c.roofs.forEach((r, k) => { r.panels = counts[k]; });
    c.battery = P.battery; c.inverter = P.inverter; c.batKw = c.batKwCharge = batPower(P.battery, P.inverter);
    syncCfg();
    const sl = q('#pPanels'); sl.max = Math.max(capTot, 1); sl.value = P.panels; sl.disabled = capTot === 0;
    q('#pBat').value = P.battery; q('#pInv').value = P.inverter;
    q('#pPanelsV').textContent = `${P.panels} panels · ${nf(c.kwp, 2)} kWp`;
    q('#pPanelsS').textContent = capTot ? `Room for ${capTot} panels on the faces you are using (change this under Roof faces → Room for). Panels fill the best face first.` : 'No room found: check the roof type and outline.';
    q('#pBatV').textContent = P.battery > 0 ? `${nf(P.battery, 1)} kWh` : 'No battery';
    q('#pBatS').textContent = P.battery > 0 ? `Charges and discharges at up to ${nf(batPower(P.battery, P.inverter), 1)} kW.` : 'Slide right to add a battery.';
    q('#pInvV').textContent = `${nf(P.inverter, 1)} kW`;
    q('#pInvS').textContent = c.kwp > P.inverter * 1.3 ? 'The panels outsize the inverter, so some sunny-peak output is clipped (already counted in the saving).' : P.inverter > 3.68 ? 'Caps what the panels and battery can deliver at once. Above 3.68 kW per phase your network operator must approve the connection (G99).' : 'Caps what the panels and battery can deliver at once.';
    counts.forEach((m, k) => { const e = q('#fc' + k); if (e) e.textContent = m; });
    layers(); fillRanges();
    if (!S.ctx) return;
    last = evalDesign(c.roofs, counts, c.battery, c.inverter, true);
    // what one more of each would add: the saving, not the price, which is for you to compare with your quotes
    const at = (dp, db, dv) => evalDesign(c.roofs, allocPanels(c.roofs, P.panels + dp), P.battery + db, P.inverter + dv, 'y1').y1;
    const base = last.y1, add = (ok, v, unit) => ok ? `One more ${unit} would add about ${gbp(Math.max(0, v - base))} a year.` : '';
    q('#pPanelsS').textContent += ' ' + add(P.panels < capTot, at(1, 0, 0), 'panel');
    q('#pBatS').textContent += ' ' + add(P.battery < 20, at(0, 1, 0), 'kWh of battery');
    q('#pInvS').textContent += ' ' + add(P.inverter < 12, at(0, 0, 0.5), 'half kW of inverter');
    const cost = netCost(c), cf = c.costFor, same = !cf || (cf.np === c.panels && Math.abs(cf.cap - c.battery) < 0.05 && Math.abs(cf.inv - c.inverter) < 0.05);
    const pay = cost > 0 && same ? paybackYears(last.years, cost) : null, net = last.total - cost, after = last.billBefore - last.y1;
    const priced = cost > 0 && same;
    q('#pTiles').innerHTML =
      tile('Estimated saving a year', gbp(last.y1), `${gbp(last.y1 / 12)} a month in year 1`, 'hero') +
      tile('Energy bill a year', `${gbp(last.billBefore)} → ${gbp(after)}`, `${last.billBefore > 0 ? nf(last.y1 / last.billBefore * 100, 0) : 0}% lower (unit rates, before standing charge${after < 0 ? '; negative = export income exceeds your bill' : ''})`) +
      tile('Saved over 25 years', gbp(last.total), 'With panel and battery fade and your price trend') +
      tile('Solar generated', `${nf(last.gen, 0)}<small>kWh a year</small>`, `${pct(last.selfPct)} used at home, the rest exported`) +
      tile('Usage covered', pct(last.covered), 'of your home use now met by solar and battery') +
      (cost > 0 ? tile('Payback', priced ? (pay === null ? '—' : `${nf(pay, 1)}<small>years</small>`) : '—',
        !priced ? 'Your price is for a different system' : pay === null ? 'Not within 25 years' : `Net ${gbp(net)} after 25 years on ${gbp(cost)}`) : tile('Payback', '—', 'Enter your installer\'s price below'));
    q('#pCostBox').hidden = !priced;
    if (priced) {
      let cum = 0; const cumul = last.years.map(v => (cum += v));
      const series = [{ name: 'Bill savings so far', color: 'var(--c-solar)', type: 'line', values: cumul }, { name: `Your price (${gbp(cost)})`, color: 'var(--c-ev)', type: 'line', dash: true, values: cumul.map(() => cost) }];
      Charts.legend(q('#pCL'), series);
      Charts.cartesian(q('#pCP'), { title: 'Cost vs savings', labels: last.years.map((_, k) => 'Yr ' + (k + 1)), tipTitles: last.years.map((_, k) => 'End of year ' + (k + 1)), unit: '£', yFmt: v => nf(v, 0), valFmt: gbp,
        xTicks: [0, 4, 9, 14, 19, 24], height: 220, stackTotal: false, series });
    }
    const cfLabel = cf ? `${cf.np} panels, ${nf(cf.cap, 1)} kWh battery, ${nf(cf.inv, 1)} kW inverter` : '';
    q('#pCostNote').innerHTML = (cost > 0 && !same ? `Your price of ${gbp(cost)} was for ${cfLabel}. Change the sliders back, or enter the price for this system. ` : '') +
      `Savings come from your own half-hourly usage and tariff, at today's rates with your export rate and price trend from Assumptions. The tool does not estimate installation costs. Save quotes below to compare providers.`;
    scheduleQuotes();
  }

  function settle() { clearTimeout(settleT); settleT = setTimeout(() => { if (S.D) { compute(); render(); } }, 300); }

  /* ---------------------------------------------------------- location ---- */
  // Building outlines near a point. The server (OpenStreetMap Overpass) and the browser are tried at the same time, because
  // that service is often busy; failing both, Nominatim gives the single building at the point.
  async function overpassDirect(lat, lon, radius) {
    const body = 'data=' + encodeURIComponent(`[out:json][timeout:12];way["building"](around:${radius},${lat},${lon});out geom tags;`);
    for (const url of ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']) {
      try {
        const res = await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(14000) });
        if (!res.ok) continue;
        return (await res.json()).elements.filter(e => e.geometry && e.geometry.length > 3).map(e => {
          const pts = e.geometry.map(g => [g.lat, g.lon]); if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
          return { id: e.id, poly: pts, tags: e.tags || {} };
        });
      } catch (e) { /* try the next mirror */ }
    }
    throw new Error('Overpass unavailable');
  }
  async function fetchBuildings(lat, lon, radius = 70) {
    try {
      const list = await Promise.any([getJSON(`/api/buildings?lat=${lat}&lon=${lon}&radius=${radius}`).then(r => r.buildings), overpassDirect(lat, lon, radius)]);
      if (list.length) return list;
    } catch (e) { /* fall through */ }
    return (await getJSON(`/api/buildings?lat=${lat}&lon=${lon}&at=1`)).buildings;
  }
  const addBuildings = list => { const have = new Set(B.map(b => b.id)); list.forEach(b => { if (!have.has(b.id)) B.push(b); }); };
  async function getJSON(url) {
    const res = await fetch(url), body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Lookup failed');
    return body;
  }
  const insideLL = (o, poly, pt) => Roof.inside(Roof.toLocal(o, pt.lat, pt.lon), poly.map(p => Roof.toLocal(o, p[0], p[1])));

  async function locate(place, who) {
    P.loc = place; P.locFor = who; P.poly = null; P.bid = null; B = [];
    S.cfg.lat = place.lat; S.cfg.lon = place.lon; saveCfg();
    q('#pLoc').textContent = (place.source === 'demo' ? '' : place.source === 'postcode' ? 'Postcode area: ' : '') + place.label + (place.address ? ' · address from your Octopus account' : '');
    map.view(place.lat, place.lon, 20);
    try {
      B = await fetchBuildings(place.lat, place.lon);
      const o = { lat: place.lat, lon: place.lon };
      const big = b => Roof.area(b.poly.map(p => Roof.toLocal(o, p[0], p[1]))) >= 30; // sheds and garages are not the house
      let pick = B.find(b => big(b) && insideLL(o, b.poly, place));
      if (!pick) { // nearest house-sized outline within 30 m of the point
        let best = 30;
        for (const b of B.filter(big)) { const c = Roof.centroid(b.poly.map(p => Roof.toLocal(o, p[0], p[1]))), d = Math.hypot(c[0], c[1]); if (d < best) { best = d; pick = b; } }
      }
      geoMsg = !pick ? ' No building outline found at that point: click one on the map, or set the roof size.' : place.source === 'address' ? ' Check the highlighted roof is yours; click another building to change it.' : ' We only found the postcode area, so click your own house on the map.';
      if (pick) pickBuilding(pick.id, true); else rebuild();
    } catch (e) {
      geoMsg = ' Could not load building outlines (' + e.message + '). Set the roof size instead.'; rebuild();
    }
    if (geoMsg) q('#pLoc').textContent += ' ·' + geoMsg;
  }

  function pickBuilding(id, quiet) {
    const b = B.find(x => x.id === id); if (!b) return;
    P.poly = b.poly; P.bid = id;
    const t = b.tags || {}, shape = t['roof:shape'] || '';
    P.type = /hip/.test(shape) ? 'hip' : shape === 'flat' ? 'flat' : /skillion|lean/.test(shape) ? 'mono' : 'gable';
    P.pitch = +t['roof:angle'] || DEFPITCH[P.type];
    const o = { lat: b.poly[0][0], lon: b.poly[0][1] };
    let r = Roof.longAxis(b.poly.map(p => Roof.toLocal(o, p[0], p[1])));
    if (t['roof:orientation'] === 'across') r = (r + 90) % 180;
    P.ridge = r; P.mono = 180;
    const f = footprint(); map.view(f.origin.lat, f.origin.lon, 20);
    rebuild();
    if (!quiet) q('#pLoc').textContent = 'Roof selected from the map' + (t['roof:shape'] ? ` (OpenStreetMap says: ${t['roof:shape']})` : '');
  }

  async function fromAccount(who) {
    try {
      const d = await getJSON('/api/property?demo=' + (who === 'demo' ? 1 : 0));
      await locate(Object.assign({}, d, d.address ? { label: d.address, address: true } : {}), who);
    } catch (e) { q('#pLoc').textContent = 'Could not place your address (' + e.message + '). Search for your postcode.'; }
  }

  /* ------------------------------------------------------------ quotes ---- */
  let quotes = JSON.parse(localStorage.getItem('octo.quotes') || '[]'), editId = null, quoteT;
  const saveQuotes = () => localStorage.setItem('octo.quotes', JSON.stringify(quotes));
  // Score a proposal on this roof and usage. Panel size and battery efficiency are the proposal's own.
  function scoreQuote(d) {
    const c = S.cfg, keep = [c.panelW, c.batEff]; c.panelW = d.panelW; c.batEff = d.batEff;
    try {
      const counts = allocPanels(c.roofs, d.panels), fits = counts.reduce((a, v) => a + v, 0), e = evalDesign(c.roofs, counts, d.battery, d.inverter, true);
      return { e, fits, pay: paybackYears(e.years, d.price), net: e.total - d.price };
    } finally { [c.panelW, c.batEff] = keep; }
  }
  function renderQuotes() {
    if (!S.ctx) return;
    const c = S.cfg, rows = quotes.map(d => ({ d, r: scoreQuote(d) }));
    const cur = last && { d: { id: 'cur', provider: 'Your current design', panels: c.panels, panelW: c.panelW, battery: c.battery, inverter: c.inverter, price: c.cost }, r: { e: last, fits: c.panels, pay: paybackYears(last.years, c.cost), net: last.total - c.cost } };
    const all = [...(cur ? [cur] : []), ...rows], bestNet = Math.max(...rows.map(x => x.r.net), -Infinity), bestPay = Math.min(...rows.filter(x => x.r.pay !== null).map(x => x.r.pay), Infinity);
    if (!rows.length) { q('#qTable').innerHTML = '<p class="hint" style="padding:8px">No quotes saved yet. Enter one above, or use <em>Fill from my current design</em>.</p>'; return; }
    q('#qTable').innerHTML = '<table><thead><tr><th>Provider</th><th>System</th><th>Price</th><th>Saving a year</th><th>Payback</th><th>Net after 25 years</th><th>Price per kWp</th><th></th></tr></thead><tbody>' +
      all.map(({ d, r }) => {
        const mine = d.id === 'cur', star = !mine && r.net === bestNet ? ' ★' : '';
        const warn = !mine && r.fits < d.panels ? `<br><small>Only ${r.fits} of ${d.panels} panels fit your roof: scored with ${r.fits}</small>` : '';
        return `<tr${mine ? ' style="color:var(--muted)"' : ''}><td>${esc(d.provider)}${star}${d.notes ? `<br><small>${esc(d.notes)}</small>` : ''}</td>
          <td>${d.panels} × ${d.panelW} W (${nf(d.panels * d.panelW / 1000, 2)} kWp)<br>${d.battery > 0 ? nf(d.battery, 1) + ' kWh battery' : 'no battery'} · ${nf(d.inverter, 1)} kW inverter${warn}</td>
          <td>${gbp(d.price)}</td><td>${gbp(r.e.y1)}</td><td${!mine && r.pay === bestPay ? ' style="font-weight:700"' : ''}>${r.pay === null ? 'over 25 years' : nf(r.pay, 1) + ' years'}</td>
          <td${!mine && r.net === bestNet ? ' style="font-weight:700"' : ''}>${gbp(r.net)}</td><td>${d.panels ? gbp(d.price / (d.panels * d.panelW / 1000)) : '—'}</td>
          <td>${mine ? '' : `<button class="tbtn" data-qa="load" data-id="${d.id}">Load</button> <button class="tbtn" data-qa="edit" data-id="${d.id}">Edit</button> <button class="tbtn" data-qa="del" data-id="${d.id}">Delete</button>`}</td></tr>`;
      }).join('') + '</tbody></table><p class="hint" style="padding:6px 8px">★ = best net gain after 25 years; bold = best of the saved quotes. Each quote is scored with the same usage, roof, shading, prices and fade, so differences come from the system and price only. Installer quality is not modelled: use the notes.</p>';
  }
  const scheduleQuotes = () => { clearTimeout(quoteT); quoteT = setTimeout(renderQuotes, 150); };
  function initQuotes() {
    const f = { prov: '#qProv', panels: '#qN', panelW: '#qW', battery: '#qB', inverter: '#qV', batEff: '#qE', price: '#qP', notes: '#qNote' };
    const fill = d => { q(f.prov).value = d.provider || ''; q(f.panels).value = d.panels; q(f.panelW).value = d.panelW; q(f.battery).value = d.battery; q(f.inverter).value = d.inverter; q(f.batEff).value = d.batEff; q(f.price).value = d.price || ''; q(f.notes).value = d.notes || ''; };
    const clear = () => { editId = null; q('#qForm').reset(); q('#qSave').textContent = 'Save quote'; };
    q('#qFill').onclick = () => { const c = S.cfg; editId = null; q('#qSave').textContent = 'Save quote'; fill({ provider: '', panels: c.panels, panelW: c.panelW, battery: c.battery, inverter: c.inverter, batEff: c.batEff, price: c.cost, notes: '' }); q(f.prov).focus(); };
    q('#qClear').onclick = clear;
    q('#qSave').onclick = () => {
      if (!q('#qForm').reportValidity()) return;
      const d = { id: editId || String(Date.now()), provider: q(f.prov).value.trim(), panels: +q(f.panels).value, panelW: +q(f.panelW).value, battery: +q(f.battery).value, inverter: +q(f.inverter).value,
        batEff: +q(f.batEff).value, price: +q(f.price).value, notes: q(f.notes).value.trim() };
      const i = quotes.findIndex(x => x.id === d.id); if (i >= 0) quotes[i] = d; else quotes.push(d);
      saveQuotes(); clear(); renderQuotes();
    };
    q('#qTable').onclick = e => {
      const b = e.target.closest('[data-qa]'); if (!b) return;
      const d = quotes.find(x => x.id === b.dataset.id); if (!d) return;
      if (b.dataset.qa === 'del') { quotes = quotes.filter(x => x !== d); saveQuotes(); renderQuotes(); }
      else if (b.dataset.qa === 'edit') { editId = d.id; fill(d); q('#qSave').textContent = 'Update quote'; q(f.prov).scrollIntoView({ block: 'center' }); }
      else { // load into the sliders, priced at the quote
        const c = S.cfg; c.panelW = d.panelW; c.batEff = d.batEff; saveCfg(); $('#aEff').value = d.batEff;
        Object.assign(P, { panels: d.panels, battery: clamp(d.battery, 0, 20), inverter: clamp(d.inverter, 2, 12), touched: true });
        rebuild(); c.cost = d.price; c.costFor = { np: c.panels, cap: c.battery, inv: c.inverter }; saveCfg(); syncControls(); live(); settle();
        q('#pQNote').textContent = `Loaded ${d.provider}.` + (c.panels < d.panels ? ` Your roof only has room for ${c.panels} of its ${d.panels} panels.` : '') + (d.notes ? ' ' + d.notes : '');
        $('#pPanels').scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    };
  }

  /* ------------------------------------------------------------ wiring ---- */
  function init(root) {
    el = root; el.innerHTML = HTML;
    P = Object.assign({}, PD, JSON.parse(localStorage.getItem('octo.plan') || '{}'));
    if (P.loc) { S.cfg.lat = P.loc.lat; S.cfg.lon = P.loc.lon; }
    map = new RoofMap(q('#pMap')); map.onPick = id => pickBuilding(id);
    map.onMove = (lat, lon) => { // load the outlines wherever the map has been moved to, so any roof can be picked
      fetchBuildings(lat, lon, 90).then(list => { addBuildings(list); layers(); }).catch(() => {});
    };
    map.onEmpty = (lat, lon) => { // clicked where no outline is drawn: look up the building there
      q('#pLoc').textContent = 'Looking for a building there…';
      getJSON(`/api/buildings?lat=${lat}&lon=${lon}&at=1`).then(r => {
        addBuildings(r.buildings);
        if (r.buildings.length) pickBuilding(r.buildings[0].id); else q('#pLoc').textContent = 'No building is mapped at that spot. Click a yellow outline, or set the roof size below.';
      }).catch(e => { q('#pLoc').textContent = 'Could not look up that building (' + e.message + ').'; });
    };
    map.view(S.cfg.lat, S.cfg.lon, 20);
    q('#pCentre').onclick = () => { const f = footprint(); map.view(f.origin.lat, f.origin.lon, 20); map.settled(); };
    q('#pZi').onclick = () => map.zoom(1); q('#pZo').onclick = () => map.zoom(-1);
    q('#pSat').onclick = e => { const sat = map.style === 'sat'; map.setStyle(sat ? 'street' : 'sat'); e.target.textContent = sat ? 'Satellite' : 'Street map'; };
    const segs = (id, set) => { q(id).onclick = e => { const b = e.target.closest('button'); if (b) { set(b.dataset.v); rebuild(); } }; };
    segs('#pType', v => { P.type = v; P.pitch = v === 'flat' && P.flat === 'ew' ? 10 : DEFPITCH[v]; });
    segs('#pFlat', v => { P.flat = v; P.pitch = v === 'ew' ? 10 : 15; });
    segs('#pOri', v => { P.portrait = v === 'p'; });
    q('#pRidge').oninput = e => { P.ridge = +e.target.value; rebuild(); };
    q('#pPitch').oninput = e => { P.pitch = +e.target.value; rebuild(); };
    q('#pMono').oninput = e => { P.mono = +e.target.value; rebuild(); };
    for (const [id, k] of [['#pFw', 'w'], ['#pFd', 'd']]) q(id).oninput = e => { P.foot[k] = clamp(+e.target.value || 6, 3, 30); rebuild(); };
    q('#pFaces').onchange = e => {
      if (e.target.dataset.k) P.shade[e.target.dataset.k] = e.target.value;
      if (e.target.dataset.u) P.off[e.target.dataset.u] = !e.target.checked;
      if (e.target.dataset.f) { const v = Math.round(+e.target.value), f = faces.find(x => x.key === e.target.dataset.f); if (v > 0 && v !== f.cap) P.fits[f.key] = v; else delete P.fits[f.key]; }
      rebuild();
    };
    const slider = (id, key) => { q(id).oninput = e => { P[key] = +e.target.value; P.touched = true; syncControls(); live(); settle(); }; };
    q('#pW').oninput = e => { S.cfg.panelW = +e.target.value; saveCfg(); rebuild(); }; // more watts per panel changes how many fit
    slider('#pPanels', 'panels'); slider('#pBat', 'battery'); slider('#pInv', 'inverter');
    q('#pQP').oninput = e => {
      const v = +e.target.value, c = S.cfg;
      c.cost = v > 0 ? v : 0; c.costFor = v > 0 ? { np: c.panels, cap: c.battery, inv: c.inverter } : null; saveCfg();
      q('#pQNote').textContent = ''; live(); settle();
    };
    initQuotes();
    q('#pFind').onsubmit = async e => {
      e.preventDefault(); const text = q('#pQ').value.trim(); if (!text) return;
      q('#pLoc').textContent = 'Searching…';
      try { await locate(await getJSON('/api/geocode?q=' + encodeURIComponent(text)), 'manual'); }
      catch (err) { q('#pLoc').textContent = err.message; }
    };
    q('#pHome').onclick = () => { P.locFor = null; if (S.raw) fromAccount(S.raw.meta.demo ? 'demo' : S.raw.meta.account); };
    window.addEventListener('beforeunload', save);
    rebuild();
  }

  // Called once the usage data has loaded: place the roof (once per account), then recommend.
  async function onData() {
    const who = S.raw.meta.demo ? 'demo' : S.raw.meta.account;
    if (P.locFor !== who && P.locFor !== 'manual') await fromAccount(who);
    else if (P.loc) {
      q('#pLoc').textContent = P.loc.label + ' · ' + (P.locFor === 'manual' ? 'searched' : 'address from your Octopus account');
      if (!B.length) fetchBuildings(P.loc.lat, P.loc.lon).then(list => { addBuildings(list); layers(); }).catch(() => {});
    }
    rebuild(); // the model now has data, so price the design and look for the best one
  }

  // An assumption changed (panel size changes how many panels fit; the rest only change prices).
  function changed(geometry) { if (geometry) rebuild(); else { live(); settle(); } }

  return { init, onData, changed };
})();
