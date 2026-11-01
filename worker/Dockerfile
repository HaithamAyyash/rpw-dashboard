FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY nakhel_worker ./nakhel_worker
USER nobody
CMD ["python", "-m", "nakhel_worker"]
