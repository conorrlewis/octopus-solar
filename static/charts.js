'use strict';
/* Tiny dependency-free SVG charts: cartesian (stacked bars + lines/areas) and heatmap.
   Colours are CSS variables, so light/dark switch without redrawing. */
const Charts = (() => {
  const tip = document.getElementById('tip');
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function showTip(html, ev) {
    tip.innerHTML = html;
    tip.classList.add('on');
    const r = tip.getBoundingClientRect();
    let x = ev.clientX + 14, y = ev.clientY + 14;
    if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - 14;
    if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - 14;
    tip.style.left = Math.max(8, x) + 'px';
    tip.style.top = Math.max(8, y) + 'px';
  }
  const hideTip = () => tip.classList.remove('on');

  function niceTicks(max, n = 4) {
    if (!(max > 0)) return { step: 1, ticks: [0, 1] };
    const raw = max / n, pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / pow;
    const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
    const ticks = [];
    for (let v = 0; v < max + step * 0.999; v += step) ticks.push(+v.toPrecision(12));
    return { step, ticks };
  }

  const ro = new ResizeObserver(entries => {
    for (const e of entries) {
      const el = e.target, w = Math.round(e.contentRect.width);
      if (el._spec && w && w !== el._w) el._redraw();
    }
  });

  function legend(el, series) {
    el.innerHTML = series.length < 2 ? '' :
      series.map(s => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('');
  }

  /* spec: {labels, tipTitles?, series:[{name,color,values,type:'bar'|'line'|'area',dash?,fmt?}],
            height?, unit?, yFmt?, valFmt?, bands?:[[i0,i1,label]], xTicks?:[idx...], xTickLabel?(i), directLabels? } */
  function cartesian(el, spec) {
    el._spec = spec;
    el._redraw = () => cartesian(el, el._spec);
    if (!el._observed) { ro.observe(el); el._observed = true; }
    const W = Math.max(260, Math.round(el.clientWidth)); el._w = W;
    const H = spec.height || 260;
    const m = { l: 44, r: 12, t: spec.unit ? 20 : 10, b: 26 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const n = spec.labels.length;
    const bars = spec.series.filter(s => (s.type || 'bar') === 'bar');
    const lines = spec.series.filter(s => s.type === 'line' || s.type === 'area');
    const valFmt = spec.valFmt || (v => String(+v.toFixed(2)));
    if (!n) { el.innerHTML = '<svg height="60"><text x="8" y="30">No data for this period</text></svg>'; return; }

    let max = 0, min = 0;
    for (let i = 0; i < n; i++) {
      max = Math.max(max, bars.reduce((a, s) => a + Math.max(0, s.values[i] || 0), 0));
      for (const s of lines) { const v = s.values[i] || 0; max = Math.max(max, v); min = Math.min(min, v); }
    }
    let ticks, lo = 0, hi;
    if (min < 0) { // lines that dip below zero: ticks run from below the minimum to above the maximum
      const st = niceTicks(max - min).step;
      lo = Math.floor(min / st + 1e-9) * st; hi = Math.ceil(max / st - 1e-9) * st; if (hi <= lo) hi = lo + st;
      ticks = []; for (let v = lo; v <= hi + st * 0.001; v += st) ticks.push(+v.toPrecision(12));
    } else { ticks = niceTicks(max * 1.02).ticks; hi = ticks[ticks.length - 1] || 1; }
    const bw = pw / n;
    const X = i => m.l + (i + 0.5) * bw;
    const Y = v => m.t + ph - ((v - lo) / (hi - lo)) * ph;
    const yFmt = spec.yFmt || (v => String(v));

    let g = '';
    for (const t of ticks) {
      g += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(t)}" y2="${Y(t)}" stroke="var(--grid)" stroke-width="1"/>`;
      g += `<text x="${m.l - 6}" y="${Y(t) + 4}" text-anchor="end">${esc(yFmt(t))}</text>`;
    }
    if (spec.unit) g += `<text x="${m.l - 6}" y="10" text-anchor="end" style="font-weight:600">${esc(spec.unit)}</text>`;
    for (const b of spec.bands || []) {
      g += `<rect x="${m.l + b[0] * bw}" y="${m.t}" width="${(b[1] - b[0] + 1) * bw}" height="${ph}" fill="var(--band)"/>`;
      if (b[2]) g += `<text x="${m.l + b[0] * bw + 4}" y="${m.t + 11}">${esc(b[2])}</text>`;
    }
    g += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(0)}" y2="${Y(0)}" stroke="var(--axis)" stroke-width="1"/>`;

    // x labels
    let idx = spec.xTicks;
    if (!idx) {
      const k = Math.max(1, Math.ceil(64 / bw)); idx = [];
      for (let i = 0; i < n; i += k) idx.push(i);
    }
    for (const i of idx) {
      g += `<text x="${X(i)}" y="${H - 8}" text-anchor="middle">${esc(spec.xTickLabel ? spec.xTickLabel(i) : spec.labels[i])}</text>`;
    }

    // stacked bars (2px surface gap between segments, 3px rounded data end)
    const barW = Math.max(1.5, Math.min(30, bw * 0.72));
    for (let i = 0; i < n; i++) {
      const segs = bars.map(s => ({ s, v: Math.max(0, s.values[i] || 0) })).filter(d => d.v > 0);
      let acc = 0;
      segs.forEach((d, k) => {
        const y0 = Y(acc), y1 = Y(acc + d.v); acc += d.v;
        const last = k === segs.length - 1;
        const yt = y1 + (last ? 0 : 1), yb = y0 - (k === 0 ? 0 : 1);
        const h = Math.max(1, yb - yt), x = X(i) - barW / 2;
        const r = last ? Math.min(3, barW / 2, h) : 0;
        g += `<path fill="${d.s.color}" d="M${x},${yt + h}L${x},${yt + r}Q${x},${yt} ${x + r},${yt}L${x + barW - r},${yt}Q${x + barW},${yt} ${x + barW},${yt + r}L${x + barW},${yt + h}Z"/>`;
      });
    }

    // lines & areas
    const markers = n <= 14;
    const labelPts = [];
    for (const s of lines) {
      const pts = s.values.map((v, i) => [X(i), Y(v || 0)]);
      const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('');
      if (s.type === 'area') g += `<path d="${d}L${pts[n - 1][0]},${Y(0)}L${pts[0][0]},${Y(0)}Z" fill="${s.color}" opacity="0.16"/>`;
      g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${s.dash ? ' stroke-dasharray="5 4"' : ''}/>`;
      if (markers) for (const p of pts) g += `<circle cx="${p[0]}" cy="${p[1]}" r="4" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`;
      let am = 0; s.values.forEach((v, i) => { if (v > s.values[am]) am = i; });
      labelPts.push({ name: s.name, x: Math.min(W - m.r - 40, Math.max(m.l + 40, pts[am][0])), y: pts[am][1] });
    }
    if (spec.directLabels !== false && lines.length && lines.length <= 4 && spec.series.length <= 5) {
      labelPts.sort((a, b) => a.y - b.y);
      let prev = -99;
      for (const l of labelPts) {
        let y = Math.max(l.y - 8, prev + 13, m.t + 10); prev = y;
        g += `<text class="lbl" x="${l.x}" y="${y}" text-anchor="middle">${esc(l.name)}</text>`;
      }
    }

    g += `<g id="hv"></g><rect id="hit" x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" fill="transparent"/>`;
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(spec.title || '')}">${g}</svg>`;

    const hv = el.querySelector('#hv'), hit = el.querySelector('#hit');
    const move = ev => {
      const r = hit.getBoundingClientRect();
      const i = Math.min(n - 1, Math.max(0, Math.floor((ev.clientX - r.left) / (r.width / n))));
      let h = `<rect x="${m.l + i * bw}" y="${m.t}" width="${bw}" height="${ph}" fill="var(--hover)"/>`;
      for (const s of lines) h += `<circle cx="${X(i)}" cy="${Y(s.values[i] || 0)}" r="4.5" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`;
      hv.innerHTML = h;
      const rows = spec.series.map(s => `<div class="tr"><span><i style="background:${s.color}"></i>${esc(s.name)}</span><b>${esc((s.fmt || valFmt)(s.values[i] || 0))}</b></div>`).join('');
      let total = '';
      if (spec.stackTotal !== false && bars.length > 1) {
        total = `<div class="tr tt"><span>${esc(spec.totalLabel || 'Total')}</span><b>${esc(valFmt(bars.reduce((a, s) => a + (s.values[i] || 0), 0)))}</b></div>`;
      }
      showTip(`<div class="th">${esc(spec.tipTitles ? spec.tipTitles[i] : spec.labels[i])}</div>${rows}${total}`, ev);
    };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerleave', () => { hv.innerHTML = ''; hideTip(); });
  }

  const RAMP_LIGHT = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
  const RAMP_DARK = ['#184f95', '#256abf', '#3987e5', '#5598e7', '#6da7ec', '#9ec5f4', '#cde2fb'];
  const isDark = () => {
    const t = document.documentElement.dataset.theme;
    return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  };
  const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  function ramp(t) {
    const R = isDark() ? RAMP_DARK : RAMP_LIGHT;
    const p = Math.min(1, Math.max(0, t)) * (R.length - 1), i = Math.min(R.length - 2, Math.floor(p)), f = p - i;
    const a = hex(R[i]), b = hex(R[i + 1]);
    return 'rgb(' + a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(',') + ')';
  }

  /* spec: {rows:[labels], cols:[labels], values:[[..]], fmt, rowTitle, colTitle(c), colTicks} */
  function heatmap(el, spec, legendEl) {
    el._spec = spec;
    el._redraw = () => heatmap(el, el._spec, legendEl);
    if (!el._observed) { ro.observe(el); el._observed = true; }
    const W = Math.max(260, Math.round(el.clientWidth)); el._w = W;
    const m = { l: 36, t: 4, b: 22 };
    const nr = spec.rows.length, nc = spec.cols.length;
    const cw = (W - m.l) / nc, ch = Math.min(30, Math.max(18, cw * 0.9));
    const H = m.t + nr * ch + m.b;
    let max = 0;
    spec.values.forEach(r => r.forEach(v => { max = Math.max(max, v); }));
    let g = '';
    spec.rows.forEach((rl, r) => {
      g += `<text x="${m.l - 6}" y="${m.t + r * ch + ch / 2 + 4}" text-anchor="end">${esc(rl)}</text>`;
      spec.cols.forEach((cl, c) => {
        g += `<rect data-r="${r}" data-c="${c}" x="${m.l + c * cw + 1}" y="${m.t + r * ch + 1}" width="${cw - 2}" height="${ch - 2}" rx="3" fill="${ramp(max ? spec.values[r][c] / max : 0)}"/>`;
      });
    });
    (spec.colTicks || []).forEach(c => {
      g += `<text x="${m.l + c * cw + cw / 2}" y="${H - 6}" text-anchor="middle">${esc(spec.cols[c])}</text>`;
    });
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">${g}</svg>`;
    el.querySelectorAll('rect').forEach(rc => {
      rc.addEventListener('pointermove', ev => {
        const r = +rc.dataset.r, c = +rc.dataset.c;
        showTip(`<div class="th">${esc(spec.rows[r])} ${esc(spec.colTitle(c))}</div><div class="tr"><span>${esc(spec.label)}</span><b>${esc(spec.fmt(spec.values[r][c]))}</b></div>`, ev);
      });
      rc.addEventListener('pointerleave', hideTip);
    });
    if (legendEl) {
      const stops = [0, 0.25, 0.5, 0.75, 1].map(t => ramp(t)).join(',');
      legendEl.innerHTML = `<div class="rampbar" style="background:linear-gradient(90deg,${stops})"></div><div class="ramplab"><span>${esc(spec.fmt(0))}</span><span>${esc(spec.fmt(max))}</span></div>`;
    }
  }

  function table(columns, rows) {
    return '<table><thead><tr>' + columns.map(c => `<th>${esc(c)}</th>`).join('') + '</tr></thead><tbody>' +
      rows.map(r => '<tr>' + r.map(c => `<td>${esc(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>';
  }

  return { cartesian, heatmap, legend, table, esc, ramp, showTip, hideTip, redrawAll: () => document.querySelectorAll('.plot').forEach(p => p._redraw && p._redraw()) };
})();
