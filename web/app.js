/* Light Dash - web app. Vanilla JS, no build step, no dependencies.

   Everything about a record type - its fields, labels, choices and links -
   comes from /api/schema, which the server builds from the same definitions it
   validates against. So the forms here cannot drift from the rules there.

   Charts follow a fixed method: categorical colours in fixed order, one y axis
   per chart, a legend for two or more series, thin marks, and a table view
   behind every chart so no value is colour-only.
*/

const state = {
  user: null,
  schema: null,
  module: 'dashboard',
  resource: null,
  q: '',
  options: {},
};

// ---------------------------------------------------------------- utilities
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// The viewer's local date. UTC would put an evening timesheet on tomorrow.
const today = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/auth/me' && path !== '/api/auth/login') {
    showLogin('Your session has ended. Sign in again.');
  }
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

const fmt = {
  int: (v) => (v == null ? '—' : Math.round(v).toLocaleString('en-US')),
  money: (v) => (v == null ? '—' : Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' })),
  moneyc: (v) => {
    if (v == null) return '—';
    const n = Number(v);
    if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
    if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
    return `$${Math.round(n)}`;
  },
  hours: (v) => `${Number(v || 0).toFixed(v % 1 ? 1 : 0)}h`,
  month: (m) => new Date(`${m}-01T00:00:00Z`).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }),
  when: (iso) => String(iso || '').slice(0, 16).replace('T', ' '),
};

const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const SERIES = () => [cssVar('--series-1'), cssVar('--series-2'), cssVar('--series-3')];

// Status words carry meaning, so they get an icon and a label, never colour alone.
const STATUS = {
  pass: ['Active', 'Approved', 'Done', 'Paid', 'Won', 'Reimbursed', 'On track'],
  fail: ['Rejected', 'Lost', 'Void', 'At risk', 'Left'],
  pending: ['Requested', 'Submitted', 'Sent', 'In progress', 'Proposal', 'Qualified', 'Planned',
    'To do', 'Not started', 'On leave', 'Lead', 'On hold', 'Draft'],
};
const ICON = { pass: '✓', fail: '✕', pending: '○', neutral: '•' };
function chip(value) {
  const kind = Object.keys(STATUS).find((k) => STATUS[k].includes(value)) || 'neutral';
  return `<span class="chip ${kind}"><span class="dot" aria-hidden="true">${ICON[kind]}</span>${esc(value)}</span>`;
}
const isStatusField = (f) => f.type === 'enum' && ['status', 'stage'].includes(f.name);

