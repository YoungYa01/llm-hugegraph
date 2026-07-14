# Backend

```bash
cd backend
rm -f .env
cp .env.example .env
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

检查：

- http://127.0.0.1:8000/api/health
- http://127.0.0.1:8000/api/debug/hugegraph
- http://127.0.0.1:8000/api/debug/llm
- http://127.0.0.1:8000/api/graph?limit=800

本版不使用 `/gremlin`。LLM 优先使用 LangChain `ChatOpenAI`，但不使用 `ChatPromptTemplate` 渲染含 JSON 示例的提示词，避免大括号模板解析错误；失败后会自动尝试 OpenAI 兼容 HTTP 和 llama.cpp `/completion`。
