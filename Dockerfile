# Alternative zum GitHub-Actions-Betrieb: läuft auf jedem eigenen Server/VM dauerhaft.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg git ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && (pip install --no-cache-dir "piper-tts>=1.2" || true)
COPY . .
ENV TZ=Europe/Berlin AUTOTUBE_WORK=/app/work PYTHONUNBUFFERED=1
HEALTHCHECK --interval=5m --timeout=20s CMD python -m autotube check --offline --no-fail >/dev/null || exit 1
CMD ["python", "-m", "autotube", "serve"]
