// Shell: auth gate, theme, and the module router.
//
// MODULE CONTRACT (see project.md §3):
//   Each file in js/modules/ default-exports { id, title, mount(container, ctx), unmount() }.
//   ctx = { supabase, session }. Modules render only inside the container they are given
//   and clean up after themselves in unmount(). The shell knows nothing else about them.
//   Adding a future section = one new file below in MODULES + one line in the nav.

const MODULES = {
  tasks: () => import('./modules/tasks.js'),
  board: () => import('./modules/board.js'),
};
const DEFAULT_MODULE = 'tasks';

const body = document.body;
const el = (id) => document.getElementById(id);
const setView = (v) => { body.dataset.view = v; };

// --- theme: dark (A) / paper (B) / soft (D), cycled; remembered per device ---
const THEMES = ['dark', 'paper', 'soft'];
const THEME_BG = { dark: '#0F141C', paper: '#F3EEE3', soft: '#EEF1F6' };

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]').setAttribute('content', THEME_BG[t]);
  localStorage.setItem('pos-theme', t);
}
function initTheme() {
  const saved = localStorage.getItem('pos-theme');
  if (saved && THEMES.includes(saved)) return applyTheme(saved);
  applyTheme(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'paper');
}
el('theme-btn').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme;
  applyTheme(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]);
});
initTheme();

// --- online/offline chip ---
const netChip = el('net');
function paintNet() {
  netChip.textContent = navigator.onLine ? 'online' : 'offline';
  netChip.classList.toggle('off', !navigator.onLine);
}
addEventListener('online', paintNet);
addEventListener('offline', paintNet);
paintNet();

// --- service worker ---
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// --- install ---
// Chrome fires beforeinstallprompt ONLY when it accepts the site as installable, so the
// button appearing is itself the proof. Going through this event installs a real app
// (a WebAPK on Android); the browser menu's "add to home screen" can instead make a
// bookmark shortcut, which is what leaves the Chrome badge on the icon.
const installBtn = el('install-btn');
let installEvent = null;

addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // keep Chrome's own banner from firing; we prompt from the button
  installEvent = e;
  installBtn.hidden = false;
});

installBtn.addEventListener('click', async () => {
  if (!installEvent) return;
  installBtn.disabled = true;
  installEvent.prompt();
  await installEvent.userChoice; // resolves whether he installs or dismisses
  installEvent = null;           // the event is single-use
  installBtn.hidden = true;
  installBtn.disabled = false;
});

addEventListener('appinstalled', () => { installEvent = null; installBtn.hidden = true; });

// --- module router ---
const viewContainer = el('view');
const nav = el('nav');
let active = null; // { id, mod }

function paintNav(id) {
  nav.querySelectorAll('[data-mod]').forEach((b) => b.classList.toggle('on', b.dataset.mod === id));
}

async function mountModule(id, ctx) {
  if (active?.id === id) return;
  if (active) { try { active.mod.unmount(); } catch {} }
  viewContainer.innerHTML = '';
  paintNav(id);
  const { default: mod } = await MODULES[id]();
  active = { id, mod };
  await mod.mount(viewContainer, ctx);
}

// Nav switches modules; ctx is captured from the live session (set in enterApp).
nav.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-mod]');
  if (btn && currentSession) mountModule(btn.dataset.mod, { supabase, session: currentSession });
});
function unmountModule() {
  if (active) { try { active.mod.unmount(); } catch {} }
  active = null;
  viewContainer.innerHTML = '';
}

// --- auth gate ---
const authMsg = el('auth-msg');
const loginBtn = el('login-btn');

function loginErrorPT(message = '') {
  if (/invalid login credentials/i.test(message)) return 'Email ou palavra-passe incorretos.';
  if (/email not confirmed/i.test(message)) return 'Confirma o teu email antes de entrar.';
  if (/network|fetch/i.test(message)) return 'Sem ligação. Verifica a internet e tenta de novo.';
  return 'Não foi possível entrar. Tenta de novo.';
}

let supabase = null;
let currentUserId = null;
let currentSession = null; // kept so nav can re-mount modules with a fresh ctx

function enterApp(session) {
  currentSession = session;
  if (currentUserId === session.user.id && active) return;
  currentUserId = session.user.id;
  el('user-email').textContent = session.user.email || '';
  setView('app');
  mountModule(DEFAULT_MODULE, { supabase, session });
}
function leaveApp() {
  currentUserId = null;
  currentSession = null;
  unmountModule();
  setView('auth');
}

(async () => {
  el('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!supabase) { authMsg.textContent = loginErrorPT('network'); return; }
    authMsg.textContent = '';
    loginBtn.disabled = true;
    loginBtn.textContent = 'A entrar…';
    const { error } = await supabase.auth.signInWithPassword({
      email: el('email').value.trim(),
      password: el('password').value,
    });
    loginBtn.disabled = false;
    loginBtn.textContent = 'Entrar';
    if (error) authMsg.textContent = loginErrorPT(error.message);
  });
  el('signout').addEventListener('click', () => supabase && supabase.auth.signOut());

  try {
    ({ supabase } = await import('./db.js'));
  } catch {
    setView('auth');
    authMsg.textContent = 'Sem ligação à internet. Liga-te para entrar.';
    return;
  }

  const { data: { session } } = await supabase.auth.getSession();
  if (session) enterApp(session); else setView('auth');

  supabase.auth.onAuthStateChange((_event, session) => {
    if (session) enterApp(session); else leaveApp();
  });
})();
