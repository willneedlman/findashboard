import io
import os
import sys
import zipfile

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import admin_auth
from main import app
from routers import admin_files


client = TestClient(app)


def _configure(monkeypatch, tmp_path):
    monkeypatch.setattr(admin_auth, "_ADMIN_SECRET", "test-secret")
    monkeypatch.setattr(admin_files, "_STORAGE_DIR", tmp_path)


def test_temp_files_require_admin(monkeypatch, tmp_path):
    monkeypatch.setattr(admin_files, "_STORAGE_DIR", tmp_path)

    assert client.get("/api/admin/files").status_code == 403
    assert client.post(
        "/api/admin/files",
        files={"file": ("private.txt", b"secret", "text/plain")},
    ).status_code == 403
    assert client.get("/api/admin/files/download-all").status_code == 403


def test_temp_file_upload_list_download_and_delete(monkeypatch, tmp_path):
    _configure(monkeypatch, tmp_path)
    headers = {"x-admin-secret": "test-secret"}

    uploaded = client.post(
        "/api/admin/files",
        headers=headers,
        files={"file": ("../research note.pdf", b"report bytes", "application/pdf")},
    )

    assert uploaded.status_code == 201
    item = uploaded.json()
    assert item["name"] == "research note.pdf"
    assert item["size"] == 12
    assert item["expiresAt"] - item["createdAt"] == 3600

    listing = client.get("/api/admin/files", headers=headers)
    assert listing.status_code == 200
    assert listing.json()["files"] == [item]

    downloaded = client.get(f"/api/admin/files/{item['id']}", headers=headers)
    assert downloaded.status_code == 200
    assert downloaded.content == b"report bytes"
    assert downloaded.headers["content-type"].startswith("application/pdf")
    assert "research%20note.pdf" in downloaded.headers["content-disposition"]

    deleted = client.delete(f"/api/admin/files/{item['id']}", headers=headers)
    assert deleted.status_code == 204
    assert client.get("/api/admin/files", headers=headers).json()["files"] == []


def test_temp_file_expires_after_one_hour(monkeypatch, tmp_path):
    _configure(monkeypatch, tmp_path)
    headers = {"x-admin-secret": "test-secret"}
    clock = {"now": 1_000.0}
    monkeypatch.setattr(admin_files, "_now", lambda: clock["now"])

    uploaded = client.post(
        "/api/admin/files",
        headers=headers,
        files={"file": ("model.xlsx", b"sheet", "application/vnd.ms-excel")},
    ).json()
    clock["now"] += 3_601

    response = client.get(f"/api/admin/files/{uploaded['id']}", headers=headers)

    assert response.status_code == 404
    assert client.get("/api/admin/files", headers=headers).json()["files"] == []
    assert list(tmp_path.iterdir()) == []


def test_download_all_returns_zip_and_preserves_duplicate_names(monkeypatch, tmp_path):
    _configure(monkeypatch, tmp_path)
    headers = {"x-admin-secret": "test-secret"}

    for content in (b"first draft", b"second draft"):
        response = client.post(
            "/api/admin/files",
            headers=headers,
            files={"file": ("brief.txt", content, "text/plain")},
        )
        assert response.status_code == 201

    downloaded = client.get("/api/admin/files/download-all", headers=headers)

    assert downloaded.status_code == 200
    assert downloaded.headers["content-type"].startswith("application/zip")
    assert "alphatape-files-" in downloaded.headers["content-disposition"]
    with zipfile.ZipFile(io.BytesIO(downloaded.content)) as archive:
        assert archive.namelist() == ["brief.txt", "brief (2).txt"]
        assert {archive.read(name) for name in archive.namelist()} == {
            b"first draft",
            b"second draft",
        }
    assert not list(tmp_path.glob(".download-*.zip"))


def test_download_all_rejects_empty_storage(monkeypatch, tmp_path):
    _configure(monkeypatch, tmp_path)

    response = client.get(
        "/api/admin/files/download-all",
        headers={"x-admin-secret": "test-secret"},
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "No active temporary files to download"
