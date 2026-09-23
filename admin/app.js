// ---------------------------------------------------------------------
// Anjali Tours & Travel - Admin App Logic (vanilla JS, no frameworks)
// ---------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
let TOKEN = localStorage.getItem('atr_admin_token') || '';
let CURRENT_FILTER = '';
let CURRENT_BOOKINGS = [];
let CURRENT_DETAIL_ID = null;
let CAL_YEAR, CAL_MONTH; // 0-based month
let SETTINGS_CACHE = {};
let TEMPLATE_KEYS = ['PAYMENT_REQUEST', 'PAYMENT_VERIFIED', 'BOOKING_CONFIRMED', 'BOOKING_COMPLETED', 'BOOKING_CANCELLED', 'RIDE_REMINDER'];
let LAST_RENDERED_BOOKING = null;
// NOTE: the old flow used a popup window (Apps Script Index.html) that
// posted the finished card image back via window.postMessage. That popup
// + offline canvas QR engine is no longer used - see generatePayment()
// and renderQrPaymentCard_() below, which build the QR directly from the
// admin-configurable UPI ID + api.qrserver.com, the same way Kala
// Residency's app does it, with no popup window involved.

// ---------------------------------------------------------------------
// SESSION STATE PRESERVATION (Admin -> Booking -> Generate QR -> Share ->
// Back must return to the exact same screen, same booking, same QR card,
// without the admin re-selecting anything or re-generating the card).
//
// Uses sessionStorage (not localStorage) deliberately - it's per-tab and
// disappears when the tab/window is actually closed, so a stale QR/state
// can never leak into a brand new admin session on the same device.
// ---------------------------------------------------------------------
const ADMIN_STATE_KEY = 'atr_admin_session_state_v1';
const ADMIN_STATE_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours - generous for a WhatsApp round trip, bounded so it can never linger indefinitely

function saveAdminState(partial) {
  try {
    const existing = readAdminStateRaw_() || {};
    const merged = Object.assign({}, existing, partial, { savedAt: Date.now() });
    sessionStorage.setItem(ADMIN_STATE_KEY, JSON.stringify(merged));
  } catch (e) {
    console.error('Could not save admin session state (storage may be full/unavailable):', e);
  }
}

// Reads the raw saved object with NO age check - only for merging into a
// new save (above), never for deciding whether to restore something.
function readAdminStateRaw_() {
  try {
    const raw = sessionStorage.getItem(ADMIN_STATE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

// Reads the saved state ONLY if it's still fresh enough to trust - this
// is the one every restore path must go through (section 8: stale data
// safety).
function readAdminState() {
  const state = readAdminStateRaw_();
  if (!state || !state.savedAt || (Date.now() - state.savedAt) > ADMIN_STATE_MAX_AGE_MS) return null;
  return state;
}

function clearAdminPaymentCardState() {
  const state = readAdminStateRaw_();
  if (state && state.paymentCard) {
    delete state.paymentCard;
    try { sessionStorage.setItem(ADMIN_STATE_KEY, JSON.stringify(state)); } catch (e) {}
  }
}

function clearAdminState() {
  try { sessionStorage.removeItem(ADMIN_STATE_KEY); } catch (e) {}
}

// Rebuilds the exact same payment-card view (image + Regenerate/Download/
// Share/WhatsApp buttons) from a saved state object, WITHOUT calling the
// server again. Shared by the live generatePayment() success path and by
// restoreAdminStateIfAny() below, so both paths behave identically.
function renderPaymentCardResult_(bookingId, d, dataUrl) {
  const area = $('cardPreviewArea');
  let html = '';
  if (dataUrl) {
    html += `<img class="payment-card-preview" src="${dataUrl}" alt="Payment card" />`;
    // Keep the two customer-delivery actions together: Share opens the
    // native device share sheet, while Save JPG downloads the complete card.
    html += `<div class="payment-card-actions">
      <button class="btn btn-primary" id="btnShareCard">${t('share_card')}</button>
      <button class="btn btn-secondary" id="btnSaveJpg">Save JPG</button>
    </div>`;
    html += `<p class="field-msg">${t('share_card_hint')}</p>`;
    html += `<div class="inline-row">
      <button class="btn btn-secondary btn-inline" id="btnRegenCard">${t('regenerate_card')}</button>
    </div>`;
  } else if (!d.upi_uri) {
    html += '<p class="field-msg error">UPI ID not configured yet. Please set it in Settings.</p>';
  }
  if (d.whatsapp_link) {
    html += `<a class="btn btn-secondary" href="${d.whatsapp_link}" target="_blank" rel="noopener">${t('whatsapp_message_btn')}</a>`;
  }
  area.innerHTML = html;

  if (dataUrl) {
    $('btnShareCard').addEventListener('click', () => shareCardImage_(dataUrl, d.booking_id, d.whatsapp_link));
    $('btnRegenCard').addEventListener('click', () => generatePayment(bookingId, { advance_amount: d.advance_amount }));
    $('btnSaveJpg').addEventListener('click', () => saveCardAsJpg_(dataUrl, d.booking_id));
  }

  // Auto-save (section 5) - no manual "Save" button, this is exactly the
  // state that must survive a Share/WhatsApp -> Back round trip.
  saveAdminState({
    section: 'detail',
    bookingId: bookingId,
    paymentCard: {
      bookingId: bookingId,
      dataUrl: dataUrl || '',
      upiUri: d.upi_uri || '',
      whatsappLink: d.whatsapp_link || '',
      cardOptions: { serverGenerated: true },
      advanceAmount: d.advance_amount,
      finalTotal: d.final_total,
      balanceAmount: d.balance_amount,
      generatedAt: Date.now()
    }
  });
}

// On boot / bfcache restore / tab refocus, put the admin back exactly
// where they were - same booking, same generated QR card - without
// requiring them to reselect anything (sections 4-7).
async function restoreAdminStateIfAny() {
  const state = readAdminState();
  if (!state || !state.section) return false;

  if (state.section === 'detail' && state.bookingId) {
    // Already showing the right booking with a card in place - nothing to do.
    const alreadyThere = CURRENT_DETAIL_ID === state.bookingId
      && !$('view-detail').classList.contains('hidden')
      && $('cardPreviewArea').innerHTML.trim() !== '';
    if (alreadyThere) return true;

    CURRENT_DETAIL_ID = state.bookingId;
    document.querySelectorAll('#appShell .view').forEach(v => v.classList.add('hidden'));
    $('view-detail').classList.remove('hidden');
    $('pageTitle').textContent = state.bookingId;
    await renderDetail(); // always re-fetches live data first - never trust the cached snapshot alone

    const fresh = LAST_RENDERED_BOOKING;
    if (!fresh) return true; // fetch failed (e.g. offline) - renderDetail() already showed its own error

    const beyondPayment = ['CONFIRMED', 'COMPLETED', 'CANCELLED'].indexOf(fresh.booking_status) !== -1 || fresh.payment_status === 'VERIFIED';
    const sameBooking = state.paymentCard && state.paymentCard.bookingId === state.bookingId;

    if (beyondPayment) {
      // Booking has already moved past the payment step since we left
      // (someone may have verified/confirmed it elsewhere) - the saved QR
      // is stale and must never be shown as if still current (section 9).
      clearAdminPaymentCardState();
    } else if (sameBooking) {
      const card = state.paymentCard;
      if (card.dataUrl) {
        // Fast path: the exact previously-drawn image, restored instantly.
        renderPaymentCardResult_(card.bookingId, {
          booking_id: card.bookingId, upi_uri: card.upiUri, whatsapp_link: card.whatsappLink,
          advance_amount: card.advanceAmount, final_total: card.finalTotal, balance_amount: card.balanceAmount
        }, card.dataUrl);
      } else if (card.cardOptions) {
        // The image was not available to restore; ask Apps Script to create
        // the complete card again instead of drawing it in the frontend.
        generatePayment(card.bookingId, { advance_amount: card.advanceAmount });
      }
    }
    return true;
  }

  if (['dashboard', 'bookings', 'calendar', 'settings'].indexOf(state.section) !== -1) {
    switchNav(state.section);
    return true;
  }
  return false;
}

function showLoading(text) { $('loadingText').textContent = text || 'Loading...'; $('loadingOverlay').classList.remove('hidden'); }
function hideLoading() { $('loadingOverlay').classList.add('hidden'); }

async function callApi(action, payload) {
  const body = Object.assign({ action: action, token: TOKEN }, payload || {});
  const res = await fetch(API_URL, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new Error('Network error');
  return res.json();
}

async function callApiSafe(action, payload, loadingText) {
  showLoading(loadingText);
  try {
    const res = await callApi(action, payload);
    hideLoading();
    if (!res.success && res.error && res.error.code === 'UNAUTHORIZED') {
      logout();
      alert('Session expired. Please log in again.');
    }
    return res;
  } catch (err) {
    hideLoading();
    return { success: false, error: { code: 'NETWORK_ERROR', message: 'Admin service is temporarily unavailable. Please check your connection and try again.' } };
  }
}

// Same as callApiSafe but WITHOUT the full-screen blocking overlay - used
// for the 4 main menu sections (Dashboard/Bookings/Calendar/Settings) so
// switching between them feels instant instead of flashing a big spinner
// over the whole screen every time. Callers show their own small inline
// loader inside the content area instead.
async function callApiQuiet(action, payload) {
  try {
    const res = await callApi(action, payload);
    if (!res.success && res.error && res.error.code === 'UNAUTHORIZED') {
      logout();
      alert('Session expired. Please log in again.');
    }
    return res;
  } catch (err) {
    return { success: false, error: { code: 'NETWORK_ERROR', message: 'Admin service is temporarily unavailable. Please check your connection and try again.' } };
  }
}

function inlineLoaderHtml(text) {
  return '<div class="inline-loader"><span class="inline-spinner"></span>' + (text || 'Loading...') + '</div>';
}

// ---------------------------------------------------------------------
// LANGUAGE
// ---------------------------------------------------------------------
function bindLangSwitcher(containerId) {
  const el = $(containerId);
  if (!el) return;
  el.querySelectorAll('.lang-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      atrSetLang(btn.dataset.lang);
      applyI18n();
      refreshCurrentViewLabels();
    });
  });
}
bindLangSwitcher('langSwitcherLogin');
bindLangSwitcher('langSwitcherDrawer');

function refreshCurrentViewLabels() {
  // Re-render whichever screen is open so JS-generated strings (not just
  // static data-i18n markup) pick up the new language immediately.
  const activeView = document.querySelector('#appShell .view:not(.hidden)');
  if (!activeView) return;
  if (activeView.id === 'view-detail' && CURRENT_DETAIL_ID) renderDetail();
  if (activeView.id === 'view-settings') loadSettings();
}

// ---------------------------------------------------------------------
// CONFIRM MODAL (section 42)
// ---------------------------------------------------------------------
function showConfirmDialog(questionKey, detailHtml) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-box">
        <h3 class="section-title">${t('confirm_dialog_title')}</h3>
        <p>${t(questionKey)}</p>
        ${detailHtml ? '<div class="modal-detail">' + detailHtml + '</div>' : ''}
        <div class="modal-actions">
          <button class="btn btn-secondary" id="modalCancelBtn">${t('cancel')}</button>
          <button class="btn btn-primary" id="modalConfirmBtn">${t('confirm')}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#modalCancelBtn').addEventListener('click', () => { overlay.remove(); resolve(false); });
    overlay.querySelector('#modalConfirmBtn').addEventListener('click', () => { overlay.remove(); resolve(true); });
  });
}

