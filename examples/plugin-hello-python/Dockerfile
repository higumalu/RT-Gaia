# 範例：plugin 自己一個容器；宿主只認 HTTP。
FROM python:3.12-slim
WORKDIR /app
COPY --from=rtgaia-sdk /wheels /wheels
RUN pip install --no-cache-dir /wheels/*.whl
COPY plugin.py .
ENV RTGAIA_PLUGIN_ARTIFACTS=/data/artifacts
EXPOSE 8701
CMD ["uvicorn", "plugin:app", "--host", "0.0.0.0", "--port", "8701"]
