// ---------------------------------------------------------------------
// Anjali Tours & Travel - Customer App Logic (vanilla JS, no frameworks)
// ---------------------------------------------------------------------

let SETTINGS = {};
let PICKUP_LOCATIONS = [];
let submitting = false;
let LAST_BOOKING_ID = null;

// Safe UI fallback for a first visit, a temporarily unavailable API, or an
// older Apps Script deployment that has not yet been updated to V10. Booking
// submission is still validated by the backend; this only prevents a blank
// Pickup dropdown from making the form unusable.
const DEFAULT_PICKUP_LOCATIONS = [
  { id: 'kalwan', en: 'Kalwan', hi: 'कलवण', hinglish: 'Kalwan', sortOrder: 1 },
  { id: 'abhona', en: 'Abhona', hi: 'अभोणा', hinglish: 'Abhona', sortOrder: 2 },
  { id: 'satana', en: 'Satana', hi: 'सटाणा', hinglish: 'Satana', sortOrder: 3 },
  { id: 'deola', en: 'Deola', hi: 'देवला', hinglish: 'Deola', sortOrder: 4 },
  { id: 'chandwad', en: 'Chandwad', hi: 'चांदवड़', hinglish: 'Chandwad', sortOrder: 5 },
  { id: 'dindori', en: 'Dindori', hi: 'दिंडोरी', hinglish: 'Dindori', sortOrder: 6 },
  { id: 'surgana', en: 'Surgana', hi: 'सुरगाणा', hinglish: 'Surgana', sortOrder: 7 },
  { id: 'malegaon', en: 'Malegaon', hi: 'मालेगांव', hinglish: 'Malegaon', sortOrder: 8 },
  { id: 'yeola', en: 'Yeola', hi: 'येवला', hinglish: 'Yeola', sortOrder: 9 },
  { id: 'nashik', en: 'Nashik', hi: 'नासिक', hinglish: 'Nashik', sortOrder: 10 }
];

const $ = (id) => document.getElementById(id);

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  $('view-' + name).classList.remove('hidden');
  window.scrollTo(0, 0);
}

function showLoading(text) {
  $('loadingText').textContent = text || 'Loading...';
  $('loadingOverlay').classList.remove('hidden');
}
function hideLoading() {
  $('loadingOverlay').classList.add('hidden');
}

// ---------------------------------------------------------------------
// API HELPER
// ---------------------------------------------------------------------
async function callApi(action, payload) {
  const body = Object.assign({ action: action }, payload || {});
  // Timeout guard: without this, a hung request (dead deployment, flaky
  // mobile network) leaves the customer staring at a spinner forever with
  // no way out. 15s is generous for Apps Script's typical cold-start.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Request timed out');
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
  if (!res.ok) throw new Error('API HTTP ' + res.status);
  return res.json();
}

function escapeHtmlCustomer(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function whatsAppLink(number, message) {
  const digits = String(number || '').replace(/\D/g, '');
  const withCountry = digits.length === 10 ? '91' + digits : digits;
  return 'https://wa.me/' + withCountry + (message ? '?text=' + encodeURIComponent(message) : '');
}

// ---------------------------------------------------------------------
// GOOGLE MAPS PICKUP / DESTINATION (low-cost, URL-based - no paid Maps
// JavaScript/Places API). See docs/PUSH-NOTIFICATIONS-SETUP.md sibling
// doc for the equivalent Maps guide.
// ---------------------------------------------------------------------
var LOC_STATE = {
  pickup: { maps_url: '', latitude: '', longitude: '' },
  destination: { maps_url: '', latitude: '', longitude: '' }
};

function isLikelyGoogleMapsUrl(url) {
  if (!url) return false;
  return /^https?:\/\/(www\.)?(google\.[a-z.]+\/maps|maps\.google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl\/maps)/i.test(url.trim());
}

function openMapsSearch(target) {
  let query = '';
  let focusEl;
  if (target === 'pickup') {
    const placeVal = $('pickupPlace').value.trim();
    const pickupSelect = $('pickup');
    const pickupLabel = pickupSelect.selectedOptions[0] ? pickupSelect.selectedOptions[0].text : '';
    query = placeVal || pickupLabel;
    focusEl = $('pickupPlace');
  } else {
    query = $('destination').value.trim();
    focusEl = $('destination');
  }
  if (!query) {
    focusEl.focus();
    return;
  }
  const url = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(query);
  window.open(url, '_blank', 'noopener');
  // Store the search URL itself as a reasonable maps_url fallback so the
  // booking still carries a usable link even if the customer never
  // pastes back a more precise share link.
  LOC_STATE[target].maps_url = url;
}

function useCurrentLocation(target) {
  const msgEl = target === 'pickup' ? $('pickupLocMsg') : $('destinationLocMsg');
  if (!navigator.geolocation) {
    msgEl.textContent = t('location_denied');
    return;
  }
  msgEl.textContent = t('date_checking'); // reuse generic "working..." copy
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      LOC_STATE[target].latitude = lat;
      LOC_STATE[target].longitude = lng;
      LOC_STATE[target].maps_url = 'https://www.google.com/maps?q=' + lat + ',' + lng;
      msgEl.textContent = '';
      const linkInput = target === 'pickup' ? $('pickupMapsLink') : $('destinationMapsLink');
      linkInput.value = LOC_STATE[target].maps_url;
      linkInput.classList.remove('hidden');
    },
    () => { msgEl.textContent = t('location_denied'); },
    { timeout: 10000 }
  );
}

