# Backend

```bash
cd backend
rm -f .env
cp .env.example .env
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

生产环境部署
```bash
cd backend
rm -f .env
cp .env.example .env
pm2 start ./ecosystem.config.js
```