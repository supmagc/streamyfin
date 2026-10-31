// A subtitle saved to the server shows up once the server has refreshed the item, which it does
// in the background and usually within a few seconds. Looked for this often, this many times.
export const SERVER_SUBTITLE_POLL_INTERVAL_MS = 1500;
export const SERVER_SUBTITLE_POLL_ATTEMPTS = 8;

// A subtitle the server has not listed by then is still synced into a download: this often, this
// many times, which covers a server busy refreshing other items.
export const SUBTITLE_SYNC_FOLLOW_UP_INTERVAL_MS = 5000;
export const SUBTITLE_SYNC_FOLLOW_UP_ATTEMPTS = 24;

// How many downloads one request asks the server about when their subtitles are synced: a list
// of ids goes in the URL, which servers and proxies cap in length.
export const SUBTITLE_SYNC_BATCH_SIZE = 50;
