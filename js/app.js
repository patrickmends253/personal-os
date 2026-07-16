// Shell: auth gate, theme, and the module router.
//
// MODULE CONTRACT (see project.md §3):
//   Each file in js/modules/ default-exports { id, title, mount(container, ctx), unmount() }.
//   ctx = { supabase, session }. Modules render only inside the container they are given
//   and clean up after themselves in unmount(). The shell knows nothing else about them.
//   Adding a future section = one new file below in MODULES + one line in the nav.

const MODULES = {
  tasks: () => import('./modules/tasks.js'),
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

// --- module router ---
const viewContainer = el('view');
let active = null; // { id, mod }

async function mountModule(id, ctx) {
  if (active?.id === id) return;
  if (active) { try { active.mod.unmount(); } catch {} }
  viewContainer.innerHTML = '';
  const { default: mod } = await MODULES[id]();
  active = { id, mod };
  await mod.mount(viewContainer, ctx);
}
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

function enterApp(session) {
  if (currentUserId === session.user.id && active) return;
  currentUserId = session.user.id;
  el('user-email').textContent = session.user.email || '';
  setView('app');
  mountModule(DEFAULT_MODULE, { supabase, session });
}
function leaveApp() {
  currentUserId = null;
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
