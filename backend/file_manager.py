import io
import mimetypes
import os
import platform
import shutil
import stat
import time
import zipfile
from pathlib import Path
from typing import Dict, List, Any, Optional

import psutil
from backend.config import BASE_DIR, TEMP_UPLOAD_DIR, config


def format_size(size_bytes: int) -> str:
    if size_bytes < 1024:
        return f"{size_bytes} B"
    for unit in ["KB", "MB", "GB", "TB"]:
        size_bytes /= 1024.0
        if size_bytes < 1024.0:
            return f"{size_bytes:.2f} {unit}"
    return f"{size_bytes:.2f} PB"


def get_file_category(name: str, is_dir: bool) -> str:
    if is_dir:
        return "folder"
    ext = Path(name).suffix.lower()
    if ext in {".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".bmp", ".ico"}:
        return "image"
    if ext in {".mp4", ".mkv", ".avi", ".mov", ".webm", ".wmv"}:
        return "video"
    if ext in {".mp3", ".wav", ".flac", ".aac", ".ogg", ".m4a"}:
        return "audio"
    if ext in {".zip", ".rar", ".7z", ".tar", ".gz", ".bz2"}:
        return "archive"
    if ext in {".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".md", ".csv"}:
        return "document"
    if ext in {".py", ".js", ".ts", ".html", ".css", ".json", ".c", ".cpp", ".cs", ".go", ".rs", ".java", ".php", ".sh", ".bat", ".ps1"}:
        return "code"
    if ext in {".exe", ".msi", ".dmg", ".pkg", ".deb", ".rpm", ".apk"}:
        return "executable"
    return "file"


class FileManager:
    """
    Cross-platform File Explorer & Resumable Chunked Transfer Manager.
    """

    def __init__(self):
        # Active chunked upload sessions: transfer_id -> metadata
        self.upload_sessions: Dict[str, Dict[str, Any]] = {}

    def get_quick_locations(self) -> List[Dict[str, Any]]:
        home = Path.home()
        locations = []

        candidates = [
            ("หน้าเดสก์ท็อป (Desktop)", home / "Desktop", "monitor"),
            ("ดาวน์โหลด (Downloads)", home / "Downloads", "download"),
            ("เอกสาร (Documents)", home / "Documents", "file-text"),
            ("รูปภาพ (Pictures)", home / "Pictures", "image"),
            ("วิดีโอ (Videos)", home / "Videos", "film"),
            ("โฟลเดอร์ผู้ใช้ (Home)", home, "home"),
            ("โฟลเดอร์โปรเจกต์ (RemoteMe)", BASE_DIR, "folder-git-2"),
        ]
        for label, path, icon in candidates:
            if path.exists():
                locations.append({
                    "name": label,
                    "path": str(path.resolve()),
                    "icon": icon,
                    "type": "shortcut",
                })

        # Add mounted drives / partitions (C:\, D:\, / etc.)
        for part in psutil.disk_partitions(all=False):
            try:
                usage = psutil.disk_usage(part.mountpoint)
                locations.append({
                    "name": f"ไดรฟ์ {part.mountpoint}",
                    "path": part.mountpoint,
                    "icon": "hard-drive",
                    "type": "drive",
                    "total_bytes": usage.total,
                    "free_bytes": usage.free,
                    "used_percent": usage.percent,
                    "total_formatted": format_size(usage.total),
                    "free_formatted": format_size(usage.free),
                })
            except Exception:
                continue

        return locations

    def list_directory(self, path_str: Optional[str] = None) -> Dict[str, Any]:
        if not path_str:
            target = Path.home() / "Desktop"
            if not target.exists():
                target = Path.home()
        else:
            target = Path(path_str)

        target = target.resolve()
        if not target.exists() or not target.is_dir():
            raise FileNotFoundError(f"ไม่พบโฟลเดอร์: {target}")

        items = []
        try:
            with os.scandir(target) as entries:
                for entry in entries:
                    try:
                        st = entry.stat(follow_symlinks=False)
                        is_dir = stat.S_ISDIR(st.st_mode)
                        size = 0 if is_dir else st.st_size
                        items.append({
                            "name": entry.name,
                            "path": str(Path(entry.path).resolve()),
                            "is_dir": is_dir,
                            "size": size,
                            "size_formatted": "โฟลเดอร์" if is_dir else format_size(size),
                            "modified": int(st.st_mtime * 1000),
                            "category": get_file_category(entry.name, is_dir),
                            "extension": "" if is_dir else Path(entry.name).suffix.lower(),
                        })
                    except PermissionError:
                        continue
                    except Exception:
                        continue
        except PermissionError:
            raise PermissionError(f"ไม่มีสิทธิ์เข้าถึงโฟลเดอร์: {target}")

        # Sort directories first, then alphabetical case-insensitive
        items.sort(key=lambda x: (not x["is_dir"], x["name"].lower()))

        # Build breadcrumbs
        parts = target.parts
        breadcrumbs = []
        acc = Path(parts[0]) if parts else target
        for idx, p in enumerate(parts):
            if idx == 0:
                acc = Path(p)
            else:
                acc = acc / p
            breadcrumbs.append({
                "name": p.rstrip("\\/") or p,
                "path": str(acc),
            })

        parent_path = str(target.parent) if target.parent != target else None

        return {
            "current_path": str(target),
            "parent_path": parent_path,
            "breadcrumbs": breadcrumbs,
            "items": items,
            "total_items": len(items),
            "os": platform.system(),
        }

    def create_folder(self, parent_path: str, folder_name: str) -> Dict[str, Any]:
        target = (Path(parent_path).resolve() / folder_name.strip()).resolve()
        target.mkdir(parents=True, exist_ok=True)
        return {"status": "ok", "path": str(target), "name": target.name}

    def rename_item(self, old_path: str, new_name: str) -> Dict[str, Any]:
        src = Path(old_path).resolve()
        if not src.exists():
            raise FileNotFoundError(f"ไม่พบไฟล์หรือโฟลเดอร์: {src}")
        dst = src.parent / new_name.strip()
        src.rename(dst)
        return {"status": "ok", "old_path": str(src), "new_path": str(dst)}

    def delete_items(self, paths: List[str]) -> Dict[str, Any]:
        if not config.allow_file_delete:
            raise PermissionError("การลบไฟล์ถูกปิดไว้ในตั้งค่าความปลอดภัย")
        deleted = []
        for p in paths:
            target = Path(p).resolve()
            if not target.exists():
                continue
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink()
            deleted.append(str(target))
        return {"status": "ok", "deleted": deleted}

    def copy_or_move(self, action: str, sources: List[str], destination_dir: str) -> Dict[str, Any]:
        dst_dir = Path(destination_dir).resolve()
        if not dst_dir.exists() or not dst_dir.is_dir():
            raise FileNotFoundError(f"ไม่พบโฟลเดอร์ปลายทาง: {dst_dir}")

        processed = []
        for s in sources:
            src = Path(s).resolve()
            if not src.exists():
                continue
            dst = dst_dir / src.name
            # Prevent overwrite collision by appending (copy) if identical parent
            if dst == src:
                dst = dst_dir / f"{src.stem}_copy{src.suffix}"
            elif dst.exists() and action == "copy":
                dst = dst_dir / f"{src.stem}_{int(time.time())}{src.suffix}"

            if action == "move":
                shutil.move(str(src), str(dst))
            else:
                if src.is_dir():
                    shutil.copytree(str(src), str(dst), dirs_exist_ok=True)
                else:
                    shutil.copy2(str(src), str(dst))
            processed.append(str(dst))

        return {"status": "ok", "action": action, "processed": processed}

    # --- Resumable Chunked Upload Engine ---
    def init_upload(self, filename: str, total_size: int, target_dir: str, transfer_id: Optional[str] = None) -> Dict[str, Any]:
        tid = transfer_id or f"up_{int(time.time() * 1000)}_{os.urandom(3).hex()}"
        dest_dir = Path(target_dir).resolve() if target_dir else Path(config.default_upload_dir).resolve()
        dest_dir.mkdir(parents=True, exist_ok=True)

        safe_name = Path(filename).name
        temp_file = TEMP_UPLOAD_DIR / f"{tid}.part"

        existing_offset = temp_file.stat().st_size if temp_file.exists() else 0

        session = {
            "transfer_id": tid,
            "filename": safe_name,
            "total_size": int(total_size),
            "received_bytes": existing_offset,
            "target_dir": str(dest_dir),
            "final_path": str(dest_dir / safe_name),
            "temp_path": str(temp_file),
            "created_at": time.time(),
            "status": "uploading",
        }
        self.upload_sessions[tid] = session
        return session

    def write_upload_chunk(self, transfer_id: str, offset: int, chunk_bytes: bytes) -> Dict[str, Any]:
        session = self.upload_sessions.get(transfer_id)
        if not session:
            raise KeyError(f"ไม่พบเซสชันการอัปโหลด: {transfer_id}")

        temp_path = Path(session["temp_path"])
        mode = "r+b" if temp_path.exists() else "wb"
        with open(temp_path, mode) as f:
            f.seek(offset)
            f.write(chunk_bytes)

        current_size = temp_path.stat().st_size
        session["received_bytes"] = current_size

        if current_size >= session["total_size"]:
            final_path = Path(session["final_path"])
            # If file exists, replace it cleanly
            if final_path.exists():
                final_path.unlink()
            shutil.move(str(temp_path), str(final_path))
            session["status"] = "completed"

        return {
            "transfer_id": transfer_id,
            "received_bytes": session["received_bytes"],
            "total_size": session["total_size"],
            "status": session["status"],
            "final_path": session["final_path"],
        }

    def cancel_upload(self, transfer_id: str) -> Dict[str, Any]:
        session = self.upload_sessions.pop(transfer_id, None)
        if session:
            temp_path = Path(session["temp_path"])
            if temp_path.exists():
                try:
                    temp_path.unlink()
                except Exception:
                    pass
        return {"status": "cancelled", "transfer_id": transfer_id}

    def create_zip_from_paths(self, paths: List[str]) -> io.BytesIO:
        """Create an in-memory or temporary zip stream for downloading folders/multiple files."""
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for p_str in paths:
                p = Path(p_str).resolve()
                if not p.exists():
                    continue
                if p.is_file():
                    zf.write(p, arcname=p.name)
                elif p.is_dir():
                    base_parent = p.parent
                    for root, _, files in os.walk(p):
                        for file in files:
                            full_f = Path(root) / file
                            try:
                                rel_arc = full_f.relative_to(base_parent)
                                zf.write(full_f, arcname=str(rel_arc))
                            except Exception:
                                continue
        buf.seek(0)
        return buf


file_manager = FileManager()
