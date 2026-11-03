// The ARQ engine against a scripted server: no board or network. Run with: pio test -e native
#include <unity.h>

#include <cmath>
#include <cstdio>
#include <cstring>
#include <deque>
#include <limits>
#include <string>
#include <vector>

#include "payload.h"
#include "ram_queue.h"
#include "response.h"
#include "uplink.h"

using namespace nakhel;

namespace {

constexpr int64_t kTs = 1793124004;
constexpr uint32_t kFar = 1000000000;

struct Answer {
  int status;
  std::string body;
};

class ScriptedTransport : public HttpTransport {
 public:
  void post(const char* path, const char* body, size_t length, HttpResponse& response) override {
    paths.emplace_back(path);
    bodies.emplace_back(body, length);
    if (answers.empty()) {
      response.status = 0;
      return;
    }
    const Answer answer = answers.front();
    answers.pop_front();
    response.status = answer.status;
    snprintf(response.body, sizeof(response.body), "%s", answer.body.c_str());
  }
  std::deque<Answer> answers;
  std::vector<std::string> paths;
  std::vector<std::string> bodies;
};

class FakePlatform : public UplinkPlatform {
 public:
  bool linkReady() override { return link; }
  int64_t epochSeconds() override { return now; }
  uint32_t uptimeSeconds() override { return 77; }
  bool uplinkRssi(int16_t& rssi) override {
    rssi = -60;
    return true;
  }
  uint32_t random() override { return randomValue; }
  void log(const char* line) override { logs.emplace_back(line); }
  void onRejected(const UplinkRecord&, const char* reason) override { rejectedReasons.emplace_back(reason); }
  bool logged(const char* text) {
    for (const auto& line : logs) {
      if (line.find(text) != std::string::npos) return true;
    }
    return false;
  }
  bool link = true;
  int64_t now = kTs;
  uint32_t randomValue = 0;
  std::vector<std::string> logs;
  std::vector<std::string> rejectedReasons;
};

UplinkRecord measurement(uint8_t node, int64_t ts = kTs) {
  UplinkRecord record;
  record.measurement.nodeId = node;
  record.measurement.timestampS = ts;
  record.measurement.confidence = 0.25F;
  snprintf(record.measurement.modelVersion, sizeof(record.measurement.modelVersion), "node-1.0");
  return record;
}

std::string iso(int64_t ts) {
  char out[kIsoBytes];
  formatIso8601(ts, out);
  return out;
}

Answer ok(int node, int64_t ts = kTs, const char* status = "stored", int code = 201) {
  return {code, std::string("{\"status\":\"") + status + "\",\"node_id\":" + std::to_string(node) + ",\"timestamp\":\"" +
                    iso(ts) + "\",\"server_time\":\"" + iso(ts) + "\"}"};
}

Answer failure(int code, const char* errorCode) {
  return {code, std::string("{\"error\":{\"code\":\"") + errorCode + "\",\"message\":\"x\"},\"server_time\":\"" + iso(kTs) + "\"}"};
}

// Health isn't under test in most cases, so push it far into the future with one successful send.
struct Rig {
  ScriptedTransport transport;
  RamQueue<8> queue;
  FakePlatform platform;
  UplinkConfig config;
  Uplink* uplink = nullptr;
  uint64_t now = 0;

  explicit Rig(uint32_t healthInterval = kFar) {
    config.clusterHealthIntervalMs = healthInterval;
    uplink = new Uplink(transport, queue, platform, config);
    transport.answers.push_back({201, "{\"status\":\"stored\",\"timestamp\":\"" + iso(kTs) + "\"}"});
    uplink->step(now);
    transport.paths.clear();
    transport.bodies.clear();
  }
  ~Rig() { delete uplink; }
  uint32_t step() { return uplink->step(now); }
};

}  // namespace

void setUp() {}
void tearDown() {}

// ---------- ARQ ----------

void test_ack_removes_the_record_and_keeps_order() {
  Rig rig;
  rig.queue.push(measurement(1));
  rig.queue.push(measurement(2));
  rig.transport.answers = {ok(1), ok(2)};
  rig.step();
  TEST_ASSERT_EQUAL_UINT(1, rig.queue.count());
  TEST_ASSERT_TRUE(rig.transport.bodies[0].find("\"node_id\":1,") != std::string::npos);
  rig.step();
  TEST_ASSERT_EQUAL_UINT(0, rig.queue.count());
  TEST_ASSERT_TRUE(rig.transport.bodies[1].find("\"node_id\":2,") != std::string::npos);
  TEST_ASSERT_EQUAL_UINT32(2, rig.uplink->stats().stored);
}

