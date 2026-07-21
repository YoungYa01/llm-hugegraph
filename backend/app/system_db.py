from __future__ import annotations

import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from .config import get_settings


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class SystemDatabase:
    """SQLite repository for users, projects, jobs, incidents and audit data."""

    def __init__(self, path: str | Path | None = None) -> None:
        settings = get_settings()
        self.path = Path(path or settings.app_database_path).expanduser().resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.initialize()

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        return connection

    def initialize(self) -> None:
        with self.connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    password_hash TEXT NOT NULL,
                    display_name TEXT NOT NULL,
                    role TEXT NOT NULL DEFAULT 'user',
                    is_active INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    expires_at TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS projects (
                    id TEXT PRIMARY KEY,
                    owner_id TEXT NOT NULL REFERENCES users(id),
                    name TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'active',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS architecture_imports (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    source_file TEXT NOT NULL DEFAULT '',
                    source_text TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'processing',
                    extracted_nodes INTEGER NOT NULL DEFAULT 0,
                    extracted_edges INTEGER NOT NULL DEFAULT 0,
                    execution_logs_json TEXT NOT NULL DEFAULT '[]',
                    graph_snapshot_json TEXT NOT NULL DEFAULT '{}',
                    error_message TEXT NOT NULL DEFAULT '',
                    created_by TEXT NOT NULL REFERENCES users(id),
                    created_at TEXT NOT NULL,
                    completed_at TEXT
                );

                CREATE TABLE IF NOT EXISTS log_batches (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    filename TEXT NOT NULL,
                    input_path TEXT NOT NULL,
                    train_filename TEXT NOT NULL DEFAULT '',
                    train_path TEXT NOT NULL DEFAULT '',
                    output_path TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'processing',
                    summary_json TEXT NOT NULL DEFAULT '{}',
                    rca_json TEXT NOT NULL DEFAULT '[]',
                    error_message TEXT NOT NULL DEFAULT '',
                    created_by TEXT NOT NULL REFERENCES users(id),
                    created_at TEXT NOT NULL,
                    completed_at TEXT
                );

                CREATE TABLE IF NOT EXISTS incidents (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    log_batch_id TEXT NOT NULL REFERENCES log_batches(id) ON DELETE CASCADE,
                    external_incident_id TEXT NOT NULL,
                    graph_incident_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    severity TEXT NOT NULL DEFAULT 'medium',
                    status TEXT NOT NULL DEFAULT 'open',
                    root_candidate TEXT NOT NULL DEFAULT '',
                    root_confidence REAL NOT NULL DEFAULT 0,
                    fault_mode TEXT NOT NULL DEFAULT '',
                    chain_json TEXT NOT NULL DEFAULT '[]',
                    analysis_json TEXT NOT NULL DEFAULT '{}',
                    detail_json TEXT NOT NULL DEFAULT '{}',
                    resolution_note TEXT NOT NULL DEFAULT '',
                    resolved_by TEXT REFERENCES users(id),
                    resolved_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(project_id, log_batch_id, external_incident_id)
                );

                CREATE TABLE IF NOT EXISTS incident_actions (
                    id TEXT PRIMARY KEY,
                    incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
                    actor_id TEXT NOT NULL REFERENCES users(id),
                    action TEXT NOT NULL,
                    note TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id, status);
                CREATE INDEX IF NOT EXISTS idx_architectures_project ON architecture_imports(project_id, created_at);
                CREATE INDEX IF NOT EXISTS idx_log_batches_project ON log_batches(project_id, created_at);
                CREATE INDEX IF NOT EXISTS idx_incidents_project ON incidents(project_id, status, created_at);
                CREATE INDEX IF NOT EXISTS idx_actions_incident ON incident_actions(incident_id, created_at);
                """
            )

    def query_one(self, sql: str, params: Iterable[Any] = ()) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(sql, tuple(params)).fetchone()
            return dict(row) if row else None

    def query_all(self, sql: str, params: Iterable[Any] = ()) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(sql, tuple(params)).fetchall()
            return [dict(row) for row in rows]

    def execute(self, sql: str, params: Iterable[Any] = ()) -> None:
        with self.connect() as connection:
            connection.execute(sql, tuple(params))
            connection.commit()

    # Users and sessions
    def user_count(self) -> int:
        row = self.query_one("SELECT COUNT(*) AS value FROM users")
        return int((row or {}).get("value") or 0)

    def create_user(self, username: str, password_hash: str, display_name: str) -> dict[str, Any]:
        user_id = str(uuid.uuid4())
        now = utc_now()
        role = "admin" if self.user_count() == 0 else "user"
        self.execute(
            "INSERT INTO users(id, username, password_hash, display_name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (user_id, username, password_hash, display_name, role, now, now),
        )
        return self.get_user(user_id) or {}

    def get_user(self, user_id: str) -> dict[str, Any] | None:
        return self.query_one("SELECT * FROM users WHERE id = ?", (user_id,))

    def get_user_by_username(self, username: str) -> dict[str, Any] | None:
        return self.query_one("SELECT * FROM users WHERE username = ? COLLATE NOCASE", (username,))

    def create_session(self, token_hash: str, user_id: str, expires_at: str) -> None:
        self.execute(
            "INSERT INTO sessions(token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
            (token_hash, user_id, expires_at, utc_now()),
        )

    def get_session_user(self, token_hash: str, now: str) -> dict[str, Any] | None:
        return self.query_one(
            """
            SELECT u.* FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ? AND s.expires_at > ? AND u.is_active = 1
            """,
            (token_hash, now),
        )

    def delete_session(self, token_hash: str) -> None:
        self.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))

    def cleanup_sessions(self, now: str) -> None:
        self.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))

    # Projects
    def create_project(self, owner_id: str, name: str, description: str) -> dict[str, Any]:
        project_id = str(uuid.uuid4())
        now = utc_now()
        self.execute(
            "INSERT INTO projects(id, owner_id, name, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
            (project_id, owner_id, name, description, now, now),
        )
        return self.get_project(project_id) or {}

    def get_project(self, project_id: str) -> dict[str, Any] | None:
        return self.query_one("SELECT * FROM projects WHERE id = ?", (project_id,))

    def list_projects(self, owner_id: str, include_archived: bool = False) -> list[dict[str, Any]]:
        if include_archived:
            return self.query_all(
                "SELECT * FROM projects WHERE owner_id = ? ORDER BY updated_at DESC",
                (owner_id,),
            )
        return self.query_all(
            "SELECT * FROM projects WHERE owner_id = ? AND status != 'archived' ORDER BY updated_at DESC",
            (owner_id,),
        )

    def update_project(self, project_id: str, name: str, description: str, status: str) -> dict[str, Any]:
        self.execute(
            "UPDATE projects SET name = ?, description = ?, status = ?, updated_at = ? WHERE id = ?",
            (name, description, status, utc_now(), project_id),
        )
        return self.get_project(project_id) or {}

    def dashboard(self, project_id: str) -> dict[str, Any]:
        counts = self.query_one(
            """
            SELECT
              (SELECT COUNT(*) FROM architecture_imports WHERE project_id = ? AND status = 'completed') AS architectures,
              (SELECT COUNT(*) FROM log_batches WHERE project_id = ? AND status = 'completed') AS log_batches,
              (SELECT COUNT(*) FROM incidents WHERE project_id = ?) AS incidents,
              (SELECT COUNT(*) FROM incidents WHERE project_id = ? AND status IN ('open', 'in_progress')) AS open_incidents,
              (SELECT COUNT(*) FROM incidents WHERE project_id = ? AND status = 'resolved') AS resolved_incidents
            """,
            (project_id, project_id, project_id, project_id, project_id),
        ) or {}
        recent = self.query_all(
            "SELECT id, title, severity, status, root_candidate, root_confidence, created_at FROM incidents WHERE project_id = ? ORDER BY created_at DESC LIMIT 8",
            (project_id,),
        )
        return {**counts, "recent_incidents": recent}

    # Architecture imports
    def create_architecture_import(
        self,
        project_id: str,
        name: str,
        source_file: str,
        source_text: str,
        created_by: str,
    ) -> dict[str, Any]:
        item_id = str(uuid.uuid4())
        self.execute(
            """
            INSERT INTO architecture_imports(id, project_id, name, source_file, source_text, status, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, 'processing', ?, ?)
            """,
            (item_id, project_id, name, source_file, source_text, created_by, utc_now()),
        )
        return self.get_architecture_import(item_id) or {}

    def get_architecture_import(self, item_id: str) -> dict[str, Any] | None:
        return self.query_one("SELECT * FROM architecture_imports WHERE id = ?", (item_id,))

    def list_architecture_imports(self, project_id: str) -> list[dict[str, Any]]:
        return self.query_all(
            """
            SELECT id, project_id, name, source_file, status, extracted_nodes, extracted_edges,
                   error_message, created_by, created_at, completed_at
            FROM architecture_imports WHERE project_id = ? ORDER BY created_at DESC
            """,
            (project_id,),
        )

    def complete_architecture_import(
        self,
        item_id: str,
        nodes: int,
        edges: int,
        execution_logs_json: str,
        graph_snapshot_json: str,
    ) -> None:
        self.execute(
            """
            UPDATE architecture_imports SET status = 'completed', extracted_nodes = ?, extracted_edges = ?,
                execution_logs_json = ?, graph_snapshot_json = ?, completed_at = ? WHERE id = ?
            """,
            (nodes, edges, execution_logs_json, graph_snapshot_json, utc_now(), item_id),
        )

    def fail_architecture_import(self, item_id: str, error_message: str) -> None:
        self.execute(
            "UPDATE architecture_imports SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?",
            (error_message[:4000], utc_now(), item_id),
        )

    # Log batches
    def create_log_batch(
        self,
        project_id: str,
        filename: str,
        input_path: str,
        train_filename: str,
        train_path: str,
        output_path: str,
        created_by: str,
        batch_id: str | None = None,
    ) -> dict[str, Any]:
        batch_id = batch_id or str(uuid.uuid4())
        self.execute(
            """
            INSERT INTO log_batches(id, project_id, filename, input_path, train_filename, train_path,
                                    output_path, status, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?)
            """,
            (batch_id, project_id, filename, input_path, train_filename, train_path, output_path, created_by, utc_now()),
        )
        return self.get_log_batch(batch_id) or {}

    def get_log_batch(self, batch_id: str) -> dict[str, Any] | None:
        return self.query_one("SELECT * FROM log_batches WHERE id = ?", (batch_id,))

    def list_log_batches(self, project_id: str) -> list[dict[str, Any]]:
        return self.query_all(
            """
            SELECT id, project_id, filename, train_filename, output_path, status, summary_json,
                   error_message, created_by, created_at, completed_at
            FROM log_batches WHERE project_id = ? ORDER BY created_at DESC
            """,
            (project_id,),
        )

    def complete_log_batch(self, batch_id: str, summary_json: str, rca_json: str) -> None:
        self.execute(
            "UPDATE log_batches SET status = 'completed', summary_json = ?, rca_json = ?, completed_at = ? WHERE id = ?",
            (summary_json, rca_json, utc_now(), batch_id),
        )

    def fail_log_batch(self, batch_id: str, error_message: str) -> None:
        self.execute(
            "UPDATE log_batches SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?",
            (error_message[:4000], utc_now(), batch_id),
        )

    def delete_log_batch(self, batch_id: str) -> bool:
        """Delete one batch; incident rows/actions cascade through foreign keys."""
        with self.connect() as connection:
            cursor = connection.execute("DELETE FROM log_batches WHERE id = ?", (batch_id,))
            connection.commit()
            return cursor.rowcount > 0

    # Incidents and resolution history
    def upsert_incident(self, data: dict[str, Any]) -> dict[str, Any]:
        incident_id = str(uuid.uuid4())
        now = utc_now()
        self.execute(
            """
            INSERT INTO incidents(
                id, project_id, log_batch_id, external_incident_id, graph_incident_id, title,
                severity, status, root_candidate, root_confidence, fault_mode, chain_json,
                analysis_json, detail_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(project_id, log_batch_id, external_incident_id) DO UPDATE SET
                graph_incident_id = excluded.graph_incident_id,
                title = excluded.title,
                severity = excluded.severity,
                root_candidate = excluded.root_candidate,
                root_confidence = excluded.root_confidence,
                fault_mode = excluded.fault_mode,
                chain_json = excluded.chain_json,
                analysis_json = excluded.analysis_json,
                detail_json = excluded.detail_json,
                updated_at = excluded.updated_at
            """,
            (
                incident_id,
                data["project_id"],
                data["log_batch_id"],
                data["external_incident_id"],
                data["graph_incident_id"],
                data["title"],
                data["severity"],
                data.get("root_candidate", ""),
                float(data.get("root_confidence") or 0),
                data.get("fault_mode", ""),
                data.get("chain_json", "[]"),
                data.get("analysis_json", "{}"),
                data.get("detail_json", "{}"),
                now,
                now,
            ),
        )
        return self.query_one(
            "SELECT * FROM incidents WHERE project_id = ? AND log_batch_id = ? AND external_incident_id = ?",
            (data["project_id"], data["log_batch_id"], data["external_incident_id"]),
        ) or {}

    def list_incidents(self, project_id: str, status: str = "", severity: str = "") -> list[dict[str, Any]]:
        clauses = ["project_id = ?"]
        params: list[Any] = [project_id]
        if status:
            clauses.append("status = ?")
            params.append(status)
        if severity:
            clauses.append("severity = ?")
            params.append(severity)
        return self.query_all(
            f"""
            SELECT id, project_id, log_batch_id, external_incident_id, graph_incident_id, title,
                   severity, status, root_candidate, root_confidence, fault_mode, chain_json,
                   resolution_note, resolved_at, created_at, updated_at
            FROM incidents WHERE {' AND '.join(clauses)} ORDER BY created_at DESC
            """,
            params,
        )

    def get_incident(self, incident_id: str) -> dict[str, Any] | None:
        return self.query_one("SELECT * FROM incidents WHERE id = ?", (incident_id,))

    def update_incident_status(
        self,
        incident_id: str,
        status: str,
        resolution_note: str,
        actor_id: str,
    ) -> dict[str, Any]:
        now = utc_now()
        resolved = status == "resolved"
        self.execute(
            """
            UPDATE incidents SET status = ?, resolution_note = ?, resolved_by = ?, resolved_at = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                status,
                resolution_note,
                actor_id if resolved else None,
                now if resolved else None,
                now,
                incident_id,
            ),
        )
        self.add_incident_action(incident_id, actor_id, status, resolution_note)
        return self.get_incident(incident_id) or {}

    def add_incident_action(self, incident_id: str, actor_id: str, action: str, note: str = "") -> None:
        self.execute(
            "INSERT INTO incident_actions(id, incident_id, actor_id, action, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (str(uuid.uuid4()), incident_id, actor_id, action, note, utc_now()),
        )

    def list_incident_actions(self, incident_id: str) -> list[dict[str, Any]]:
        return self.query_all(
            """
            SELECT a.id, a.action, a.note, a.created_at, u.id AS actor_id, u.username, u.display_name
            FROM incident_actions a JOIN users u ON u.id = a.actor_id
            WHERE a.incident_id = ? ORDER BY a.created_at DESC
            """,
            (incident_id,),
        )


_database: SystemDatabase | None = None


def get_system_db() -> SystemDatabase:
    global _database
    if _database is None:
        _database = SystemDatabase()
    return _database
