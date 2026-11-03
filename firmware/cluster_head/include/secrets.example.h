// Copy to include/secrets.h and fill in. secrets.h is git-ignored: never commit a real key.
#pragma once

#define NAKHEL_WIFI_SSID "your-wifi"
#define NAKHEL_WIFI_PASSWORD "your-wifi-password"

// Server address with no trailing slash. Use https:// for anything outside a test bench.
#define NAKHEL_SERVER_URL "http://192.168.1.10:3100"

// Created when the cluster head is registered, and shown once.
#define NAKHEL_API_KEY "nkh_replace_me"

// Root certificate (PEM) that signed the server's certificate. Required for https://: the firmware
// won't compile without it, because connecting unverified would hand the API key to anyone.
#define NAKHEL_ROOT_CA ""
