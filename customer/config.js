// ---------------------------------------------------------------------
// PASTE YOUR GOOGLE APPS SCRIPT WEB APP URL BELOW (ends with /exec)
// This is the ONLY place you need to configure the API URL for the
// customer app.
// ---------------------------------------------------------------------
const API_URL = "https://script.google.com/macros/s/AKfycbyn0Jw4goHi9KmPIHShBdgASptVm1OzyaeToOOzNznp-Tf1VfLuZLIkv1UwY2pZdKqD/exec";

// ---------------------------------------------------------------------
// OPTIONAL: OneSignal App ID for customer push notifications (section 5).
// Leave blank to keep push notifications off - WhatsApp remains the
// primary communication method either way. See
// docs/PUSH-NOTIFICATIONS-SETUP.md for how to get this value.
// This is a public identifier, safe to keep in frontend code.
// ---------------------------------------------------------------------
const ONESIGNAL_APP_ID = "";

// ---------------------------------------------------------------------
// Bump this whenever app.js/index.html changes. Logged to console on
// every load (harmless, no UI) so you can open any browser's console on
// the LIVE site and instantly confirm whether it's actually running this
// build, or a stale cached one - compare against GET_HEALTH's api_version.
// ---------------------------------------------------------------------
const APP_VERSION = "10.1";