void test_no_answer_keeps_the_record_and_blocks_the_next_one() {
  Rig rig;
  rig.queue.push(measurement(1));
  rig.queue.push(measurement(2));
  rig.step();  // no scripted answer: a timeout
  TEST_ASSERT_EQUAL_UINT(2, rig.queue.count());
  TEST_ASSERT_EQUAL_UINT32(1, rig.uplink->stats().retries);
  rig.now += rig.config.firstRetryMs;
  rig.transport.answers = {ok(1)};
  rig.step();
  TEST_ASSERT_TRUE(rig.transport.bodies[1].find("\"node_id\":1,") != std::string::npos);
}

void test_retransmission_is_byte_identical() {
  Rig rig;
  auto record = measurement(9);
  record.measurement.confidence = 0.8125F;
  rig.queue.push(record);
  rig.step();
  rig.platform.now += 3600;  // the clock moves on, but the timestamp must not
  rig.now += rig.config.firstRetryMs;
  rig.step();
  TEST_ASSERT_EQUAL_UINT(2, rig.transport.bodies.size());
  TEST_ASSERT_TRUE(rig.transport.bodies[0] == rig.transport.bodies[1]);
}

void test_lost_ack_ends_with_a_duplicate_answer_and_removal() {
  Rig rig;
  rig.queue.push(measurement(1));
  rig.step();
  rig.now += rig.config.firstRetryMs;
  rig.transport.answers = {ok(1, kTs, "duplicate", 200)};
  rig.step();
  TEST_ASSERT_EQUAL_UINT(0, rig.queue.count());
  TEST_ASSERT_EQUAL_UINT32(1, rig.uplink->stats().duplicates);
  TEST_ASSERT_EQUAL_UINT32(0, rig.uplink->stats().stored);
}

void test_nothing_is_sent_before_the_backoff_ends() {
  Rig rig;
  rig.queue.push(measurement(1));
  rig.step();
  const uint32_t wait = rig.step();
  TEST_ASSERT_EQUAL_UINT32(rig.config.firstRetryMs, wait);
  rig.now += rig.config.firstRetryMs - 1;
  rig.step();
  TEST_ASSERT_EQUAL_UINT(1, rig.transport.bodies.size());
  rig.now += 1;
  rig.step();
  TEST_ASSERT_EQUAL_UINT(2, rig.transport.bodies.size());
}

void test_backoff_doubles_to_the_cap_and_resets_after_an_ack() {
  Rig rig;
  rig.queue.push(measurement(1));
  rig.queue.push(measurement(2));
  const uint32_t expected[] = {5000, 10000, 20000, 40000, 80000, 160000, 320000, 600000, 600000};
  for (uint32_t delay : expected) {
    rig.step();
    TEST_ASSERT_EQUAL_UINT32(delay, rig.step());
    rig.now += delay;
  }
  rig.transport.answers = {ok(1)};
  rig.step();
  rig.step();  // node 2 goes out at once, then fails
  TEST_ASSERT_EQUAL_UINT32(5000, rig.step());
}

void test_jitter_adds_at_most_twenty_percent() {
  Rig rig;
  rig.platform.randomValue = 999;  // 999 % 1000 = the largest possible
  rig.queue.push(measurement(1));
  rig.step();
  TEST_ASSERT_EQUAL_UINT32(5999, rig.step());
}

void test_retries_never_give_up() {
  Rig rig;
  rig.queue.push(measurement(1));
  for (int i = 0; i < 500; ++i) {
    rig.step();
    rig.now += rig.config.maxRetryMs * 2;
  }
  TEST_ASSERT_EQUAL_UINT(1, rig.queue.count());
  TEST_ASSERT_EQUAL_UINT32(500, rig.uplink->stats().retries);
}

void test_server_errors_are_retried() {
  const int statuses[] = {429, 500, 502, 503, 504, 403, 404, 301};
  for (int status : statuses) {
    Rig rig;
    rig.queue.push(measurement(1));
    rig.transport.answers = {{status, "{\"error\":{\"code\":\"server_error\"}}"}};
    rig.step();
    TEST_ASSERT_EQUAL_UINT(1, rig.queue.count());
    TEST_ASSERT_EQUAL_UINT32(1, rig.uplink->stats().retries);
  }
}

