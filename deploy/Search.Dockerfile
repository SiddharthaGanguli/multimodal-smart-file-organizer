FROM python:3.11-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 SEARCH_MODEL_DIR=/opt/filewise-model
WORKDIR /srv/filewise
COPY pyproject.toml README.md ./
COPY app ./app
COPY deploy/model-NOTICE.txt deploy/model-LICENSE.txt ./licenses/
RUN pip install --no-cache-dir '.[search]' && python -m app.retrieval.model --download \
    && useradd --uid 10001 --create-home filewise
USER filewise
EXPOSE 10000
# Render terminates TLS at its proxy; this container is only reached through that proxy.
CMD ["sh", "-c", "exec uvicorn app.search_api:app --host 0.0.0.0 --port ${PORT:-10000} --workers 1 --proxy-headers --forwarded-allow-ips '*' --no-access-log"]