$('btnPickupMaps').addEventListener('click', () => openMapsSearch('pickup'));
$('btnDestinationMaps').addEventListener('click', () => openMapsSearch('destination'));
$('btnPickupCurrentLoc').addEventListener('click', () => useCurrentLocation('pickup'));
$('btnDestinationCurrentLoc').addEventListener('click', () => useCurrentLocation('destination'));

$('togglePickupLink').addEventListener('click', () => $('pickupMapsLink').classList.toggle('hidden'));
$('toggleDestinationLink').addEventListener('click', () => $('destinationMapsLink').classList.toggle('hidden'));

function validateMapsLinkInput(target) {
  const linkInput = target === 'pickup' ? $('pickupMapsLink') : $('destinationMapsLink');
  const msgEl = target === 'pickup' ? $('pickupLocMsg') : $('destinationLocMsg');
  const val = linkInput.value.trim();
  if (!val) { msgEl.textContent = ''; return true; }
  if (!isLikelyGoogleMapsUrl(val)) {
    msgEl.textContent = t('invalid_maps_link');
    msgEl.className = 'field-msg unavailable';
    return false;
  }
  msgEl.textContent = '';
  LOC_STATE[target].maps_url = val;
  return true;
}
$('pickupMapsLink').addEventListener('change', () => validateMapsLinkInput('pickup'));
$('destinationMapsLink').addEventListener('change', () => validateMapsLinkInput('destination'));

// ---------------------------------------------------------------------
// LANGUAGE
// ---------------------------------------------------------------------
document.querySelectorAll('.lang-pill').forEach(btn => {
  btn.addEventListener('click', () => {
    atrSetLang(btn.dataset.lang);
    applyI18n();
    applySettingsToUi();
    populatePickupSelect();
  });
});

// ---------------------------------------------------------------------
// INIT
// ---------------------------------------------------------------------
// Speed trick: settings + cities barely ever change, so we show the last
// known copy from localStorage INSTANTLY (no spinner, no blank screen)
// and quietly refresh from the server in the background. First-ever visit
// (no cache yet) shows a lightweight skeleton instead of a full-screen
// blocking spinner, and a single combined GET_BOOTSTRAP call replaces the
// old two separate requests to cut round-trip time roughly in half.
// v3: bootstrap now carries pickupLocations (Pickup dropdown source) and the
// cache is bumped again so stale empty-list data cannot hide the fallback.
const BOOTSTRAP_CACHE_KEY = 'atr_bootstrap_cache_v3';

