#!/usr/bin/env python3
import json
import requests

BASE = "http://127.0.0.1:8000"
for path in ["/api/health", "/api/debug/hugegraph", "/api/debug/llm", "/api/graph?limit=800"]:
    url = BASE + path
    print("\n===", url, "===")
    try:
        r = requests.get(url, timeout=120)
        print(r.status_code)
        try:
            print(json.dumps(r.json(), ensure_ascii=False, indent=2)[:4000])
        except Exception:
            print(r.text[:4000])
    except Exception as e:
        print("ERROR", e)
