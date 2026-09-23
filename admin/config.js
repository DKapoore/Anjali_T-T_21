// ---------------------------------------------------------------------
// PASTE YOUR GOOGLE APPS SCRIPT WEB APP URL BELOW (ends with /exec)
// This must be the SAME URL used in customer/config.js - it is one
// backend serving both apps.
// ---------------------------------------------------------------------
const API_URL = "https://script.google.com/macros/s/AKfycbyn0Jw4goHi9KmPIHShBdgASptVm1OzyaeToOOzNznp-Tf1VfLuZLIkv1UwY2pZdKqD/exec";

// ---------------------------------------------------------------------
// OneSignal App ID for admin push notifications (New Booking, Payment
// Submitted/Verified, Booking Confirmed/Cancelled). Leave blank to keep
// push notifications off - the admin app and WhatsApp flow work fully
// without it. See docs/PUSH-NOTIFICATIONS-SETUP.md.
// This is a public identifier, safe to keep in frontend code. The
// matching REST API Key is kept server-side only (Apps Script Script
// Properties) - never put it here.
// ---------------------------------------------------------------------
const ONESIGNAL_APP_ID = "";
