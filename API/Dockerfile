# DealerPulse API: small, non-root image. The SQLite database lives in /app/data (mount a volume to keep changes).
FROM python:3.11-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY dealerpulse ./dealerpulse
COPY scripts ./scripts
COPY wsgi.py ./
COPY data ./data

RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin app && chown -R app:app /app/data
USER app

ENV DEALERPULSE_ENV=production \
    DATABASE_URL=sqlite:////app/data/dealerpulse.db \
    STREAM_MAX_SECONDS=300 \
    TRUST_PROXY=false
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health').status==200 else 1)"

# gthread workers keep notification streams from blocking other requests.
CMD ["gunicorn", "wsgi:app", "--bind", "0.0.0.0:8000", "--workers", "2", "--worker-class", "gthread", "--threads", "16", "--timeout", "0", "--graceful-timeout", "20", "--access-logfile", "-"]