void test_no_send_while_the_link_is_down_and_no_backoff_is_used_up() {
  Rig rig;
  rig.queue.push(measurement(1));
  rig.platform.link = false;
  TEST_ASSERT_EQUAL_UINT32(rig.config.linkPollMs, rig.step());
  TEST_ASSERT_EQUAL_UINT(0, rig.transport.bodies.size());
  TEST_ASSERT_EQUAL_UINT32(0, rig.uplink->stats().retries);
  rig.platform.link = true;
  rig.transport.answers = {ok(1)};
  rig.step();
  TEST_ASSERT_EQUAL_UINT(0, rig.queue.count());
}

// ---------- A 2xx that isn't from our server must not lose data ----------

void test_a_fake_200_is_not_an_ack() {
  const char* pages[] = {"<html>Sign in to Wi-Fi</html>", "", "{\"status\":\"ok\"}", "{\"status\":\"stored\"}"};
  for (const char* page : pages) {
    Rig rig;
    rig.queue.push(measurement(1));
    rig.transport.answers = {{200, page}};
    rig.step();
    TEST_ASSERT_EQUAL_UINT(1, rig.queue.count());
  }
}

void test_an_ack_for_another_record_is_not_an_ack() {
  Rig rig;
  rig.queue.push(measurement(1));
  rig.transport.answers = {ok(2)};
  rig.step();
  TEST_ASSERT_EQUAL_UINT(1, rig.queue.count());
  rig.now += 100000;
  rig.transport.answers = {ok(1, kTs + 1)};
  rig.step();
  TEST_ASSERT_EQUAL_UINT(1, rig.queue.count());
}

void test_status_and_word_must_agree() {
  Rig rig;
  rig.queue.push(measurement(1));
  rig.transport.answers = {ok(1, kTs, "stored", 200)};
  rig.step();
  TEST_ASSERT_EQUAL_UINT(1, rig.queue.count());
}

// ---------- Refusals ----------

void test_refused_records_are_removed_reported_and_the_queue_moves_on() {
  const struct {
    int status;
    const char* code;
  } cases[] = {{400, "invalid_json"},      {400, "invalid_body"},   {400, "timestamp_in_future"},
               {400, "timestamp_too_old"}, {413, "body_too_large"}, {422, "unknown_node"}};
  for (const auto& c : cases) {
    Rig rig;
    rig.queue.push(measurement(1));
    rig.queue.push(measurement(2));
    rig.transport.answers = {failure(c.status, c.code), ok(2)};
    rig.step();
    TEST_ASSERT_EQUAL_UINT(1, rig.queue.count());
    TEST_ASSERT_EQUAL_UINT32(1, rig.uplink->stats().rejected);
    TEST_ASSERT_EQUAL_STRING(c.code, rig.platform.rejectedReasons[0].c_str());
    rig.step();  // no backoff
    TEST_ASSERT_EQUAL_UINT(0, rig.queue.count());
  }
}

void test_a_proxys_400_or_401_page_is_only_retried() {
  const int statuses[] = {400, 401, 413, 422};
  for (int status : statuses) {
    Rig rig;
    rig.queue.push(measurement(1));
    rig.transport.answers = {{status, "<html>Bad Request</html>"}};
    rig.step();
    TEST_ASSERT_EQUAL_UINT(1, rig.queue.count());
    TEST_ASSERT_FALSE(rig.uplink->keyRefused());
    TEST_ASSERT_EQUAL_UINT32(1, rig.uplink->stats().retries);
  }
}

void test_a_cut_off_error_body_still_counts() {
  Rig rig;
  rig.queue.push(measurement(1));
  std::string details(5000, 'x');
  rig.transport.answers = {{400, "{\"error\":{\"code\":\"invalid_body\",\"message\":\"" + details + "\"}}"}};
  rig.step();
  TEST_ASSERT_EQUAL_UINT(0, rig.queue.count());
}

void test_refused_key_stops_sending_and_keeps_the_buffer() {
  Rig rig;
  rig.queue.push(measurement(1));
  rig.queue.push(measurement(2));
  rig.transport.answers = {failure(401, "unauthorized")};
  rig.step();
  TEST_ASSERT_TRUE(rig.uplink->keyRefused());
  TEST_ASSERT_EQUAL_UINT(2, rig.queue.count());
  rig.now += 100000000;
  for (int i = 0; i < 5; ++i) rig.step();
  TEST_ASSERT_EQUAL_UINT(1, rig.transport.bodies.size());
  TEST_ASSERT_TRUE(rig.platform.logged("API key refused"));
}

