const DAILY_LIST_URL = "https://fortnite.gg/daily-jam-tracks";

// fortnite.gg's shop page (fortnite.gg/shop) is behind an active Cloudflare
// bot challenge, but this specific page responds normally to a plain fetch
// as long as a real browser User-Agent is sent — verified by hand before
// building this. If that ever stops working, this will start returning a
// challenge page instead of track markup and TRACK_PATTERN just won't
// match anything (fetchDailyJamTracks returns []) rather than throwing.
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

const TRACK_PATTERN =
  /<a class='jam' href='\/cosmetics\?id=(\d+)'[^>]*><div class='jam-img'><img src='([^']+)'[^>]*><\/div><div class='jam-info'><h3 class='jam-title'>([^<]*)<\/h3><div class='jam-artist'>([^<]*)<\/div><\/div><\/a>/g;

export async function fetchDailyJamTracks() {
  const res = await fetch(DAILY_LIST_URL, {
    headers: { "User-Agent": BROWSER_USER_AGENT, Accept: "text/html,application/xhtml+xml" },
  });
  if (!res.ok) {
    throw new Error(`fortnite.gg daily-jam-tracks fetch failed: ${res.status} ${res.statusText}`);
  }
  const html = await res.text();

  const tracks = [];
  for (const match of html.matchAll(TRACK_PATTERN)) {
    const [, id, image, title, artist] = match;
    tracks.push({ id, title, artist, image });
  }
  return tracks;
}
