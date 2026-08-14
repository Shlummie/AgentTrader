const $ = (selector) => document.querySelector(selector);
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });
let view = { status: null, orders: [], memory: null };
let busy = false;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function pct(value, digits = 2) {
  return value == null ? '—' : `${Number(value).toFixed(digits)}%`;
}

function setTone(element, value) {
  element.classList.remove('positive', 'negative');
  if (value > 0) element.classList.add('positive');
  if (value < 0) element.classList.add('negative');
}

function setPill(element, label, tone = 'neutral') {
  element.textContent = label;
  element.className = `status-pill ${tone}`;
}

function setHealth(id, ok, text, warning = false) {
  const icon = $(`#${id}Icon`);
  icon.className = `health-icon ${warning ? 'warn' : ok ? 'good' : 'bad'}`;
  $(`#${id}Health`).textContent = text;
}

function renderChart(points) {
  const line = $('#chartLine');
  const area = $('#chartArea');
  const grid = $('#chartGrid');
  grid.replaceChildren();
  if (!points || points.length < 2) {
    line.setAttribute('d', ''); area.setAttribute('d', ''); $('#chartEmpty').hidden = false; return;
  }
  $('#chartEmpty').hidden = true;
  const values = points.map((point) => point.equity);
  let min = Math.min(...values), max = Math.max(...values);
  const pad = Math.max((max - min) * .18, max * .002);
  min -= pad; max += pad;
  const x = (index) => 10 + index / (points.length - 1) * 700;
  const y = (value) => 205 - (value - min) / (max - min || 1) * 185;
  const d = points.map((point, index) => `${index ? 'L' : 'M'} ${x(index).toFixed(2)} ${y(point.equity).toFixed(2)}`).join(' ');
  line.setAttribute('d', d);
  area.setAttribute('d', `${d} L 710 215 L 10 215 Z`);
  for (let index = 0; index < 5; index += 1) {
    const gridLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    const gridY = 20 + index * 46;
    gridLine.setAttribute('x1', '10'); gridLine.setAttribute('x2', '710'); gridLine.setAttribute('y1', gridY); gridLine.setAttribute('y2', gridY); gridLine.setAttribute('stroke', '#263038'); gridLine.setAttribute('stroke-width', '1');
    grid.append(gridLine);
  }
}

function renderList(element, items, fallback, mapper = (item) => String(item)) {
  element.replaceChildren();
  const values = items?.length ? items : [fallback];
  for (const item of values) {
    const li = document.createElement('li');
    li.textContent = mapper(item);
    element.append(li);
  }
}