void test_a_bad_confidence_is_rejected_locally_and_never_sent() {
  const float values[] = {std::numeric_limits<float>::quiet_NaN(), std::numeric_limits<float>::infinity(), 1.01F, -0.01F};
  for (float value : values) {
    Rig rig;
    auto bad = measurement(1);
    bad.measurement.confidence = value;
    rig.queue.push(bad);
    rig.step();
    TEST_ASSERT_EQUAL_UINT(0, rig.transport.bodies.size());
    TEST_ASSERT_EQUAL_UINT(0, rig.queue.count());
    TEST_ASSERT_EQUAL_STRING("invalid_locally", rig.platform.rejectedReasons[0].c_str());
  }
}

void test_a_bad_model_version_is_rejected_locally() {
  const char* versions[] = {"", "has space", "quote\"", "back\\slash"};
  for (const char* version : versions) {
    Rig rig;
    auto bad = measurement(1);
    snprintf(bad.measurement.modelVersion, sizeof(bad.measurement.modelVersion), "%s", version);
    rig.queue.push(bad);
    rig.step();
    TEST_ASSERT_EQUAL_UINT(0, rig.transport.bodies.size());
    TEST_ASSERT_EQUAL_UINT(0, rig.queue.count());
  }
}

void test_a_model_version_with_no_terminator_is_refused() {
  static char body[kBodyBytes];
  Measurement m;
  memset(m.modelVersion, 'a', sizeof(m.modelVersion));
  TEST_ASSERT_EQUAL_size_t(0, buildMeasurement(m, body, sizeof(body)));
}

void test_the_edges_of_the_confidence_range_are_valid() {
  static char body[kBodyBytes];
  Measurement m;
  snprintf(m.modelVersion, sizeof(m.modelVersion), "node-1.0");
  m.confidence = 0.0F;
  TEST_ASSERT_GREATER_THAN_size_t(0, buildMeasurement(m, body, sizeof(body)));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"confidence\":0,"));
  m.confidence = 1.0F;
  TEST_ASSERT_GREATER_THAN_size_t(0, buildMeasurement(m, body, sizeof(body)));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"confidence\":1,"));
}

void test_the_body_holds_the_result_and_no_matrix() {
  static char body[kBodyBytes];
  Measurement m;
  m.nodeId = 7;
  m.timestampS = kTs;
  m.confidence = 0.85F;
  snprintf(m.modelVersion, sizeof(m.modelVersion), "node-1.0");
  TEST_ASSERT_GREATER_THAN_size_t(0, buildMeasurement(m, body, sizeof(body)));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"node_id\":7,"));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"confidence\":0.85,"));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"model_version\":\"node-1.0\""));
  TEST_ASSERT_NULL(strstr(body, "mfcc"));
}

// ---------- Cluster health ----------

void test_health_goes_out_on_schedule_and_counts_the_buffer() {
  Rig rig(1000);
  rig.queue.push(measurement(1));
  rig.now = 1000;
  rig.transport.answers = {{201, "{\"status\":\"stored\",\"timestamp\":\"" + iso(kTs) + "\"}"}};
  rig.step();
  TEST_ASSERT_EQUAL_STRING("/api/v1/ingest/cluster-health", rig.transport.paths[0].c_str());
  const std::string& body = rig.transport.bodies[0];
  TEST_ASSERT_TRUE(body.find("\"buffered_count\":1") != std::string::npos);
  TEST_ASSERT_TRUE(body.find("\"uplink_type\":\"wifi\"") != std::string::npos);
  TEST_ASSERT_TRUE(body.find("\"rssi_dbm\":-60") != std::string::npos);
  TEST_ASSERT_EQUAL_UINT32(2, rig.uplink->stats().healthSent);  // one more than the rig's setup
}

void test_failed_health_is_not_retransmitted_and_does_not_block_data() {
  Rig rig(1000);
  rig.queue.push(measurement(1));
  rig.now = 1000;
  rig.transport.answers = {{500, ""}, ok(1)};
  rig.step();
  TEST_ASSERT_EQUAL_UINT32(1, rig.uplink->stats().healthFailed);
  rig.step();
  TEST_ASSERT_EQUAL_UINT(0, rig.queue.count());
}

