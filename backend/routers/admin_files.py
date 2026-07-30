"""Admin-only temporary file storage with a fixed one-hour retention window."""

import asyncio
import json
import os
import re
import tempfile
import time
import uuid
import zipfile
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from admin_auth import require_admin


RETENTION_SECONDS = 60 * 60
MAX_FILE_BYTES = 50 * 1024 * 1024
MAX_TOTAL_BYTES = 200 * 1024 * 1024
MAX_FILES = 24
_STORAGE_DIR = Path(
    os.getenv(
        "ADMIN_TEMP_FILE_DIR",
        Path(tempfile.gettempdir()) / "alphatape-admin-files",
    )
)
_cleanup_task: asyncio.Task | None = None

router = APIRouter(dependencies=[Depends(require_admin)])


def _now() -> float:
    return time.time()


def _safe_name(raw: str | None) -> str:
    name = Path(raw or "upload.bin").name
    name = re.sub(r"[\x00-\x1f\x7f]+", "", name).strip().strip(".")
    return name[:180] or "upload.bin"


def _paths(file_id: str) -> tuple[Path, Path]:
    try:
        normalized = uuid.UUID(file_id).hex
    except ValueError as exc:
        raise HTTPException(404, "Temporary file not found") from exc
    return _STORAGE_DIR / f"{normalized}.bin", _STORAGE_DIR / f"{normalized}.json"


def _remove_pair(data_path: Path, metadata_path: Path) -> None:
    data_path.unlink(missing_ok=True)
    metadata_path.unlink(missing_ok=True)


def _read_metadata(metadata_path: Path) -> dict | None:
    try:
        value = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None
    return value if isinstance(value, dict) else None


def cleanup_expired(now: float | None = None) -> int:
    if not _STORAGE_DIR.exists():
        return 0
    current = _now() if now is None else now
    removed = 0
    for metadata_path in _STORAGE_DIR.glob("*.json"):
        metadata = _read_metadata(metadata_path)
        file_id = metadata_path.stem
        data_path = _STORAGE_DIR / f"{file_id}.bin"
        if (
            metadata is None
            or not data_path.is_file()
            or float(metadata.get("expiresAt", 0)) <= current
        ):
            _remove_pair(data_path, metadata_path)
            removed += 1
    for partial in _STORAGE_DIR.glob(".*.part"):
        try:
            if current - partial.stat().st_mtime > 300:
                partial.unlink(missing_ok=True)
        except OSError:
            partial.unlink(missing_ok=True)
    return removed


def _active_files() -> list[dict]:
    cleanup_expired()
    files: list[dict] = []
    if not _STORAGE_DIR.exists():
        return files
    for metadata_path in _STORAGE_DIR.glob("*.json"):
        metadata = _read_metadata(metadata_path)
        if metadata is None:
            continue
        data_path = _STORAGE_DIR / f"{metadata_path.stem}.bin"
        if data_path.is_file():
            files.append(metadata)
    return sorted(files, key=lambda item: float(item.get("createdAt", 0)), reverse=True)


def _archive_name(name: str, used: set[str]) -> str:
    candidate = _safe_name(name)
    stem = Path(candidate).stem
    suffix = Path(candidate).suffix
    number = 2
    while candidate.casefold() in used:
        candidate = f"{stem} ({number}){suffix}"
        number += 1
    used.add(candidate.casefold())
    return candidate


@router.get("")
def list_temp_files():
    return {
        "files": _active_files(),
        "retentionSeconds": RETENTION_SECONDS,
        "limits": {
            "maxFileBytes": MAX_FILE_BYTES,
            "maxTotalBytes": MAX_TOTAL_BYTES,
            "maxFiles": MAX_FILES,
        },
    }