function renderStatus() {
  const { status } = view;
  if (!status) return;
  const { account, settings, performance, currentRun, timing, health } = status;
  $('#equityValue').textContent = money.format(account.equity);
  $('#netPnl').textContent = money.format(performance.netPnl); setTone($('#netPnl'), performance.netPnl);
  $('#netReturn').textContent = pct(performance.netReturnPct); setTone($('#netReturn'), performance.netReturnPct);
  $('#drawdown').textContent = pct(performance.maxDrawdownPct);
  $('#winRate').textContent = performance.winRatePct == null ? '—' : pct(performance.winRatePct, 1);
  $('#actualVsLong').textContent = money.format(performance.actualVsAlwaysLongPnl); setTone($('#actualVsLong'), performance.actualVsAlwaysLongPnl);
  $('#brierScore').textContent = performance.brierScore == null ? '—' : performance.brierScore.toFixed(3);
  $('#streak').textContent = performance.currentStreak ? `${performance.currentStreak.count} ${performance.currentStreak.type}${performance.currentStreak.count === 1 ? '' : 's'}` : '—';
  renderChart(performance.equityCurve);

  const enabled = settings.automationEnabled;
  $('#automationToggle').setAttribute('aria-checked', String(enabled));
  $('#automationRail').textContent = enabled ? 'Enabled' : 'Paused';
  $('#automationRail').className = enabled ? 'positive' : '';
  $('#controlDot').className = `status-dot${enabled ? ' on' : ''}`;
  $('#clockRail').textContent = `${timing.marketDate} · ${timing.decisionWindow}`;
  $('#nextRunRail').textContent = `${timing.nextEligibleMarketDate} · 12:00–12:15 ET`;
  $('#dataRail').textContent = health.marketData.ok ? 'Ready · no fallback' : 'Blocked';
  if (document.activeElement !== $('#tickerInput')) $('#tickerInput').value = settings.ticker || '';
  $('#tickerNote').textContent = settings.ticker
    ? `${settings.tickerName || settings.ticker} is saved${settings.appliesTo === 'next_session' ? '; today’s frozen run is unchanged.' : '.'}`
    : 'Yahoo must verify an active US listing before it is saved.';
  setPill($('#accountStatus'), account.paused ? 'EQUITY PAUSED' : account.openPosition ? 'POSITION OPEN' : 'READY', account.paused ? 'bad' : account.openPosition ? 'warn' : 'good');

  setHealth('storage', health.storage.ok, 'Primary state, recovery copies, and append-only ledger are readable.');
  setHealth('model', health.model.available, health.model.available ? 'OMP available; required model is GPT-5.6-Sol at max reasoning.' : `OMP unavailable: ${health.model.error || 'not found'}`);
  setHealth('market', health.marketData.ok, health.marketData.ok ? 'Yahoo adapter ready; stale or missing bars block a trade.' : health.marketData.failure?.message || 'Market data failure.');
  const task = health.scheduledTask;
  setHealth('task', task?.installed && String(task.wakeToRun).toLowerCase() === 'false', task?.installed
    ? `Installed${task.liveInspection === false ? ' (last verified)' : ''} · wake=${task.wakeToRun} · catch-up=${task.startWhenAvailable} · ${task.multipleInstancesPolicy}`
    : 'Not installed. Run “npm run task:install”.', !task?.installed);

  const run = currentRun;
  setPill($('#runStatus'), run?.status || 'IDLE', run?.status === 'COMPLETE' || run?.status === 'OPEN' ? 'good' : run?.failure ? 'bad' : run ? 'warn' : 'neutral');
  $('#signalTitle').textContent = run ? `${run.symbol || 'No ticker'} · ${run.marketDate}` : settings.ticker ? `${settings.ticker} awaits the decision window` : 'Waiting for a ticker';
  const decision = run?.decision;
  $('#signalAction').textContent = decision?.action || '—';
  $('#signalAction').className = `signal-action ${decision?.action === 'BUY' ? 'buy' : decision?.action === 'SELL' ? 'sell' : 'neutral-signal'}`;
  $('#signalAllocation').textContent = decision ? `${decision.allocationPct}%` : '—';
  $('#signalConfidence').textContent = decision ? `${decision.confidencePct}%` : '—';
  $('#signalFill').textContent = run?.entry?.effectivePrice ? money.format(run.entry.effectivePrice) : '—';
  $('#signalClose').textContent = run?.close?.exitPrice ? money.format(run.close.exitPrice) : run?.status === 'OPEN' ? `Due ${run.session?.end || 'at close'}` : '—';
  $('#signalThesis').textContent = decision?.thesis || run?.failure?.message || 'No decision has been invoked for this market date.';
  renderList($('#evidenceList'), decision?.evidence, 'Frozen Yahoo input will appear here.', (item) => item.claim ? `${item.claim}${item.source ? ` — ${item.source}` : ''}` : String(item));
  renderList($('#riskList'), decision?.risks, 'Every signal is experimental and may lose money.');
  $('#invalidationText').textContent = decision?.invalidation || '—';
}

function td(text, className = '') {
  const cell = document.createElement('td'); cell.textContent = text; if (className) cell.className = className; return cell;
}

function renderOrders() {
  const body = $('#ordersBody'); body.replaceChildren();
  $('#orderCount').textContent = `${view.orders.length} order${view.orders.length === 1 ? '' : 's'}`;
  if (!view.orders.length) {
    const row = document.createElement('tr'); const cell = td('No settled paper orders yet.', 'empty-cell'); cell.colSpan = 11; row.append(cell); body.append(row); return;
  }
  for (const order of view.orders) {
    const row = document.createElement('tr');
    row.append(
      td(order.marketDate), td(order.symbol), td(order.action, order.action === 'BUY' ? 'side-buy' : 'side-sell'),
      td(`${order.allocationPct}%`), td(number.format(order.quantity)), td(money.format(order.entryPrice)), td(money.format(order.exitPrice)),
      td(money.format(order.pnl), order.pnl >= 0 ? 'positive' : 'negative'), td(money.format(order.equityAfter)), td(`${order.confidencePct}%`), td(order.status)
    );
    body.append(row);
  }
}

