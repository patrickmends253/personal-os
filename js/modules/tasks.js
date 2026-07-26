// Tasks module — the merged Today + Tasks screen (project.md §8):
// a single-focus "A seguir" card on top, the full flat priority list below.
//
// Data model:
//   tasks(cadence: daily|weekly|once, quota, due_date, position, completed_at)
//   subtasks(task_id, for_date, done)  — daily blocks get a fresh dated list each day
//   task_completions(task_id, done_on) — one per day max; weekly progress = count this week
//
// Rules (all decided in project.md §7/§8):
//   daily+subtasks → done today when all of today's subtasks are done (adding one reopens it)
//   daily plain    → checkbox toggles today's completion
//   weekly (quota) → tap = +1 today (max 1/day, tap again to undo); done for week at quota
//   once           → checkbox toggles completed_at; dated ones surface on their day;
//                    undated = "quando puder" backlog
//   done items grey out and sink to the bottom ("Feitas hoje"); week resets Monday.

export default { id: 'tasks', title: 'Hoje', mount, unmount };

let root = null;
let db = null;
let uid = null;

let tasks = [];
let subs = [];
let comps = [];
let cats = [];
let expandedId = null;
let subTarget = 'today'; // which day tab: 'today' | 'tomorrow' | 'none'
let catSel = null;       // selected category chip: filters the list AND tags new subtasks
let pageId = null;       // open task page, or null for the Today list
let days = [];           // task_days rows for the open page's board
let loadError = false;

// Fixed palette — mid-tone on purpose so a dot reads on both the dark and the paper themes.
const CAT_COLORS = ['#F5A524', '#4ADE80', '#60A5FA', '#F472B6', '#A78BFA', '#2DD4BF'];

// The app is deployed by pushing a file, so it can go live before the SQL migration is
// run. These flags let it notice the new tables are missing and simply do without them —
// categories hide, history stops recording — instead of breaking adding a subtask.
let catsOk = true;
let daysOk = true;
let planOk = true;
let todayWon = null;     // does today have a day_wins row? (Progresso board reads it) — null until loaded

const NEST_HOLD_MS = 400; // hold this long over a row before it becomes a nest target
let drag = null;        // active drag gesture (see startDrag)
let dragEndedAt = 0;    // so the click after a drag doesn't expand a row
let toastTimer = null;

let focusHandler = null;