@router.post("", status_code=201)
async def upload_temp_file(file: UploadFile = File(...)):
    active = _active_files()
    if len(active) >= MAX_FILES:
        raise HTTPException(409, f"Temporary storage is limited to {MAX_FILES} files")

    current_total = sum(int(item.get("size", 0)) for item in active)
    if current_total >= MAX_TOTAL_BYTES:
        raise HTTPException(409, "Temporary storage is full")

    _STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    file_id = uuid.uuid4().hex
    data_path = _STORAGE_DIR / f"{file_id}.bin"
    metadata_path = _STORAGE_DIR / f"{file_id}.json"
    partial_path = _STORAGE_DIR / f".{file_id}.part"
    size = 0

    try:
        with partial_path.open("wb") as output:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_FILE_BYTES:
                    raise HTTPException(413, "File exceeds the 50 MB limit")
                if current_total + size > MAX_TOTAL_BYTES:
                    raise HTTPException(413, "Upload would exceed the 200 MB storage limit")
                output.write(chunk)
        partial_path.replace(data_path)
        created_at = _now()
        metadata = {
            "id": file_id,
            "name": _safe_name(file.filename),
            "contentType": file.content_type or "application/octet-stream",
            "size": size,
            "createdAt": created_at,
            "expiresAt": created_at + RETENTION_SECONDS,
        }
        metadata_path.write_text(
            json.dumps(metadata, separators=(",", ":")),
            encoding="utf-8",
        )
        return metadata
    except Exception:
        _remove_pair(data_path, metadata_path)
        partial_path.unlink(missing_ok=True)
        raise
    finally:
        await file.close()


@router.get("/download-all")
def download_all_temp_files():
    active = _active_files()
    if not active:
        raise HTTPException(404, "No active temporary files to download")

    _STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    archive_handle = tempfile.NamedTemporaryFile(
        prefix=".download-",
        suffix=".zip",
        dir=_STORAGE_DIR,
        delete=False,
    )
    archive_path = Path(archive_handle.name)
    archive_handle.close()
    used_names: set[str] = set()
    archived_count = 0

    try:
        with zipfile.ZipFile(
            archive_path,
            mode="w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=6,
        ) as archive:
            for item in sorted(active, key=lambda value: str(value.get("name", "")).casefold()):
                try:
                    data_path, _ = _paths(str(item.get("id", "")))
                except HTTPException:
                    continue
                if not data_path.is_file():
                    continue
                archive.write(
                    data_path,
                    arcname=_archive_name(str(item.get("name") or "download.bin"), used_names),
                )
                archived_count += 1
        if archived_count == 0:
            raise HTTPException(404, "No active temporary files to download")
    except Exception:
        archive_path.unlink(missing_ok=True)
        raise

    timestamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime(_now()))
    return FileResponse(
        archive_path,
        media_type="application/zip",
        filename=f"alphatape-files-{timestamp}.zip",
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
        background=BackgroundTask(archive_path.unlink, missing_ok=True),
    )


@router.get("/{file_id}")
def download_temp_file(file_id: str):
    data_path, metadata_path = _paths(file_id)
    metadata = _read_metadata(metadata_path)
    if (
        metadata is None
        or not data_path.is_file()
        or float(metadata.get("expiresAt", 0)) <= _now()
    ):
        _remove_pair(data_path, metadata_path)
        raise HTTPException(404, "Temporary file not found or expired")
    return FileResponse(
        data_path,
        media_type=str(metadata.get("contentType") or "application/octet-stream"),
        filename=_safe_name(str(metadata.get("name") or "download.bin")),
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.delete("/{file_id}", status_code=204)
def delete_temp_file(file_id: str):
    data_path, metadata_path = _paths(file_id)
    if not data_path.exists() and not metadata_path.exists():
        raise HTTPException(404, "Temporary file not found")
    _remove_pair(data_path, metadata_path)
    return Response(status_code=204)


async def _cleanup_loop() -> None:
    while True:
        cleanup_expired()
        await asyncio.sleep(60)


def start_cleanup_loop() -> None:
    global _cleanup_task
    if _cleanup_task is None or _cleanup_task.done():
        _cleanup_task = asyncio.create_task(_cleanup_loop())


async def stop_cleanup_loop() -> None:
    global _cleanup_task
    if _cleanup_task is None:
        return
    _cleanup_task.cancel()
    try:
        await _cleanup_task
    except asyncio.CancelledError:
        pass
    _cleanup_task = None