void test_health_still_goes_out_during_a_retry_wait() {
  Rig rig(1000);
  rig.queue.push(measurement(1));
  rig.step();  // the measurement fails, and backs off for 5 s
  rig.now = 1000;
  rig.transport.answers = {{201, "{\"status\":\"stored\",\"timestamp\":\"" + iso(kTs) + "\"}"}};
  TEST_ASSERT_EQUAL_UINT32(0, rig.step());
  TEST_ASSERT_EQUAL_STRING("/api/v1/ingest/cluster-health", rig.transport.paths.back().c_str());
}

void test_health_refused_key_stops_everything() {
  Rig rig(1000);
  rig.now = 1000;
  rig.transport.answers = {failure(401, "unauthorized")};
  rig.step();
  TEST_ASSERT_TRUE(rig.uplink->keyRefused());
}

// ---------- Clock ----------

void test_clock_drift_is_logged() {
  Rig rig;
  rig.queue.push(measurement(1));
  rig.platform.now = kTs + 3600;
  rig.transport.answers = {ok(1)};
  rig.step();
  TEST_ASSERT_TRUE(rig.platform.logged("3600 s off"));
}

void test_small_drift_is_not_logged() {
  Rig rig;
  rig.queue.push(measurement(1));
  rig.platform.now = kTs + 30;
  rig.transport.answers = {ok(1)};
  rig.step();
  TEST_ASSERT_FALSE(rig.platform.logged("off server time"));
}

// ---------- Payloads ----------

void test_iso_format_and_parse() {
  char out[kIsoBytes];
  formatIso8601(0, out);
  TEST_ASSERT_EQUAL_STRING("1970-01-01T00:00:00Z", out);
  formatIso8601(1709210096, out);  // leap day
  TEST_ASSERT_EQUAL_STRING("2024-02-29T12:34:56Z", out);
  int64_t parsed = 0;
  TEST_ASSERT_TRUE(parseIso8601Utc("2024-02-29T12:34:56.789Z", parsed));
  TEST_ASSERT_EQUAL_INT64(1709210096, parsed);
  TEST_ASSERT_TRUE(parseIso8601Utc("1970-01-01T00:00:00Z", parsed));
  TEST_ASSERT_EQUAL_INT64(0, parsed);
  TEST_ASSERT_FALSE(parseIso8601Utc("2024-02-29", parsed));
  TEST_ASSERT_FALSE(parseIso8601Utc("2024-02-29T12:34:56+04:00", parsed));
}

void test_worst_case_measurement_fits_the_body_buffer() {
  Measurement m;
  m.nodeId = 255;
  m.timestampS = kTs;
  m.receivedAtS = kTs;
  m.hasSnr = true;
  m.snrDb = -3.3333333e38F;
  m.hasRssi = true;
  m.rssiDbm = -200;
  m.confidence = 0.33333334F;
  memset(m.modelVersion, 'a', sizeof(m.modelVersion) - 1);
  static char body[kBodyBytes];
  const size_t length = buildMeasurement(m, body, sizeof(body));
  TEST_ASSERT_GREATER_THAN_size_t(0, length);
  TEST_ASSERT_LESS_THAN_size_t(sizeof(body), length);
}

void test_too_small_a_buffer_fails_cleanly() {
  Measurement m;
  snprintf(m.modelVersion, sizeof(m.modelVersion), "node-1.0");
  char body[20];
  TEST_ASSERT_EQUAL_size_t(0, buildMeasurement(m, body, sizeof(body)));
}

void test_a_bad_optional_value_is_dropped() {
  static char body[kBodyBytes];
  Measurement m;
  snprintf(m.modelVersion, sizeof(m.modelVersion), "node-1.0");
  m.hasRssi = true;
  m.rssiDbm = 21;
  m.hasSnr = true;
  m.snrDb = std::numeric_limits<float>::infinity();
  TEST_ASSERT_GREATER_THAN_size_t(0, buildMeasurement(m, body, sizeof(body)));
  TEST_ASSERT_NULL(strstr(body, "rssi_dbm"));
  TEST_ASSERT_NULL(strstr(body, "snr_db"));
}

