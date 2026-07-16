// Entry point: the auth gate + the temporary sync smoke-test.
// (This is a minimal proto-router. The real module router / module contract lands
//  with the Tasks module in step 4 — see project.md §3.)

const body = document.body;
const setView = (v) => { body.dataset.view = v; };
const IS_MOBILE = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const DEVICE = IS_MOBILE ? 'Telemóvel' : 'Computador';

// --- elements ---
const el = (id) => document.getElementById(id);
const loginForm = el('login-form');
const emailInput = el('email');
const passwordInput = el('password');
const loginBtn = el('login-btn');
const authMsg = el('auth-msg');
const netChip = el('net');
const syncInput = el('sync-input');
const syncSave = el('sync-save');
const syncStatus = el('sync-status');
const userEmail = el('user-email');
const signoutBtn = el('signout');

// --- static UI (works with or without a connection) ---
function paintGreeting() {
  const h = new Date().getHours();
  el('greet').textContent = h < 12 ? 'Bom dia.' : h < 20 ? 'Boa tarde.' : 'Boa noite.';
}
function paintDate() {
  const d = new Date().toLocaleDateString('pt-PT', { weekday: 'long', day: 'numeric', month: 'long' });
  el('date').textContent = d.charAt(0).toUpperCase() + d.slice(1);
}
function paintNet() {
  netChip.textContent = navigator.onLine ? 'online' : 'offline';
  netChip.classList.toggle('off', !navigator.onLine);
}

// --- register the service worker (cached shell → opens instantly / offline) ---
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// --- login error → plain Portuguese ---
function loginErrorPT(message = '') {
  if (/invalid login credentials/i.test(message)) return 'Email ou palavra-passe incorretos.';
  if (/email not confirmed/i.test(message)) return 'Confirma o teu email antes de entrar.';
  if (/network|fetch/i.test(message)) return 'Sem ligação. Verifica a internet e tenta de novo.';
  return 'Não foi possível entrar. Tenta de novo.';
}

// --- sync smoke-test ---
let supabase = null;
let userId = null;

async function loadSync() {
  if (!supabase || !userId) return;
  const { data, error } = await supabase
    .from('sync_test')
    .select('content, device, updated_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) { syncStatus.textContent = 'Não foi possível ler os dados.'; return; }
  if (!data) { syncStatus.textContent = 'Ainda nada guardado.'; return; }

  const when = new Date(data.updated_at).toLocaleString('pt-PT',
    { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  syncStatus.innerHTML =
    `Última gravação: <b>${escapeHtml(data.content || '(vazio)')}</b><br>` +
    `via ${escapeHtml(data.device || '?')} · ${when}`;
}

async function saveSync() {
  if (!supabase || !userId) return;
  syncSave.disabled = true;
  const { error } = await supabase.from('sync_test').upsert({
    user_id: userId,
    content: syncInput.value.trim(),
    device: DEVICE,
    updated_at: new Date().toISOString(),
  });
  syncSave.disabled = false;
  if (error) { syncStatus.textContent = 'Não foi possível guardar.'; return; }
  syncInput.value = '';
  loadSync();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- session state ---
function enterApp(session) {
  userId = session.user.id;
  userEmail.textContent = session.user.email || '';
  setView('app');
  loadSync();
}
function leaveApp() {
  userId = null;
  setView('auth');
}

// --- boot ---
(async () => {
  paintGreeting();
  paintDate();
  paintNet();
  window.addEventListener('online', paintNet);
  window.addEventListener('offline', paintNet);

  // wire DOM once (safe regardless of auth state)
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!supabase) { authMsg.textContent = loginErrorPT('network'); return; }
    authMsg.textContent = '';
    loginBtn.disabled = true;
    loginBtn.textContent = 'A entrar…';
    const { error } = await supabase.auth.signInWithPassword({
      email: emailInput.value.trim(),
      password: passwordInput.value,
    });
    loginBtn.disabled = false;
    loginBtn.textContent = 'Entrar';
    if (error) authMsg.textContent = loginErrorPT(error.message);
    // success is handled by onAuthStateChange
  });
  syncSave.addEventListener('click', saveSync);
  syncInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveSync(); });
  signoutBtn.addEventListener('click', () => supabase && supabase.auth.signOut());
  window.addEventListener('focus', loadSync); // re-check for changes from other devices

  // load Supabase (may fail offline — degrade gracefully instead of white-screening)
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
