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
let expandedId = null;
let subTarget = 'today'; // where a new subtask goes: 'today' | 'tomorrow'
let loadError = false;

let focusHandler = null;

// ---------- dates (device-local; one user, one timezone) ----------
function iso(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function todayStr() { return iso(new Date()); }
function tomorrowStr() { const d = new Date(); d.setDate(d.getDate() + 1); return iso(d); }
function mondayStr() {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return iso(d);
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- lifecycle ----------
async function mount(container, ctx) {
  root = container;
  db = ctx.supabase;
  uid = ctx.session.user.id;
  expandedId = null;
  focusHandler = () => refresh();
  window.addEventListener('focus', focusHandler);
  root.addEventListener('click', onClick);
  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('keydown', onKeyDown);
  root.innerHTML = '<p class="empty">A carregar…</p>';
  await refresh();
}

function unmount() {
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
  const tomorrow = tomorrowStr();
  const [t, s, c] = await Promise.all([
    db.from('tasks').select('*').order('position').order('created_at'),
    db.from('subtasks').select('*')
      .or(`for_date.is.null,for_date.eq.${today},for_date.eq.${tomorrow}`)
      .order('position').order('created_at'),
    db.from('task_completions').select('*').gte('done_on', mondayStr()),
  ]);
  loadError = !!(t.error || s.error || c.error);
  if (!loadError) {
    tasks = t.data;
    subs = s.data;
    comps = c.data;
  }
  render();
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

  if (t.cadence === 'daily' || t.cadence === 'once') {
    if (mySubs.length > 0) {
      st.block = true;
      const done = mySubs.filter((s) => s.done).length;
      st.prog = { done, total: mySubs.length };
    }
  }
  if (t.cadence === 'daily') {
    st.doneToday = st.block ? st.prog.done === st.prog.total : compToday(t);
  } else if (t.cadence === 'weekly') {
    st.count = weekCount(t);
    st.doneToday = compToday(t);
    st.hidden = st.count >= (t.quota || 1) && !st.doneToday; // met earlier in the week
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

function visibleLists() {
  const open = [];
  const done = [];
  for (const t of tasks) {
    const st = status(t);
    if (st.hidden) continue;
    (st.doneToday ? done : open).push({ t, st });
  }
  return { open, done };
}

// ---------- rendering ----------
function heroHtml(open) {
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
    return `<div class="hero zen"><div class="title">Tudo feito por hoje.</div>
      <div class="sub">Descansa — ou adiciona o que vier.</div></div>`;
  }

  const { t, st } = open[0];
  if (st.block) {
    const next = subsFor(t, todayStr()).find((s) => !s.done);
    const pct = Math.round((st.prog.done / st.prog.total) * 100);
    return `<div class="hero">
      <div class="title">${esc(next.title)}</div>
      <div class="sub">Parte de: ${esc(t.title)} · ${st.prog.done + 1} de ${st.prog.total}${t.cadence === 'daily' ? ' hoje' : ''}</div>
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
      <span>${st.prog.done}/${st.prog.total}${t.cadence === 'daily' ? ' hoje' : ''}</span>`);
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

function expandHtml(t, st) {
  const today = todayStr();
  const list = subsFor(t, today);
  const tmr = t.cadence === 'daily' ? subs.filter((s) => s.task_id === t.id && s.for_date === tomorrowStr()) : [];
  const canSub = t.cadence === 'daily' || t.cadence === 'once';

  let h = '<div class="expand">';
  if (canSub) {
    for (const s of list) {
      h += `<div class="subrow ${s.done ? 'sdone' : ''}">
        <button class="cb ${s.done ? 'on' : ''}" data-act="toggle-sub" data-id="${s.id}">✓</button>
        <span class="st">${esc(s.title)}</span>
        <button class="xbtn" data-act="del-sub" data-id="${s.id}">×</button>
      </div>`;
    }
    if (tmr.length) {
      h += `<div class="subhead">Para amanhã</div>`;
      for (const s of tmr) {
        h += `<div class="subrow"><span class="st" style="color:var(--muted)">${esc(s.title)}</span>
          <button class="xbtn" data-act="del-sub" data-id="${s.id}">×</button></div>`;
      }
    }
    h += `<div class="addsub">
      <input class="field" id="addsub-input" placeholder="Nova subtarefa…" autocomplete="off">
      ${t.cadence === 'daily'
        ? `<button class="pill ${subTarget === 'today' ? 'on' : ''}" data-act="sub-target" data-v="today">Hoje</button>
           <button class="pill ${subTarget === 'tomorrow' ? 'on' : ''}" data-act="sub-target" data-v="tomorrow">Amanhã</button>`
        : ''}
      <button class="pill on" data-act="add-sub" data-id="${t.id}">+</button>
    </div>`;
  }
  h += `<div class="rowactions">
    <button class="ghostbtn" data-act="rename" data-id="${t.id}">Mudar nome</button>
    ${t.cadence === 'once' ? `<button class="ghostbtn" data-act="redate" data-id="${t.id}">Mudar data</button>` : ''}
    <button class="ghostbtn danger" data-act="del-task" data-id="${t.id}">Apagar</button>
  </div></div>`;
  return h;
}

function rowHtml({ t, st }, isDone) {
  const cbOn = isDone || st.doneToday;
  return `<div class="row ${isDone ? 'done-row' : ''}" data-id="${t.id}">
    <div class="rowline">
      <button class="cb ${cbOn ? 'on' : ''}" data-act="${st.block ? 'expand' : 'toggle-task'}" data-id="${t.id}">✓</button>
      <button class="tmain" data-act="expand" data-id="${t.id}">
        <div class="tt">${esc(t.title)}</div>${rowMeta(t, st)}
      </button>
      ${!isDone ? `<button class="handle" data-id="${t.id}">≡</button>` : ''}
    </div>
    ${expandedId === t.id ? expandHtml(t, st) : ''}
  </div>`;
}

function render() {
  if (!root) return;
  const { open, done } = visibleLists();
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
    ${heroHtml(open)}
    ${open.length
      ? `<div class="kicker plain">Hoje</div>
         <div class="rows" id="open-rows">${open.map((x) => rowHtml(x, false)).join('')}</div>` : ''}
    ${done.length
      ? `<div class="kicker plain">Feitas hoje</div>
         <div class="rows">${done.map((x) => rowHtml(x, true)).join('')}</div>` : ''}
    <button class="fab" data-act="sheet">+</button>
  `;
}

// ---------- data actions ----------
async function toggleTask(t) {
  const today = todayStr();
  if (t.cadence === 'once') {
    const v = t.completed_at ? null : new Date().toISOString();
    t.completed_at = v; render();
    await db.from('tasks').update({ completed_at: v }).eq('id', t.id);
  } else {
    const existing = comps.find((c) => c.task_id === t.id && c.done_on === today);
    if (existing) {
      comps = comps.filter((c) => c !== existing); render();
      await db.from('task_completions').delete().eq('id', existing.id);
    } else {
      const row = { user_id: uid, task_id: t.id, done_on: today };
      comps.push(row); render();
      const { data } = await db.from('task_completions').insert(row).select().single();
      if (data) Object.assign(row, data);
    }
  }
}

async function toggleSub(id) {
  const s = subs.find((x) => x.id === id);
  s.done = !s.done; render();
  await db.from('subtasks').update({ done: s.done }).eq('id', id);
  // a one-off block completes itself when its last subtask is checked
  const t = tasks.find((x) => x.id === s.task_id);
  if (t && t.cadence === 'once') {
    const mine = subsFor(t, todayStr());
    const allDone = mine.length > 0 && mine.every((x) => x.done);
    const v = allDone ? (t.completed_at || new Date().toISOString()) : null;
    if ((t.completed_at || null) !== v) {
      t.completed_at = v; render();
      await db.from('tasks').update({ completed_at: v }).eq('id', t.id);
    }
  }
}

async function addSub(taskId, title) {
  const t = tasks.find((x) => x.id === taskId);
  const for_date = t.cadence === 'daily' ? (subTarget === 'today' ? todayStr() : tomorrowStr()) : null;
  const position = subs.filter((s) => s.task_id === taskId).length;
  const { data } = await db.from('subtasks')
    .insert({ user_id: uid, task_id: taskId, title, for_date, position }).select().single();
  if (data) subs.push(data);
  // adding a subtask reopens a completed one-off block
  if (t.cadence === 'once' && t.completed_at) {
    t.completed_at = null;
    await db.from('tasks').update({ completed_at: null }).eq('id', t.id);
  }
  render();
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
      updates.push(db.from('tasks').update({ position: slots[i] }).eq('id', id));
    }
  });
  tasks.sort((a, b) => a.position - b.position || (a.created_at < b.created_at ? -1 : 1));
  render();
  await Promise.all(updates);
}

// ---------- drag to reorder (pointer events on the ≡ handle) ----------
function startDrag(e, handle) {
  e.preventDefault();
  const row = handle.closest('.row');
  const list = root.querySelector('#open-rows');
  if (!row || !list) return;
  row.classList.add('dragging');
  handle.setPointerCapture(e.pointerId);

  const onMove = (ev) => {
    const rows = [...list.querySelectorAll('.row')].filter((r) => r !== row);
    let placed = false;
    for (const r of rows) {
      const rect = r.getBoundingClientRect();
      if (ev.clientY < rect.top + rect.height / 2) { list.insertBefore(row, r); placed = true; break; }
    }
    if (!placed) list.appendChild(row);
  };
  const onUp = () => {
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onUp);
    row.classList.remove('dragging');
    persistOrder([...list.querySelectorAll('.row')].map((r) => r.dataset.id));
  };
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onUp);
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
      if (!error && data) tasks.push(data);
      wrapEl.remove();
      render();
    }
  });
}

// ---------- event delegation ----------
function onClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn || !root.contains(btn)) return;
  const act = btn.dataset.act;
  const id = btn.dataset.id;
  const task = id ? tasks.find((t) => t.id === id) : null;

  if (act === 'retry') refresh();
  else if (act === 'sheet') openSheet();
  else if (act === 'expand') { expandedId = expandedId === id ? null : id; subTarget = 'today'; render(); }
  else if (act === 'toggle-task') toggleTask(task);
  else if (act === 'toggle-sub') toggleSub(id);
  else if (act === 'sub-target') {
    subTarget = btn.dataset.v;
    btn.parentElement.querySelectorAll('[data-act="sub-target"]').forEach((p) =>
      p.classList.toggle('on', p.dataset.v === subTarget));
  }
  else if (act === 'add-sub') {
    const input = root.querySelector('#addsub-input');
    const title = input.value.trim();
    if (title) { input.value = ''; addSub(id, title); }
  }
  else if (act === 'del-sub') {
    subs = subs.filter((s) => s.id !== id); render();
    db.from('subtasks').delete().eq('id', id);
  }
  else if (act === 'del-task') {
    if (confirm('Apagar esta tarefa?')) {
      tasks = tasks.filter((t) => t.id !== id);
      subs = subs.filter((s) => s.task_id !== id);
      comps = comps.filter((c) => c.task_id !== id);
      expandedId = null; render();
      db.from('tasks').delete().eq('id', id);
    }
  }
  else if (act === 'rename') {
    const v = prompt('Novo nome:', task.title);
    if (v && v.trim()) { task.title = v.trim(); render(); db.from('tasks').update({ title: task.title }).eq('id', id); }
  }
  else if (act === 'redate') {
    const v = prompt('Nova data (AAAA-MM-DD, vazio = quando puder):', task.due_date || '');
    if (v !== null) {
      const clean = v.trim();
      if (clean && !/^\d{4}-\d{2}-\d{2}$/.test(clean)) return alert('Formato: AAAA-MM-DD');
      task.due_date = clean || null; render();
      db.from('tasks').update({ due_date: task.due_date }).eq('id', id);
    }
  }
  else if (act === 'hero-done') {
    if (btn.dataset.sub) toggleSub(btn.dataset.sub);
    else toggleTask(task);
  }
}

function onPointerDown(e) {
  const handle = e.target.closest('.handle');
  if (handle && root.contains(handle)) startDrag(e, handle);
}
function onKeyDown(e) {
  if (e.key === 'Enter' && e.target.id === 'addsub-input') {
    const title = e.target.value.trim();
    const btn = root.querySelector('[data-act="add-sub"]');
    if (title && btn) { e.target.value = ''; addSub(btn.dataset.id, title); }
  }
}