function readBootstrapCache() {
  try {
    const raw = localStorage.getItem(BOOTSTRAP_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function writeBootstrapCache(data) {
  try { localStorage.setItem(BOOTSTRAP_CACHE_KEY, JSON.stringify(data)); } catch (e) {}
}

async function init() {
  console.log('Anjali customer app - APP_VERSION:', APP_VERSION, '- API_URL:', API_URL);
  callApi('GET_HEALTH').then(res => {
    if (res && res.success) console.log('Anjali backend GET_HEALTH:', res.data);
  }).catch(() => {});

  applyI18n();
  const cached = readBootstrapCache();

  if (cached) {
    // Instant paint from cache - no spinner at all.
    SETTINGS = cached.settings;
    PICKUP_LOCATIONS = cached.pickupLocations || [];
    applySettingsToUi();
    populatePickupSelect();
    showView('home');
    refreshBootstrapInBackground();
    return;
  }

  // No cache yet (first-ever visit on this device) - show skeleton, not a
  // full blocking overlay, while the first real load happens. The pickup
  // select gets its own "Loading..." state so it's clear it's not just
  // broken while GET_BOOTSTRAP is in flight.
  showSkeleton();
  showPickupLoadingState();
  const ok = await refreshBootstrapInBackground();
  if (!ok) showCityLoadError();
}

async function refreshBootstrapInBackground() {
  try {
    const res = await callApi('GET_BOOTSTRAP');
    if (!res.success) {
      console.error('Anjali pickup loader: GET_BOOTSTRAP failed', res.error);
      if (!PICKUP_LOCATIONS.length) {
        PICKUP_LOCATIONS = DEFAULT_PICKUP_LOCATIONS.slice();
        populatePickupSelect();
      }
      return false;
    }
    SETTINGS = res.data.settings;
    // V10 uses pickupLocations. Keep compatibility with an older deployment
    // that still returns cities, so the dropdown does not silently disappear
    // while the Apps Script deployment is being rolled forward.
    PICKUP_LOCATIONS = res.data.pickupLocations || (res.data.cities || []).map((city, index) => ({
      id: String(city.id || city.city_id || city.name || city.city_name || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
      en: String(city.en || city.name || city.city_name || '').trim(),
      hi: String(city.hi || '').trim(),
      hinglish: String(city.hinglish || city.en || city.name || city.city_name || '').trim(),
      sortOrder: Number(city.sortOrder || city.sort_order || index + 1)
    }));
    if (!PICKUP_LOCATIONS.length) PICKUP_LOCATIONS = DEFAULT_PICKUP_LOCATIONS.slice();
    // Never persist an empty pickup list as if it were a good cache - a
    // transient bad response should not overwrite a previously-working
    // cache and get "stuck" for the next visit (section 18).
    if (PICKUP_LOCATIONS.length > 0) {
      writeBootstrapCache({ settings: SETTINGS, pickupLocations: PICKUP_LOCATIONS });
    } else {
      console.error('Anjali pickup loader: GET_BOOTSTRAP returned zero pickup locations - not caching this response');
    }
    applySettingsToUi();
    populatePickupSelect();
    if (!document.getElementById('view-home').classList.contains('hidden') || skeletonShowing) {
      showView('home');
    }
    return true;
  } catch (err) {
    console.error('Anjali pickup loader: bootstrap request failed', err);
    if (!PICKUP_LOCATIONS.length) {
      PICKUP_LOCATIONS = DEFAULT_PICKUP_LOCATIONS.slice();
      populatePickupSelect();
    }
    return false;
  }
}

// Console debugging helper - type clearBootstrapCache() in the browser
// console then reload to force a fully fresh GET_BOOTSTRAP fetch.
function clearBootstrapCache() {
  localStorage.removeItem(BOOTSTRAP_CACHE_KEY);
  console.log('Anjali: bootstrap cache cleared. Reload the page.');
}
window.clearBootstrapCache = clearBootstrapCache;

// Section 5/7: never fail silently. If the very first load (no cache to
// fall back on) fails, tell the customer plainly and give them a Retry
// that re-runs the exact same loader - no separate/duplicated API logic.
function showCityLoadError() {
  skeletonShowing = false;
  $('cityErrorMsg').textContent = t('err_locations_unavailable');
  // Keep the booking form reachable with the safe default list. The console
  // still records the real API error, and submission remains server-validated.
  if (!PICKUP_LOCATIONS.length) PICKUP_LOCATIONS = DEFAULT_PICKUP_LOCATIONS.slice();
  populatePickupSelect();
  showView('home');
}

async function retryCityLoading() {
  $('btnRetryCities').disabled = true;
  showPickupLoadingState();
  const ok = await refreshBootstrapInBackground();
  $('btnRetryCities').disabled = false;
  if (!ok) {
    showCityLoadError();
  } else {
    showView('home');
  }
}
$('btnRetryCities').addEventListener('click', retryCityLoading);

let skeletonShowing = false;
function showSkeleton() {
  skeletonShowing = true;
  $('homeTitle').innerHTML = '<span class="skeleton-line skeleton-w80"></span>';
  $('homeVehicle').innerHTML = '<span class="skeleton-line skeleton-w40"></span>';
  showView('home');
}

function applySettingsToUi() {
  skeletonShowing = false;
  document.title = (SETTINGS.BUSINESS_NAME || 'Anjali Tours & Travel') + ' - Booking';
  $('vehicleLabel').innerHTML = (SETTINGS.VEHICLE_NAME || 'TUV 300') + ' <span data-i18n="brand_sub">' + t('brand_sub') + '</span>';
  $('vehicleLabel2').textContent = SETTINGS.VEHICLE_NAME || 'TUV 300';
  $('homeVehicle').textContent = SETTINGS.VEHICLE_NAME || '';
  // Rebuilt fully each time (not just the inner span) so it recovers cleanly
  // from the skeleton placeholder shown on first-ever visit, and so it
  // re-renders correctly whenever the language changes.
  $('homeTitle').innerHTML = t('home_title_prefix') + ' <span id="baseCityLabel">' +
    escapeHtmlCustomer(SETTINGS.BASE_CITY || '') + '</span> ' + t('home_title_suffix');

  const waNumber = SETTINGS.WHATSAPP_NUMBER || '918308345237';
  const waGeneric = whatsAppLink(waNumber, 'Hi, I want to know more about ' + (SETTINGS.VEHICLE_NAME || 'your vehicle') + ' booking.');
  $('headerWhatsApp').href = waGeneric;
  $('btnWhatsAppUs').href = waGeneric;
  $('btnErrorWhatsApp').href = waGeneric;
  $('btnErrorWhatsApp').textContent = 'WhatsApp ' + (SETTINGS.WHATSAPP_NUMBER ? SETTINGS.WHATSAPP_NUMBER.replace(/^91/, '') : '8308345237');
}

// Defensive normalization layer - the backend already filters/sorts active
// pickup locations (PickupLocations.gs getPublicPickupLocations_), but the
// frontend should never trust a single source blindly: this guards
// against a malformed/duplicate/blank entry ever reaching the dropdown.
function normalizePickupLocations(rawList) {
  if (!Array.isArray(rawList)) return [];
  const seen = new Set();
  const cleaned = [];
  rawList.forEach(entry => {
    if (!entry || typeof entry !== 'object') return;
    const id = String(entry.id ?? '').trim();
    const en = String(entry.en ?? '').trim();
    if (!id || !en || seen.has(id)) return;
    seen.add(id);
    cleaned.push({
      id, en,
      hi: String(entry.hi ?? '').trim(),
      mr: String(entry.mr ?? '').trim(),
      hinglish: String(entry.hinglish ?? '').trim() || en,
      sortOrder: Number(entry.sortOrder) || 0
    });
  });
  cleaned.sort((a, b) => a.sortOrder - b.sortOrder);
  return cleaned;
}

// Pickup location display names are dynamic data (like the old city
// names), never translation-dictionary keys - resolved per-language
// directly from the location object, matching i18n.js's own convention.
function pickupLocalizedName(loc, lang) {
  if (lang === 'hi') return loc.hi || loc.en;
  if (lang === 'hl') return loc.hinglish || loc.en;
  return loc.en;
}

function showPickupLoadingState() {
  const el = $('pickup');
  el.innerHTML = '';
  el.appendChild(new Option(t('loading_pickup'), ''));
  el.disabled = true;
}

function populatePickupSelect() {
  const pickup = $('pickup');
  if (!pickup) {
    console.error('Anjali pickup loader: pickup select not found in DOM');
    return;
  }
  const locations = normalizePickupLocations(PICKUP_LOCATIONS);
  PICKUP_LOCATIONS = locations; // keep state consistent with what's actually shown
  const previousValue = pickup.value;
  pickup.innerHTML = '';
  pickup.disabled = false;

  if (!locations.length) {
    console.error('Anjali pickup loader: no active pickup locations in bootstrap response');
    pickup.appendChild(new Option(t('no_locations_available'), ''));
    return;
  }

  const lang = atrGetLang();
  locations.forEach(loc => {
    pickup.appendChild(new Option(pickupLocalizedName(loc, lang), loc.id));
  });

  if (previousValue && locations.some(l => l.id === previousValue)) {
    pickup.value = previousValue;
  } else if (SETTINGS.BASE_CITY) {
    const baseMatch = locations.find(l => l.en.toLowerCase() === SETTINGS.BASE_CITY.toLowerCase());
    if (baseMatch) pickup.value = baseMatch.id;
  }
}

// ---------------------------------------------------------------------
// DATE AVAILABILITY
// ---------------------------------------------------------------------
function minDateToday() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

async function checkDate(dateStr) {
  const msgEl = $('dateMsg');
  msgEl.textContent = t('date_checking');
  msgEl.className = 'field-msg';
  try {
    const res = await callApi('CHECK_DATE', { travel_date: dateStr });
    if (!res.success) {
      msgEl.textContent = res.error.message;
      msgEl.className = 'field-msg unavailable';
      return false;
    }
    if (res.data.available) {
      msgEl.textContent = t('date_available');
      msgEl.className = 'field-msg available';
      return true;
    } else {
      msgEl.textContent = t('date_unavailable');
      msgEl.className = 'field-msg unavailable';
      return false;
    }
  } catch (err) {
    msgEl.textContent = t('date_check_error');
    msgEl.className = 'field-msg unavailable';
    return false;
  }
}

// ---------------------------------------------------------------------
// EVENTS
// ---------------------------------------------------------------------
$('btnGoBook').addEventListener('click', () => showView('book'));
$('btnBackHome').addEventListener('click', () => showView('home'));
$('btnNewBooking').addEventListener('click', () => {
  $('bookingForm').reset();
  $('dateMsg').textContent = '';
  $('pickupLocMsg').textContent = '';
  $('destinationLocMsg').textContent = '';
  $('pickupMapsLink').classList.add('hidden');
  $('destinationMapsLink').classList.add('hidden');
  $('pickupMapsLink').value = '';
  $('destinationMapsLink').value = '';
  LOC_STATE.pickup = { maps_url: '', latitude: '', longitude: '' };
  LOC_STATE.destination = { maps_url: '', latitude: '', longitude: '' };
  showView('book');
});

$('travelDate').min = minDateToday();
$('travelDate').addEventListener('change', (e) => {
  if (e.target.value) checkDate(e.target.value);
});

$('bookingForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (submitting) return;

  const errorEl = $('formError');
  errorEl.textContent = '';

  const travelDate = $('travelDate').value;
  const pickupId = $('pickup').value;
  const pickupLoc = PICKUP_LOCATIONS.find(l => l.id === pickupId);
  const pickupDisplay = pickupLoc ? pickupLoc.en : '';
  const destination = $('destination').value.trim();
  const tripType = document.querySelector('input[name="tripType"]:checked').value;
  const customerName = $('customerName').value.trim();
  const whatsapp = $('whatsapp').value.trim();
  const passengers = Number($('passengers').value);
  const note = $('note').value.trim();

  if (!travelDate) { errorEl.textContent = t('err_select_date'); return; }
  if (!pickupId) { errorEl.textContent = t('err_select_pickup'); return; }
  if (!destination) { errorEl.textContent = t('err_enter_destination'); return; }
  if (pickupDisplay && destination.toLowerCase() === pickupDisplay.toLowerCase()) {
    errorEl.textContent = t('err_same_pickup_drop'); return;
  }
  if (!customerName) { errorEl.textContent = t('err_enter_name'); return; }
  if (!/^\d{10,13}$/.test(whatsapp.replace(/\D/g, ''))) {
    errorEl.textContent = t('err_enter_whatsapp'); return;
  }
  if (!validateMapsLinkInput('pickup') || !validateMapsLinkInput('destination')) { return; }

  const pickupPlace = $('pickupPlace').value.trim();

  submitting = true;
  $('submitBtn').disabled = true;
  showLoading('...');

  try {
    // Re-verify availability right before submitting (section 8) -
    // the server re-checks again with a lock regardless.
    const res = await callApi('CREATE_BOOKING', {
      travel_date: travelDate,
      pickup_id: pickupId,
      destination: destination,
      trip_type: tripType,
      customer_name: customerName,
      whatsapp: whatsapp,
      passengers: passengers,
      note: note,
      lang: atrGetLang(),
      pickup_location: pickupPlace,
      pickup_maps_url: LOC_STATE.pickup.maps_url,
      pickup_latitude: LOC_STATE.pickup.latitude,
      pickup_longitude: LOC_STATE.pickup.longitude,
      destination_maps_url: LOC_STATE.destination.maps_url,
      destination_latitude: LOC_STATE.destination.latitude,
      destination_longitude: LOC_STATE.destination.longitude
    });

    hideLoading();
    submitting = false;
    $('submitBtn').disabled = false;

    if (!res.success) {
      errorEl.textContent = res.error.message || t('err_generic');
      if (res.error.code === 'DATE_UNAVAILABLE') {
        $('dateMsg').textContent = res.error.message;
        $('dateMsg').className = 'field-msg unavailable';
      }
      return;
    }

    renderConfirmation(res.data, {
      travelDate, pickup: pickupDisplay, destination, customerName, whatsapp,
      pickupPlace,
      pickupMapsUrl: LOC_STATE.pickup.maps_url,
      destinationMapsUrl: LOC_STATE.destination.maps_url
    });
  } catch (err) {
    hideLoading();
    submitting = false;
    $('submitBtn').disabled = false;
    errorEl.textContent = t('err_generic');
  }
});

function renderConfirmation(data, form) {
  LAST_BOOKING_ID = data.booking_id;
  $('cBookingId').textContent = data.booking_id;
  $('cDate').textContent = formatDate(form.travelDate);
  $('cPickup').textContent = form.pickup;
  $('cDestination').textContent = form.destination;
  $('cName').textContent = form.customerName;
  $('cWhatsApp').textContent = form.whatsapp;
  $('notifyMsg').textContent = '';
  $('btnEnableNotify').classList.toggle('hidden', !ONESIGNAL_APP_ID);

  if (form.pickupPlace) {
    $('cPickupLoc').textContent = form.pickupPlace;
    $('cPickupLocRow').classList.remove('hidden');
  } else {
    $('cPickupLocRow').classList.add('hidden');
  }
  // Destination is now a single free-text field (no separate "place"
  // refinement input), so this extra confirmation row is never shown.
  $('cDestinationLocRow').classList.add('hidden');
  if (form.pickupMapsUrl) {
    $('btnViewPickup').href = form.pickupMapsUrl;
    $('btnViewPickup').classList.remove('hidden');
  } else {
    $('btnViewPickup').classList.add('hidden');
  }
  if (form.destinationMapsUrl) {
    $('btnViewDestination').href = form.destinationMapsUrl;
    $('btnViewDestination').classList.remove('hidden');
  } else {
    $('btnViewDestination').classList.add('hidden');
  }

  const waNumber = SETTINGS.WHATSAPP_NUMBER || '918308345237';
  const message = 'Hi, I just submitted a booking request.\nBooking ID: ' + data.booking_id +
    '\nTravel Date: ' + formatDate(form.travelDate) + '\nPickup: ' + form.pickup + '\nDrop: ' + form.destination;
  $('btnContactWhatsApp').href = whatsAppLink(waNumber, message);

  showView('confirm');
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ---------------------------------------------------------------------
// OPTIONAL CUSTOMER PUSH NOTIFICATIONS (section 5)
// Not mandatory - WhatsApp remains the primary channel. This only
// activates if ONESIGNAL_APP_ID is configured in config.js. See
// docs/PUSH-NOTIFICATIONS-SETUP.md.
// ---------------------------------------------------------------------
$('btnEnableNotify').addEventListener('click', async () => {
  if (!ONESIGNAL_APP_ID || typeof OneSignal === 'undefined') {
    $('notifyMsg').textContent = t('notifications_denied');
    return;
  }
  try {
    await OneSignal.init({ appId: ONESIGNAL_APP_ID, allowLocalhostAsSecureOrigin: true });
    await OneSignal.Notifications.requestPermission();
    const granted = OneSignal.Notifications.permission;
    if (granted) {
      const playerId = OneSignal.User.PushSubscription.id;
      if (playerId) {
        await callApi('SAVE_PUSH_SUBSCRIPTION', {
          user_type: 'CUSTOMER',
          player_id: playerId,
          booking_id: LAST_BOOKING_ID || ''
        });
      }
      $('notifyMsg').textContent = t('notifications_enabled');
      $('notifyMsg').className = 'field-msg available';
    } else {
      $('notifyMsg').textContent = t('notifications_denied');
      $('notifyMsg').className = 'field-msg';
    }
  } catch (err) {
    $('notifyMsg').textContent = t('notifications_denied');
  }
});

// ---------------------------------------------------------------------
// PWA SERVICE WORKER
// ---------------------------------------------------------------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // updateViaCache: 'none' stops the BROWSER from HTTP-caching
    // service-worker.js itself - without this, some hosts/CDNs can keep
    // serving an old service-worker.js indefinitely, which means the
    // browser never even learns a new app version exists.
    navigator.serviceWorker.register('service-worker.js', { updateViaCache: 'none' }).catch(() => {});
  });
}

init();