// ---------------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------------
function logout() {
  TOKEN = '';
  localStorage.removeItem('atr_admin_token');
  clearAdminState(); // don't let a saved booking/QR session leak into the next login on this device
  $('appShell').classList.add('hidden');
  $('view-login').classList.remove('hidden');
}

$('btnLogin').addEventListener('click', async () => {
  const username = $('loginUsername').value.trim();
  const password = $('loginPassword').value;
  $('loginError').textContent = '';
  if (!username || !password) { $('loginError').textContent = 'Please enter username and password.'; return; }

  showLoading('Logging in...');
  try {
    const res = await callApi('ADMIN_LOGIN', { username, password });
    hideLoading();
    if (!res.success) { $('loginError').textContent = res.error.message; return; }
    TOKEN = res.data.token;
    localStorage.setItem('atr_admin_token', TOKEN);
    enterApp();
  } catch (err) {
    hideLoading();
    $('loginError').textContent = 'Could not reach admin service. Please check your connection.';
  }
});

$('btnLogout').addEventListener('click', async () => {
  await callApiSafe('ADMIN_LOGOUT', {}, 'Logging out...');
  logout();
});

async function enterApp() {
  $('view-login').classList.add('hidden');
  $('appShell').classList.remove('hidden');
  const restored = await restoreAdminStateIfAny();
  if (!restored) switchNav('dashboard');
}

// ---------------------------------------------------------------------
// NAV - hamburger + slide-out drawer
// ---------------------------------------------------------------------
function openDrawer() {
  $('drawer').classList.add('open');
  $('drawer').setAttribute('aria-hidden', 'false');
  $('drawerBackdrop').classList.remove('hidden');
  $('btnHamburger').setAttribute('aria-expanded', 'true');
}
function closeDrawer() {
  $('drawer').classList.remove('open');
  $('drawer').setAttribute('aria-hidden', 'true');
  $('drawerBackdrop').classList.add('hidden');
  $('btnHamburger').setAttribute('aria-expanded', 'false');
}
$('btnHamburger').addEventListener('click', () => {
  $('drawer').classList.contains('open') ? closeDrawer() : openDrawer();
});
$('drawerBackdrop').addEventListener('click', closeDrawer);
$('drawerLogout').addEventListener('click', async () => {
  closeDrawer();
  await callApiSafe('ADMIN_LOGOUT', {}, 'Logging out...');
  logout();
});

document.querySelectorAll('.drawer-item[data-view]').forEach(btn => {
  btn.addEventListener('click', () => {
    switchNav(btn.dataset.view);
    closeDrawer();
  });
});

function switchNav(view) {
  document.querySelectorAll('.drawer-item[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('#appShell .view').forEach(v => v.classList.add('hidden'));
  $('view-' + view).classList.remove('hidden');
  const titleKeys = { dashboard: 'nav_dashboard', bookings: 'nav_bookings', calendar: 'nav_calendar', settings: 'nav_settings' };
  $('pageTitle').textContent = t(titleKeys[view] || 'nav_dashboard');
  CURRENT_DETAIL_ID = null;
  // A deliberate move away from a booking's detail screen - not a
  // WhatsApp-share round trip - so it's correct to drop any saved
  // booking/QR focus here (section 8: never let one booking's saved
  // state bleed into an unrelated screen).
  saveAdminState({ section: view, bookingId: null, paymentCard: null });
  if (view === 'dashboard') loadDashboard();
  if (view === 'bookings') loadBookings();
  if (view === 'calendar') loadCalendar();
  if (view === 'settings') loadSettings();
}

// ---------------------------------------------------------------------
// DASHBOARD
// ---------------------------------------------------------------------
async function loadDashboard() {
  $('view-dashboard').querySelector('.stat-grid').style.opacity = '0.5';
  const res = await callApiQuiet('GET_DASHBOARD', {});
  $('view-dashboard').querySelector('.stat-grid').style.opacity = '1';
  if (res.success) {
    const d = res.data;
    $('statToday').textContent = d.today;
    $('statUpcoming').textContent = d.upcoming;
    $('statPending').textContent = d.pending;
    $('statPayment').textContent = d.payment_pending;
    $('statConfirmed').textContent = d.confirmed;
    $('statCancelled').textContent = d.cancelled;
  }
  refreshPushBanner();
}

function refreshPushBanner() {
  const on = localStorage.getItem('atr_admin_push_on') === '1';
  $('pushBannerText').textContent = on ? t('admin_push_on') : t('admin_push_off');
  $('btnEnableAdminPush').classList.toggle('hidden', on || !ONESIGNAL_APP_ID);
}

$('btnEnableAdminPush').addEventListener('click', async () => {
  if (!ONESIGNAL_APP_ID || typeof OneSignal === 'undefined') {
    alert('Push notifications are not configured yet. See docs/PUSH-NOTIFICATIONS-SETUP.md.');
    return;
  }
  try {
    await OneSignal.init({ appId: ONESIGNAL_APP_ID, allowLocalhostAsSecureOrigin: true });
    await OneSignal.Notifications.requestPermission();
    if (OneSignal.Notifications.permission) {
      const playerId = OneSignal.User.PushSubscription.id;
      if (playerId) {
        await callApiSafe('SAVE_PUSH_SUBSCRIPTION', { user_type: 'ADMIN', player_id: playerId }, 'Enabling notifications...');
        localStorage.setItem('atr_admin_push_on', '1');
      }
    }
  } catch (e) { /* ignore */ }
  refreshPushBanner();
});

// ---------------------------------------------------------------------
// BOOKINGS LIST
// ---------------------------------------------------------------------
document.querySelectorAll('.filter-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    CURRENT_FILTER = chip.dataset.filter;
    loadBookings();
  });
});

