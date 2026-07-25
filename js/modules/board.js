// Progresso module — the streak board (project.md: a section per module file).
//
// Reads day_wins (written by the Tasks module: one row per day the plate was cleared)
// and draws a GitHub-style consistency heatmap plus current / best / total streaks.
// It only reads — nothing here decides what a "win" is; the Tasks module owns that rule.

export default { id: 'board', title: 'Progresso', mount, unmount };

let root = null;
let db = null;
let wins = new Set(); // 'YYYY-MM-DD' of every won day
let loadError = false;
let focusHandler = null;

// ---------- dates (device-local; one user, one timezone) ----------
function iso(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function todayStr() { return iso(new Date()); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
// Parse 'YYYY-MM-DD' as a LOCAL date (new Date(str) would read it as UTC → off-by-one).
function parseLocal(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
// Monday of the week containing d (weeks start Monday, matching the Tasks module).
function mondayOf(d) { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }

// ---------- lifecycle ----------
async function mount(container, ctx) {
  root = container;
  db = ctx.supabase;
  focusHandler = () => refresh();
  window.addEventListener('focus', focusHandler);
  root.addEventListener('click', onClick);
  root.innerHTML = '<p class="empty">A carregar…</p>';
  await refresh();
}

function unmount() {
  window.removeEventListener('focus', focusHandler);
  if (root) {
    root.removeEventListener('click', onClick);
    root.innerHTML = '';
  }
  root = null;
}

async function refresh() {
  const { data, error } = await db.from('day_wins').select('won_on');
  loadError = !!error;
  if (!loadError) wins = new Set((data || []).map((r) => r.won_on));
  render();
}

// ---------- streak maths ----------
function stats() {
  const today = new Date();
  // current streak: alive if today or (not yet today) yesterday is a win, then count back
  let cursor = wins.has(todayStr()) ? today
    : wins.has(iso(addDays(today, -1))) ? addDays(today, -1) : null;
  let current = 0;
  while (cursor && wins.has(iso(cursor))) { current++; cursor = addDays(cursor, -1); }

  // longest run over all won days
  const sorted = [...wins].sort();
  let best = 0, run = 0, prev = null;
  for (const day of sorted) {
    run = (prev && day === iso(addDays(parseLocal(prev), 1))) ? run + 1 : 1;
    if (run > best) best = run;
    prev = day;
  }

  // this calendar month
  const mPrefix = todayStr().slice(0, 7);
  const month = [...wins].filter((d) => d.startsWith(mPrefix)).length;

  return { current, best, total: wins.size, month };
}

// ---------- heatmap (trailing 53 weeks, Monday-start columns) ----------
function heatmapHtml() {
  const today = new Date();
  const todayIso = todayStr();
  const start = mondayOf(addDays(today, -52 * 7)); // 53 columns ending this week
  const end = addDays(mondayOf(today), 6);         // fill to Sunday of the current week

  const columns = [];       // [{ monthLabel, cells: [{iso, state}x7 }]
  const monthName = (m) => ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun',
    'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'][m];
  let lastMonth = -1;

  for (let day = new Date(start); day <= end; ) {
    const cells = [];
    let colMonth = null;
    for (let i = 0; i < 7; i++) {
      const key = iso(day);
      if (colMonth === null) colMonth = day.getMonth();
      let state = 'empty';
      if (key > todayIso) state = 'future';
      else if (wins.has(key)) state = 'won';
      if (key === todayIso) state += ' today';
      cells.push({ key, state });
      day = addDays(day, 1);
    }
    // label the column when its month first appears (like GitHub's month row)
    let label = '';
    if (colMonth !== lastMonth) { label = monthName(colMonth); lastMonth = colMonth; }
    columns.push({ label, cells });
  }

  const cols = columns.length;
  const months = columns.map((c) =>
    `<span class="hm-m">${c.label}</span>`).join('');
  const grid = columns.map((c) => c.cells.map((cell) =>
    `<i class="hm-c ${cell.state}" title="${cell.key}"></i>`).join('')).join('');

  return `<div class="hm-scroll"><div class="hm" style="--cols:${cols}">
    <div class="hm-wd"><span>Seg</span><span>Qua</span><span>Sex</span></div>
    <div class="hm-body">
      <div class="hm-months">${months}</div>
      <div class="hm-grid">${grid}</div>
    </div>
  </div></div>`;
}

// ---------- rendering ----------
function render() {
  if (!root) return;

  if (loadError) {
    root.innerHTML = `<div class="greet"><h1>Progresso</h1></div>
      <div class="hero zen"><div class="title">Não foi possível carregar.</div>
        <div class="sub">Verifica a ligação e volta a tentar.</div>
        <button class="btn" data-act="retry">Tentar de novo</button></div>`;
    return;
  }

  const s = stats();

  if (s.total === 0) {
    root.innerHTML = `<div class="greet"><h1>Progresso</h1>
        <div class="date">O teu quadro de constância</div></div>
      <div class="hero zen"><div class="title">O quadro ainda está vazio.</div>
        <div class="sub">Fecha o dia com tudo feito e o primeiro quadrado acende-se aqui.</div></div>`;
    return;
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const flame = s.current > 0 ? ' 🔥' : '';

  root.innerHTML = `
    <div class="greet">
      <h1>Progresso</h1>
      <div class="date">Os dias em que fechaste tudo</div>
    </div>

    <div class="stats">
      <div class="stat">
        <div class="stat-n">${s.current}${flame}</div>
        <div class="stat-l">dias seguidos</div>
      </div>
      <div class="stat">
        <div class="stat-n">${s.best}</div>
        <div class="stat-l">melhor sequência</div>
      </div>
      <div class="stat">
        <div class="stat-n">${s.total}</div>
        <div class="stat-l">${s.total === 1 ? 'dia no total' : 'dias no total'}</div>
      </div>
    </div>

    <div class="kicker">Último ano</div>
    ${heatmapHtml()}
    <div class="hm-legend">
      <span>${plural(s.month, 'dia', 'dias')} este mês</span>
      <span class="hm-key"><i class="hm-c empty"></i><i class="hm-c won"></i> aceso = dia fechado</span>
    </div>
  `;

  // start scrolled to the most recent weeks — that's where the action is
  const sc = root.querySelector('.hm-scroll');
  if (sc) sc.scrollLeft = sc.scrollWidth;
}

// ---------- events ----------
function onClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn || !root.contains(btn)) return;
  if (btn.dataset.act === 'retry') refresh();
}