// ---------------------------------------------------------------- charts
function niceStep(raw) {
  const mag = 10 ** Math.floor(Math.log10(Math.abs(raw) || 1));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

function tableToggle(host) {
  const btn = $('.toggle-table', host);
  btn.addEventListener('click', () => {
    const hidden = $('.table-twin', host).classList.toggle('hidden');
    btn.textContent = hidden ? 'Show values as a table' : 'Hide the table';
  });
}

/** Horizontal bars, one series, value labels at the bar end. */
function barChart(host, { rows, valueFormat, caption }) {
  if (!rows.length) {
    host.innerHTML = '<p class="empty">Nothing recorded yet.</p>';
    return;
  }
  const width = Math.max(300, host.clientWidth || 600);
  const barH = 18;
  const band = 32;
  const m = { top: 6, right: 80, bottom: 24, left: 120 };
  const plotW = width - m.left - m.right;
  const height = m.top + rows.length * band + m.bottom;
  const max = Math.max(...rows.map((r) => r.value)) || 1;
  const sx = (v) => (v / max) * plotW;
  const color = SERIES()[0];
  const parts = [`<svg class="chart" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(caption)}">`];
  const step = niceStep(max / 4);
  for (let t = 0; t <= max * 1.001; t += step) {
    const x = m.left + sx(t);
    parts.push(`<line class="grid-line" x1="${x}" x2="${x}" y1="${m.top}" y2="${m.top + rows.length * band}"/>`);
    parts.push(`<text class="tick-label" x="${x}" y="${height - 8}" text-anchor="middle">${esc(valueFormat(t))}</text>`);
  }
  parts.push(`<line class="axis-line" x1="${m.left}" x2="${m.left}" y1="${m.top}" y2="${m.top + rows.length * band}"/>`);
  rows.forEach((r, i) => {
    const y = m.top + i * band;
    const w = Math.max(sx(r.value), 2);
    const rr = Math.min(4, w, barH / 2);
    const x0 = m.left;
    parts.push(`<text x="${m.left - 10}" y="${y + barH / 2 + 4}" text-anchor="end" fill="${cssVar('--text-secondary')}">${esc(r.label.length > 18 ? `${r.label.slice(0, 17)}…` : r.label)}</text>`);
    parts.push(`<path d="M${x0} ${y} H${x0 + w - rr} Q${x0 + w} ${y} ${x0 + w} ${y + rr} V${y + barH - rr} Q${x0 + w} ${y + barH} ${x0 + w - rr} ${y + barH} H${x0} Z" fill="${color}"><title>${esc(r.label)}: ${esc(valueFormat(r.value))}</title></path>`);
    parts.push(`<text x="${x0 + w + 8}" y="${y + barH / 2 + 4}" fill="${cssVar('--text-primary')}" style="font-variant-numeric:tabular-nums">${esc(valueFormat(r.value))}</text>`);
  });
  parts.push('</svg>');
  host.innerHTML = `${parts.join('')}
    <button class="toggle-table" type="button">Show values as a table</button>
    <div class="table-twin hidden"><table class="data"><caption class="sub-note" style="text-align:left">${esc(caption)}</caption>
      <tbody>${rows.map((r) => `<tr><td>${esc(r.label)}</td><td class="num">${esc(valueFormat(r.value))}</td></tr>`).join('')}</tbody></table></div>`;
  tableToggle(host);
}

/** Lines over time, one shared y axis, crosshair tooltip, keyboard readout. */
function lineChart(host, { labels, series, valueFormat, caption }) {
  const width = Math.max(320, host.clientWidth || 640);
  const height = 240;
  const m = { top: 16, right: 84, bottom: 28, left: 64 };
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;
  const colors = SERIES();
  const values = series.flatMap((s) => s.values);
  const hi = Math.max(...values, 0) * 1.12 || 1;
  const n = labels.length;
  const x = (i) => m.left + (n === 1 ? plotW / 2 : (i * plotW) / (n - 1));
  const y = (v) => m.top + plotH - (v / hi) * plotH;
  const step = niceStep(hi / 4);
  const parts = [`<svg class="chart" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(caption)}">`];
  for (let t = 0; t <= hi; t += step) {
    parts.push(`<line class="grid-line" x1="${m.left}" x2="${m.left + plotW}" y1="${y(t)}" y2="${y(t)}"/>`);
    parts.push(`<text class="tick-label" x="${m.left - 8}" y="${y(t) + 3.5}" text-anchor="end">${esc(valueFormat(t))}</text>`);
  }
  parts.push(`<line class="axis-line" x1="${m.left}" x2="${m.left + plotW}" y1="${m.top + plotH}" y2="${m.top + plotH}"/>`);
  labels.forEach((l, i) => parts.push(`<text x="${x(i)}" y="${m.top + plotH + 18}" text-anchor="middle">${esc(l)}</text>`));
  series.forEach((s, si) => {
    const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
    parts.push(`<path d="${d}" fill="none" stroke="${colors[si]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
  });
  series.forEach((s, si) => {
    s.values.forEach((v, i) => parts.push(`<circle cx="${x(i)}" cy="${y(v)}" r="4.5" fill="${colors[si]}" stroke="${cssVar('--surface-1')}" stroke-width="2"/>`));
    const last = s.values.length - 1;
    parts.push(`<text class="end-label" x="${x(last) + 10}" y="${y(s.values[last]) + 4}" fill="${colors[si]}">${esc(s.label)}</text>`);
  });
  parts.push(`<line class="crosshair hidden" x1="0" x2="0" y1="${m.top}" y2="${m.top + plotH}"/>`);
  parts.push(`<rect class="hit" x="${m.left}" y="${m.top}" width="${plotW}" height="${plotH}" tabindex="0" aria-label="Use left and right arrow keys to read each month."/>`);
  parts.push('</svg>');
  host.innerHTML = `<div class="chart-wrap">${parts.join('')}<div class="tooltip" role="status" aria-live="polite"></div></div>
    <div class="legend">${series.map((s, si) => `<span><i style="background:${colors[si]}"></i>${esc(s.label)}</span>`).join('')}</div>
    <button class="toggle-table" type="button">Show values as a table</button>
    <div class="table-twin hidden"><table class="data"><caption class="sub-note" style="text-align:left">${esc(caption)}</caption>
      <thead><tr><th>Month</th>${series.map((s) => `<th class="num">${esc(s.label)}</th>`).join('')}</tr></thead>
      <tbody>${labels.map((l, i) => `<tr><td>${esc(l)}</td>${series.map((s) => `<td class="num">${esc(valueFormat(s.values[i]))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  tableToggle(host);

  const svg = $('svg', host);
  const tip = $('.tooltip', host);
  const cross = $('.crosshair', svg);
  const hit = $('.hit', svg);
  let active = -1;
  const show = (i) => {
    if (i < 0 || i >= n) return;
    active = i;
    cross.classList.remove('hidden');
    cross.setAttribute('x1', x(i));
    cross.setAttribute('x2', x(i));
    tip.innerHTML = `<div class="tt-title">${esc(labels[i])}</div>${series
      .map((s, si) => `<div class="tt-row"><span><i style="background:${colors[si]}"></i>${esc(s.label)}</span><b>${esc(valueFormat(s.values[i]))}</b></div>`)
      .join('')}`;
    tip.classList.add('on');
    const scale = (host.clientWidth || width) / width;
    tip.style.left = `${Math.min(Math.max(x(i) * scale - 70, 0), (host.clientWidth || width) - 170)}px`;
    tip.style.top = `${m.top * scale + 6}px`;
  };
  const hide = () => {
    cross.classList.add('hidden');
    tip.classList.remove('on');
  };
  hit.addEventListener('mousemove', (ev) => {
    const box = svg.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * width;
    let best = 0;
    for (let i = 1; i < n; i += 1) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    show(best);
  });
  hit.addEventListener('mouseleave', hide);
  hit.addEventListener('focus', () => show(active < 0 ? n - 1 : active));
  hit.addEventListener('blur', hide);
  hit.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowRight') { show(Math.min(n - 1, active + 1)); ev.preventDefault(); }
    if (ev.key === 'ArrowLeft') { show(Math.max(0, active - 1)); ev.preventDefault(); }
  });
}

// ---------------------------------------------------------------- dashboard
function tile(label, value, context = '') {
  return `<div class="card tile"><div class="label">${esc(label)}</div><div class="value">${value}</div>${
    context ? `<div class="context">${context}</div>` : ''}</div>`;
}

async function viewDashboard(root) {
  const d = await api('/api/dashboard');
  const tiles = [];
  if (d.crm) {
    tiles.push(tile('Open pipeline', esc(fmt.moneyc(d.crm.open_value)), `${d.crm.pipeline.reduce((a, s) => a + s.n, 0)} open deals`));
    tiles.push(tile('Won this year', esc(fmt.moneyc(d.crm.won_this_year))));
  }
  if (d.finance) {
    tiles.push(tile('Outstanding invoices', esc(fmt.moneyc(d.finance.outstanding)),
      d.finance.overdue.n ? `${chip('Overdue')} ${d.finance.overdue.n} worth ${esc(fmt.money(d.finance.overdue.v))}` : 'none overdue'));
    tiles.push(tile('Expenses to approve', esc(fmt.int(d.finance.expenses_awaiting))));
  }
  if (d.projects) {
    tiles.push(tile('Active projects', esc(fmt.int(d.projects.active)),
      `${d.projects.open_tasks} open tasks${d.projects.overdue_tasks ? ` · <strong>${d.projects.overdue_tasks} overdue</strong>` : ''}`));
    tiles.push(tile('Hours this month', esc(fmt.int(d.projects.hours_this_month)), 'logged on timesheets'));
  }
  if (d.hr) {
    tiles.push(tile('Headcount', esc(fmt.int(d.hr.headcount)), `${d.hr.out_next_14_days} out in the next 14 days`));
    tiles.push(tile('Time off to approve', esc(fmt.int(d.hr.time_off_pending))));
  }

  root.innerHTML = `
    <div class="grid cols-4">${tiles.join('')}</div>
    <div class="grid cols-2" style="margin-top:16px">
      ${d.finance ? '<div class="card span-2"><h2>Revenue and expenses, last six months <span class="note">paid invoices by issue month · approved expenses</span></h2><div id="ch-money"></div></div>' : ''}
      ${d.crm ? '<div class="card"><h2>Open pipeline by stage</h2><div id="ch-pipe"></div></div>' : ''}
      ${d.projects ? '<div class="card"><h2>Hours by project, this month</h2><div id="ch-hours"></div></div>' : ''}
      ${d.hr ? '<div class="card"><h2>Headcount by department</h2><div id="ch-dept"></div></div>' : ''}
      ${d.hr ? `<div class="card"><h2>Goals by status</h2><div>${d.hr.goals_by_status.length
        ? `<table class="data"><tbody>${d.hr.goals_by_status.map((g) => `<tr><td>${chip(g.label)}</td><td class="num">${g.n}</td></tr>`).join('')}</tbody></table>`
        : '<p class="empty">No goals yet.</p>'}</div></div>` : ''}
    </div>
    ${!Object.keys(d).length ? '<div class="banner"><div><div class="ttl">Nothing to show</div><p>This account cannot read any module yet. Ask an administrator for access.</p></div></div>' : ''}`;

  if (d.finance) {
    lineChart($('#ch-money', root), {
      labels: d.finance.revenue.map((r) => fmt.month(r.month)),
      series: [
        { label: 'Revenue', values: d.finance.revenue.map((r) => r.total) },
        { label: 'Expenses', values: d.finance.expenses.map((r) => r.total) },
      ],
      valueFormat: fmt.moneyc,
      caption: 'Revenue (paid invoices, by issue month) and approved expenses, last six months.',
    });
  }
  if (d.crm) {
    barChart($('#ch-pipe', root), {
      rows: d.crm.pipeline.map((s) => ({ label: `${s.label} (${s.n})`, value: s.value })),
      valueFormat: fmt.moneyc,
      caption: 'Value of open deals by stage.',
    });
  }
  if (d.projects) {
    barChart($('#ch-hours', root), {
      rows: d.projects.hours_by_project.map((p) => ({ label: p.label, value: p.hours })),
      valueFormat: fmt.hours,
      caption: 'Hours logged this month, by project.',
    });
  }
  if (d.hr) {
    barChart($('#ch-dept', root), {
      rows: d.hr.by_department.map((x) => ({ label: x.label, value: x.n })),
      valueFormat: (v) => fmt.int(v),
      caption: 'Current employees by department.',
    });
  }
}

// ---------------------------------------------------------------- records
async function optionsFor(ref) {
  if (!state.options[ref]) state.options[ref] = (await api(`/api/options/${ref}`)).options;
  return state.options[ref];
}

function cell(res, f, row) {
  const v = row[f.name];
  if (v == null || v === '') return '<span class="evidence">—</span>';
  if (f.type === 'ref') return esc(row._labels?.[f.name] ?? `#${v}`);
  if (isStatusField(f)) return chip(v);
  if (f.type === 'money') return `<span class="money">${esc(fmt.money(v))}</span>`;
  if (f.type === 'percent') return `${esc(v)}%`;
  if (f.type === 'url') return `<a href="${esc(v)}" target="_blank" rel="noopener noreferrer">${esc(v.replace(/^https?:\/\//, ''))}</a>`;
  if (f.type === 'date') {
    const late = v < today() && (
      (res.name === 'tasks' && f.name === 'due_date' && row.status !== 'Done')
      || (res.name === 'invoices' && f.name === 'due_date' && row.status === 'Sent'));
    return `<span class="mono">${esc(v)}</span>${late ? '<div class="overdue">overdue</div>' : ''}`;
  }
  return esc(v);
}

async function viewResource(root, name) {
  const res = state.schema.resources[name];
  const listFields = res.fields.filter((f) => f.list);
  const qs = new URLSearchParams({ limit: '200' });
  if (state.q) qs.set('q', state.q);
  const data = await api(`/api/r/${name}?${qs}`);

  root.innerHTML = `
    <div id="record-panel"></div>
    <div class="card">
      <div class="toolbar">
        <input type="search" id="search" placeholder="Search ${esc(res.label.toLowerCase())}" value="${esc(state.q)}" aria-label="Search ${esc(res.label)}">
        <span class="count">${data.total} ${esc(data.total === 1 ? res.singular.toLowerCase() : res.label.toLowerCase())}${data.total > data.rows.length ? `, first ${data.rows.length} shown` : ''}</span>
        <span class="spacer"></span>
        ${res.canWrite ? `<button class="btn primary" id="new-record" type="button">New ${esc(res.singular.toLowerCase())}</button>` : '<span class="hint">Read-only for this account</span>'}
      </div>
      ${data.rows.length
        ? `<div class="table-scroll"><table class="data">
            <thead><tr>${listFields.map((f) => `<th class="${['money', 'number', 'percent'].includes(f.type) ? 'num' : ''}">${esc(f.label)}</th>`).join('')}</tr></thead>
            <tbody>${data.rows.map((row) => `<tr class="record" data-id="${row.id}" tabindex="0">${listFields
              .map((f) => `<td class="${['money', 'number', 'percent'].includes(f.type) ? 'num' : ''}">${cell(res, f, row)}</td>`)
              .join('')}</tr>`).join('')}</tbody>
          </table></div>`
        : `<p class="empty">${state.q ? 'Nothing matches that search.' : `No ${esc(res.label.toLowerCase())} yet.`}</p>`}
    </div>`;

  let t;
  $('#search', root).addEventListener('input', (ev) => {
    clearTimeout(t);
    t = setTimeout(() => {
      state.q = ev.target.value;
      render().then(() => {
        const s = $('#search');
        s.focus();
        s.setSelectionRange(s.value.length, s.value.length);
      });
    }, 250);
  });
  $('#new-record', root)?.addEventListener('click', () => openRecord(root, res, null));
  $$('tr.record', root).forEach((tr) => {
    const open = () => openRecord(root, res, Number(tr.dataset.id));
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') open(); });
  });
}

function inputFor(f, value, disabled) {
  const v = value ?? '';
  const dis = disabled ? ' disabled' : '';
  const req = f.required ? ' required' : '';
  const ph = f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : '';
  switch (f.type) {
    case 'textarea':
      return `<textarea name="${f.name}"${dis}${req}${ph}>${esc(v)}</textarea>`;
    case 'number':
    case 'money':
    case 'percent':
      return `<input name="${f.name}" type="number" value="${esc(v)}" step="${f.step ?? (f.type === 'money' ? '0.01' : '1')}"${
        f.type === 'percent' ? ' min="0" max="100"' : `${f.min != null ? ` min="${f.min}"` : ''}${f.max != null ? ` max="${f.max}"` : ''}`}${dis}${req}>`;
    case 'date':
      return `<input name="${f.name}" type="date" value="${esc(v)}"${dis}${req}>`;
    case 'email':
      return `<input name="${f.name}" type="email" value="${esc(v)}"${dis}${req}>`;
    case 'url':
      return `<input name="${f.name}" type="url" value="${esc(v)}" placeholder="https://"${dis}${req}>`;
    case 'enum':
      return `<select name="${f.name}"${dis}${req}>${f.required ? '' : '<option value=""></option>'}${f.options
        .map((o) => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    default:
      return `<input name="${f.name}" type="text" value="${esc(v)}"${dis}${req}${ph}>`;
  }
}

function itemsEditor(items, disabled) {
  const rows = (items?.length ? items : [{ description: '', quantity: 1, unit_price: 0 }])
    .map((it) => `<tr>
      <td><input data-k="description" value="${esc(it.description)}" placeholder="What was delivered"${disabled ? ' disabled' : ''}></td>
      <td style="width:90px"><input data-k="quantity" type="number" step="0.01" min="0" value="${esc(it.quantity)}"${disabled ? ' disabled' : ''}></td>
      <td style="width:130px"><input data-k="unit_price" type="number" step="0.01" min="0" value="${esc(it.unit_price)}"${disabled ? ' disabled' : ''}></td>
      <td class="amount"></td>
      <td style="width:36px">${disabled ? '' : '<button class="btn ghost" type="button" data-remove title="Remove line">✕</button>'}</td>
    </tr>`).join('');
  return `<div class="items-editor">
    <table><thead><tr><th>Description</th><th>Qty</th><th>Unit price</th><th style="text-align:right">Amount</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>
    ${disabled ? '' : '<button class="btn" type="button" data-add-line style="margin-top:6px">Add line</button>'}
    <div class="totals"><span>Subtotal <b data-t="subtotal"></b></span><span>Tax <b data-t="tax"></b></span><span>Total <b data-t="total"></b></span></div>
    <div class="hint" style="text-align:right">Totals are worked out by the server when you save.</div>
  </div>`;
}

function wireItems(form) {
  const ed = $('.items-editor', form);
  if (!ed) return null;
  const recalc = () => {
    let sub = 0;
    $$('tbody tr', ed).forEach((tr) => {
      const q = Number($('[data-k="quantity"]', tr).value) || 0;
      const p = Number($('[data-k="unit_price"]', tr).value) || 0;
      sub += q * p;
      $('.amount', tr).textContent = fmt.money(Math.round(q * p * 100) / 100);
    });
    const rate = Number(form.elements.tax_rate?.value) || 0;
    const tax = Math.round(sub * rate) / 100;
    $('[data-t="subtotal"]', ed).textContent = fmt.money(sub);
    $('[data-t="tax"]', ed).textContent = fmt.money(tax);
    $('[data-t="total"]', ed).textContent = fmt.money(sub + tax);
  };
  ed.addEventListener('input', recalc);
  form.elements.tax_rate?.addEventListener('input', recalc);
  ed.addEventListener('click', (ev) => {
    if (ev.target.matches('[data-remove]')) {
      if ($$('tbody tr', ed).length > 1) ev.target.closest('tr').remove();
      recalc();
    }
    if (ev.target.matches('[data-add-line]')) {
      const first = $('tbody tr', ed);
      const row = first.cloneNode(true);
      $$('input', row).forEach((i) => { i.value = i.dataset.k === 'quantity' ? '1' : i.dataset.k === 'unit_price' ? '0' : ''; });
      $('tbody', ed).append(row);
      recalc();
    }
  });
  recalc();
  return () => $$('tbody tr', ed).map((tr) => ({
    description: $('[data-k="description"]', tr).value,
    quantity: $('[data-k="quantity"]', tr).value,
    unit_price: $('[data-k="unit_price"]', tr).value,
  })).filter((it) => it.description.trim() || Number(it.unit_price));
}

async function openRecord(root, res, id) {
  const panel = $('#record-panel', root);
  $$('tr.record', root).forEach((tr) => tr.classList.toggle('selected', Number(tr.dataset.id) === id));
  panel.innerHTML = '<div class="card record-panel"><p class="evidence">Loading…</p></div>';
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const record = id ? await api(`/api/r/${res.name}/${id}`) : null;
  const readOnly = !res.canWrite;
  // Fill every link picker this form needs before drawing it.
  const refs = [...new Set(res.fields.filter((f) => f.type === 'ref').map((f) => f.ref))];
  const opts = Object.fromEntries(await Promise.all(refs.map(async (r) => [r, await optionsFor(r).catch(() => [])])));

  // A new record's date defaults to the viewer's own today, not the server's.
  const value = (f) => (record ? record[f.name] : f.type === 'date' && f.default ? today() : f.default);
  const fieldHtml = (f) => {
    if (f.type === 'items') return itemsEditor(record?.items, readOnly || (record && ['Paid', 'Void'].includes(record.status)));
    const label = `${esc(f.label)}${f.required ? '<span class="req" aria-hidden="true">*</span>' : ''}`;
    if (f.readonly) {
      if (!record) return '';
      return `<label>${label}<span class="readonly-value">${f.type === 'money' ? esc(fmt.money(record[f.name])) : esc(record[f.name] ?? '—')}</span></label>`;
    }
    const full = f.type === 'textarea' ? ' class="full"' : '';
    let control;
    if (f.type === 'ref') {
      const list = opts[f.ref] || [];
      const cur = value(f);
      control = `<select name="${f.name}"${readOnly ? ' disabled' : ''}${f.required ? ' required' : ''}>
        ${f.required && cur ? '' : '<option value=""></option>'}
        ${list.map((o) => `<option value="${o.id}"${o.id === cur ? ' selected' : ''}>${esc(o.title)}</option>`).join('')}
      </select>`;
    } else {
      control = inputFor(f, value(f), readOnly);
    }
    const noteHint = res.requireNote && f.name === res.requireNote.field
      ? `<span class="hint">Required when ${esc(res.requireNote.when.join(' or '))} changes — explain the assessment.</span>` : '';
    return `<label${full}>${label}${control}${noteHint}</label>`;
  };

  const title = record
    ? esc(record.number || [record.first_name, record.last_name].filter(Boolean).join(' ') || record.name || record.title || `${res.singular} #${record.id}`)
    : `New ${esc(res.singular.toLowerCase())}`;
  panel.innerHTML = `
    <div class="card record-panel">
      <h2>${title}<span class="note">${record ? `${esc(res.singular)} #${record.id}` : ''}</span></h2>
      <form class="form-grid" novalidate>${res.fields.map(fieldHtml).join('')}</form>
      <div class="form-actions">
        ${readOnly ? '' : `<button class="btn primary" type="button" data-save>${record ? 'Save changes' : `Create ${esc(res.singular.toLowerCase())}`}</button>`}
        <button class="btn ghost" type="button" data-close>Close</button>
        <span class="spacer"></span>
        ${record ? '<button class="toggle-table" type="button" data-history>History</button>' : ''}
        ${record && !readOnly ? '<button class="btn ghost danger" type="button" data-delete>Delete</button>' : ''}
      </div>
      <div class="err" data-err></div>
      <div data-history-list></div>
    </div>`;

  const form = $('form', panel);
  const getItems = wireItems(form);
  const err = $('[data-err]', panel);
  $('[data-close]', panel).addEventListener('click', () => {
    panel.innerHTML = '';
    $$('tr.record', root).forEach((tr) => tr.classList.remove('selected'));
  });

  $('[data-save]', panel)?.addEventListener('click', async () => {
    const body = {};
    for (const f of res.fields) {
      if (f.readonly) continue;
      if (f.type === 'items') {
        if (getItems) body.items = getItems();
        continue;
      }
      const el = form.elements[f.name];
      if (el) body[f.name] = el.value;
    }
    err.textContent = '';
    try {
      const saved = await api(record ? `/api/r/${res.name}/${record.id}` : `/api/r/${res.name}`, {
        method: record ? 'PATCH' : 'POST',
        body: JSON.stringify(body),
      });
      if (saved.unchanged) {
        err.textContent = 'Nothing changed.';
        return;
      }
      state.options = {}; // titles may have changed
      await render();
      openRecord($('#view'), res, saved.id);
    } catch (e) {
      err.textContent = e.message;
    }
  });

  $('[data-delete]', panel)?.addEventListener('click', async () => {
    if (!window.confirm(`Delete this ${res.singular.toLowerCase()}? The audit log keeps a copy of what it held.`)) return;
    try {
      await api(`/api/r/${res.name}/${record.id}`, { method: 'DELETE' });
      state.options = {};
      await render();
    } catch (e) {
      err.textContent = e.message;
    }
  });

  $('[data-history]', panel)?.addEventListener('click', async (ev) => {
    const host = $('[data-history-list]', panel);
    if (host.innerHTML) {
      host.innerHTML = '';
      ev.target.textContent = 'History';
      return;
    }
    const { events } = await api(`/api/r/${res.name}/${record.id}/history`);
    ev.target.textContent = 'Hide history';
    host.innerHTML = renderHistory(events);
  });
}

function describeChange(field, [from, to]) {
  const show = (v) => {
    if (v == null || v === '') return '—';
    if (Array.isArray(v)) return `${v.length} line${v.length === 1 ? '' : 's'}`;
    return String(v);
  };
  return `${esc(field.replace(/_/g, ' '))}: ${esc(show(from))} → ${esc(show(to))}`;
}

function renderHistory(events) {
  if (!events.length) return '<p class="evidence">No history recorded.</p>';
  return `<ol class="history-list">${events.map((e) => `<li>
    <div class="h-head">
      <span class="h-who">${esc(e.actor_label)}</span>
      <span class="h-src">${esc(e.action)}</span>
      <span class="h-at">${esc(fmt.when(e.at))}</span>
    </div>
    <div class="h-metric">${Object.entries(e.changes).map(([f, ch]) => describeChange(f, ch)).join(' · ')}</div>
  </li>`).join('')}</ol>`;
}

// ---------------------------------------------------------------- audit (admin)
async function viewAudit(root) {
  const entity = state.auditEntity || '';
  const { events } = await api(`/api/audit?limit=200${entity ? `&entity=${encodeURIComponent(entity)}` : ''}`);
  const names = Object.values(state.schema.resources);
  root.innerHTML = `
    <div class="card">
      <h2>Audit log <span class="note">every create, change and delete — append-only</span></h2>
      <div class="toolbar">
        <select id="audit-entity" aria-label="Filter by record type">
          <option value="">All record types</option>
          ${names.map((r) => `<option value="${r.name}"${r.name === entity ? ' selected' : ''}>${esc(r.label)}</option>`).join('')}
        </select>
        <span class="count">${events.length} most recent</span>
      </div>
      ${events.length ? `<div class="table-scroll"><table class="data">
        <thead><tr><th>When</th><th>Who</th><th>Record</th><th>Action</th><th>What changed</th></tr></thead>
        <tbody>${events.map((e) => `<tr>
          <td class="mono">${esc(fmt.when(e.at))}</td>
          <td>${esc(e.actor_label)}</td>
          <td>${esc(state.schema.resources[e.entity]?.singular || e.entity)} #${e.entity_id}</td>
          <td><span class="h-src">${esc(e.action)}</span></td>
          <td style="max-width:520px;color:var(--text-secondary)">${Object.entries(e.changes).slice(0, 6).map(([f, ch]) => describeChange(f, ch)).join(' · ')}${Object.keys(e.changes).length > 6 ? ' …' : ''}</td>
        </tr>`).join('')}</tbody></table></div>` : '<p class="empty">Nothing recorded yet.</p>'}
    </div>`;
  $('#audit-entity', root).addEventListener('change', (ev) => {
    state.auditEntity = ev.target.value;
    render();
  });
}

// ---------------------------------------------------------------- navigation
const isAdmin = () => state.user?.scopes.includes('admin');

function drawNav() {
  const mods = [['dashboard', 'Dashboard'], ...Object.entries(state.schema.modules).map(([k, m]) => [k, m.label])];
  if (isAdmin()) mods.push(['audit', 'Audit log']);
  $('#modules').innerHTML = mods
    .map(([k, label]) => `<button role="tab" data-module="${k}" aria-selected="${k === state.module}">${esc(label)}</button>`)
    .join('');
  const mod = state.schema.modules[state.module];
  const sub = $('#resources');
  if (mod) {
    sub.hidden = false;
    sub.innerHTML = mod.resources
      .filter((r) => state.schema.resources[r])
      .map((r) => `<button data-resource="${r}" aria-selected="${r === state.resource}">${esc(state.schema.resources[r].label)}</button>`)
      .join('');
  } else {
    sub.hidden = true;
    sub.innerHTML = '';
  }
  $$('#modules button').forEach((b) => b.addEventListener('click', () => {
    state.module = b.dataset.module;
    state.resource = state.schema.modules[state.module]?.resources.find((r) => state.schema.resources[r]) || null;
    state.q = '';
    render();
  }));
  $$('#resources button').forEach((b) => b.addEventListener('click', () => {
    state.resource = b.dataset.resource;
    state.q = '';
    render();
  }));
}

async function render() {
  drawNav();
  const root = $('#view');
  root.style.opacity = '0.55'; // keep the old view while the new one loads
  try {
    if (state.module === 'dashboard') await viewDashboard(root);
    else if (state.module === 'audit') await viewAudit(root);
    else await viewResource(root, state.resource);
  } catch (e) {
    root.innerHTML = `<div class="banner"><div><div class="ttl">Could not load this view</div><p>${esc(e.message)}</p></div></div>`;
  } finally {
    root.style.opacity = '1';
  }
}

// ---------------------------------------------------------------- sign-in
function showLogin(message) {
  $('#login-screen').hidden = false;
  $('#identity').hidden = true;
  $('#modules').hidden = true;
  $('#resources').hidden = true;
  $('#login-err').textContent = message || '';
}

async function startSession(user) {
  state.user = user;
  state.schema = await api('/api/schema');
  $('#login-screen').hidden = true;
  $('#modules').hidden = false;
  $('#identity').hidden = false;
  $('#who').innerHTML = `<strong>${esc(user.name)}</strong><span class="role">${esc(user.role)}</span>`;
  await render();
}

function applyTheme(mode) {
  document.documentElement.setAttribute('data-theme', mode);
  try { localStorage.setItem('lightdash-theme', mode); } catch { /* storage unavailable */ }
}

async function start() {
  try {
    const saved = localStorage.getItem('lightdash-theme');
    if (saved) document.documentElement.setAttribute('data-theme', saved);
  } catch { /* storage unavailable */ }

  $('#theme-toggle').addEventListener('click', () => {
    const now = document.documentElement.getAttribute('data-theme')
      || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    applyTheme(now === 'dark' ? 'light' : 'dark');
    if (state.user) render(); // charts read colours from CSS, so redraw
  });
  $('#sign-out').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* already gone */ }
    location.reload();
  });
  $('#login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const btn = $('button[type="submit"]', ev.target);
    btn.disabled = true;
    try {
      const { user } = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: f.get('email'), password: f.get('password') }),
      });
      ev.target.reset();
      await startSession(user);
    } catch (e) {
      $('#login-err').textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  });
  let t;
  window.addEventListener('resize', () => {
    clearTimeout(t);
    t = setTimeout(() => { if (state.user && state.module === 'dashboard') render(); }, 200);
  });

  try {
    const { user } = await api('/api/auth/me');
    await startSession(user);
  } catch {
    showLogin();
  }
}

start();