let searchDebounce;
$('bookingSearch').addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(loadBookings, 350);
});

async function loadBookings() {
  const search = $('bookingSearch').value.trim();
  const listEl = $('bookingList');
  listEl.innerHTML = inlineLoaderHtml('Loading bookings...');
  const res = await callApiQuiet('GET_BOOKINGS', { filter: CURRENT_FILTER, search: search });
  listEl.innerHTML = '';
  if (!res.success) {
    listEl.innerHTML = '<p class="field-msg error">' + res.error.message + '</p>';
    return;
  }
  CURRENT_BOOKINGS = res.data.bookings;
  if (!CURRENT_BOOKINGS.length) {
    listEl.innerHTML = '<p class="field-msg">No bookings found.</p>';
    return;
  }
  CURRENT_BOOKINGS.forEach(b => {
    const row = document.createElement('div');
    row.className = 'booking-row';
    row.innerHTML =
      '<div class="booking-row-top"><span>' + b.booking_id + '</span><span>' + fmtDate(b.travel_date) + '</span></div>' +
      '<div class="booking-row-mid">' + escapeHtml(b.customer_name) + ' &middot; ' + escapeHtml(b.pickup) + ' &rarr; ' + escapeHtml(b.destination) + '</div>' +
      '<span class="status-tag status-' + b.booking_status + '">' + b.booking_status.replace('_', ' ') + '</span>';
    row.addEventListener('click', () => openDetail(b.booking_id));
    listEl.appendChild(row);
  });
}