void test_node_health_uses_its_own_path() {
  Rig rig;
  UplinkRecord record;
  record.kind = UplinkRecord::Kind::NodeHealth;
  record.nodeHealth.nodeId = 4;
  record.nodeHealth.timestampS = kTs;
  record.nodeHealth.hasBattery = true;
  record.nodeHealth.batteryMv = 3900;
  rig.queue.push(record);
  rig.transport.answers = {ok(4)};
  rig.step();
  TEST_ASSERT_EQUAL_STRING("/api/v1/ingest/node-health", rig.transport.paths[0].c_str());
  TEST_ASSERT_TRUE(rig.transport.bodies[0].find("\"battery_mv\":3900") != std::string::npos);
  TEST_ASSERT_EQUAL_UINT(0, rig.queue.count());
}

// ---------- Queue ----------

void test_full_queue_refuses_the_new_record_and_keeps_the_old() {
  static RamQueue<2> queue;
  TEST_ASSERT_TRUE(queue.push(measurement(1)));
  TEST_ASSERT_TRUE(queue.push(measurement(2)));
  TEST_ASSERT_FALSE(queue.push(measurement(3)));
  TEST_ASSERT_EQUAL_UINT(1, queue.dropped());
  static UplinkRecord out;
  TEST_ASSERT_TRUE(queue.peek(out));
  TEST_ASSERT_EQUAL_UINT8(1, out.measurement.nodeId);
  TEST_ASSERT_TRUE(queue.peek(out));
  TEST_ASSERT_EQUAL_UINT8(1, out.measurement.nodeId);
  queue.remove();
  TEST_ASSERT_TRUE(queue.push(measurement(3)));  // wraps around
  queue.remove();
  TEST_ASSERT_TRUE(queue.peek(out));
  TEST_ASSERT_EQUAL_UINT8(3, out.measurement.nodeId);
  queue.remove();
  queue.remove();  // harmless when empty
  TEST_ASSERT_FALSE(queue.peek(out));
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_ack_removes_the_record_and_keeps_order);
  RUN_TEST(test_no_answer_keeps_the_record_and_blocks_the_next_one);
  RUN_TEST(test_retransmission_is_byte_identical);
  RUN_TEST(test_lost_ack_ends_with_a_duplicate_answer_and_removal);
  RUN_TEST(test_nothing_is_sent_before_the_backoff_ends);
  RUN_TEST(test_backoff_doubles_to_the_cap_and_resets_after_an_ack);
  RUN_TEST(test_jitter_adds_at_most_twenty_percent);
  RUN_TEST(test_retries_never_give_up);
  RUN_TEST(test_server_errors_are_retried);
  RUN_TEST(test_no_send_while_the_link_is_down_and_no_backoff_is_used_up);
  RUN_TEST(test_a_fake_200_is_not_an_ack);
  RUN_TEST(test_an_ack_for_another_record_is_not_an_ack);
  RUN_TEST(test_status_and_word_must_agree);
  RUN_TEST(test_refused_records_are_removed_reported_and_the_queue_moves_on);
  RUN_TEST(test_a_proxys_400_or_401_page_is_only_retried);
  RUN_TEST(test_a_cut_off_error_body_still_counts);
  RUN_TEST(test_refused_key_stops_sending_and_keeps_the_buffer);
  RUN_TEST(test_a_bad_confidence_is_rejected_locally_and_never_sent);
  RUN_TEST(test_a_bad_model_version_is_rejected_locally);
  RUN_TEST(test_a_model_version_with_no_terminator_is_refused);
  RUN_TEST(test_the_edges_of_the_confidence_range_are_valid);
  RUN_TEST(test_the_body_holds_the_result_and_no_matrix);
  RUN_TEST(test_health_goes_out_on_schedule_and_counts_the_buffer);
  RUN_TEST(test_failed_health_is_not_retransmitted_and_does_not_block_data);
  RUN_TEST(test_health_still_goes_out_during_a_retry_wait);
  RUN_TEST(test_health_refused_key_stops_everything);
  RUN_TEST(test_clock_drift_is_logged);
  RUN_TEST(test_small_drift_is_not_logged);
  RUN_TEST(test_iso_format_and_parse);
  RUN_TEST(test_worst_case_measurement_fits_the_body_buffer);
  RUN_TEST(test_too_small_a_buffer_fails_cleanly);
  RUN_TEST(test_a_bad_optional_value_is_dropped);
  RUN_TEST(test_node_health_uses_its_own_path);
  RUN_TEST(test_full_queue_refuses_the_new_record_and_keeps_the_old);
  return UNITY_END();
}