// ---------- dates (device-local; one user, one timezone) ----------
function iso(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function todayStr() { return iso(new Date()); }
function tomorrowStr() { const d = new Date(); d.setDate(d.getDate() + 1); return iso(d); }
function daysAgoStr(n) { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); }
function mondayStr() {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return iso(d);
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- saving ----------
// A Supabase query builder is LAZY: the request is only sent when the builder is
// awaited (fetch lives inside its .then()). A fire-and-forget `db.from(...).delete()`
// therefore does nothing at all — which is why deleted rows used to come back on the
// next refresh. Every write goes through here so it is both sent and checked.
async function save(query) {
  const { error } = await query;
  if (!error) return true;
  console.error('[tasks] write failed', error);
  toast('Não foi possível guardar. Tenta de novo.');
  await refresh();
  return false;
}

function toast(msg) {
  let el = document.getElementById('pos-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'pos-toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  requestAnimationFrame(() => el.classList.add('on'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2800);
}

// ---------- lifecycle ----------
async function mount(container, ctx) {
  root = container;
  db = ctx.supabase;
  uid = ctx.session.user.id;
  expandedId = null;
  pageId = null; days = [];
  focusHandler = () => { if (!drag) refresh(); };
  window.addEventListener('focus', focusHandler);
  root.addEventListener('click', onClick);
  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('keydown', onKeyDown);
  root.innerHTML = '<p class="empty">A carregar…</p>';
  await refresh();
}

function unmount() {
  endDrag(true);
  document.getElementById('pos-toast')?.remove();
  window.removeEventListener('focus', focusHandler);
  if (root) {
    root.removeEventListener('click', onClick);
    root.removeEventListener('pointerdown', onPointerDown);
    root.removeEventListener('keydown', onKeyDown);
    root.innerHTML = '';
  }
  root = null;
}

async function refresh() {
  const today = todayStr();
  const [t, s, c, w, g] = await Promise.all([
    db.from('tasks').select('*').order('position').order('created_at'),
    // Undated ones are the task's backlog ("quando puder"); dated ones from the last two
    // weeks cover today, tomorrow, anything planned ahead, and recent leftovers.
    db.from('subtasks').select('*')
      .or(`for_date.is.null,for_date.gte.${daysAgoStr(14)}`)
      .order('position').order('created_at'),
    db.from('task_completions').select('*').gte('done_on', mondayStr()),
    db.from('day_wins').select('won_on').eq('won_on', today).maybeSingle(),
    db.from('categories').select('*').order('position').order('created_at'),
  ]);
  loadError = !!(t.error || s.error || c.error);
  if (!loadError) {
    tasks = t.data;
    subs = s.data;
    comps = c.data;
    // the planning columns are absent until that migration is run: without them, keep the
    // old behaviour (every weekly routine on the Today list) rather than half a feature
    planOk = t.data.length === 0 || 'planned_for' in t.data[0];
    catsOk = !g.error;    // false until the categories migration is run — not fatal
    cats = g.data || [];
    todayWon = !!w.data;  // a missing row (not an error) means today isn't won yet
  }
  render();
}

// Records how much of today's plan got done, per task, so each task's page can draw a
// green/orange/red board later. Stores the RAW NUMBERS (done/total) rather than a colour:
// where the thresholds sit is a rendering decision, and this way it can be changed later
// without losing history. A task with no plan and no tick writes nothing (that day stays
// blank rather than counting as a failure).
async function recordDay(t) {
  if (!t || loadError || !daysOk) return;
  const plan = subsFor(t, todayStr());
  const done = plan.length ? plan.filter((s) => s.done).length : (status(t).doneToday ? 1 : 0);
  const total = plan.length || 1;
  // No plan and nothing done — he ticked it and changed his mind. Clear the day back to
  // blank instead of leaving a stale square (a planned-but-undone day still records 0/N,
  // which is the red case; an untouched day should record nothing at all).
  const clear = !plan.length && !done;

  // Keep the open page's board in step, so today's square reacts as he ticks.
  if (pageId === t.id) {
    const i = days.findIndex((d) => d.day === todayStr());
    if (clear) { if (i >= 0) days.splice(i, 1); }
    else if (i >= 0) Object.assign(days[i], { done, total });
    else days.push({ task_id: t.id, day: todayStr(), done, total });
    render();
  }

  // Recording is a background nicety: never nag him about it, just stop trying.
  const { error } = clear
    ? await db.from('task_days').delete().eq('task_id', t.id).eq('day', todayStr())
    : await db.from('task_days').upsert(
        { user_id: uid, task_id: t.id, day: todayStr(), done, total },
        { onConflict: 'user_id,task_id,day' });
  if (error) { daysOk = false; console.warn('[tasks] histórico desligado (falta a migração?)', error); }
}

// A day counts as "won" when the plate ends the day cleared AND something was actually
// done today — so the Progresso heatmap only lights up days you truly closed out. We keep
// today's row in sync as tasks are checked/reopened; earlier days are never touched here.
async function maintainDayWin() {
  if (loadError || !db || todayWon === null) return;
  const { open, done } = visibleLists();
  const desired = tasks.length > 0 && open.length === 0 && done.length > 0;
  if (desired === todayWon) return;
  todayWon = desired; // optimistic: flip first so re-renders don't re-fire the write
  if (desired) {
    await db.from('day_wins')
      .upsert({ user_id: uid, won_on: todayStr() }, { onConflict: 'user_id,won_on', ignoreDuplicates: true });
  } else {
    await db.from('day_wins').delete().eq('won_on', todayStr());
  }
}

// ---------- derived state ----------
function subsFor(task, date) {
  if (task.cadence === 'once') return subs.filter((s) => s.task_id === task.id && !s.for_date);
  return subs.filter((s) => s.task_id === task.id && s.for_date === date);
}
function weekCount(task) { return comps.filter((c) => c.task_id === task.id).length; }
function compToday(task) { return comps.some((c) => c.task_id === task.id && c.done_on === todayStr()); }

function status(t) {
  const today = todayStr();
  const st = { block: false, doneToday: false, hidden: false, prog: null, count: 0 };
  const mySubs = subsFor(t, today);

  // Any task can be a block now — a block is simply "has a plan for today".
  if (mySubs.length > 0) {
    st.block = true;
    const done = mySubs.filter((s) => s.done).length;
    st.prog = { done, total: mySubs.length };
  }

  if (t.cadence === 'daily') {
    st.doneToday = st.block ? st.prog.done === st.prog.total : compToday(t);
  } else if (t.cadence === 'weekly') {
    st.count = weekCount(t);
    // With a plan for today, finishing the plan is what counts as today's session;
    // maintainWeeklyBlock() writes the matching completion row so the quota advances.
    st.doneToday = st.block ? st.prog.done === st.prog.total : compToday(t);
    // met earlier in the week → rest, unless he has deliberately planned today
    st.hidden = st.count >= (t.quota || 1) && !st.doneToday && !st.block;
  } else { // once
    if (t.completed_at) {
      st.doneToday = iso(new Date(t.completed_at)) === today;
      st.hidden = !st.doneToday; // completed on an earlier day → archived
    } else if (t.due_date && t.due_date > today) {
      st.hidden = true; // surfaces on its day
    }
  }
  return st;
}

// Is this task part of *today*, or is it just available this week? Dailies and one-offs are
// always today's business. A weekly routine is only today's if he chose it the night before,
// already planned steps for it, or has started it — otherwise it drops to "Esta semana"
// below, still visible and tickable all day (his design, 2026-07-26).
function isForToday(t) {
  if (!planOk || t.cadence !== 'weekly') return true;
  return t.planned_for === todayStr()
    || subsFor(t, todayStr()).length > 0
    || compToday(t);
}

function visibleLists() {
  const open = [];
  const later = [];
  const done = [];
  for (const t of tasks) {
    const st = status(t);
    if (st.hidden) continue;
    if (st.doneToday) done.push({ t, st });
    else (isForToday(t) ? open : later).push({ t, st });
  }
  return { open, later, done };
}

// ---------- rendering ----------
function heroHtml(open, later = []) {
  if (loadError) {
    return `<div class="hero zen"><div class="title">Não foi possível carregar.</div>
      <div class="sub">Verifica a ligação e volta a tentar.</div>
      <button class="btn" data-act="retry">Tentar de novo</button></div>`;
  }
  if (tasks.length === 0) {
    return `<div class="hero zen"><div class="title">Sem tarefas ainda.</div>
      <div class="sub">Toca em + e cria a primeira.</div></div>`;
  }
  if (open.length === 0) {
    // Nothing chosen for today isn't the same as nothing left to do — don't say "all done"
    // when there are still weekly routines sitting below waiting to be picked up.
    return later.length
      ? `<div class="hero zen"><div class="title">Nada escolhido para hoje.</div>
          <div class="sub">Há ${later.length} ${later.length === 1 ? 'coisa' : 'coisas'} desta semana aqui em baixo, se te apetecer.</div></div>`
      : `<div class="hero zen"><div class="title">Tudo feito por hoje.</div>
          <div class="sub">Descansa — ou adiciona o que vier.</div></div>`;
  }

  const { t, st } = open[0];
  if (st.block) {
    const next = subsFor(t, todayStr()).find((s) => !s.done);
    const pct = Math.round((st.prog.done / st.prog.total) * 100);
    const c = catOf(next);
    return `<div class="hero">
      <div class="title">${c ? `<i class="herodot" style="background:${c.color}"></i>` : ''}${esc(next.title)}</div>
      <div class="sub">Parte de: ${esc(t.title)} · ${st.prog.done + 1} de ${st.prog.total}${t.cadence === 'once' ? '' : ' hoje'}</div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <button class="btn" data-act="hero-done" data-id="${t.id}" data-sub="${next.id}">Concluir</button>
    </div>`;
  }
  let sub = '';
  if (t.cadence === 'weekly') sub = `${st.count} de ${t.quota} esta semana`;
  else if (t.cadence === 'daily') sub = 'Diária';
  else if (t.due_date) sub = t.due_date < todayStr() ? 'Em atraso' : 'Para hoje';
  else sub = 'Quando puder';
  const bar = t.cadence === 'weekly' && t.quota > 1
    ? `<div class="bar"><i style="width:${Math.round((st.count / t.quota) * 100)}%"></i></div>` : '';
  return `<div class="hero">
    <div class="title">${esc(t.title)}</div>
    <div class="sub">${sub}</div>${bar}
    <button class="btn" data-act="hero-done" data-id="${t.id}">Concluir</button>
  </div>`;
}

function rowMeta(t, st) {
  const bits = [];
  if (st.block) {
    const pct = Math.round((st.prog.done / st.prog.total) * 100);
    bits.push(`<span class="minibar"><i style="width:${pct}%"></i></span>
      <span>${st.prog.done}/${st.prog.total}${t.cadence === 'once' ? '' : ' hoje'}</span>`);
    // a weekly block still needs its week counter alongside today's plan
    if (t.cadence === 'weekly') bits.push(`<span class="tag">${st.count}/${t.quota || 1} sem.</span>`);
  } else if (t.cadence === 'weekly') {
    if ((t.quota || 1) > 1) {
      const pct = Math.round((st.count / t.quota) * 100);
      bits.push(`<span class="minibar"><i style="width:${pct}%"></i></span><span>${st.count}/${t.quota} sem.</span>`);
    } else {
      bits.push('<span class="tag">1×/sem.</span>');
    }
  } else if (t.cadence === 'once') {
    if (t.due_date) {
      if (!t.completed_at && t.due_date < todayStr()) bits.push('<span class="tag late">em atraso</span>');
      else if (t.due_date === todayStr()) bits.push('<span class="tag">hoje</span>');
    } else {
      bits.push('<span class="tag">quando puder</span>');
    }
  }
  return bits.length ? `<span class="tsub">${bits.join('')}</span>` : '';
}

// Hoje / Amanhã / Quando puder are three SEPARATE lists, not sections of one list: the
// tab you are on is both what you see and where a new subtask lands. A one-off task has
// no days at all, so it keeps a single flat checklist and shows no tabs.
const SUB_TABS = [['today', 'Hoje'], ['tomorrow', 'Amanhã'], ['none', 'Quando puder']];

function subBucket(t, tab) {
  const today = todayStr();
  const mine = subs.filter((s) => s.task_id === t.id);
  if (t.cadence === 'once') return mine;
  if (tab === 'none') return mine.filter((s) => !s.for_date);
  if (tab === 'tomorrow') return mine.filter((s) => s.for_date > today);
  return mine.filter((s) => s.for_date === today);
}

// Planned for a past day and never done. Kept out of the tabs (they belong to no day any
// more) but shown under today's list, because that is where he would act on them — §8
// says leftovers must not silently roll into today, but they must not vanish either.
function subLeftovers(t) {
  if (t.cadence === 'once') return [];
  return subs.filter((s) => s.task_id === t.id && s.for_date && s.for_date < todayStr() && !s.done);
}

// Categories belong to one task (his call, 2026-07-27): "Personal OS" means something on
// Claude 1h and nothing on Exercício físico, so each task keeps its own list.
function catsFor(taskId) { return cats.filter((c) => c.task_id === taskId); }
function catOf(s) { return cats.find((c) => c.id === s.category_id) || null; }

function subLine(s, { check = true, move = false, day = '' } = {}) {
  const c = catOf(s);
  // the dot doubles as the control: tapping it cycles the step through the categories
  const dot = catsFor(s.task_id).length
    ? `<button class="catdot" data-act="cycle-cat" data-id="${s.id}"
         style="${c ? `background:${c.color};border-color:${c.color}` : ''}"
         title="${c ? esc(c.name) : 'Sem categoria'}"></button>`
    : '';
  return `<div class="subrow ${s.done ? 'sdone' : ''}">
    ${check
      ? `<button class="cb ${s.done ? 'on' : ''}" data-act="toggle-sub" data-id="${s.id}">✓</button>`
      : ''}
    ${dot}
    <span class="st"${check ? '' : ' style="color:var(--muted)"'}>${esc(s.title)}</span>
    ${day ? `<span class="tag">${day}</span>` : ''}
    ${move ? `<button class="xbtn move" data-act="sub-to-today" data-id="${s.id}" title="Trazer para hoje">↑ hoje</button>` : ''}
    <button class="xbtn" data-act="del-sub" data-id="${s.id}">×</button>
  </div>`;
}

function expandHtml(t, st) {
  const tabbed = t.cadence !== 'once';
  const tab = tabbed ? subTarget : 'today';
  const list = subBucket(t, tab);
  // anything dated past tomorrow keeps its day visible inside the Amanhã tab
  const dayOf = (s) => tab === 'tomorrow' && s.for_date !== tomorrowStr()
    ? new Date(s.for_date + 'T00:00:00').toLocaleDateString('pt-PT', { day: 'numeric', month: 'short' })
    : '';

  let h = '<div class="expand">';
  if (tabbed) {
    h += `<div class="pills subwhen">
      ${SUB_TABS.map(([v, label]) => {
        const n = subBucket(t, v).length;
        return `<button class="pill ${tab === v ? 'on' : ''}" data-act="sub-target" data-v="${v}">${label}${n ? ` <b>${n}</b>` : ''}</button>`;
      }).join('')}
    </div>`;
  }

  // Category chips work like the day tabs: the selected one filters the list AND is what a
  // new step gets tagged with. "Todas" selected = show everything, tag nothing.
  // Long-press a chip to rename it, recolour it or delete it.
  const mine = catsFor(t.id);
  if (catsOk) h += `<div class="pills cats">
    ${mine.length ? `<button class="pill ${catSel === null ? 'on' : ''}" data-act="cat-sel" data-v="">Todas</button>` : ''}
    ${mine.map((c) => `<button class="pill cat ${catSel === c.id ? 'on' : ''}" data-act="cat-sel" data-v="${c.id}"
        style="${catSel === c.id ? `border-color:${c.color};color:${c.color}` : ''}">
        <i style="background:${c.color}"></i>${esc(c.name)}</button>`).join('')}
    <button class="pill" data-act="cat-new" data-id="${t.id}" title="Nova categoria">+ categoria</button>
  </div>`;

  const shown = catSel === null ? list : list.filter((s) => s.category_id === catSel);
  h += shown.length
    ? shown.map((s) => subLine(s, { check: tab === 'today', move: tabbed && tab !== 'today', day: dayOf(s) })).join('')
    : `<div class="subempty">${
        catSel !== null ? 'Nada nesta categoria.'
        : !tabbed ? 'Sem passos ainda.'
        : tab === 'today' ? 'Nada planeado para hoje.'
        : tab === 'tomorrow' ? 'Nada para amanhã.' : 'Nada na lista.'}</div>`;

  if (tab === 'today') {
    const left = subLeftovers(t);
    if (left.length) {
      h += `<div class="subhead">Por acabar de dias anteriores</div>`;
      h += left.map((s) => subLine(s, { check: false, move: true })).join('');
    }
  }

  h += `<div class="addsub">
    <input class="field" id="addsub-input" placeholder="${
      !tabbed ? 'Novo passo…'
      : tab === 'today' ? 'Nova subtarefa para hoje…'
      : tab === 'tomorrow' ? 'Nova subtarefa para amanhã…' : 'Nova subtarefa, quando puder…'}" autocomplete="off">
    <button class="pill on" data-act="add-sub" data-id="${t.id}">+</button>
  </div>`;
  h += `<div class="rowactions">
    <button class="ghostbtn" data-act="rename" data-id="${t.id}">Mudar nome</button>
    ${t.cadence === 'once' ? `<button class="ghostbtn" data-act="redate" data-id="${t.id}">Mudar data</button>` : ''}
    <button class="ghostbtn danger" data-act="del-task" data-id="${t.id}">Apagar</button>
  </div></div>`;
  return h;
}

function rowHtml({ t, st }, isDone, isLater) {
  const cbOn = isDone || st.doneToday;
  return `<div class="row ${isDone ? 'done-row' : ''}" data-id="${t.id}">
    <div class="rowline">
      <button class="cb ${cbOn ? 'on' : ''}" data-act="${st.block ? 'expand' : 'toggle-task'}" data-id="${t.id}">✓</button>
      <button class="tmain" data-act="expand" data-id="${t.id}">
        <div class="tt">${esc(t.title)}</div>${rowMeta(t, st)}
      </button>
      ${isLater ? `<button class="xbtn move" data-act="plan-today" data-id="${t.id}">↑ hoje</button>` : ''}
      ${hasPage(t) ? `<button class="pagebtn" data-act="open-page" data-id="${t.id}" title="Abrir a página">›</button>` : ''}
      ${!isDone && !isLater ? `<button class="handle" data-id="${t.id}">≡</button>` : ''}
    </div>
    ${expandedId === t.id ? expandHtml(t, st) : ''}
  </div>`;
}

// ---------- a task's own page ----------
// Every recurring task gets one; a one-off has nothing worth a page (no cadence, no
// history, and its steps are already the whole task). Reached with the › on its row.
function hasPage(t) { return t.cadence === 'daily' || t.cadence === 'weekly'; }

async function openPage(id) {
  pageId = id;
  days = [];
  expandedId = null; subTarget = 'today'; catSel = null;
  render();
  window.scrollTo(0, 0);
  if (!daysOk) return;
  const { data, error } = await db.from('task_days').select('*')
    .eq('task_id', id).gte('day', daysAgoStr(371));
  if (error) { daysOk = false; console.warn('[tasks] histórico indisponível', error); }
  else days = data;
  render();
}

function closePage() { pageId = null; days = []; render(); }

// Green = the whole plan done, orange = part of it, red = planned and did none,
// blank = never touched that day (his call, 2026-07-26: same rule for every cadence —
// a quiet day is just a quiet day, he'll notice it himself).
function dayState(d) {
  if (!d || d.total === 0) return '';
  if (d.done >= d.total) return 'won';
  return d.done > 0 ? 'half' : 'miss';
}

function taskBoardHtml() {
  const byDay = new Map(days.map((d) => [d.day, d]));
  const todayIso = todayStr();
  const MONTHS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  const add = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

  const today = new Date();
  const monday = (d) => { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
  const start = monday(add(today, -25 * 7)); // ~6 months, enough to see a habit forming
  const end = add(monday(today), 6);

  const columns = [];
  let lastMonth = -1;
  for (let day = new Date(start); day <= end; ) {
    const cells = [];
    let colMonth = null;
    for (let i = 0; i < 7; i++) {
      const key = iso(day);
      if (colMonth === null) colMonth = day.getMonth();
      let state = key > todayIso ? 'future' : dayState(byDay.get(key));
      if (key === todayIso) state += ' today';
      const d = byDay.get(key);
      cells.push(`<i class="hm-c ${state}" title="${key}${d ? ` · ${d.done}/${d.total}` : ''}"></i>`);
      day = add(day, 1);
    }
    const label = colMonth !== lastMonth ? MONTHS[colMonth] : '';
    lastMonth = colMonth;
    columns.push({ label, cells: cells.join('') });
  }

  const recent = [...byDay.values()].filter((d) => d.day > iso(add(today, -30)));
  const greens = recent.filter((d) => dayState(d) === 'won').length;

  return `<div class="taskboard">
    <div class="hm-scroll"><div class="hm" style="--cols:${columns.length}">
      <div class="hm-wd"><span>Seg</span><span>Qua</span><span>Sex</span></div>
      <div class="hm-body">
        <div class="hm-months">${columns.map((c) => `<span class="hm-m">${c.label}</span>`).join('')}</div>
        <div class="hm-grid">${columns.map((c) => c.cells).join('')}</div>
      </div>
    </div></div>
    <div class="hm-legend">
      <span>${greens} ${greens === 1 ? 'dia completo' : 'dias completos'} nos últimos 30</span>
      <span class="hm-key">
        <i class="hm-c"></i><i class="hm-c miss"></i><i class="hm-c half"></i><i class="hm-c won"></i>
      </span>
    </div>
  </div>`;
}

// ---------- the planning page ----------
// This is the page of his "Planear o dia seguinte" task (flagged is_planner, so renaming
// it can't break anything). Picking a routine here sets planned_for = tomorrow, which is
// what puts it in tomorrow's "Hoje" list instead of down in "Esta semana".
function plannerHtml(t) {
  const tmr = tomorrowStr();
  const routines = tasks.filter((x) => x.cadence === 'weekly' && !x.is_planner);
  const chosen = routines.filter((x) => x.planned_for === tmr);
  const dated = tasks.filter((x) => x.cadence === 'once' && !x.completed_at && x.due_date === tmr);
  const label = new Date(tmr + 'T00:00:00').toLocaleDateString('pt-PT', { weekday: 'long', day: 'numeric', month: 'long' });

  const line = (x) => {
    const planned = x.planned_for === tmr;
    const steps = subs.filter((s) => s.task_id === x.id && s.for_date === tmr).length;
    return `<button class="planrow ${planned ? 'on' : ''}" data-act="plan-toggle" data-id="${x.id}">
      <span class="cb ${planned ? 'on' : ''}">✓</span>
      <span class="st">${esc(x.title)}</span>
      ${steps ? `<span class="tag">${steps} ${steps === 1 ? 'passo' : 'passos'}</span>` : ''}
      <span class="tag">${weekCount(x)}/${x.quota || 1} sem.</span>
    </button>`;
  };

  return `
    <div class="pagehead">
      <button class="backbtn" data-act="close-page">‹</button>
      <div>
        <h1>Amanhã</h1>
        <div class="date">${label.charAt(0).toUpperCase() + label.slice(1)}</div>
      </div>
    </div>

    <div class="kicker">O que queres fazer</div>
    <div class="hint" style="margin:-4px 0 10px">O que escolheres abre o dia amanhã. O resto fica em "Esta semana", à mão.</div>
    <div class="planlist">${routines.map(line).join('') || '<p class="empty">Sem rotinas semanais.</p>'}</div>

    <div class="kicker plain">Só para amanhã</div>
    <div class="addsub">
      <input class="field" id="newtmr-input" placeholder="Algo pontual para amanhã…" autocomplete="off">
      <button class="pill on" data-act="add-tomorrow">+</button>
    </div>
    ${dated.length ? `<div class="rows">${dated.map((x) => `
      <div class="subrow"><span class="st">${esc(x.title)}</span>
        <button class="xbtn" data-act="del-task-quiet" data-id="${x.id}">×</button></div>`).join('')}</div>` : ''}

    <div class="kicker plain">Resumo</div>
    <p class="empty">${chosen.length + dated.length === 0
      ? 'Ainda não escolheste nada. Amanhã abre só com as diárias.'
      : `Amanhã abre com as diárias${chosen.length ? ` + ${chosen.length} ${chosen.length === 1 ? 'rotina' : 'rotinas'}` : ''}${dated.length ? ` + ${dated.length} ${dated.length === 1 ? 'tarefa pontual' : 'tarefas pontuais'}` : ''}.`}</p>
    <p class="hint">Para preparar os passos de um bloco (Etsy, Claude…), abre a página dele e usa a pastilha <b>Amanhã</b>.</p>
  `;
}

function pageHtml(t) {
  if (t.is_planner && planOk) return plannerHtml(t);
  const st = status(t);
  let sub = t.cadence === 'daily' ? 'Todos os dias'
    : (t.quota || 1) > 1 ? `${st.count} de ${t.quota} esta semana` : '1× por semana';
  if (st.block) sub += ` · ${st.prog.done}/${st.prog.total} hoje`;

  return `
    <div class="pagehead">
      <button class="backbtn" data-act="close-page">‹</button>
      <div>
        <h1>${esc(t.title)}</h1>
        <div class="date">${sub}</div>
      </div>
    </div>
    <div class="kicker">Passos</div>
    <div class="pagepanel">${expandHtml(t, st)}</div>
    <div class="kicker plain">Constância</div>
    ${daysOk ? taskBoardHtml()
      : '<p class="empty">O histórico ainda não está ligado — falta correr a migração no Supabase.</p>'}
  `;
}

function render() {
  if (!root || drag) return; // never rebuild the DOM under a finger mid-drag

  if (pageId) {
    const t = tasks.find((x) => x.id === pageId);
    if (!t) { pageId = null; }           // deleted from under us
    else { root.innerHTML = pageHtml(t); return; }
  }

  const { open, later, done } = visibleLists();
  const h = new Date().getHours();
  const greet = h < 12 ? 'Bom dia.' : h < 20 ? 'Boa tarde.' : 'Boa noite.';
  const dateStr = new Date().toLocaleDateString('pt-PT', { weekday: 'long', day: 'numeric', month: 'long' });
  const counts = tasks.length && !loadError
    ? `<div class="counts">${open.length} por fazer · ${done.length} ${done.length === 1 ? 'feita' : 'feitas'} hoje</div>` : '';

  root.innerHTML = `
    <div class="greet">
      <h1>${greet}</h1>
      <div class="date">${dateStr.charAt(0).toUpperCase() + dateStr.slice(1)}</div>
      ${counts}
    </div>
    <div class="kicker">A seguir</div>
    ${heroHtml(open, later)}
    ${open.length
      ? `<div class="kicker plain">Hoje</div>
         <div class="rows" id="open-rows">${open.map((x) => rowHtml(x, false)).join('')}</div>` : ''}
    ${later.length
      ? `<div class="kicker plain">Esta semana</div>
         <div class="hint" style="margin:-4px 0 8px">Não escolheste para hoje — mas estão aqui se te apetecer.</div>
         <div class="rows later">${later.map((x) => rowHtml(x, false, true)).join('')}</div>` : ''}
    ${done.length
      ? `<div class="kicker plain">Feitas hoje</div>
         <div class="rows">${done.map((x) => rowHtml(x, true)).join('')}</div>` : ''}
    <button class="fab" data-act="sheet">+</button>
  `;
  maintainDayWin(); // fire-and-forget; only writes when today's win state actually changes
}

// ---------- data actions ----------
async function toggleTask(t) {
  const today = todayStr();
  if (t.cadence === 'once') {
    const v = t.completed_at ? null : new Date().toISOString();
    t.completed_at = v; render();
    await save(db.from('tasks').update({ completed_at: v }).eq('id', t.id));
  } else {
    const existing = comps.find((c) => c.task_id === t.id && c.done_on === today);
    if (existing) {
      comps = comps.filter((c) => c !== existing); render();
      await save(db.from('task_completions').delete().eq('id', existing.id));
    } else {
      const row = { user_id: uid, task_id: t.id, done_on: today };
      comps.push(row); render();
      const { data, error } = await db.from('task_completions').insert(row).select().single();
      if (error) { toast('Não foi possível guardar. Tenta de novo.'); await refresh(); }
      else if (data) Object.assign(row, data);
    }
  }
  await recordDay(t); // plain tick, no plan — still worth a square on the board
}

async function toggleSub(id) {
  const s = subs.find((x) => x.id === id);
  s.done = !s.done; render();
  await save(db.from('subtasks').update({ done: s.done }).eq('id', id));
  await syncBlock(tasks.find((x) => x.id === s.task_id));
}

// A block's plan is the source of truth for whether it is done. Once the plan is complete
// we record that: a one-off task gets its completed_at, a weekly task gets a completion row
// for today (which is what the n/5 quota and the history are counted from). Daily tasks
// need nothing stored — status() reads the plan directly.
async function syncBlock(t) {
  if (!t) return;
  const mine = subsFor(t, todayStr());
  await recordDay(t);
  if (mine.length === 0) return;
  const allDone = mine.every((x) => x.done);

  if (t.cadence === 'once') {
    const v = allDone ? (t.completed_at || new Date().toISOString()) : null;
    if ((t.completed_at || null) === v) return;
    t.completed_at = v; render();
    await save(db.from('tasks').update({ completed_at: v }).eq('id', t.id));
    return;
  }
  if (t.cadence !== 'weekly') return;

  const existing = comps.find((c) => c.task_id === t.id && c.done_on === todayStr());
  if (allDone && !existing) {
    const row = { user_id: uid, task_id: t.id, done_on: todayStr() };
    comps.push(row); render();
    const { data, error } = await db.from('task_completions').insert(row).select().single();
    if (error) { toast('Não foi possível guardar. Tenta de novo.'); await refresh(); }
    else if (data) Object.assign(row, data);
  } else if (!allDone && existing) {
    comps = comps.filter((c) => c !== existing); render();
    if (existing.id) await save(db.from('task_completions').delete().eq('id', existing.id));
  }
}

async function addSub(taskId, title, target = subTarget) {
  const t = tasks.find((x) => x.id === taskId);
  const for_date = t.cadence === 'once' || target === 'none' ? null
    : target === 'tomorrow' ? tomorrowStr()
    : todayStr();
  const position = subs.filter((s) => s.task_id === taskId).length;
  const row = { user_id: uid, task_id: taskId, title, for_date, position };
  if (catsOk) row.category_id = catSel; // the column only exists after the migration
  const { data, error } = await db.from('subtasks').insert(row).select().single();
  if (error) { toast('Não foi possível guardar. Tenta de novo.'); await refresh(); return null; }
  subs.push(data);
  render();
  // adding an unfinished step reopens a block that had been completed
  await syncBlock(t);
  return data;
}

// ---------- categories ----------
// A new one picks the first colour this task isn't already using, so two categories on the
// same task never look alike without him having to think about it.
function nextColor(taskId) {
  const used = new Set(catsFor(taskId).map((c) => c.color));
  return CAT_COLORS.find((c) => !used.has(c)) || CAT_COLORS[catsFor(taskId).length % CAT_COLORS.length];
}

async function newCat(taskId) {
  const name = prompt('Nome da nova categoria:');
  if (!name || !name.trim()) return;
  const { data, error } = await db.from('categories').insert({
    user_id: uid, task_id: taskId, name: name.trim(),
    color: nextColor(taskId), position: catsFor(taskId).length,
  }).select().single();
  if (error) { toast('Não foi possível criar a categoria.'); return; }
  cats.push(data);
  catSel = data.id; // land on the new one, so the next step he adds gets tagged with it
  render();
}

async function delCat(id) {
  const c = cats.find((x) => x.id === id);
  if (!c || !confirm(`Apagar a categoria "${c.name}"?\n\nAs subtarefas ficam sem categoria, não são apagadas.`)) return;
  cats = cats.filter((x) => x.id !== id);
  subs.forEach((s) => { if (s.category_id === id) s.category_id = null; });
  catSel = null;
  render();
  await save(db.from('categories').delete().eq('id', id));
}

// Long-press a chip: rename, recolour, or delete. Kept off the normal tap so the chip's
// main job (filter + tag) stays a single quick touch.
function editCat(id) {
  const c = cats.find((x) => x.id === id);
  if (!c) return;
  let color = c.color;
  const wrapEl = document.createElement('div');
  wrapEl.className = 'sheetwrap';
  wrapEl.innerHTML = `<div class="sheet">
    <h2>Categoria</h2>
    <input class="field" id="cat-name" autocomplete="off" value="${esc(c.name)}">
    <div class="swatches">
      ${CAT_COLORS.map((col) => `<button class="swatch ${col === color ? 'on' : ''}"
        data-col="${col}" style="background:${col}"></button>`).join('')}
    </div>
    <button class="btn" id="cat-save">Guardar</button>
    <button class="ghostbtn danger" id="cat-remove">Apagar categoria</button>
  </div>`;
  root.appendChild(wrapEl);
  wrapEl.querySelector('#cat-name').focus();

  wrapEl.addEventListener('click', async (e) => {
    if (e.target === wrapEl) return wrapEl.remove();
    const sw = e.target.closest('[data-col]');
    if (sw) {
      color = sw.dataset.col;
      wrapEl.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('on', s.dataset.col === color));
      return;
    }
    if (e.target.id === 'cat-remove') { wrapEl.remove(); return delCat(id); }
    if (e.target.id === 'cat-save') {
      const name = wrapEl.querySelector('#cat-name').value.trim() || c.name;
      Object.assign(c, { name, color });
      wrapEl.remove();
      render();
      await save(db.from('categories').update({ name, color }).eq('id', id));
    }
  });
}

// Tapping a step's dot walks it through that task's categories and back to none.
async function cycleCat(id) {
  const s = subs.find((x) => x.id === id);
  if (!s) return;
  const mine = catsFor(s.task_id);
  if (!mine.length) return;
  const i = mine.findIndex((c) => c.id === s.category_id);
  s.category_id = i + 1 >= mine.length ? null : mine[i + 1].id;
  render();
  await save(db.from('subtasks').update({ category_id: s.category_id }).eq('id', id));
}

// ---------- planning ----------
async function planToggle(id, day) {
  const t = tasks.find((x) => x.id === id);
  if (!t) return;
  t.planned_for = t.planned_for === day ? null : day;
  render();
  await save(db.from('tasks').update({ planned_for: t.planned_for }).eq('id', id));
}

async function addTomorrowTask(title) {
  const position = tasks.length ? Math.max(...tasks.map((x) => x.position)) + 1 : 0;
  const { data, error } = await db.from('tasks').insert({
    user_id: uid, title, cadence: 'once', quota: null, due_date: tomorrowStr(), position,
  }).select().single();
  if (error) { toast('Não foi possível guardar. Tenta de novo.'); return; }
  tasks.push(data);
  render();
}

// Pull a leftover / backlog / future subtask into today's plan.
async function subToToday(id) {
  const s = subs.find((x) => x.id === id);
  if (!s) return;
  s.for_date = todayStr();
  s.done = false;
  render();
  await save(db.from('subtasks').update({ for_date: s.for_date, done: false }).eq('id', id));
  await syncBlock(tasks.find((x) => x.id === s.task_id));
}

async function persistOrder(orderedIds) {
  // The dragged (open) tasks permute among the position slots they already hold,
  // so done/hidden tasks keep their priority for tomorrow.
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const slots = orderedIds.map((id) => byId.get(id).position).sort((a, b) => a - b);
  const updates = [];
  orderedIds.forEach((id, i) => {
    const t = byId.get(id);
    if (t.position !== slots[i]) {
      t.position = slots[i];
      updates.push(save(db.from('tasks').update({ position: slots[i] }).eq('id', id)));
    }
  });
  tasks.sort((a, b) => a.position - b.position || (a.created_at < b.created_at ? -1 : 1));
  render();
  await Promise.all(updates);
}

// ---------- drag the ≡ handle: reorder, or drop onto a task to nest ----------
//
// Nothing is moved in the DOM while the finger is down. The row follows the pointer
// with a transform and the others slide to open a gap; the real list is rebuilt only
// on drop. That matters on touch: a pointerdown implicitly captures the pointer to the
// handle, and re-inserting the handle's row in the DOM releases that capture — which is
// exactly why the old version stopped receiving pointermove and appeared frozen.

function startDrag(e, handle) {
  const row = handle.closest('.row');
  const list = root.querySelector('#open-rows');
  if (!row || !list || drag) return;
  e.preventDefault();

  const sy = window.scrollY;
  const metrics = [...list.querySelectorAll('.row')].map((r) => {
    const b = r.getBoundingClientRect();
    return { id: r.dataset.id, el: r, top: b.top + sy, h: b.height };
  });
  const from = metrics.findIndex((m) => m.el === row);
  if (from < 0) return;

  drag = {
    id: row.dataset.id, row, metrics, from, to: from,
    startY: e.clientY + sy, clientY: e.clientY, scroll: 0, moved: false,
    nestId: null, overId: null, overSince: 0,
  };
  row.classList.add('dragging');
  document.body.classList.add('dragging-active');
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragUp);
  window.addEventListener('pointercancel', onDragUp);
  requestAnimationFrame(dragTick);
}

function onDragMove(ev) {
  if (!drag) return;
  drag.clientY = ev.clientY;
  const zone = 72;
  drag.scroll = ev.clientY < zone ? -1 : ev.clientY > window.innerHeight - zone ? 1 : 0;
  updateDrag();
}

// Runs every frame while dragging: keeps scrolling at the screen edge, and keeps the
// hold-to-nest timer ticking even when the finger is perfectly still.
function dragTick() {
  if (!drag) return;
  if (drag.scroll) window.scrollBy(0, drag.scroll * 10);
  updateDrag();
  requestAnimationFrame(dragTick);
}

function updateDrag() {
  const y = drag.clientY + window.scrollY; // document coords: survives auto-scroll
  if (Math.abs(y - drag.startY) > 5) drag.moved = true;
  drag.row.style.transform = `translateY(${y - drag.startY}px)`;

  // Middle band of a row = "drop into it"; the outer thirds = "drop between rows".
  // Nesting deletes the dragged task, so it must be deliberate: you have to HOLD over the
  // row for a moment before it engages. Brushing past a row on the way to a new position
  // can't nest by accident (which is exactly how a task got swallowed on 2026-07-26).
  let over = null;
  for (let i = 0; i < drag.metrics.length; i++) {
    const m = drag.metrics[i];
    const band = m.h * 0.3;
    if (i !== drag.from && y > m.top + band && y < m.top + m.h - band && canNest(m.id)) {
      over = m.id;
      break;
    }
  }
  if (over !== drag.overId) { drag.overId = over; drag.overSince = Date.now(); }
  drag.nestId = over && Date.now() - drag.overSince >= NEST_HOLD_MS ? over : null;
  if (!drag.nestId) {
    let to = 0;
    drag.metrics.forEach((m, i) => { if (y > m.top + m.h / 2) to = i + 1; });
    drag.to = to > drag.from ? to - 1 : to; // the dragged row vacates its own slot
  }
  paintDrag();
}

function paintDrag() {
  const gap = drag.metrics[drag.from].h;
  drag.metrics.forEach((m, i) => {
    if (i === drag.from) return;
    m.el.classList.toggle('nestover', m.id === drag.nestId);
    let shift = 0;
    if (!drag.nestId) {
      if (i > drag.from && i <= drag.to) shift = -gap;
      else if (i < drag.from && i >= drag.to) shift = gap;
    }
    m.el.style.transform = shift ? `translateY(${shift}px)` : '';
  });
}

// One level of subtasks only (project.md §7) — so a task that already has its own
// subtasks can't be nested. Every cadence can now be a parent.
function canNest(targetId) {
  const t = tasks.find((x) => x.id === drag.id);
  if (!t || !tasks.some((x) => x.id === targetId)) return false;
  return !subs.some((s) => s.task_id === t.id);
}

function endDrag(silent) {
  if (!drag) return null;
  const d = drag;
  drag = null;
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragUp);
  window.removeEventListener('pointercancel', onDragUp);
  document.body.classList.remove('dragging-active');
  d.row.classList.remove('dragging');
  d.metrics.forEach((m) => { m.el.style.transform = ''; m.el.classList.remove('nestover'); });
  if (d.moved) dragEndedAt = Date.now();
  return silent ? null : d;
}

function onDragUp() {
  const d = endDrag(false);
  if (!d || !d.moved) return;
  if (d.nestId) return nestTask(d.id, d.nestId);
  if (d.to === d.from) return;
  const ids = d.metrics.map((m) => m.id);
  ids.splice(d.to, 0, ids.splice(d.from, 1)[0]);
  persistOrder(ids);
}

// Dropping a task onto another turns it into a subtask: the subtask model is just a
// title + a checkbox, so the original task row (and its cadence/history) goes away.
async function nestTask(dragId, targetId) {
  const t = tasks.find((x) => x.id === dragId);
  const p = tasks.find((x) => x.id === targetId);
  if (!t || !p) return;
  const loses = t.cadence !== 'once' ? '\n\nDeixa de ser tarefa: perde a cadência e o progresso da semana.' : '';
  if (!confirm(`Tornar "${t.title}" numa subtarefa de "${p.title}"?${loses}`)) return render();
  if (!(await addSub(p.id, t.title, 'today'))) return;

  tasks = tasks.filter((x) => x.id !== dragId);
  comps = comps.filter((c) => c.task_id !== dragId);
  expandedId = p.id; // open the parent so he sees where it landed
  render();
  await save(db.from('tasks').delete().eq('id', dragId));
}

// ---------- add-task sheet (own subtree so typing survives) ----------
function openSheet() {
  let cadence = 'once';
  let quota = 5;
  const wrapEl = document.createElement('div');
  wrapEl.className = 'sheetwrap';
  wrapEl.innerHTML = `<div class="sheet">
    <h2>Nova tarefa</h2>
    <input class="field" id="nt-title" placeholder="O que há para fazer?" autocomplete="off">
    <div class="pills">
      <button class="pill" data-c="once">Única</button>
      <button class="pill" data-c="daily">Diária</button>
      <button class="pill" data-c="weekly">Semanal</button>
    </div>
    <div class="steprow" id="nt-quota" style="display:none">
      <span>Vezes por semana:</span>
      <button class="pill" data-q="-1">−</button>
      <span id="nt-quota-n" style="color:var(--text);font-weight:600">5</span>
      <button class="pill" data-q="1">+</button>
    </div>
    <div id="nt-date-wrap">
      <input class="field" id="nt-date" type="date">
      <div class="hint" style="margin-top:6px">Sem data = quando puder.</div>
    </div>
    <button class="btn" id="nt-create">Criar</button>
  </div>`;
  root.appendChild(wrapEl);

  const paint = () => {
    wrapEl.querySelectorAll('.pill[data-c]').forEach((p) =>
      p.classList.toggle('on', p.dataset.c === cadence));
    wrapEl.querySelector('#nt-quota').style.display = cadence === 'weekly' ? 'flex' : 'none';
    wrapEl.querySelector('#nt-date-wrap').style.display = cadence === 'once' ? 'block' : 'none';
    wrapEl.querySelector('#nt-quota-n').textContent = quota;
  };
  paint();
  wrapEl.querySelector('#nt-title').focus();

  wrapEl.addEventListener('click', async (e) => {
    if (e.target === wrapEl) { wrapEl.remove(); return; }
    const pill = e.target.closest('[data-c]');
    if (pill) { cadence = pill.dataset.c; paint(); return; }
    const q = e.target.closest('[data-q]');
    if (q) { quota = Math.min(7, Math.max(1, quota + Number(q.dataset.q))); paint(); return; }
    if (e.target.id === 'nt-create') {
      const title = wrapEl.querySelector('#nt-title').value.trim();
      if (!title) return;
      e.target.disabled = true;
      const position = tasks.length ? Math.max(...tasks.map((t) => t.position)) + 1 : 0;
      const { data, error } = await db.from('tasks').insert({
        user_id: uid, title, cadence,
        quota: cadence === 'weekly' ? quota : null,
        due_date: cadence === 'once' ? (wrapEl.querySelector('#nt-date').value || null) : null,
        position,
      }).select().single();
      if (error) { toast('Não foi possível guardar. Tenta de novo.'); e.target.disabled = false; return; }
      tasks.push(data);
      wrapEl.remove();
      render();
    }
  });
}

// ---------- event delegation ----------
function onClick(e) {
  if (Date.now() - dragEndedAt < 300) return; // the click that trails a drag
  const btn = e.target.closest('[data-act]');
  if (!btn || !root.contains(btn)) return;
  const act = btn.dataset.act;
  const id = btn.dataset.id;
  const task = id ? tasks.find((t) => t.id === id) : null;

  if (act === 'retry') refresh();
  else if (act === 'open-page') openPage(id);
  else if (act === 'close-page') closePage();
  else if (act === 'sheet') openSheet();
  else if (act === 'expand') {
    expandedId = expandedId === id ? null : id;
    subTarget = 'today'; catSel = null;
    render();
  }
  else if (act === 'toggle-task') toggleTask(task);
  else if (act === 'toggle-sub') toggleSub(id);
  else if (act === 'sub-target') {
    // the tab now decides what is listed, so this has to re-render — carry any half-typed
    // subtask across so switching tabs doesn't eat what he was writing
    const typed = root.querySelector('#addsub-input')?.value || '';
    subTarget = btn.dataset.v;
    render();
    const input = root.querySelector('#addsub-input');
    if (input && typed) { input.value = typed; input.focus(); }
  }
  else if (act === 'add-sub') {
    const input = root.querySelector('#addsub-input');
    const title = input.value.trim();
    if (title) { input.value = ''; addSub(id, title); }
  }
  else if (act === 'cat-sel') {
    if (btn.dataset.longpress) { delete btn.dataset.longpress; return; } // the editor opened
    const v = btn.dataset.v || null;
    catSel = catSel === v ? null : v; // tap the active chip again to go back to Todas
    render();
  }
  else if (act === 'cat-new') newCat(id);
  else if (act === 'plan-toggle') planToggle(id, tomorrowStr());
  else if (act === 'plan-today') planToggle(id, todayStr());
  else if (act === 'add-tomorrow') {
    const input = root.querySelector('#newtmr-input');
    const title = input.value.trim();
    if (title) { input.value = ''; addTomorrowTask(title); }
  }
  else if (act === 'del-task-quiet') {
    tasks = tasks.filter((x) => x.id !== id); render();
    save(db.from('tasks').delete().eq('id', id));
  }
  else if (act === 'cycle-cat') cycleCat(id);
  else if (act === 'sub-to-today') subToToday(id);
  else if (act === 'del-sub') {
    const owner = tasks.find((t) => t.id === subs.find((s) => s.id === id)?.task_id);
    subs = subs.filter((s) => s.id !== id); render();
    save(db.from('subtasks').delete().eq('id', id)).then(() => syncBlock(owner));
  }
  else if (act === 'del-task') {
    if (confirm('Apagar esta tarefa?')) {
      tasks = tasks.filter((t) => t.id !== id);
      subs = subs.filter((s) => s.task_id !== id);
      comps = comps.filter((c) => c.task_id !== id);
      expandedId = null; render();
      save(db.from('tasks').delete().eq('id', id));
    }
  }
  else if (act === 'rename') {
    const v = prompt('Novo nome:', task.title);
    if (v && v.trim()) {
      task.title = v.trim(); render();
      save(db.from('tasks').update({ title: task.title }).eq('id', id));
    }
  }
  else if (act === 'redate') {
    const v = prompt('Nova data (AAAA-MM-DD, vazio = quando puder):', task.due_date || '');
    if (v !== null) {
      const clean = v.trim();
      if (clean && !/^\d{4}-\d{2}-\d{2}$/.test(clean)) return alert('Formato: AAAA-MM-DD');
      task.due_date = clean || null; render();
      save(db.from('tasks').update({ due_date: task.due_date }).eq('id', id));
    }
  }
  else if (act === 'hero-done') {
    if (btn.dataset.sub) toggleSub(btn.dataset.sub);
    else toggleTask(task);
  }
}

function onPointerDown(e) {
  const handle = e.target.closest('.handle');
  if (handle && root.contains(handle)) { startDrag(e, handle); return; }

  // long-press a category chip to edit it; a normal tap still selects it
  const chip = e.target.closest('.cats .pill.cat');
  if (!chip || !root.contains(chip)) return;
  const id = chip.dataset.v;
  const timer = setTimeout(() => {
    chip.dataset.longpress = '1';
    if (navigator.vibrate) navigator.vibrate(15);
    editCat(id);
  }, 480);
  const cancel = () => {
    clearTimeout(timer);
    chip.removeEventListener('pointerup', cancel);
    chip.removeEventListener('pointercancel', cancel);
    chip.removeEventListener('pointerleave', cancel);
  };
  chip.addEventListener('pointerup', cancel);
  chip.addEventListener('pointercancel', cancel);
  chip.addEventListener('pointerleave', cancel);
}
function onKeyDown(e) {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'addsub-input') {
    const title = e.target.value.trim();
    const btn = root.querySelector('[data-act="add-sub"]');
    if (title && btn) { e.target.value = ''; addSub(btn.dataset.id, title); }
  } else if (e.target.id === 'newtmr-input') {
    const title = e.target.value.trim();
    if (title) { e.target.value = ''; addTomorrowTask(title); }
  }
}
