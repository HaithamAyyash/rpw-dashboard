// Runs the same ARQ engine as the ESP32 on a PC, against a real NAKHEL server, with faults injected.
// Driven by test_integration/test_uplink_server.py. Not part of the firmware.
#include <arpa/inet.h>
#include <netdb.h>
#include <sys/socket.h>
#include <unistd.h>

#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <random>
#include <string>
#include <thread>

#include "ram_queue.h"
#include "uplink.h"

using namespace nakhel;

namespace {

class SocketTransport : public HttpTransport {
 public:
  SocketTransport(std::string host, std::string port, std::string key) : host_(std::move(host)), port_(std::move(port)), key_(std::move(key)) {}

  void post(const char* path, const char* body, size_t length, HttpResponse& response) override {
    response.status = 0;
    addrinfo hints{};
    hints.ai_socktype = SOCK_STREAM;
    addrinfo* address = nullptr;
    if (getaddrinfo(host_.c_str(), port_.c_str(), &hints, &address) != 0) return;
    const int fd = socket(address->ai_family, address->ai_socktype, address->ai_protocol);
    timeval timeout{15, 0};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    if (connect(fd, address->ai_addr, address->ai_addrlen) == 0) {
      std::string request = std::string("POST ") + path + " HTTP/1.1\r\nHost: " + host_ + "\r\nAuthorization: Bearer " + key_ +
                            "\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: " + std::to_string(length) + "\r\n\r\n";
      request.append(body, length);
      if (send(fd, request.data(), request.size(), 0) == static_cast<ssize_t>(request.size())) {
        std::string all;
        char chunk[2048];
        ssize_t got = 0;
        while ((got = recv(fd, chunk, sizeof(chunk), 0)) > 0) all.append(chunk, static_cast<size_t>(got));
        const size_t split = all.find("\r\n\r\n");
        if (split != std::string::npos && all.rfind("HTTP/1.1 ", 0) == 0) {
          response.status = atoi(all.c_str() + 9);
          snprintf(response.body, sizeof(response.body), "%s", all.c_str() + split + 4);
        }
      }
    }
    close(fd);
    freeaddrinfo(address);
  }

 private:
  std::string host_;
  std::string port_;
  std::string key_;
};

// Applies a repeating fault pattern to data sends. Cluster health passes through untouched.
//   d = the network is down: nothing reaches the server
//   l = the server gets it and stores it, but the answer is lost (the classic ARQ case)
//   c = a captive portal answers 200 with its own page; the server sees nothing
//   5 = the server answers 503 without seeing it
//   o = normal
class FaultyTransport : public HttpTransport {
 public:
  FaultyTransport(HttpTransport& inner, std::string pattern) : inner_(inner), pattern_(std::move(pattern)) {}

  void post(const char* path, const char* body, size_t length, HttpResponse& response) override {
    if (strstr(path, "cluster-health") != nullptr || pattern_.empty()) {
      inner_.post(path, body, length, response);
      return;
    }
    const char fault = pattern_[next_++ % pattern_.size()];
    if (fault == 'd') {
      response.status = -1;
    } else if (fault == 'c') {
      response.status = 200;
      snprintf(response.body, sizeof(response.body), "<html>Sign in to Wi-Fi</html>");
    } else if (fault == '5') {
      response.status = 503;
    } else {
      inner_.post(path, body, length, response);
      if (fault == 'l') {
        response = HttpResponse();
        response.status = -1;
      }
    }
  }

 private:
  HttpTransport& inner_;
  std::string pattern_;
  size_t next_ = 0;
};

class HostPlatform : public UplinkPlatform {
 public:
  bool linkReady() override { return true; }
  int64_t epochSeconds() override { return static_cast<int64_t>(time(nullptr)); }
  uint32_t uptimeSeconds() override { return 123; }
  bool uplinkRssi(int16_t& rssi) override {
    rssi = -55;
    return true;
  }
  uint32_t random() override { return 0; }
  void log(const char* line) override { fprintf(stderr, "%s\n", line); }
};

// A known low value per node, so the test can check what the database holds and no alert is raised.
float scoreFor(int node) { return static_cast<float>(node % 40) / 100.0F; }

}  // namespace

// Usage: uplink_host <host> <port> <key> <base-epoch> <pattern> <node>...
int main(int argc, char** argv) {
  if (argc < 7) {
    fprintf(stderr, "usage: uplink_host host port key base-epoch fault-pattern node...\n");
    return 2;
  }
  SocketTransport socketTransport(argv[1], argv[2], argv[3]);
  std::string pattern = argv[5];
  if (pattern == "-") pattern.clear();
  FaultyTransport transport(socketTransport, pattern);
  static RamQueue<64> queue;
  HostPlatform platform;
  UplinkConfig config;
  config.firstRetryMs = 10;
  config.maxRetryMs = 40;
  static Uplink uplink(transport, queue, platform, config);

  static UplinkRecord record;
  const int64_t base = atoll(argv[4]);
  for (int i = 6; i < argc; ++i) {
    const int node = atoi(argv[i]);
    record = UplinkRecord();
    record.measurement.nodeId = static_cast<uint8_t>(node);
    record.measurement.timestampS = base + (i - 6);
    record.measurement.receivedAtS = base + (i - 6) + 1;
    record.measurement.hasSnr = true;
    record.measurement.snrDb = 7.5F;
    record.measurement.hasRssi = true;
    record.measurement.rssiDbm = -101;
    record.measurement.confidence = scoreFor(node);
    snprintf(record.measurement.modelVersion, sizeof(record.measurement.modelVersion), "node-test-1.0");
    queue.push(record);
  }
  const auto started = std::chrono::steady_clock::now();
  const auto nowMs = [&] { return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count()); };
  while (queue.count() > 0 && !uplink.keyRefused() && nowMs() < 60000) {
    const uint32_t wait = uplink.step(nowMs());
    if (wait > 0) std::this_thread::sleep_for(std::chrono::milliseconds(wait > 50 ? 50 : wait));
  }
  const UplinkStats& s = uplink.stats();
  printf("{\"left\":%zu,\"stored\":%u,\"duplicates\":%u,\"rejected\":%u,\"retries\":%u,\"health_sent\":%u,\"key_refused\":%s}\n", queue.count(), s.stored, s.duplicates,
         s.rejected, s.retries, s.healthSent, uplink.keyRefused() ? "true" : "false");
  return 0;
}
