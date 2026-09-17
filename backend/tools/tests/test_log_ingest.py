from __future__ import annotations

import json
import gzip
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[2]
LIB_ROOT = BACKEND_ROOT / "lib"
if str(LIB_ROOT) not in sys.path:
    sys.path.insert(0, str(LIB_ROOT))

from logfault.ingest import load_events, parse_log_file_with_report  # noqa: E402
from logfault.drain_adapter import template_events  # noqa: E402
from logfault.features import build_window_features  # noqa: E402


INPUT_CONFIG = {
    "include_globs": ["**/*"],
    "exclude_globs": [],
    "supported_suffixes": [
        ".log", ".txt", ".out", ".json", ".jsonl", ".ndjson", ".access", ".error", "",
    ],
    "encoding": "auto",
    "encoding_errors": "replace",
    "minimum_confidence": 0.1,
}


class LogIngestTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="logfault-test-")
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_legacy_spring_and_java_exception_chain(self) -> None:
        path = self.root / "order-service-8080.log"
        path.write_text(
            "26/01/20 14:12:21.240 ERROR --- [http-1] com.demo.Order : [trace-123] request failed\n"
            "java.lang.RuntimeException: wrapper\n"
            "\tat com.demo.Order.run(Order.java:10)\n"
            "Caused by: java.net.ConnectException: Connection refused\n",
            encoding="utf-8",
        )

        result, scores = parse_log_file_with_report(path)

        self.assertEqual(result.parser_name, "spring_java")
        self.assertEqual(dict(scores)["spring_java"], 1.0)
        self.assertEqual(len(result.events), 1)
        event = result.events[0]
        self.assertEqual(event.service, "order-service")
        self.assertEqual(event.trace_id, "trace-123")
        self.assertEqual(event.root_exception_class, "java.net.ConnectException")
        self.assertEqual(event.source_line_end, 4)
        self.assertTrue(event.raw_block.startswith("26/01/20"))

    def test_modern_spring_with_pid_context_and_iso_timezone(self) -> None:
        path = self.root / "billing.txt"
        path.write_text(
            "2026-01-20T14:12:21.240+08:00 INFO 12345 --- [billing] [main] com.demo.App : started\n",
            encoding="utf-8",
        )

        frame = load_events(path, INPUT_CONFIG)

        row = frame.iloc[0]
        self.assertEqual(row["parser_name"], "spring_java")
        self.assertEqual(row["process_id"], "12345")
        self.assertEqual(str(row["timestamp"]), "2026-01-20 06:12:21.240000")

    def test_json_nested_fields_and_python_exception(self) -> None:
        path = self.root / "worker.ndjson"
        payload = {
            "@timestamp": "2026-01-20T14:12:21.240Z",
            "log": {"level": "error", "logger": "worker.jobs"},
            "service": {"name": "worker-service", "instance": {"id": "worker-2"}},
            "trace": {"id": "abcde12345"},
            "message": "job failed",
            "exception": {"stacktrace": "Traceback (most recent call last):\nValueError: bad input"},
        }
        path.write_text(json.dumps(payload) + "\n", encoding="utf-8")

        frame = load_events(path, INPUT_CONFIG)

        row = frame.iloc[0]
        self.assertEqual(row["parser_name"], "json")
        self.assertEqual(row["service"], "worker-service")
        self.assertEqual(row["instance"], "worker-2")
        self.assertEqual(row["trace_id"], "abcde12345")
        self.assertEqual(row["root_exception_class"], "ValueError")

    def test_logfmt_and_nginx_formats(self) -> None:
        logfmt = self.root / "api.out"
        logfmt.write_text(
            'time="2026-01-20T14:12:21.240Z" level=warning service=api '
            'msg="slow request" trace_id=trace-9\n',
            encoding="utf-8",
        )
        nginx = self.root / "nginx.access"
        nginx.write_text(
            '127.0.0.1 - - [20/Jan/2026:14:12:21 +0800] "GET /health HTTP/1.1" '
            '503 12 "-" "curl"\n',
            encoding="utf-8",
        )

        logfmt_frame = load_events(logfmt, INPUT_CONFIG)
        nginx_frame = load_events(nginx, INPUT_CONFIG)

        self.assertEqual(logfmt_frame.iloc[0]["level"], "WARN")
        self.assertEqual(logfmt_frame.iloc[0]["message"], "slow request")
        self.assertEqual(nginx_frame.iloc[0]["parser_name"], "nginx_access")
        self.assertEqual(nginx_frame.iloc[0]["level"], "ERROR")

    def test_zip_parses_multiple_formats_and_error_logs(self) -> None:
        archive_path = self.root / "logs.zip"
        with zipfile.ZipFile(archive_path, "w") as archive:
            archive.writestr(
                "node-a/order-err.log",
                "2026-01-20 14:12:21.240 ERROR --- [main] demo.Order : failed\n",
            )
            archive.writestr(
                "node-b/gateway.jsonl",
                json.dumps({
                    "timestamp": "2026-01-20T14:12:22Z",
                    "level": "info",
                    "service": "gateway",
                    "message": "accepted",
                }) + "\n",
            )

        frame = load_events(archive_path, INPUT_CONFIG)

        self.assertEqual(len(frame), 2)
        self.assertEqual(set(frame["parser_name"]), {"spring_java", "json"})
        self.assertEqual(frame.attrs["parse_quality"]["source_files"], 2)
        self.assertEqual(
            frame.attrs["parse_quality"]["parser_distribution"],
            {"spring_java": 1, "json": 1},
        )

    def test_kubernetes_cri_and_syslog(self) -> None:
        cri = self.root / "pod.log"
        cri.write_text(
            "2026-01-20T14:12:21.240Z stderr F "
            "2026-01-20 22:12:21.240 ERROR --- [main] demo.Pod : container failed\n",
            encoding="utf-8",
        )
        syslog = self.root / "system.txt"
        syslog.write_text(
            "<34>1 2026-01-20T14:12:21Z host-a checkout 123 ID47 - disk failure\n",
            encoding="utf-8",
        )

        cri_frame = load_events(cri, INPUT_CONFIG)
        syslog_frame = load_events(syslog, INPUT_CONFIG)

        self.assertEqual(cri_frame.iloc[0]["parser_name"], "kubernetes_cri")
        self.assertEqual(cri_frame.iloc[0]["message"], "container failed")
        self.assertEqual(syslog_frame.iloc[0]["parser_name"], "syslog")
        self.assertEqual(syslog_frame.iloc[0]["service"], "checkout")
        self.assertEqual(syslog_frame.iloc[0]["level"], "FATAL")

    def test_gzip_and_gb18030_are_detected(self) -> None:
        gzip_path = self.root / "inventory.log.gz"
        raw = (
            "2026-01-20 14:12:21.240 INFO --- [main] demo.Inventory : 库存更新完成\n"
        ).encode("gb18030")
        with gzip.open(gzip_path, "wb") as handle:
            handle.write(raw)

        frame = load_events(gzip_path, INPUT_CONFIG)

        self.assertEqual(frame.iloc[0]["message"], "库存更新完成")
        self.assertEqual(frame.attrs["parse_quality"]["files"][0]["encoding"], "gb18030")

    def test_unrecognized_text_is_not_assigned_a_fake_timestamp(self) -> None:
        path = self.root / "unknown.txt"
        path.write_text("hello world\nno timestamp here\n", encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "没有解析出带有效时间戳"):
            load_events(path, INPUT_CONFIG)

    def test_new_event_columns_remain_compatible_with_drain_and_windows(self) -> None:
        path = self.root / "events.jsonl"
        path.write_text(
            "\n".join([
                json.dumps({
                    "timestamp": "2026-01-20T14:12:21Z",
                    "level": "info",
                    "service": "gateway",
                    "message": "request 100 accepted",
                }),
                json.dumps({
                    "timestamp": "2026-01-20T14:13:21Z",
                    "level": "error",
                    "service": "gateway",
                    "message": "request 101 failed",
                }),
            ]) + "\n",
            encoding="utf-8",
        )

        events = load_events(path, INPUT_CONFIG)
        templated, templates, _ = template_events(events, {
            "backend": "fallback",
            "similarity_threshold": 0.4,
            "mask_patterns": [r"\b\d+\b"],
        })
        windowed = build_window_features(
            templated,
            {"size_minutes": 5, "step_minutes": 1, "min_events": 1},
            {"namespace_by_service": True, "include_levels": False},
        )

        self.assertFalse(templates.empty)
        self.assertFalse(windowed.metadata.empty)
        self.assertTrue(all(name.startswith("gateway::") for name in windowed.matrix.columns))


if __name__ == "__main__":
    unittest.main()