function fmtDate(d) {
  const dateObj = new Date((d instanceof Date ? d : (d + 'T00:00:00')));
  if (isNaN(dateObj.getTime())) return d;
  return dateObj.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function rupee(n) { if (n === '' || n === undefined || n === null) return '-'; return '\u20b9' + Number(n).toLocaleString('en-IN'); }

// ---------------------------------------------------------------------
// BOOKING DETAIL
// ---------------------------------------------------------------------
$('btnBackToList').addEventListener('click', () => switchNav('bookings'));

async function openDetail(bookingId) {
  CURRENT_DETAIL_ID = bookingId;
  document.querySelectorAll('#appShell .view').forEach(v => v.classList.add('hidden'));
  $('view-detail').classList.remove('hidden');
  $('pageTitle').textContent = bookingId;
  // Freshly selected from the list - reset any previous booking's saved
  // card so it can never bleed into this one (section 8).
  saveAdminState({ section: 'detail', bookingId: bookingId, paymentCard: null });
  await renderDetail();
}

// Which actions make sense for a given booking status (section 41)
function actionsForStatus_(b) {
  const allow = { fare: false, payment: false, verify: false, confirm: false, complete: false, cancel: false };
  const s = b.booking_status;
  if (['REQUESTED', 'FARE_PENDING', 'PAYMENT_PENDING', 'PAYMENT_SUBMITTED'].indexOf(s) !== -1) { allow.fare = true; allow.payment = true; }
  if (['PAYMENT_PENDING', 'PAYMENT_SUBMITTED'].indexOf(s) !== -1 && b.payment_status !== 'VERIFIED') allow.verify = true;
  if (b.payment_status === 'VERIFIED' && s !== 'CONFIRMED' && s !== 'COMPLETED' && s !== 'CANCELLED') allow.confirm = true;
  if (s === 'CONFIRMED') allow.complete = true;
  if (['REQUESTED', 'FARE_PENDING', 'PAYMENT_PENDING', 'PAYMENT_SUBMITTED', 'CONFIRMED'].indexOf(s) !== -1) allow.cancel = true;
  return allow;
}

async function renderDetail() {
  $('detailCard').innerHTML = inlineLoaderHtml('Loading booking...');
  const res = await callApiQuiet('GET_BOOKINGS', { search: CURRENT_DETAIL_ID });
  if (!res.success || !res.data.bookings.length) {
    $('detailCard').innerHTML = '<p class="field-msg error">Booking not found.</p>';
    LAST_RENDERED_BOOKING = null;
    return;
  }
  const b = res.data.bookings.find(x => x.booking_id === CURRENT_DETAIL_ID) || res.data.bookings[0];
  LAST_RENDERED_BOOKING = b;
  // Lightweight snapshot for the "same booking, same fare/advance/balance"
  // requirement even if a later restore has to work offline (section 4/8).
  saveAdminState({
    section: 'detail',
    bookingId: b.booking_id,
    bookingSnapshot: {
      customer_name: b.customer_name, whatsapp: b.whatsapp, travel_date: b.travel_date,
      pickup: b.pickup, destination: b.destination, passengers: b.passengers,
      fare: b.fare, toll: b.toll, other_charges: b.other_charges, discount: b.discount,
      final_total: b.final_total, advance_percent: b.advance_percent,
      advance_amount: b.advance_amount, balance_amount: b.balance_amount,
      booking_status: b.booking_status, payment_status: b.payment_status
    }
  });
  const card = $('detailCard');
  const allow = actionsForStatus_(b);
  const msgLang = localStorage.getItem('atr_msg_lang') || atrGetLang();

  card.innerHTML = `
    <div class="detail-row"><span>Booking ID</span><b>${b.booking_id}</b></div>
    <div class="detail-row"><span>Status</span><b>${b.booking_status}</b></div>
    <div class="detail-row"><span>Customer</span><b>${escapeHtml(b.customer_name)}</b></div>
    <div class="detail-row"><span>WhatsApp</span><b>${b.whatsapp}</b></div>
    <div class="detail-row"><span>Travel Date</span><b>${fmtDate(b.travel_date)}</b></div>
    <div class="detail-row"><span>Pickup</span><b>${escapeHtml(b.pickup)}</b></div>
    <div class="detail-row"><span>Drop</span><b>${escapeHtml(b.destination)}</b></div>

    <div class="detail-section-label">Pickup &amp; Destination Location</div>
    <label class="field-label">Pickup Location</label>
    <input type="text" id="dPickupLoc" class="field-input" value="${escapeHtml(b.pickup_location_name || '')}" placeholder="e.g. Kalwan Bus Stand" />
    <label class="field-label">Pickup Google Maps Link</label>
    <input type="url" id="dPickupMapsUrl" class="field-input" value="${escapeHtml(b.pickup_maps_url || '')}" placeholder="https://maps.google.com/..." />
    <div class="inline-row">
      ${b.pickup_maps_url ? `<a class="btn btn-secondary btn-inline" href="${b.pickup_maps_url}" target="_blank" rel="noopener">&#129517; Navigate to Pickup</a>` : `<span class="field-msg">Location not available</span>`}
    </div>
    <label class="field-label">Destination Location</label>
    <input type="text" id="dDestinationLoc" class="field-input" value="${escapeHtml(b.destination_location_name || '')}" placeholder="e.g. Nashik Road Railway Station" />
    <label class="field-label">Destination Google Maps Link</label>
    <input type="url" id="dDestinationMapsUrl" class="field-input" value="${escapeHtml(b.destination_maps_url || '')}" placeholder="https://maps.google.com/..." />
    <div class="inline-row">
      ${b.destination_maps_url ? `<a class="btn btn-secondary btn-inline" href="${b.destination_maps_url}" target="_blank" rel="noopener">&#129517; Navigate to Destination</a>` : `<span class="field-msg">Location not available</span>`}
    </div>
    <button class="btn btn-secondary" id="btnSaveLocation">Save Location</button>
    <p class="field-msg error" id="locationError"></p>
    <div class="detail-row"><span>Trip Type</span><b>${b.trip_type}</b></div>
    <div class="detail-row"><span>Passengers</span><b>${b.passengers}</b></div>
    <div class="detail-row"><span>Note</span><b>${escapeHtml(b.customer_note || '-')}</b></div>

    <div class="detail-section-label">${t('fare_entry')}</div>
    <label class="field-label">${t('trip_fare')}</label>
    <input type="number" id="dFare" class="field-input" value="${b.fare || ''}" />
    <label class="field-label">${t('toll')}</label>
    <input type="number" id="dToll" class="field-input" value="${b.toll || ''}" />
    <label class="field-label">${t('other_charges')}</label>
    <input type="number" id="dOther" class="field-input" value="${b.other_charges || ''}" />
    <label class="field-label">${t('discount')}</label>
    <input type="number" id="dDiscount" class="field-input" value="${b.discount || ''}" />
    <label class="field-label">${t('advance_percent')}</label>
    <input type="number" id="dAdvancePercent" class="field-input" value="${b.advance_percent || 50}" />
    <div class="detail-row"><span>${t('final_total')}</span><b>${rupee(b.final_total)}</b></div>
    <div class="detail-row"><span>${t('advance_amount')}</span><b>${rupee(b.advance_amount)}</b></div>
    <div class="detail-row"><span>${t('balance_amount')}</span><b>${rupee(b.balance_amount)}</b></div>
    ${allow.fare ? `<button class="btn btn-primary" id="btnSaveFare">${t('save_fare')}</button>` : ''}

    <div class="detail-section-label">${t('payment_section')}</div>
    <div class="detail-row"><span>${t('payment_status')}</span><b>${b.payment_status}</b></div>
    <label class="field-label">${t('message_language')}</label>
    <select id="msgLangSelect" class="field-input">
      <option value="en" ${msgLang === 'en' ? 'selected' : ''}>English</option>
      <option value="hi" ${msgLang === 'hi' ? 'selected' : ''}>Hindi</option>
      <option value="hl" ${msgLang === 'hl' ? 'selected' : ''}>Hinglish</option>
    </select>
    ${allow.payment && (b.advance_amount === '' || b.advance_amount === undefined || b.advance_amount === null) ? `<p class="field-msg">${t('hint_save_fare_first')}</p>` : ''}
    ${allow.payment ? `<button class="btn btn-secondary" id="btnGenPayment">${t('generate_payment_card')}</button>` : ''}
    <div id="cardPreviewArea"></div>
    ${allow.verify ? `<button class="btn btn-primary" id="btnVerifyPayment">${t('payment_verified_btn')}</button>` : ''}

    <div class="detail-section-label">${t('booking_actions')}</div>
    ${allow.confirm ? `<button class="btn btn-primary" id="btnConfirmBooking">${t('confirm_booking_btn')}</button>` : ''}
    ${allow.complete ? `<button class="btn btn-secondary" id="btnCompleteBooking">${t('complete_booking_btn')}</button>` : ''}
    ${allow.cancel ? `<button class="btn btn-danger" id="btnCancelBooking">${t('cancel_booking_btn')}</button>` : ''}
    <p class="field-msg error" id="detailError"></p>

    <div class="detail-section-label">${t('timeline')}</div>
    <div id="timelineArea">${inlineLoaderHtml()}</div>
  `;

  if (allow.fare) $('btnSaveFare').addEventListener('click', () => saveFare(b.booking_id));
  $('btnSaveLocation').addEventListener('click', () => saveLocation(b.booking_id));
  if (allow.payment) $('btnGenPayment').addEventListener('click', () => generatePayment(b.booking_id));
  // If fare/advance was already saved earlier (e.g. admin re-opening this
  // booking later), show the QR card immediately without requiring a
  // click - matches the "no separate save step" flow.
  if (allow.payment && b.advance_amount !== '' && b.advance_amount !== undefined && b.advance_amount !== null) {
    generatePayment(b.booking_id);
  }
  if (allow.verify) $('btnVerifyPayment').addEventListener('click', () => verifyPayment(b));
  if (allow.confirm) $('btnConfirmBooking').addEventListener('click', () => confirmBookingAction(b));
  if (allow.complete) $('btnCompleteBooking').addEventListener('click', () => completeBookingAction(b));
  if (allow.cancel) $('btnCancelBooking').addEventListener('click', () => cancelBookingAction(b));
  $('msgLangSelect').addEventListener('change', (e) => { localStorage.setItem('atr_msg_lang', e.target.value); });

  loadTimeline(b.booking_id);
}

function currentMsgLang_() {
  return localStorage.getItem('atr_msg_lang') || atrGetLang();
}

// Single-step flow (Kala Residency style): admin enters the fare and this
// one call (a) saves it, (b) lets the backend calculate the configured
// advance % automatically, and (c) immediately shows the UPI QR payment
// card - no separate "Generate Payment Card" click needed. UPI ID itself
// still comes from Admin Settings (server-side), never hardcoded here.
async function saveFare(bookingId) {
  const payload = {
    booking_id: bookingId,
    fare: $('dFare').value,
    toll: $('dToll').value,
    other_charges: $('dOther').value,
    discount: $('dDiscount').value,
    advance_percent: $('dAdvancePercent').value
  };
  const res = await callApiSafe('SET_FARE', payload, 'Saving fare...');
  if (!res.success) { $('detailError').textContent = res.error.message; return; }
  // renderDetail() re-fetches the booking and - since advance_amount is
  // now set - automatically shows the QR card itself (see renderDetail
  // below), so no separate "Generate Payment Card" call is needed here.
  await renderDetail();
}

async function saveLocation(bookingId) {
  $('locationError').textContent = '';
  const payload = {
    booking_id: bookingId,
    pickup_location_name: $('dPickupLoc').value.trim(),
    pickup_maps_url: $('dPickupMapsUrl').value.trim(),
    destination_location_name: $('dDestinationLoc').value.trim(),
    destination_maps_url: $('dDestinationMapsUrl').value.trim()
  };
  const res = await callApiSafe('UPDATE_BOOKING', payload, 'Saving location...');
  if (!res.success) { $('locationError').textContent = res.error.message; return; }
  renderDetail();
}

// ---------------------------------------------------------------------
// UPI QR generation - Kala Residency style workflow:
// no offline canvas QR engine, no popup window. The UPI link (built
// server-side from the admin-configurable UPI ID in Settings) is handed
// straight to the public QR image API and shown as a plain <img>, the
// same way Kala Residency's index.html does it. This call alone both
// fetches the QR data AND marks the booking's payment_status as QR_SENT,
// so it also works as the standalone "Generate Payment Card" action for
// a booking whose fare was already saved earlier (no need to save again).
// ---------------------------------------------------------------------
async function generatePayment(bookingId) {
  const area = $('cardPreviewArea');
  area.innerHTML = inlineLoaderHtml('Generating QR...');
  const res = await callApiQuiet('CREATE_PAYMENT_REQUEST', { booking_id: bookingId, lang: currentMsgLang_() });
  if (!res.success) {
    area.innerHTML = '<p class="field-msg error">' + (res.error && res.error.message ? res.error.message : t('err_save_fare_first')) + '</p>';
    return;
  }
  renderQrPaymentCard_(res.data);
}

// Builds the same style of QR image URL Kala Residency uses - the UPI
// link is sent to a public QR-image API and the returned PNG is shown
// directly, no offline/local QR rendering involved.
function buildQrImageUrl_(upiUri, size) {
  size = size || 260;
  return 'https://api.qrserver.com/v1/create-qr-code/?size=' + size + 'x' + size + '&data=' + encodeURIComponent(upiUri);
}

function renderQrPaymentCard_(d) {
  const area = $('cardPreviewArea');
  if (!d.upi_uri) {
    area.innerHTML = '<p class="field-msg error">UPI ID not configured yet. Please set it in Settings.</p>';
    return;
  }
  let html = `<img class="payment-card-preview qr-only-img" src="${buildQrImageUrl_(d.upi_uri, 260)}" alt="UPI Payment QR" crossorigin="anonymous" />`;
  html += `<div class="detail-row"><span>${t('final_total')}</span><b>${rupee(d.final_total)}</b></div>`;
  html += `<div class="detail-row"><span>${t('advance_amount')}</span><b>${rupee(d.advance_amount)}</b></div>`;
  html += `<div class="detail-row"><span>${t('balance_amount')}</span><b>${rupee(d.balance_amount)}</b></div>`;
  html += `<div class="payment-card-actions">
    <button class="btn btn-primary" id="btnShareCard">${t('share_card')}</button>
    <button class="btn btn-secondary" id="btnSaveJpg">Save JPG</button>
  </div>`;
  if (d.whatsapp_link) {
    html += `<a class="btn btn-secondary" href="${d.whatsapp_link}" target="_blank" rel="noopener">${t('whatsapp_message_btn')}</a>`;
  }
  html += `<div class="inline-row">
    <button class="btn btn-secondary btn-inline" id="btnRegenCard">${t('regenerate_card')}</button>
  </div>`;
  area.innerHTML = html;

  $('btnShareCard').addEventListener('click', async () => {
    const dataUrl = await buildFramedQrCardDataUrl_(d);
    if (!dataUrl) { alert('Could not generate card image. Please try again.'); return; }
    shareCardImage_(dataUrl, d.booking_id, d.whatsapp_link);
  });
  $('btnSaveJpg').addEventListener('click', async () => {
    const dataUrl = await buildFramedQrCardDataUrl_(d);
    if (!dataUrl) { alert('Could not generate card image. Please try again.'); return; }
    saveCardAsJpg_(dataUrl, d.booking_id);
  });
  $('btnRegenCard').addEventListener('click', () => generatePayment(d.booking_id));
}

function roundRect_(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Downloadable/shareable branded card: draws the same qrserver.com QR
// image onto a canvas frame with booking + payment details, exactly the
// way Kala Residency's generateFramedQRDataURL() composites its "Download
// QR" image. Business name comes from Admin Settings, never hardcoded.
function buildFramedQrCardDataUrl_(d) {
  return new Promise((resolve) => {
    const b = LAST_RENDERED_BOOKING || {};
    const businessName = (SETTINGS_CACHE && SETTINGS_CACHE.BUSINESS_NAME) || 'Anjali Tours & Travel';
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 420; canvas.height = 700;

    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 420, 700);

    const grad = ctx.createLinearGradient(0, 0, 420, 90);
    grad.addColorStop(0, '#0f766e'); grad.addColorStop(1, '#0891b2');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, 420, 90);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 20px Arial'; ctx.textAlign = 'center';
    ctx.fillText(businessName, 210, 38);
    ctx.font = '12px Arial';
    ctx.fillText('Car Booking Payment', 210, 62);

    const qrImg = new Image();
    qrImg.crossOrigin = 'Anonymous';
    qrImg.onload = () => {
      const qrSize = 200;
      ctx.drawImage(qrImg, (420 - qrSize) / 2, 105, qrSize, qrSize);

      const dy = 320;
      ctx.fillStyle = '#ECFEFF'; roundRect_(ctx, 25, dy, 370, 195, 10); ctx.fill();
      ctx.strokeStyle = '#A5F3FC'; ctx.lineWidth = 1.5; roundRect_(ctx, 25, dy, 370, 195, 10); ctx.stroke();
      ctx.fillStyle = '#0E7490'; ctx.font = 'bold 15px Arial'; ctx.textAlign = 'center';
      ctx.fillText('Booking & Payment Details', 210, dy + 22);

      const rows = [
        ['Booking ID:', b.booking_id || d.booking_id || '-'],
        ['Passenger:', b.customer_name || '-'],
        ['Travel Date:', d.travel_date_display || fmtDate(b.travel_date)],
        ['Route:', (d.pickup || b.pickup || '-') + ' -> ' + (d.destination || b.destination || '-')],
        ['Total Fare:', rupee(d.final_total)],
        ['Advance Paid:', rupee(d.advance_amount)],
        ['Balance Due:', rupee(d.balance_amount)]
      ];
      ctx.textAlign = 'left'; ctx.font = 'bold 11px Arial';
      rows.forEach(([label, val], i) => {
        const y = dy + 40 + i * 20;
        ctx.fillStyle = '#333'; ctx.fillText(label, 40, y);
        ctx.fillStyle = '#0E7490'; ctx.fillText(String(val), 160, y);
      });

      const ny = 535;
      ctx.fillStyle = '#FFF7ED'; roundRect_(ctx, 25, ny, 370, 90, 8); ctx.fill();
      ctx.strokeStyle = '#FED7AA'; ctx.lineWidth = 1; roundRect_(ctx, 25, ny, 370, 90, 8); ctx.stroke();
      ctx.fillStyle = '#92400E'; ctx.font = '10px Arial'; ctx.textAlign = 'left';
      const lines = [
        'Scan QR and pay the exact advance amount shown above.',
        'Send payment screenshot on this WhatsApp after paying.',
        'Booking is confirmed only after payment verification.'
      ];
      lines.forEach((l, i) => ctx.fillText(l, 35, ny + 20 + i * 20));

      ctx.fillStyle = '#999'; ctx.font = '9px Arial'; ctx.textAlign = 'center';
      ctx.fillText(businessName + ' - Payment Card', 210, 685);

      resolve(canvas.toDataURL('image/jpeg', 0.95));
    };
    qrImg.onerror = () => resolve('');
    qrImg.src = buildQrImageUrl_(d.upi_uri, 300);
  });
}

// Web Share API where supported (Android share sheet incl. WhatsApp);
// falls back to a plain download so the admin can still attach it
// manually. A normal web app cannot silently attach an image straight
// into a wa.me chat, so this is the most practical UX (section 15).
// Web Share API where supported (Android share sheet incl. WhatsApp) -
// the closest a web app can get to "send this image to WhatsApp".
// A normal website has NO way to silently attach an image straight into
// a specific customer's WhatsApp chat (no browser exposes that API, for
// good privacy/security reasons) - so when file-sharing isn't available,
// the next best thing is done automatically: download the image AND open
// that exact customer's WhatsApp chat, so the admin only has to tap the
// attach icon once, already in the right conversation (section 15).
async function shareCardImage_(dataUrl, bookingId, whatsappLink) {
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const file = new File([blob], 'Payment-Card-' + (bookingId || 'Card') + '.png', { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Payment Card', text: bookingId });
      return;
    }
  } catch (e) { /* fall through */ }

  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = 'Payment-Card-' + (bookingId || 'Card') + '.png';
  a.click();
  alert('Native sharing is not supported on this browser. The complete card was downloaded as PNG.');
}

async function saveCardAsJpg_(dataUrl, bookingId) {
  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = dataUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0);
    const jpgUrl = canvas.toDataURL('image/jpeg', 0.95);
    const a = document.createElement('a');
    a.href = jpgUrl;
    a.download = 'Payment-Card-' + (bookingId || 'Card') + '.jpg';
    a.click();
  } catch (e) {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = 'Payment-Card-' + (bookingId || 'Card') + '.png';
    a.click();
  }
}

async function verifyPayment(b) {
  const ok = await showConfirmDialog('confirm_payment_q', `${b.booking_id} &middot; ${escapeHtml(b.customer_name)}`);
  if (!ok) return;
  const res = await callApiSafe('VERIFY_PAYMENT', { booking_id: b.booking_id }, 'Verifying payment...');
  if (!res.success) { $('detailError').textContent = res.error.message; return; }
  await sendGeneratedMessage_(b.booking_id, 'PAYMENT_VERIFIED');
  renderDetail();
}

async function confirmBookingAction(b) {
  const ok = await showConfirmDialog('confirm_booking_q', `${b.booking_id} &middot; ${escapeHtml(b.customer_name)}`);
  if (!ok) return;
  const res = await callApiSafe('CONFIRM_BOOKING', { booking_id: b.booking_id }, 'Confirming booking...');
  if (!res.success) { $('detailError').textContent = res.error.message; return; }
  await sendGeneratedMessage_(b.booking_id, 'BOOKING_CONFIRMED');
  renderDetail();
}

async function completeBookingAction(b) {
  const ok = await showConfirmDialog('complete_booking_q', `${b.booking_id} &middot; ${escapeHtml(b.customer_name)}`);
  if (!ok) return;
  const res = await callApiSafe('COMPLETE_BOOKING', { booking_id: b.booking_id }, 'Updating...');
  if (!res.success) { $('detailError').textContent = res.error.message; return; }
  await sendGeneratedMessage_(b.booking_id, 'BOOKING_COMPLETED');
  renderDetail();
}

async function cancelBookingAction(b) {
  const ok = await showConfirmDialog('cancel_booking_q', `${b.booking_id} &middot; ${escapeHtml(b.customer_name)}`);
  if (!ok) return;
  const reason = prompt('Reason for cancellation (optional):') || '';
  const res = await callApiSafe('CANCEL_BOOKING', { booking_id: b.booking_id, reason }, 'Cancelling...');
  if (!res.success) { $('detailError').textContent = res.error.message; return; }
  await sendGeneratedMessage_(b.booking_id, 'BOOKING_CANCELLED', { cancel_reason: reason });
  renderDetail();
}

// Fetches the rendered WhatsApp message for the given template + booking
// and shows a "WhatsApp Message Ready" link under the action buttons.
// Never claims the message was actually sent (section 23) - only that
// the pre-filled WhatsApp chat is ready to open.
async function sendGeneratedMessage_(bookingId, templateKey, extra) {
  const res = await callApiSafe('GET_MESSAGE', {
    booking_id: bookingId,
    template_key: templateKey,
    lang: currentMsgLang_(),
    extra: extra || {}
  }, 'Preparing message...');
  if (!res.success) return;
  const area = $('cardPreviewArea') || $('detailError').parentElement;
  const link = document.createElement('a');
  link.className = 'btn btn-primary';
  link.href = res.data.whatsapp_link;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = t('whatsapp_ready');
  area.appendChild(link);
}

async function loadTimeline(bookingId) {
  const area = $('timelineArea');
  const res = await callApiQuiet('GET_BOOKING_TIMELINE', { booking_id: bookingId });
  if (!area) return;
  if (!res.success || !res.data.events.length) {
    area.innerHTML = '<p class="field-msg">No activity recorded yet.</p>';
    return;
  }
  area.innerHTML = res.data.events.map(ev => `
    <div class="timeline-row">
      <div class="timeline-dot"></div>
      <div class="timeline-body">
        <div class="timeline-action">${escapeHtml(ev.action.replace(/_/g, ' '))}</div>
        <div class="timeline-meta">${fmtDateTime(ev.timestamp)} &middot; ${escapeHtml(ev.user || '-')}</div>
        ${ev.details ? '<div class="timeline-details">' + escapeHtml(ev.details) + '</div>' : ''}
      </div>
    </div>`).join('');
}
function fmtDateTime(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ---------------------------------------------------------------------
// CALENDAR
// ---------------------------------------------------------------------
$('calPrev').addEventListener('click', () => { CAL_MONTH--; if (CAL_MONTH < 0) { CAL_MONTH = 11; CAL_YEAR--; } loadCalendar(); });
$('calNext').addEventListener('click', () => { CAL_MONTH++; if (CAL_MONTH > 11) { CAL_MONTH = 0; CAL_YEAR++; } loadCalendar(); });
$('btnBlockDate').addEventListener('click', async () => {
  const date = $('blockDate').value;
  const reason = $('blockReason').value.trim();
  if (!date) { alert('Please select a date to block.'); return; }
  const res = await callApiSafe('BLOCK_DATE', { date, reason }, 'Blocking date...');
  if (!res.success) { alert(res.error.message); return; }
  $('blockReason').value = '';
  loadCalendar();
});

async function loadCalendar() {
  if (CAL_YEAR === undefined) {
    const now = new Date();
    CAL_YEAR = now.getFullYear();
    CAL_MONTH = now.getMonth();
  }
  const first = new Date(CAL_YEAR, CAL_MONTH, 1);
  const last = new Date(CAL_YEAR, CAL_MONTH + 1, 0);
  const fromDate = isoDate(first);
  const toDate = isoDate(last);
  $('calMonthLabel').textContent = first.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  const grid = $('calGrid');
  grid.innerHTML = inlineLoaderHtml('Loading calendar...');
  const res = await callApiQuiet('GET_CALENDAR', { from_date: fromDate, to_date: toDate });
  grid.innerHTML = '';
  if (!res.success) { grid.innerHTML = '<p class="field-msg error">' + res.error.message + '</p>'; return; }

  const calData = res.data.calendar;
  const startWeekday = first.getDay();
  for (let i = 0; i < startWeekday; i++) {
    const empty = document.createElement('div');
    empty.className = 'cal-cell empty';
    grid.appendChild(empty);
  }
  for (let day = 1; day <= last.getDate(); day++) {
    const dateStr = isoDate(new Date(CAL_YEAR, CAL_MONTH, day));
    const cell = document.createElement('div');
    cell.className = 'cal-cell';
    cell.textContent = day;
    const entries = calData[dateStr] || [];
    if (entries.length) {
      const hasConfirmed = entries.some(e => e.status === 'CONFIRMED');
      const hasBlocked = entries.some(e => e.status === 'BLOCKED');
      const hasPending = entries.some(e => ['REQUESTED', 'FARE_PENDING', 'PAYMENT_PENDING', 'PAYMENT_SUBMITTED'].indexOf(e.status) !== -1);
      const dot = document.createElement('span');
      dot.className = 'dot ' + (hasBlocked ? 'dot-blocked' : hasConfirmed ? 'dot-confirmed' : hasPending ? 'dot-pending' : '');
      cell.appendChild(dot);
      cell.title = entries.map(e => e.status + (e.customer_name ? ' - ' + e.customer_name : '')).join(', ');
    }
    grid.appendChild(cell);
  }
}
function isoDate(d) { return d.toISOString().slice(0, 10); }

// ---------------------------------------------------------------------
// SETTINGS
// ---------------------------------------------------------------------
async function loadSettings() {
  applyI18n();
  const res = await callApiQuiet('GET_SETTINGS_ADMIN', {});
  if (res.success) {
    const s = res.data;
    SETTINGS_CACHE = s;
    $('setBusinessName').value = s.BUSINESS_NAME || '';
    $('setWhatsApp').value = s.WHATSAPP_NUMBER || '';
    $('setContactNumber').value = s.CONTACT_NUMBER || '';
    $('setVehicle').value = s.VEHICLE_NAME || '';
    $('setBaseCity').value = s.BASE_CITY || '';
    $('setAddress').value = s.BUSINESS_ADDRESS || '';
    $('setTagline').value = s.TAGLINE || '';
    $('setAdvancePercent').value = s.ADVANCE_PERCENT || 50;
    $('setHoldMinutes').value = s.HOLD_MINUTES || 60;
    $('setUpiId').value = s.UPI_ID || '';
    $('setUpiName').value = s.UPI_BUSINESS_NAME || '';
    $('setUpiQrUrl').value = s.UPI_QR_IMAGE_URL || '';
    $('setCardFooter').value = s.CARD_FOOTER_TEXT || '';
    $('setCardLanguage').value = s.CARD_LANGUAGE || 'EN_HI';
    renderLogoPreview(s.BUSINESS_LOGO_BASE64 || '');
  }
  await loadCitiesAdmin();
  await loadPickupLocationsAdmin();
  await loadTemplateEditor();
  await loadNotificationSettings();
}

$('btnSaveBusiness').addEventListener('click', async () => {
  const updates = {
    BUSINESS_NAME: $('setBusinessName').value.trim(),
    WHATSAPP_NUMBER: $('setWhatsApp').value.trim(),
    CONTACT_NUMBER: $('setContactNumber').value.trim(),
    VEHICLE_NAME: $('setVehicle').value.trim(),
    BASE_CITY: $('setBaseCity').value.trim(),
    BUSINESS_ADDRESS: $('setAddress').value.trim(),
    TAGLINE: $('setTagline').value.trim(),
    ADVANCE_PERCENT: $('setAdvancePercent').value,
    HOLD_MINUTES: $('setHoldMinutes').value
  };
  const res = await callApiSafe('UPDATE_SETTINGS', { updates }, 'Saving...');
  alert(res.success ? 'Business settings saved.' : res.error.message);
});

$('btnSaveUpi').addEventListener('click', async () => {
  const updates = {
    UPI_ID: $('setUpiId').value.trim(),
    UPI_BUSINESS_NAME: $('setUpiName').value.trim(),
    UPI_QR_IMAGE_URL: $('setUpiQrUrl').value.trim()
  };
  const res = await callApiSafe('UPDATE_SETTINGS', { updates }, 'Saving...');
  alert(res.success ? 'UPI settings saved.' : res.error.message);
});

// ---- Logo management (section 12) ----
function renderLogoPreview(base64) {
  const area = $('logoPreviewArea');
  area.innerHTML = base64
    ? `<img src="${base64}" class="logo-preview-img" alt="Business logo" />`
    : '<div class="logo-preview-placeholder">No logo uploaded</div>';
}

$('btnUploadLogo').addEventListener('click', async () => {
  const file = $('logoFileInput').files[0];
  if (!file) { alert('Please choose a PNG or JPG logo file first.'); return; }
  showLoading('Processing logo...');
  try {
    const resized = await resizeLogoFile(file, 320);
    hideLoading();
    renderLogoPreview(resized);
    const res = await callApiSafe('SAVE_BUSINESS_LOGO', { logo_base64: resized }, 'Saving logo...');
    if (!res.success) alert(res.error.message);
    else { SETTINGS_CACHE.BUSINESS_LOGO_BASE64 = resized; }
  } catch (e) {
    hideLoading();
    alert('Could not process that image. Please try a PNG or JPG file.');
  }
});

$('btnRemoveLogo').addEventListener('click', async () => {
  const res = await callApiSafe('SAVE_BUSINESS_LOGO', { logo_base64: '' }, 'Removing logo...');
  if (res.success) { renderLogoPreview(''); SETTINGS_CACHE.BUSINESS_LOGO_BASE64 = ''; }
  else alert(res.error.message);
});

$('btnSaveBranding').addEventListener('click', async () => {
  const updates = {
    CARD_FOOTER_TEXT: $('setCardFooter').value.trim(),
    CARD_LANGUAGE: $('setCardLanguage').value
  };
  const res = await callApiSafe('UPDATE_SETTINGS', { updates }, 'Saving...');
  if (res.success) SETTINGS_CACHE.CARD_LANGUAGE = updates.CARD_LANGUAGE;
  alert(res.success ? 'Branding settings saved.' : res.error.message);
});

// ---- Cities ----
async function loadCitiesAdmin() {
  const list = $('cityList');
  list.innerHTML = inlineLoaderHtml('Loading cities...');
  const res = await callApiQuiet('GET_CITIES_ADMIN', {});
  list.innerHTML = '';
  if (!res.success) { list.innerHTML = '<p class="field-msg error">' + res.error.message + '</p>'; return; }
  res.data.cities.forEach(c => {
    const active = String(c.active).toUpperCase() !== 'FALSE';
    const row = document.createElement('div');
    row.className = 'city-item';
    row.innerHTML = `<span>${escapeHtml(c.city_name)} ${active ? '' : '(disabled)'}</span>
      <button data-id="${c.city_id}" data-active="${active}">${active ? 'Disable' : 'Enable'}</button>`;
    row.querySelector('button').addEventListener('click', async (e) => {
      const nowActive = e.target.dataset.active === 'true';
      await callApiSafe('UPDATE_CITY', { city_id: e.target.dataset.id, active: !nowActive }, 'Updating...');
      loadCitiesAdmin();
    });
    list.appendChild(row);
  });
}

$('btnAddCity').addEventListener('click', async () => {
  const name = $('newCityName').value.trim();
  if (!name) return;
  const res = await callApiSafe('ADD_CITY', { city_name: name }, 'Adding city...');
  if (res.success) { $('newCityName').value = ''; loadCitiesAdmin(); }
  else alert(res.error.message);
});

// ---- Pickup Locations (drives the Customer app's Pickup dropdown -
// see PickupLocations.gs. Destination is free customer text and has no
// admin-managed list at all.) ----
let PICKUP_LOCATIONS_ADMIN = [];

async function loadPickupLocationsAdmin() {
  const list = $('pickupLocList');
  list.innerHTML = inlineLoaderHtml('Loading pickup locations...');
  const res = await callApiQuiet('GET_PICKUP_LOCATIONS_ADMIN', {});
  list.innerHTML = '';
  if (!res.success) { list.innerHTML = '<p class="field-msg error">' + res.error.message + '</p>'; return; }
  PICKUP_LOCATIONS_ADMIN = res.data.locations || [];
  if (!PICKUP_LOCATIONS_ADMIN.length) {
    list.innerHTML = '<p class="field-msg">No pickup locations yet.</p>';
    return;
  }
  PICKUP_LOCATIONS_ADMIN.forEach(loc => {
    const active = loc.active === true || String(loc.active).toUpperCase() === 'TRUE';
    const row = document.createElement('div');
    row.className = 'pickup-loc-item';
    row.innerHTML = `
      <div class="pickup-loc-item-header">
        <span>${escapeHtml(loc.en)}${active ? '' : ' (disabled)'}</span>
      </div>
      <label class="field-label">English Name *</label>
      <input type="text" class="field-input ploc-en" value="${escapeHtml(loc.en)}" />
      <label class="field-label">Hindi Name</label>
      <input type="text" class="field-input ploc-hi" value="${escapeHtml(loc.hi || '')}" />
      <label class="field-label">Marathi Name</label>
      <input type="text" class="field-input ploc-mr" value="${escapeHtml(loc.mr || '')}" />
      <label class="field-label">Hinglish Name</label>
      <input type="text" class="field-input ploc-hinglish" value="${escapeHtml(loc.hinglish || '')}" />
      <label class="field-label">Sort Order</label>
      <input type="number" class="field-input ploc-sort" value="${Number(loc.sortOrder) || 0}" />
      <div class="pickup-loc-item-actions">
        <button class="btn btn-secondary btn-inline ploc-save">Save</button>
        <button class="btn btn-secondary btn-inline ploc-toggle">${active ? 'Disable' : 'Enable'}</button>
        <button class="btn btn-danger btn-inline ploc-delete">Delete</button>
      </div>
      <p class="field-msg error ploc-error"></p>`;

    row.querySelector('.ploc-save').addEventListener('click', async () => {
      const errEl = row.querySelector('.ploc-error');
      errEl.textContent = '';
      const en = row.querySelector('.ploc-en').value.trim();
      if (!en) { errEl.textContent = 'English name is required.'; return; }
      const res2 = await callApiSafe('UPDATE_PICKUP_LOCATION', {
        id: loc.id,
        en: en,
        hi: row.querySelector('.ploc-hi').value.trim(),
        mr: row.querySelector('.ploc-mr').value.trim(),
        hinglish: row.querySelector('.ploc-hinglish').value.trim(),
        sort_order: row.querySelector('.ploc-sort').value
      }, 'Saving...');
      if (!res2.success) { errEl.textContent = res2.error.message; return; }
      loadPickupLocationsAdmin();
    });

    row.querySelector('.ploc-toggle').addEventListener('click', async () => {
      const errEl = row.querySelector('.ploc-error');
      const res2 = await callApiSafe('TOGGLE_PICKUP_LOCATION', { id: loc.id, active: !active }, 'Updating...');
      if (!res2.success) { errEl.textContent = res2.error.message; return; }
      loadPickupLocationsAdmin();
    });

    row.querySelector('.ploc-delete').addEventListener('click', async () => {
      const ok = await showConfirmDialog('confirm_delete_pickup_q', escapeHtml(loc.en));
      if (!ok) return;
      const errEl = row.querySelector('.ploc-error');
      const res2 = await callApiSafe('DELETE_PICKUP_LOCATION', { id: loc.id }, 'Deleting...');
      if (!res2.success) { errEl.textContent = res2.error.message; return; }
      loadPickupLocationsAdmin();
    });

    list.appendChild(row);
  });
}

$('btnAddPickup').addEventListener('click', async () => {
  const en = $('newPickupEn').value.trim();
  const errEl = $('pickupLocError');
  errEl.textContent = '';
  if (!en) { errEl.textContent = 'Please enter an English name.'; return; }
  const res = await callApiSafe('ADD_PICKUP_LOCATION', {
    en: en,
    hi: $('newPickupHi').value.trim(),
    mr: $('newPickupMr').value.trim(),
    hinglish: $('newPickupHinglish').value.trim()
  }, 'Adding...');
  if (!res.success) { errEl.textContent = res.error.message; return; }
  $('newPickupEn').value = '';
  $('newPickupHi').value = '';
  $('newPickupMr').value = '';
  $('newPickupHinglish').value = '';
  loadPickupLocationsAdmin();
});

// ---- Message templates (section 24) ----
async function loadTemplateEditor() {
  const area = $('templateEditor');
  area.innerHTML = inlineLoaderHtml('Loading templates...');
  const res = await callApiQuiet('GET_MESSAGE_TEMPLATES', {});
  if (!res.success) { area.innerHTml = '<p class="field-msg error">' + res.error.message + '</p>'; return; }
  const templates = res.data.templates; // { KEY: { en: '', hi: '', hl: '' } }
  area.innerHTML = '';
  TEMPLATE_KEYS.forEach(key => {
    const wrap = document.createElement('div');
    wrap.className = 'template-block';
    const values = templates[key] || { en: '', hi: '', hl: '' };
    wrap.innerHTML = `
      <div class="detail-section-label">${key.replace(/_/g, ' ')}</div>
      <div class="template-tabs">
        <button class="template-tab active" data-lang="en">EN</button>
        <button class="template-tab" data-lang="hi">HI</button>
        <button class="template-tab" data-lang="hl">HL</button>
      </div>
      <textarea class="field-input template-textarea" data-lang="en" rows="6">${escapeHtml(values.en)}</textarea>
      <textarea class="field-input template-textarea hidden" data-lang="hi" rows="6">${escapeHtml(values.hi)}</textarea>
      <textarea class="field-input template-textarea hidden" data-lang="hl" rows="6">${escapeHtml(values.hl)}</textarea>
      <p class="field-msg">Placeholders: {{booking_id}} {{customer_name}} {{travel_date}} {{pickup}} {{drop}} {{trip_type}} {{total_fare}} {{advance}} {{balance}} {{payment_reference}} {{cancel_reason}} {{business_name}} {{whatsapp_number}}</p>
      <button class="btn btn-primary btn-inline btn-save-template" data-key="${key}">${t('save_template')}</button>
    `;
    wrap.querySelectorAll('.template-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        wrap.querySelectorAll('.template-tab').forEach(x => x.classList.remove('active'));
        tab.classList.add('active');
        wrap.querySelectorAll('.template-textarea').forEach(ta => ta.classList.toggle('hidden', ta.dataset.lang !== tab.dataset.lang));
      });
    });
    wrap.querySelector('.btn-save-template').addEventListener('click', async () => {
      const payload = { template_key: key };
      wrap.querySelectorAll('.template-textarea').forEach(ta => { payload[ta.dataset.lang] = ta.value; });
      const res2 = await callApiSafe('SAVE_MESSAGE_TEMPLATE', payload, 'Saving template...');
      alert(res2.success ? 'Template saved.' : res2.error.message);
    });
    area.appendChild(wrap);
  });
}

// ---- Notification settings (section 34) ----
async function loadNotificationSettings() {
  const area = $('notificationSettingsArea');
  area.innerHTML = inlineLoaderHtml('Loading...');
  const res = await callApiQuiet('GET_NOTIFICATION_SETTINGS', {});
  if (!res.success) { area.innerHTML = '<p class="field-msg error">' + res.error.message + '</p>'; return; }
  const settings = res.data.settings;
  const events = [
    ['new_booking', 'event_new_booking'], ['payment_submitted', 'event_payment_submitted'],
    ['payment_verified', 'event_payment_verified'], ['booking_confirmed', 'event_booking_confirmed'],
    ['booking_cancelled', 'event_booking_cancelled'], ['booking_completed', 'event_booking_completed'],
    ['upcoming_ride', 'event_upcoming_ride']
  ];
  area.innerHTML = events.map(([key, labelKey]) => `
    <label class="toggle-row">
      <span>${t(labelKey)}</span>
      <input type="checkbox" class="notif-toggle" data-key="${key}" ${settings[key] !== 'false' ? 'checked' : ''} />
    </label>`).join('');
  area.querySelectorAll('.notif-toggle').forEach(cb => {
    cb.addEventListener('change', async () => {
      await callApiSafe('SAVE_NOTIFICATION_SETTINGS', { key: cb.dataset.key, enabled: cb.checked }, 'Saving...');
    });
  });
}

// ---------------------------------------------------------------------
// PWA SERVICE WORKER + BOOTSTRAP
// ---------------------------------------------------------------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js', { updateViaCache: 'none' }).catch(() => {});
  });
}

applyI18n();
(function bootstrap() {
  if (TOKEN) {
    enterApp();
  } else {
    $('view-login').classList.remove('hidden');
  }
})();

// ---------------------------------------------------------------------
// BACK/RESTORE NAVIGATION (sections 4-6): after Admin -> Booking ->
// Generate QR -> Share/WhatsApp -> Back, the panel must reappear exactly
// as it was, not reset to the dashboard or a fresh login. None of these
// listeners block or intercept the actual Back navigation - the browser
// back button, bfcache, and history all keep working normally; this
// only restores in-app state once we're back.
// ---------------------------------------------------------------------
window.addEventListener('pageshow', (event) => {
  // event.persisted === true means the page came back from bfcache (JS
  // state technically intact) - but some mobile browsers/PWAs discard
  // backgrounded tabs and reload instead, in which case this fires as
  // part of a completely fresh boot. Either way, re-check saved state.
  if (!TOKEN) return;
  if (event.persisted || !CURRENT_DETAIL_ID) {
    restoreAdminStateIfAny();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !TOKEN) return;
  // Only act if this tab's in-memory state looks like it was reset
  // (e.g. the OS discarded the background tab and reloaded it) - if
  // CURRENT_DETAIL_ID is already set, nothing was lost and there's
  // nothing to restore.
  if (!CURRENT_DETAIL_ID && $('appShell') && !$('appShell').classList.contains('hidden')) {
    restoreAdminStateIfAny();
  }
});

window.addEventListener('popstate', () => {
  if (!TOKEN) return;
  if (!CURRENT_DETAIL_ID) restoreAdminStateIfAny();
});
