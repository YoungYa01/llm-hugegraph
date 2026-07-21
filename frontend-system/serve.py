#!/usr/bin/env python3
"""Serve the native frontend with cache disabled during local development."""

from __future__ import annotations

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class NoCacheRequestHandler(SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the LogScope RCA management frontend")
    parser.add_argument("--bind", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=5174)
    args = parser.parse_args()

    frontend_dir = Path(__file__).resolve().parent
    handler = partial(NoCacheRequestHandler, directory=str(frontend_dir))
    server = ThreadingHTTPServer((args.bind, args.port), handler)
    print(f"LogScope RCA 管理端：http://127.0.0.1:{args.port}", flush=True)
    print("当前界面版本：2026.07.21-r2（已禁用浏览器缓存）", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
