"""Google Drive access for the Input folder — list pending clips,
download one, rename it to DONE_<name> on success. Uses a service
account (same one Alani-Bot's Calendar sync can already use — just needs
the Drive API enabled on that project and the Input folder's parent
shared with its email, since a service account has no "My Drive" of its
own).

DONE-prefix semantics live here, not in pipeline.py, since renaming a
Drive file IS the durable "done" marker the whole feature relies on —
keeping it in one place avoids two code paths disagreeing about what
"pending" means.
"""

import io
import json

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload

import config

_SCOPES = ["https://www.googleapis.com/auth/drive"]
_VIDEO_EXTS = (".mov", ".mp4", ".avi", ".mkv", ".webm")
DONE_PREFIX = "DONE_"

_service = None


def _get_service():
    global _service
    if _service is not None:
        return _service
    if not config.GOOGLE_SERVICE_ACCOUNT_KEY:
        raise RuntimeError("GOOGLE_SERVICE_ACCOUNT_KEY not configured")
    info = json.loads(config.GOOGLE_SERVICE_ACCOUNT_KEY)
    creds = service_account.Credentials.from_service_account_info(info, scopes=_SCOPES)
    _service = build("drive", "v3", credentials=creds, cache_discovery=False)
    return _service


def _find_child_folder(service, name, parent_id=None):
    """Find a folder by name, either among everything shared with this
    service account (parent_id=None, the path's first segment) or among a
    known parent's children (every later segment)."""
    clauses = [
        "mimeType = 'application/vnd.google-apps.folder'",
        f"name = '{name}'",
        "trashed = false",
    ]
    if parent_id:
        clauses.append(f"'{parent_id}' in parents")
    else:
        clauses.append("sharedWithMe = true")
    resp = service.files().list(q=" and ".join(clauses), fields="files(id, name)").execute()
    files = resp.get("files", [])
    if not files:
        where = "shared with this service account" if not parent_id else f"under parent {parent_id}"
        raise RuntimeError(f'Drive folder "{name}" not found ({where}). Check sharing / DRIVE_INPUT_FOLDER_PATH.')
    return files[0]["id"]


def resolve_input_folder_id():
    service = _get_service()
    folder_id = None
    for segment in config.DRIVE_INPUT_FOLDER_PATH.strip("/").split("/"):
        folder_id = _find_child_folder(service, segment, parent_id=folder_id)
    return folder_id


def _list_video_files(folder_id):
    service = _get_service()
    q = f"'{folder_id}' in parents and trashed = false"
    resp = service.files().list(q=q, fields="files(id, name)", pageSize=1000).execute()
    files = resp.get("files", [])
    return [f for f in files if f["name"].lower().endswith(_VIDEO_EXTS)]


def list_pending_clips(folder_id):
    """Every video not already prefixed DONE_ — used by run1/runany."""
    return [f for f in _list_video_files(folder_id) if not f["name"].startswith(DONE_PREFIX)]


def list_all_clips(folder_id):
    """Every video regardless of DONE_ status — used by runall."""
    return _list_video_files(folder_id)


def download_file(file_id, dest_path):
    service = _get_service()
    request = service.files().get_media(fileId=file_id)
    with io.FileIO(dest_path, "wb") as fh:
        downloader = MediaIoBaseDownload(fh, request)
        done = False
        while not done:
            _, done = downloader.next_chunk()
    return dest_path


def mark_done(file_id, current_name):
    """Renames the clip to DONE_<original name> — the durable success
    marker. Never called on failure (see pipeline.py): a failed clip
    keeps its original name so the next run1/runany retries it."""
    if current_name.startswith(DONE_PREFIX):
        return current_name
    new_name = DONE_PREFIX + current_name
    service = _get_service()
    service.files().update(fileId=file_id, body={"name": new_name}).execute()
    return new_name