function inlineCode(parent, text) {
  const parts = text.split(/(`[^`]+`)/g);
  for (const part of parts) {
    if (part.startsWith('`') && part.endsWith('`')) { const code = document.createElement('code'); code.textContent = part.slice(1, -1); parent.append(code); }
    else parent.append(document.createTextNode(part));
  }
}

function renderMarkdown(container, markdown) {
  container.replaceChildren();
  let list = null;
  for (const raw of String(markdown || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { list = null; continue; }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) { list = null; const h = document.createElement(`h${heading[1].length}`); inlineCode(h, heading[2]); container.append(h); continue; }
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet) { if (!list) { list = document.createElement('ul'); container.append(list); } const li = document.createElement('li'); inlineCode(li, bullet[1]); list.append(li); continue; }
    list = null; const p = document.createElement('p'); inlineCode(p, line.replace(/^>\s?/, '')); container.append(p);
  }
}

function renderMemory() {
  if (!view.memory) return;
  renderMarkdown($('#playbookContent'), view.memory.playbook);
  const select = $('#journalSelect'); const previous = select.value; select.replaceChildren();
  if (!view.memory.journals.length) { const option = new Option('No journals', ''); select.add(option); renderMarkdown($('#journalContent'), 'A reflection is written after the first settled paper trade.'); return; }
  for (const journal of view.memory.journals) select.add(new Option(journal.marketDate, journal.marketDate));
  select.value = view.memory.journals.some((journal) => journal.marketDate === previous) ? previous : view.memory.journals[0].marketDate;
  const selected = view.memory.journals.find((journal) => journal.marketDate === select.value);
  renderMarkdown($('#journalContent'), selected?.markdown);
}

async function refresh() {
  if (busy) return;
  const [status, orders, memory] = await Promise.all([api('/api/status'), api('/api/orders'), api('/api/memory')]);
  view = { status, orders: orders.orders, memory };
  renderStatus(); renderOrders(); renderMemory();
}

async function action(label, callback) {
  if (busy) return;
  busy = true; $('#actionNotice').textContent = label;
  document.querySelectorAll('button').forEach((button) => { button.disabled = true; });
  try {
    const result = await callback();
    $('#actionNotice').textContent = typeof result === 'string' ? result : JSON.stringify(result);
    await refreshAfterAction();
  } catch (error) {
    $('#actionNotice').textContent = `Blocked: ${error.message}`;
  } finally {
    busy = false; document.querySelectorAll('button').forEach((button) => { button.disabled = false; });
  }
}

async function refreshAfterAction() {
  const [status, orders, memory] = await Promise.all([api('/api/status'), api('/api/orders'), api('/api/memory')]);
  view = { status, orders: orders.orders, memory }; renderStatus(); renderOrders(); renderMemory();
}

$('#tickerInput').addEventListener('input', (event) => { event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9.-]/g, ''); });
$('#tickerForm').addEventListener('submit', (event) => { event.preventDefault(); action('Verifying ticker through Yahoo…', async () => { const result = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ ticker: $('#tickerInput').value }) }); return `${result.tickerValidation.symbol} verified on ${result.tickerValidation.exchange}.`; }); });
$('#automationToggle').addEventListener('click', () => action('Updating automation state…', async () => { const enabled = !view.status.settings.automationEnabled; await api('/api/settings', { method: 'PUT', body: JSON.stringify({ automationEnabled: enabled }) }); return enabled ? 'Scheduled decisions enabled.' : 'New decisions paused; recovery remains active.'; }));
$('#manualTickButton').addEventListener('click', () => action('Running a time-gated tick…', () => api('/api/tick', { method: 'POST', body: '{}' })));
$('#exportButton').addEventListener('click', () => action('Writing a complete JSON backup…', async () => { const result = await api('/api/export', { method: 'POST', body: '{}' }); return `Backup saved: ${result.filePath} · SHA-256 ${result.sha256}`; }));
$('#newExperimentButton').addEventListener('click', () => { if (confirm('Start a new paper experiment at $100,000? Prior orders, runs, and journals will be preserved.')) action('Starting a new experiment…', async () => { const result = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ startNewExperiment: true, automationEnabled: false }) }); return `New experiment ${result.account.experimentId} started with automation paused.`; }); });
$('#shutdownButton').addEventListener('click', async () => { if (!confirm('Stop only the dashboard server? The scheduled-task setting will remain unchanged.')) return; await api('/api/shutdown', { method: 'POST', body: '{}' }); document.body.replaceChildren(Object.assign(document.createElement('main'), { className: 'shell', textContent: 'AgentTrader dashboard stopped. Scheduled trading was not paused.' })); });
$('#refreshButton').addEventListener('click', () => refresh().catch((error) => { $('#actionNotice').textContent = error.message; }));
$('#journalSelect').addEventListener('change', () => { const selected = view.memory?.journals.find((journal) => journal.marketDate === $('#journalSelect').value); renderMarkdown($('#journalContent'), selected?.markdown); });

refresh().catch((error) => { $('#actionNotice').textContent = `Dashboard load failed: ${error.message}`; });
setInterval(() => refresh().catch(() => {}), 30_000);
