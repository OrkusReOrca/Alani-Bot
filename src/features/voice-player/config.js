import path from "path";
import { fileURLToPath } from "url";
import { readEnv } from "../../common/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  // Drive folder (path from the folders shared with the service account) holding
  // the files that can be played. Sub-folders aren't searched.
  folderPath: (readEnv("VC_DRIVE_FOLDER_PATH") || "Alani/Files to play discord VC").split("/").filter(Boolean),
  cacheDir: path.join(__dirname, "..", "..", "..", "data", "vc-cache"),
};

export const limits = {
  cacheMaxBytes: 2 * 1024 ** 3, // converted audio kept on disk (unqueued tracks are evicted oldest-first)
  opusBitrate: "96k", // Discord caps voice at the channel's bitrate (64-96k typical), so more is wasted
  idleLeaveMs: 5 * 60 * 1000, // leave after this long with nothing playing
  aloneLeaveMs: 60 * 1000, // leave after this long with nobody else in the call
  libraryCacheMs: 30 * 1000, // how long a Drive folder listing is reused
  joinTimeoutMs: 30 * 1000,
};

const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "flac", "ogg", "oga", "opus", "m4a", "aac", "wma", "webm", "mka"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "mkv", "avi", "m4v", "wmv", "flv"]);

// Playable if Drive says audio/video, or the extension does (Drive sometimes
// reports application/octet-stream for uploads).
export function isPlayableFile({ name, mimeType }) {
  if (mimeType?.startsWith("audio/") || mimeType?.startsWith("video/")) return true;
  const extension = name.split(".").pop().toLowerCase();
  return AUDIO_EXTENSIONS.has(extension) || VIDEO_EXTENSIONS.has(extension);
}
