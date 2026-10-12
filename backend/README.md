# Backend

```bash
cd backend
rm -f .env
cp .env.example .env
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

启动 LiteLLM 网关
```bash
cd backend
python -m venv .venv-litellm
# Linux/macOS: source .venv-litellm/bin/activate
# Windows PowerShell: .venv-litellm\Scripts\Activate.ps1
pip install "litellm[proxy]"
$env:LITELLM_MASTER_KEY="sk-local-gateway"
litellm --config litellm_config.yaml --port 4000
```

项目的 `LLM_PROTOCOL` 和 `RCA_DECISION_PROTOCOL` 可分别设置为
`litellm`、`conversation` 或 `llama_cpp`。`litellm` 模式只访问
`http://127.0.0.1:4000/v1`；`conversation` 模式的日志分析地址单独由
`LLM_CONVERSATION_URL` 配置，RCA 地址由 `RCA_DECISION_URL` 配置。新增云厂商、
自部署 vLLM、SGLang 或其他 OpenAI 兼容服务时，只需在 `litellm_config.yaml`
中增加模型别名。

生产环境部署
```bash
cd backend
rm -f .env
cp .env.example .env
pm2 start ./ecosystem.config.js
```
LiteLLM 的 `LITELLM_MASTER_KEY` 必须与项目的 `LLM_API_KEY` 和
`RCA_DECISION_API_KEY` 保持一致；生产环境请替换示例密钥。
