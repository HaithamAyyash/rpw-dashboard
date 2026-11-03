# PlatformIO plus a host compiler: builds the firmware and runs its tests with no setup on the host.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends build-essential git \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir platformio==6.1.18
