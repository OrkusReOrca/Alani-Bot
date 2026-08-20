import dotenv from "dotenv";
dotenv.config();

function required(name) {
  return process.env[name] && process.env[name].trim() !== "" ? process.env[name].trim() : null;
}

// Which Google Calendar orkus-info's events sync to — deliberately
// per-database (not a single global calendar) so a future database can
// get its own calendar via its own <NAME>_GOOGLE_CALENDAR_ID, reusing
// the same shared service account (see src/common/googleCalendar.js)
// and src/common/config.js's googleServiceAccountKey.
export const config = {
  googleCalendarId: required("ORKUS_INFO_GOOGLE_CALENDAR_ID"),
};
