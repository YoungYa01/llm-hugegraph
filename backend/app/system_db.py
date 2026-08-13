from __future__ import annotations

import sqlite3
import uuid
import json
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
                    employee_id TEXT NOT NULL,
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
                    report_json TEXT NOT NULL DEFAULT '{}',
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

                CREATE TABLE IF NOT EXISTS graph_admin_operations (
                    id TEXT PRIMARY KEY,
                    actor_id TEXT NOT NULL,
                    action TEXT NOT NULL,
                    project_id TEXT,
                    target_id TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'previewed',
                    confirmation_text TEXT NOT NULL,
                    preview_json TEXT NOT NULL DEFAULT '{}',
                    result_json TEXT NOT NULL DEFAULT '{}',
                    error_message TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    started_at TEXT,
                    completed_at TEXT,
                    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
                );

                CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id, status);
                CREATE INDEX IF NOT EXISTS idx_architectures_project ON architecture_imports(project_id, created_at);
                CREATE INDEX IF NOT EXISTS idx_log_batches_project ON log_batches(project_id, created_at);
                CREATE INDEX IF NOT EXISTS idx_incidents_project ON incidents(project_id, status, created_at);
                CREATE INDEX IF NOT EXISTS idx_actions_incident ON incident_actions(incident_id, created_at);
                CREATE INDEX IF NOT EXISTS idx_graph_admin_operations_created ON graph_admin_operations(created_at);
                CREATE INDEX IF NOT EXISTS idx_graph_admin_operations_project ON graph_admin_operations(project_id, created_at);
                """
            )
            user_cols = [row[1] for row in connection.execute("PRAGMA table_info(users)").fetchall()]
            if "employee_id" not in user_cols:
                connection.execute("ALTER TABLE users ADD COLUMN employee_id TEXT NOT NULL DEFAULT ''")
            # 兼容性表结构升级：确保长任务具备进度列与阶段描述列
            for table in ("architecture_imports", "log_batches"):
                cols = [row[1] for row in connection.execute(f"PRAGMA table_info({table})").fetchall()]
                if "progress" not in cols:
                    connection.execute(f"ALTER TABLE {table} ADD COLUMN progress INTEGER NOT NULL DEFAULT 0")
                if "progress_message" not in cols:
                    connection.execute(f"ALTER TABLE {table} ADD COLUMN progress_message TEXT NOT NULL DEFAULT ''")
                if table == "log_batches" and "report_json" not in cols:
                    connection.execute(f"ALTER TABLE {table} ADD COLUMN report_json TEXT NOT NULL DEFAULT '{{}}'")

    # Graph administration and audit
    def create_graph_admin_operation(
        self,
        *,
        actor_id: str,
        action: str,
        project_id: str | None,
        target_id: str,
        confirmation_text: str,
        preview: dict[str, Any],
    ) -> dict[str, Any]:
        operation_id = str(uuid.uuid4())
        self.execute(
            """
            INSERT INTO graph_admin_operations(
                id, actor_id, action, project_id, target_id, status,
                confirmation_text, preview_json, created_at
            ) VALUES (?, ?, ?, ?, ?, 'previewed', ?, ?, ?)
            """,
            (
                operation_id,
                actor_id,
                action,
                project_id,
                target_id,
                confirmation_text,
                json.dumps(preview, ensure_ascii=False),
                utc_now(),
            ),
        )
        return self.get_graph_admin_operation(operation_id) or {}

    def get_graph_admin_operation(self, operation_id: str) -> dict[str, Any] | None:
        return self.query_one(
            "SELECT * FROM graph_admin_operations WHERE id = ?",
            (operation_id,),
        )

    def start_graph_admin_operation(self, operation_id: str) -> bool:
        with self.connect() as connection:
            cursor = connection.execute(
                """
                UPDATE graph_admin_operations
                SET status = 'running', started_at = ?
                WHERE id = ? AND status = 'previewed'
                """,
                (utc_now(), operation_id),
            )
            connection.commit()
            return cursor.rowcount == 1

    def finish_graph_admin_operation(
        self,
        operation_id: str,
        *,
        result: dict[str, Any] | None = None,
        error_message: str = "",
    ) -> None:
        status = "failed" if error_message else "completed"
        self.execute(
            """
            UPDATE graph_admin_operations
            SET status = ?, result_json = ?, error_message = ?, completed_at = ?
            WHERE id = ?
            """,
            (
                status,
                json.dumps(result or {}, ensure_ascii=False),
                error_message[:4000],
                utc_now(),
                operation_id,
            ),
        )

    def list_graph_admin_operations(self, limit: int = 100) -> list[dict[str, Any]]:
        return self.query_all(
            """
            SELECT o.*, u.username AS actor_username, u.display_name AS actor_display_name,
                   u.employee_id AS actor_employee_id, p.name AS project_name
            FROM graph_admin_operations o
            LEFT JOIN users u ON u.id = o.actor_id
            LEFT JOIN projects p ON p.id = o.project_id
            ORDER BY o.created_at DESC
            LIMIT ?
            """,
            (max(1, min(int(limit), 500)),),
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

    def create_user(
        self,
        username: str,
        password_hash: str,
        display_name: str,
        employee_id: str,
    ) -> dict[str, Any]:
        user_id = str(uuid.uuid4())
        now = utc_now()
        role = "admin" if self.user_count() == 0 else "user"
        self.execute(
            "INSERT INTO users(id, username, password_hash, display_name, employee_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (user_id, username, password_hash, display_name, employee_id, role, now, now),
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
                "SELECT p.*, u.username AS owner_name, u.display_name AS owner_display_name FROM projects p LEFT JOIN users u ON p.owner_id = u.id WHERE p.owner_id = ? ORDER BY p.updated_at DESC",
                (owner_id,),
            )
        return self.query_all(
            "SELECT p.*, u.username AS owner_name, u.display_name AS owner_display_name FROM projects p LEFT JOIN users u ON p.owner_id = u.id WHERE p.owner_id = ? AND p.status != 'archived' ORDER BY p.updated_at DESC",
            (owner_id,),
        )

    def list_projects_for_user(self, user: dict[str, Any]) -> list[dict[str, Any]]:
        """管理员查看全系统所有人的项目，普通用户仅查看自己创建的项目。"""
        if user.get("role") == "admin":
            return self.query_all(
                """
                SELECT p.*, u.username AS owner_name, u.display_name AS owner_display_name
                FROM projects p
                LEFT JOIN users u ON p.owner_id = u.id
                WHERE p.status != 'archived'
                ORDER BY p.updated_at DESC
                """
            )
        return self.query_all(
            """
            SELECT p.*, u.username AS owner_name, u.display_name AS owner_display_name
            FROM projects p
            LEFT JOIN users u ON p.owner_id = u.id
            WHERE p.owner_id = ? AND p.status != 'archived'
            ORDER BY p.updated_at DESC
            """,
            (user["id"],),
        )

    def list_all_users(self) -> list[dict[str, Any]]:
        return self.query_all(
            "SELECT id, username, display_name, employee_id, role, is_active, created_at FROM users ORDER BY created_at ASC"
        )

    def update_user_role_and_status(self, user_id: str, role: str, is_active: int) -> dict[str, Any] | None:
        self.execute(
            "UPDATE users SET role = ?, is_active = ? WHERE id = ?",
            (role, is_active, user_id),
        )
        return self.get_user(user_id)

    def update_user_profile(
        self,
        user_id: str,
        display_name: str | None = None,
        employee_id: str | None = None,
        role: str | None = None,
        is_active: int | None = None,
        password_hash: str | None = None,
    ) -> dict[str, Any] | None:
        updates = []
        params = []
        if display_name is not None:
            updates.append("display_name = ?")
            params.append(display_name)
        if employee_id is not None:
            updates.append("employee_id = ?")
            params.append(employee_id)
        if role is not None:
            updates.append("role = ?")
            params.append(role)
        if is_active is not None:
            updates.append("is_active = ?")
            params.append(is_active)
        if password_hash is not None:
            updates.append("password_hash = ?")
            params.append(password_hash)

        if updates:
            params.append(user_id)
            query = f"UPDATE users SET {', '.join(updates)} WHERE id = ?"
            self.execute(query, tuple(params))

        return self.get_user(user_id)

    def update_project(self, project_id: str, name: str, description: str, status: str) -> dict[str, Any]:
        self.execute(
            "UPDATE projects SET name = ?, description = ?, status = ?, updated_at = ? WHERE id = ?",
            (name, description, status, utc_now(), project_id),
        )
        return self.get_project(project_id) or {}

    def delete_project(self, project_id: str) -> bool:
        """物理删除项目及其关联的所有架构、日志批次与故障记录（触发级联删除）。"""
        with self.connect() as connection:
            cursor = connection.execute("DELETE FROM projects WHERE id = ?", (project_id,))
            connection.commit()
            return cursor.rowcount > 0

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
        severity_row = self.query_one(
            """
            SELECT
              SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) AS cnt_critical,
              SUM(CASE WHEN severity = 'high' THEN 1 ELSE 0 END) AS cnt_high,
              SUM(CASE WHEN severity = 'medium' THEN 1 ELSE 0 END) AS cnt_medium,
              SUM(CASE WHEN severity = 'low' THEN 1 ELSE 0 END) AS cnt_low
            FROM incidents WHERE project_id = ?
            """,
            (project_id,),
        ) or {}
        status_row = self.query_one(
            """
            SELECT
              SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS cnt_open,
              SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS cnt_in_progress,
              SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS cnt_resolved
            FROM incidents WHERE project_id = ?
            """,
            (project_id,),
        ) or {}
        recent = self.query_all(
            "SELECT id, title, severity, status, root_candidate, root_confidence, created_at FROM incidents WHERE project_id = ? ORDER BY created_at DESC LIMIT 8",
            (project_id,),
        )
        return {
            **counts,
            "severity_dist": {
                "critical": int(severity_row.get("cnt_critical") or 0),
                "high": int(severity_row.get("cnt_high") or 0),
                "medium": int(severity_row.get("cnt_medium") or 0),
                "low": int(severity_row.get("cnt_low") or 0),
            },
            "status_dist": {
                "open": int(status_row.get("cnt_open") or 0),
                "in_progress": int(status_row.get("cnt_in_progress") or 0),
                "resolved": int(status_row.get("cnt_resolved") or 0),
            },
            "recent_incidents": recent,
        }

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
            INSERT INTO architecture_imports(id, project_id, name, source_file, source_text, status, progress, progress_message, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, 'processing', 5, '文件已接收，准备大模型抽取...', ?, ?)
            """,
            (item_id, project_id, name, source_file, source_text, created_by, utc_now()),
        )
        return self.get_architecture_import(item_id) or {}

    def get_architecture_import(self, item_id: str) -> dict[str, Any] | None:
        return self.query_one("SELECT * FROM architecture_imports WHERE id = ?", (item_id,))

    def list_architecture_imports(self, project_id: str) -> list[dict[str, Any]]:
        return self.query_all(
            """
            SELECT id, project_id, name, source_file, status, progress, progress_message, extracted_nodes, extracted_edges,
                   error_message, created_by, created_at, completed_at
            FROM architecture_imports WHERE project_id = ? ORDER BY created_at DESC
            """,
            (project_id,),
        )

    def update_architecture_progress(self, item_id: str, progress: int, message: str) -> None:
        self.execute(
            "UPDATE architecture_imports SET progress = ?, progress_message = ? WHERE id = ?",
            (max(0, min(100, progress)), message[:255], item_id),
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
            UPDATE architecture_imports SET status = 'completed', progress = 100, progress_message = '抽取与建图完成', extracted_nodes = ?, extracted_edges = ?,
                execution_logs_json = ?, graph_snapshot_json = ?, completed_at = ? WHERE id = ?
            """,
            (nodes, edges, execution_logs_json, graph_snapshot_json, utc_now(), item_id),
        )

    def fail_architecture_import(self, item_id: str, error_message: str) -> None:
        self.execute(
            "UPDATE architecture_imports SET status = 'failed', progress_message = ?, error_message = ?, completed_at = ? WHERE id = ?",
            (f"处理失败: {error_message[:150]}", error_message[:4000], utc_now(), item_id),
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
                                    output_path, status, progress, progress_message, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'processing', 5, '日志包接收完成，准备执行分析...', ?, ?)
            """,
            (batch_id, project_id, filename, input_path, train_filename, train_path, output_path, created_by, utc_now()),
        )
        return self.get_log_batch(batch_id) or {}

    def get_log_batch(self, batch_id: str) -> dict[str, Any] | None:
        return self.query_one("SELECT * FROM log_batches WHERE id = ?", (batch_id,))

    def list_log_batches(self, project_id: str) -> list[dict[str, Any]]:
        rows = self.query_all(
            """
            SELECT id, project_id, filename, train_filename, output_path, status, progress, progress_message, summary_json,
                   error_message, created_by, created_at, completed_at
            FROM log_batches WHERE project_id = ? ORDER BY created_at DESC
            """,
            (project_id,),
        )
        # 为每个批次附加严重度分布和已解决计数（单次查询聚合，避免 N+1）
        if rows:
            ids = [r["id"] for r in rows]
            placeholders = ",".join("?" * len(ids))
            agg_rows = self.query_all(
                f"""
                SELECT log_batch_id,
                       SUM(CASE WHEN severity='critical' THEN 1 ELSE 0 END) AS cnt_critical,
                       SUM(CASE WHEN severity='high'     THEN 1 ELSE 0 END) AS cnt_high,
                       SUM(CASE WHEN severity='medium'   THEN 1 ELSE 0 END) AS cnt_medium,
                       SUM(CASE WHEN severity='low'      THEN 1 ELSE 0 END) AS cnt_low,
                       SUM(CASE WHEN status='resolved'   THEN 1 ELSE 0 END) AS cnt_resolved,
                       COUNT(*) AS cnt_total
                FROM incidents
                WHERE log_batch_id IN ({placeholders})
                GROUP BY log_batch_id
                """,
                ids,
            )
            agg_map = {r["log_batch_id"]: r for r in agg_rows}
            for row in rows:
                agg = agg_map.get(row["id"], {})
                row["severity_dist"] = {
                    "critical": int(agg.get("cnt_critical") or 0),
                    "high":     int(agg.get("cnt_high")     or 0),
                    "medium":   int(agg.get("cnt_medium")   or 0),
                    "low":      int(agg.get("cnt_low")      or 0),
                }
                row["resolved_count"] = int(agg.get("cnt_resolved") or 0)
        return rows

    def complete_log_batch(self, batch_id: str, summary_json: str, rca_json: str, report_json: str = "{}") -> None:
        self.execute(
            "UPDATE log_batches SET status = 'completed', progress = 100, progress_message = '日志解析与 RCA 诊断完成', summary_json = ?, rca_json = ?, report_json = ?, completed_at = ? WHERE id = ?",
            (summary_json, rca_json, report_json, utc_now(), batch_id),
        )

    def update_log_batch_report(self, batch_id: str, report_json: str) -> None:
        self.execute(
            "UPDATE log_batches SET report_json = ? WHERE id = ?",
            (report_json, batch_id),
        )

    def update_log_batch_progress(
        self,
        batch_id: str,
        progress: int | None = None,
        progress_message: str | None = None,
        *,
        status: str = "processing",
        percent: int | None = None,
        stage: str = "",
        message: str | None = None,
    ) -> None:
        """Persist task progress while accepting both legacy and structured calls.

        Background analysis historically called this method as
        ``(batch_id, progress, message)``. Newer callers use keyword-only
        ``percent/stage/message`` values. Keeping one implementation prevents a
        later duplicate definition from silently breaking either call style.
        """
        progress_value = percent if percent is not None else progress
        progress_value = max(0, min(100, int(progress_value or 0)))
        message_value = message if message is not None else progress_message
        message_value = str(message_value or "")
        item = self.get_log_batch(batch_id)
        summary: dict[str, Any] = {}
        if item:
            try:
                data = json.loads(str(item.get("summary_json") or "{}"))
                summary = data if isinstance(data, dict) else {}
            except (TypeError, ValueError, json.JSONDecodeError):
                summary = {}
        summary.update(
            {
                "progress_percent": progress_value,
                "progress_stage": stage,
                "progress_message": message_value,
            }
        )
        self.execute(
            """
            UPDATE log_batches
            SET status = ?, progress = ?, progress_message = ?, summary_json = ?
            WHERE id = ?
            """,
            (
                status,
                progress_value,
                message_value[:255],
                json.dumps(summary, ensure_ascii=False),
                batch_id,
            ),
        )

    def fail_log_batch(self, batch_id: str, error_message: str) -> None:
        self.execute(
            "UPDATE log_batches SET status = 'failed', progress_message = ?, error_message = ?, completed_at = ? WHERE id = ?",
            (f"分析失败: {error_message[:150]}", error_message[:4000], utc_now(), batch_id),
        )

    def get_active_tasks(self, project_id: str) -> list[dict[str, Any]]:
        """Query currently active (processing) long tasks for the specified project."""
        tasks: list[dict[str, Any]] = []
        arch_rows = self.query_all(
            """
            SELECT id, name AS task_name, source_file AS filename, status, progress, progress_message, created_at
            FROM architecture_imports WHERE project_id = ? AND status = 'processing'
            ORDER BY created_at DESC
            """,
            (project_id,),
        )
        for r in arch_rows:
            tasks.append({
                "task_id": r["id"],
                "type": "architecture",
                "task_name": r["task_name"] or r["filename"] or "架构描述增量抽取",
                "filename": r["filename"],
                "status": r["status"],
                "progress": r["progress"],
                "progress_message": r["progress_message"] or "正在使用 LLM 抽取架构节点与拓扑...",
                "created_at": r["created_at"],
            })

        log_rows = self.query_all(
            """
            SELECT id, filename, status, progress, progress_message, created_at
            FROM log_batches WHERE project_id = ? AND status = 'processing'
            ORDER BY created_at DESC
            """,
            (project_id,),
        )
        for r in log_rows:
            tasks.append({
                "task_id": r["id"],
                "type": "logs",
                "task_name": f"日志分析 ({r['filename']})",
                "filename": r["filename"],
                "status": r["status"],
                "progress": r["progress"],
                "progress_message": r["progress_message"] or "正在执行日志解析与图谱 RCA 推理...",
                "created_at": r["created_at"],
            })
        return tasks

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

    def list_all_log_batches_admin(
        self,
        project_id: str | None = None,
        status_filter: str | None = None,
        has_fault: bool | None = None,
        search: str | None = None,
        page: int = 1,
        limit: int = 20,
    ) -> dict[str, Any]:
        """Admin cross-project query for log batches with pagination and rich filters."""
        where_clauses = ["1=1"]
        params: list[Any] = []

        if project_id:
            where_clauses.append("lb.project_id = ?")
            params.append(project_id)

        if status_filter:
            where_clauses.append("lb.status = ?")
            params.append(status_filter)

        if search:
            where_clauses.append(
                "(lb.filename LIKE ? OR p.name LIKE ? OR u.display_name LIKE ? OR u.username LIKE ?)"
            )
            term = f"%{search.strip()}%"
            params.extend([term, term, term, term])

        where_sql = " AND ".join(where_clauses)

        # Count query
        count_sql = f"""
            SELECT COUNT(*) as total
            FROM log_batches lb
            JOIN projects p ON p.id = lb.project_id
            JOIN users u ON u.id = lb.created_by
            WHERE {where_sql}
        """

        # Having clause for fault filter if specified
        having_sql = ""
        if has_fault is True:
            having_sql = " HAVING incident_count > 0"
        elif has_fault is False:
            having_sql = " HAVING incident_count = 0"

        offset = max(0, (page - 1) * limit)

        query_sql = f"""
            SELECT lb.id, lb.project_id, lb.filename, lb.input_path, lb.train_filename, lb.output_path,
                   lb.status, lb.summary_json, lb.error_message, lb.created_by, lb.created_at, lb.completed_at,
                   p.name AS project_name,
                   u.username AS creator_username,
                   u.display_name AS creator_display_name,
                   COUNT(i.id) AS incident_count,
                   SUM(CASE WHEN i.severity='critical' THEN 1 ELSE 0 END) AS cnt_critical,
                   SUM(CASE WHEN i.severity='high'     THEN 1 ELSE 0 END) AS cnt_high,
                   SUM(CASE WHEN i.severity='medium'   THEN 1 ELSE 0 END) AS cnt_medium,
                   SUM(CASE WHEN i.severity='low'      THEN 1 ELSE 0 END) AS cnt_low
            FROM log_batches lb
            JOIN projects p ON p.id = lb.project_id
            JOIN users u ON u.id = lb.created_by
            LEFT JOIN incidents i ON i.log_batch_id = lb.id
            WHERE {where_sql}
            GROUP BY lb.id
            {having_sql}
            ORDER BY lb.created_at DESC
        """

        raw_rows = self.query_all(query_sql, params)
        total_items = len(raw_rows)
        paged_rows = raw_rows[offset : offset + limit]

        items = []
        for r in paged_rows:
            item = dict(r)
            file_size_bytes = 0
            try:
                if item.get("input_path") and Path(item["input_path"]).exists():
                    file_size_bytes = Path(item["input_path"]).stat().st_size
                elif item.get("output_path") and Path(item["output_path"]).exists():
                    file_size_bytes = Path(item["output_path"]).stat().st_size
            except Exception:
                pass
            item["file_size_bytes"] = file_size_bytes
            item["severity_dist"] = {
                "critical": int(item.get("cnt_critical") or 0),
                "high": int(item.get("cnt_high") or 0),
                "medium": int(item.get("cnt_medium") or 0),
                "low": int(item.get("cnt_low") or 0),
            }
            items.append(item)

        return {
            "items": items,
            "total": total_items,
            "page": page,
            "limit": limit,
        }

    def get_global_log_stats_admin(self) -> dict[str, Any]:
        """Admin global summary metrics for log database management."""
        batch_counts = self.query_one(
            """
            SELECT
                COUNT(*) AS total_batches,
                SUM(CASE WHEN status = 'completed'  THEN 1 ELSE 0 END) AS total_completed,
                SUM(CASE WHEN status = 'failed'     THEN 1 ELSE 0 END) AS total_failed,
                SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS total_processing
            FROM log_batches
            """
        ) or {}

        fault_batch_row = self.query_one(
            """
            SELECT COUNT(DISTINCT log_batch_id) AS fault_batches FROM incidents
            """
        ) or {}

        incidents_row = self.query_one(
            """
            SELECT COUNT(*) AS total_incidents FROM incidents
            """
        ) or {}

        projects_row = self.query_all(
            """
            SELECT p.id AS project_id, p.name AS project_name,
                   COUNT(DISTINCT lb.id) AS batch_count,
                   COUNT(DISTINCT i.id) AS incident_count
            FROM projects p
            LEFT JOIN log_batches lb ON lb.project_id = p.id
            LEFT JOIN incidents i ON i.project_id = p.id
            GROUP BY p.id
            ORDER BY batch_count DESC
            """
        )

        all_batches = self.query_all("SELECT input_path, output_path, summary_json FROM log_batches")
        total_bytes = 0
        total_parsed_lines = 0

        for b in all_batches:
            try:
                ip = b.get("input_path")
                if ip and Path(ip).exists():
                    total_bytes += Path(ip).stat().st_size
                elif b.get("output_path") and Path(b["output_path"]).exists():
                    total_bytes += Path(b["output_path"]).stat().st_size
            except Exception:
                pass

            sj = b.get("summary_json")
            if sj:
                try:
                    import json
                    parsed = json.loads(sj) if isinstance(sj, str) else sj
                    total_parsed_lines += int(parsed.get("events") or parsed.get("lines_count") or parsed.get("total_lines") or 0)
                except Exception:
                    pass

        return {
            "total_batches": int(batch_counts.get("total_batches") or 0),
            "total_completed": int(batch_counts.get("total_completed") or 0),
            "total_failed": int(batch_counts.get("total_failed") or 0),
            "total_processing": int(batch_counts.get("total_processing") or 0),
            "fault_batches": int(fault_batch_row.get("fault_batches") or 0),
            "total_incidents": int(incidents_row.get("total_incidents") or 0),
            "total_file_size_bytes": total_bytes,
            "total_parsed_lines": total_parsed_lines,
            "projects_distribution": projects_row,
        }

    def get_log_batch_analytics_admin(self, batch_id: str) -> dict[str, Any] | None:
        """Get deep analytics and details for a specific log batch."""
        import csv

        row = self.query_one(
            """
            SELECT lb.*, p.name AS project_name, u.display_name AS creator_display_name, u.username AS creator_username
            FROM log_batches lb
            JOIN projects p ON p.id = lb.project_id
            JOIN users u ON u.id = lb.created_by
            WHERE lb.id = ?
            """,
            (batch_id,),
        )
        if not row:
            return None

        batch = dict(row)
        incidents = self.query_all(
            "SELECT * FROM incidents WHERE log_batch_id = ? ORDER BY created_at DESC",
            (batch_id,),
        )

        file_exists = False
        file_size = 0
        if batch.get("input_path") and Path(batch["input_path"]).exists():
            file_exists = True
            file_size = Path(batch["input_path"]).stat().st_size
        elif batch.get("output_path") and Path(batch["output_path"]).exists():
            file_exists = True
            file_size = Path(batch["output_path"]).stat().st_size

        templates_list = []
        events_sample = []
        report_md = ""

        output_dir = Path(batch.get("output_path") or "")
        if output_dir.exists() and output_dir.is_dir():
            tmpl_csv = output_dir / "templates.csv"
            if tmpl_csv.exists():
                try:
                    with open(tmpl_csv, "r", encoding="utf-8", errors="replace") as f:
                        reader = csv.DictReader(f)
                        for r in reader:
                            templates_list.append({
                                "id": r.get("EventId") or r.get("id") or r.get("TemplateId") or "",
                                "template": r.get("EventTemplate") or r.get("template") or r.get("Event") or "",
                                "count": int(r.get("Occurrences") or r.get("count") or 1)
                            })
                except Exception:
                    pass

            events_csv = output_dir / "events.csv"
            if events_csv.exists():
                try:
                    with open(events_csv, "r", encoding="utf-8", errors="replace") as f:
                        reader = csv.DictReader(f)
                        for i, r in enumerate(reader):
                            if i >= 100:
                                break
                            events_sample.append(dict(r))
                except Exception:
                    pass

            rep_path = output_dir / "report.md"
            if not rep_path.exists():
                rep_path = output_dir / "kg_rca_report.md"
            if rep_path.exists():
                try:
                    report_md = rep_path.read_text(encoding="utf-8", errors="replace")
                except Exception:
                    pass

            unassigned_errors = []
            unassigned_csv = output_dir / "unassigned_error_events.csv"
            if unassigned_csv.exists():
                try:
                    with open(unassigned_csv, "r", encoding="utf-8", errors="replace") as f:
                        reader = csv.DictReader(f)
                        for i, r in enumerate(reader):
                            if i >= 50:
                                break
                            unassigned_errors.append(dict(r))
                except Exception:
                    pass

            anomaly_windows = []
            windows_csv = output_dir / "anomaly_windows.csv"
            if windows_csv.exists():
                try:
                    with open(windows_csv, "r", encoding="utf-8", errors="replace") as f:
                        reader = csv.DictReader(f)
                        for i, r in enumerate(reader):
                            if i >= 50:
                                break
                            anomaly_windows.append(dict(r))
                except Exception:
                    pass

        return {
            "batch": batch,
            "incidents": incidents,
            "templates": templates_list,
            "events_sample": events_sample,
            "unassigned_errors": unassigned_errors,
            "anomaly_windows": anomaly_windows,
            "report_md": report_md,
            "file_info": {
                "exists": file_exists,
                "size_bytes": file_size,
            },
        }




_database: SystemDatabase | None = None


def get_system_db() -> SystemDatabase:
    global _database
    if _database is None:
        _database = SystemDatabase()
    return _database
