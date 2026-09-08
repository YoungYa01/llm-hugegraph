module.exports = {
    apps: [{
        name: "fastapi-app",
        script: "uvicorn",
        args: "app.main:app --reload --host 0.0.0.0 --port 8000",
    }]
}
