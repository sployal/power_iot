/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ESP32 LIGHT CONTROL — WiFi + Firebase Firestore Edition
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *  Migrated FROM: Supabase REST API
 *  Migrated TO:   Firebase Firestore REST API
 *
 *  Firestore collections expected (matches your Next.js dashboard):
 *    • sensor_readings  — documents inserted each upload interval
 *    • device_controls  — single document with id "1"
 *    • power_settings   — single document with id "1" (read-only from ESP32)
 *
 *  ── Required libraries (install via Arduino Library Manager) ────────────────
 *    • LiquidCrystal I2C       (Frank de Brabander)
 *    • Rtc by Makuna            (Michael C. Miller)  — ThreeWire + RtcDS1302
 *    • Keypad                   (Mark Stanley / Alexander Brevig)
 *    • ArduinoJson              (Benoît Blanchon)  >= v7
 *    • HTTPClient               (built-in ESP32 core)
 *    • WiFi                     (built-in ESP32 core)
 *
 *  ── Config — fill in the defines below ─────────────────────────────────────
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ╔══════════════════════════════════════════════════════╗
// ║               USER CONFIGURATION                    ║
// ╚══════════════════════════════════════════════════════╝

#define WIFI_SSID        "Samsung"
#define WIFI_PASSWORD    "Muren2569105gtk"

// From your Firebase console → Project Settings → General → Web App config
#define FIREBASE_PROJECT_ID  "signup-login-realtime-1fad6"
#define FIREBASE_API_KEY     "AIzaSyCMQlqLdLUknPcyYUKdGUhbeZraXc103CQ"

// How often to upload a reading (milliseconds)
#define UPLOAD_INTERVAL_MS   5000UL

// How often to poll device_controls from Firestore (milliseconds)
#define POLL_INTERVAL_MS     3000UL

// ══════════════════════════════════════════════════════════════════════════════

#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <ThreeWire.h>
#include <RtcDS1302.h>
#include <Keypad.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// ── Firestore base URL ────────────────────────────────────────────────────────
// Pattern: https://firestore.googleapis.com/v1/projects/{projectId}/databases/(default)/documents
#define FS_BASE  "https://firestore.googleapis.com/v1/projects/" FIREBASE_PROJECT_ID "/databases/(default)/documents"

// ── I2C (ESP32 default: SDA=21, SCL=22) ──────────────────────────────────────
#define I2C_SDA 21
#define I2C_SCL 22

LiquidCrystal_I2C lcd(0x27, 16, 2);

// ── DS1302 RTC ────────────────────────────────────────────────────────────────
ThreeWire myWire(17, 16, 5);   // DAT=17, CLK=16, RST=5
RtcDS1302<ThreeWire> Rtc(myWire);

// ── Relay & LDR ───────────────────────────────────────────────────────────────
const int RELAY1_PIN = 26;
const int RELAY2_PIN = 27;
const int LDR_PIN    = 34;

// ── Keypad (4×4) ──────────────────────────────────────────────────────────────
const byte ROWS = 4, COLS = 4;
char keys[ROWS][COLS] = {
  {'1','2','3','A'},
  {'4','5','6','B'},
  {'7','8','9','C'},
  {'*','0','#','D'}
};
byte rowPins[ROWS] = {32, 33, 25, 13};
byte colPins[COLS] = {14, 12, 19, 18};
Keypad keypad = Keypad(makeKeymap(keys), rowPins, colPins, ROWS, COLS);

// ── Relay 1 (schedule) ────────────────────────────────────────────────────────
int  onHour = -1, onMin = -1;
int  offHour = -1, offMin = -1;
bool scheduleSet = false;
bool relay1State = false;

// ── Relay 2 (LDR) ─────────────────────────────────────────────────────────────
const int HYST_BAND    = 80;
int       ldrThreshold = 1600;
bool      relay2State  = false;
bool      ldrManual    = false;

// ── LDR smoothing ─────────────────────────────────────────────────────────────
const int LDR_SAMPLES = 5;
int ldrBuffer[LDR_SAMPLES];
int ldrIndex  = 0;
bool ldrReady = false;

// ── Menu state machine ────────────────────────────────────────────────────────
enum State {
  NORMAL,
  SET_ON_HOUR, SET_ON_MIN, SET_OFF_HOUR, SET_OFF_MIN,
  CONFIRM,
  SET_THRESHOLD
};
State  menuState   = NORMAL;
String inputBuffer = "";

// ── Timers ────────────────────────────────────────────────────────────────────
unsigned long lastUpload = 0;
unsigned long lastPoll   = 0;

// ── WiFi helpers ──────────────────────────────────────────────────────────────
bool wifiConnected = false;

void connectWiFi() {
  lcd.clear();
  lcd.setCursor(0, 0); lcd.print("Connecting WiFi ");
  lcd.setCursor(0, 1); lcd.print(WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500);
    lcd.setCursor(15, 0);
    lcd.print(attempts % 2 == 0 ? "." : " ");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    wifiConnected = true;
    lcd.clear();
    lcd.setCursor(0, 0); lcd.print("WiFi Connected! ");
    lcd.setCursor(0, 1);
    String ip = WiFi.localIP().toString();
    lcd.print(ip.substring(0, 16));
    Serial.print("[WiFi] IP: "); Serial.println(WiFi.localIP());
    delay(1500);
  } else {
    wifiConnected = false;
    lcd.clear();
    lcd.setCursor(0, 0); lcd.print("WiFi FAILED!    ");
    lcd.setCursor(0, 1); lcd.print("Offline mode... ");
    Serial.println("[WiFi] Connection failed — running offline");
    delay(1500);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  FIRESTORE REST HELPERS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Build a Firestore "Value" object for a boolean field.
 * Firestore REST uses typed value wrappers: { "booleanValue": true }
 */
void addBool(JsonObject& fields, const char* key, bool val) {
  JsonObject field = fields[key].to<JsonObject>();
  field["booleanValue"] = val;
}

void addInt(JsonObject& fields, const char* key, int val) {
  JsonObject field = fields[key].to<JsonObject>();
  field["integerValue"] = String(val);   // Firestore expects integer as string
}

void addString(JsonObject& fields, const char* key, const char* val) {
  JsonObject field = fields[key].to<JsonObject>();
  field["stringValue"] = val;
}

/**
 * Extract a boolean from a Firestore field value object.
 * Returns defaultVal if field doesn't exist.
 */
bool fsGetBool(JsonObject& fields, const char* key, bool defaultVal = false) {
  if (!fields[key].is<JsonObject>()) return defaultVal;
  JsonObject f = fields[key].as<JsonObject>();
  if (f["booleanValue"].is<bool>()) return f["booleanValue"].as<bool>();
  return defaultVal;
}

int fsGetInt(JsonObject& fields, const char* key, int defaultVal = 0) {
  if (!fields[key].is<JsonObject>()) return defaultVal;
  JsonObject f = fields[key].as<JsonObject>();
  // Firestore returns integers as strings
  if (f["integerValue"].is<const char*>()) return String(f["integerValue"].as<const char*>()).toInt();
  if (f["integerValue"].is<int>())         return f["integerValue"].as<int>();
  return defaultVal;
}

/**
 * POST a new document to a Firestore collection (auto-generated document ID).
 * Returns true on HTTP 200/200.
 */
bool firestoreInsert(const char* collection, JsonDocument& doc) {
  if (WiFi.status() != WL_CONNECTED) return false;

  String url = String(FS_BASE) + "/" + collection + "?key=" + FIREBASE_API_KEY;

  String body;
  serializeJson(doc, body);

  HTTPClient http;
  http.begin(url);
  http.addHeader("Content-Type", "application/json");

  int code = http.POST(body);
  bool ok  = (code >= 200 && code < 300);
  if (!ok) {
    Serial.printf("[Firestore INSERT %s] HTTP %d\n", collection, code);
    Serial.println(http.getString());
  }
  http.end();
  return ok;
}

/**
 * PATCH (merge-update) a specific Firestore document.
 * Uses ?updateMask.fieldPaths= to only overwrite supplied fields.
 * fieldNames: comma-separated list of top-level field names being updated.
 */
bool firestorePatch(const char* collection, const char* docId,
                    JsonDocument& doc, const String& fieldNames) {
  if (WiFi.status() != WL_CONNECTED) return false;

  // Build updateMask query string
  // e.g. "relay1_state,relay2_state" → "&updateMask.fieldPaths=relay1_state&updateMask.fieldPaths=relay2_state"
  String mask = "";
  String remaining = fieldNames;
  while (remaining.length() > 0) {
    int comma = remaining.indexOf(',');
    String field;
    if (comma == -1) {
      field     = remaining;
      remaining = "";
    } else {
      field     = remaining.substring(0, comma);
      remaining = remaining.substring(comma + 1);
    }
    field.trim();
    if (field.length()) mask += "&updateMask.fieldPaths=" + field;
  }

  String url = String(FS_BASE) + "/" + collection + "/" + docId
             + "?key=" + FIREBASE_API_KEY + mask;

  String body;
  serializeJson(doc, body);

  HTTPClient http;
  http.begin(url);
  http.addHeader("Content-Type", "application/json");

  int code = http.PATCH(body);
  bool ok  = (code >= 200 && code < 300);
  if (!ok) {
    Serial.printf("[Firestore PATCH %s/%s] HTTP %d\n", collection, docId, code);
    Serial.println(http.getString());
  }
  http.end();
  return ok;
}

/**
 * GET a specific Firestore document.
 * Parses the response and populates `out` with the document's fields object.
 * Returns true on success.
 */
bool firestoreGet(const char* collection, const char* docId, JsonDocument& out) {
  if (WiFi.status() != WL_CONNECTED) return false;

  String url = String(FS_BASE) + "/" + collection + "/" + docId
             + "?key=" + FIREBASE_API_KEY;

  HTTPClient http;
  http.begin(url);
  http.addHeader("Accept", "application/json");

  int code = http.GET();
  if (code != 200) {
    Serial.printf("[Firestore GET %s/%s] HTTP %d\n", collection, docId, code);
    http.end();
    return false;
  }

  String payload = http.getString();
  http.end();

  DeserializationError err = deserializeJson(out, payload);
  if (err) {
    Serial.print("[Firestore] JSON parse error: ");
    Serial.println(err.c_str());
    return false;
  }
  return true;
}

// ══════════════════════════════════════════════════════════════════════════════
//  UPLOAD / POLL LOGIC
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Build a Firestore ISO-8601 timestamp string from the RTC.
 */
void buildTimestamp(char* buf, size_t len) {
  RtcDateTime now = Rtc.GetDateTime();
  // Note: RTC has no timezone info — stored as "local time Z" label.
  snprintf(buf, len, "2024-%02d-%02dT%02d:%02d:%02dZ",
           now.Month(), now.Day(), now.Hour(), now.Minute(), now.Second());
}

/**
 * Upload one sensor reading to the `sensor_readings` Firestore collection.
 * Matches the shape the dashboard expects:
 *   { created_at, ldr_value, relay1_state, relay2_state }
 */
void uploadReading(int ldrValue) {
  JsonDocument doc;
  JsonObject fields = doc["fields"].to<JsonObject>();

  // created_at — stored as a Firestore timestampValue
  char ts[25];
  buildTimestamp(ts, sizeof(ts));
  JsonObject tsField = fields["created_at"].to<JsonObject>();
  tsField["timestampValue"] = ts;

  addInt(fields,  "ldr_value",    ldrValue);
  addBool(fields, "relay1_state", relay1State);
  addBool(fields, "relay2_state", relay2State);

  if (firestoreInsert("sensor_readings", doc)) {
    Serial.println("[Upload] Reading sent to Firestore");
  }
}

/**
 * Patch the `device_controls/1` document with current relay states.
 * Called after applying remote commands so the dashboard stays in sync.
 */
void ackControls() {
  JsonDocument doc;
  JsonObject fields = doc["fields"].to<JsonObject>();

  char ts[25];
  buildTimestamp(ts, sizeof(ts));
  addString(fields, "updated_at",    ts);
  addBool(fields,   "relay1_state",  relay1State);
  addBool(fields,   "relay2_state",  relay2State);
  addBool(fields,   "relay1_manual", ldrManual ? false : true);
  addBool(fields,   "relay2_manual", ldrManual);

  firestorePatch("device_controls", "1", doc,
    "updated_at,relay1_state,relay2_state,relay1_manual,relay2_manual");
}

/**
 * Fetch `device_controls/1` from Firestore and apply any remote changes.
 */
void pollAndApply() {
  JsonDocument raw;
  if (!firestoreGet("device_controls", "1", raw)) return;

  // All fields are nested under raw["fields"]
  if (!raw["fields"].is<JsonObject>()) {
    Serial.println("[Poll] No fields in device_controls/1");
    return;
  }
  JsonObject fields = raw["fields"].as<JsonObject>();

  // ── Relay 1 ──────────────────────────────────────────────────────────────
  bool r1Manual = fsGetBool(fields, "relay1_manual", false);
  bool r1State  = fsGetBool(fields, "relay1_state",  false);

  if (r1Manual) {
    scheduleSet = false;
    if (r1State != relay1State) {
      relay1State = r1State;
      applyRelay1();
      Serial.print("[Remote] R1 → "); Serial.println(relay1State ? "ON" : "OFF");
    }
  }

  // ── Schedule ──────────────────────────────────────────────────────────────
  bool schedSet = fsGetBool(fields, "schedule_set", false);
  if (schedSet) {
    int oh = fsGetInt(fields, "on_hour",  -1);
    int om = fsGetInt(fields, "on_min",   -1);
    int fh = fsGetInt(fields, "off_hour", -1);
    int fm = fsGetInt(fields, "off_min",  -1);
    if (oh >= 0 && om >= 0 && fh >= 0 && fm >= 0) {
      onHour = oh; onMin = om;
      offHour = fh; offMin = fm;
      scheduleSet = true;
    }
  } else {
    if (!r1Manual) scheduleSet = false;
  }

  // ── Relay 2 ──────────────────────────────────────────────────────────────
  bool r2Manual = fsGetBool(fields, "relay2_manual", false);
  bool r2State  = fsGetBool(fields, "relay2_state",  false);

  if (r2Manual) {
    ldrManual = true;
    if (r2State != relay2State) {
      relay2State = r2State;
      applyRelay2();
      Serial.print("[Remote] R2 → "); Serial.println(relay2State ? "ON" : "OFF");
    }
  } else {
    ldrManual = false;
  }

  // ── LDR threshold ─────────────────────────────────────────────────────────
  int remoteThr = fsGetInt(fields, "ldr_threshold", 1600);
  if (remoteThr != ldrThreshold) {
    ldrThreshold = remoteThr;
    Serial.print("[Remote] LDR threshold → "); Serial.println(ldrThreshold);
  }

  Serial.println("[Poll] Controls applied from Firestore");
}

// ══════════════════════════════════════════════════════════════════════════════
//  HARDWARE HELPERS  (unchanged from original)
// ══════════════════════════════════════════════════════════════════════════════

int readSmoothedLDR() {
  ldrBuffer[ldrIndex] = analogRead(LDR_PIN);
  ldrIndex = (ldrIndex + 1) % LDR_SAMPLES;
  if (ldrIndex == 0) ldrReady = true;
  int count = ldrReady ? LDR_SAMPLES : ldrIndex;
  long sum  = 0;
  for (int i = 0; i < count; i++) sum += ldrBuffer[i];
  return (int)(sum / count);
}

void applyRelay1() { digitalWrite(RELAY1_PIN, relay1State ? HIGH : LOW); }
void applyRelay2() { digitalWrite(RELAY2_PIN, relay2State ? LOW  : HIGH); }  // active-LOW module

void printPrompt(const char* line0, const char* line1 = "") {
  lcd.clear();
  lcd.setCursor(0, 0); lcd.print(line0);
  lcd.setCursor(0, 1); lcd.print(line1);
}

void handleBackspace(const char* promptLine1, const char* labelPrefix) {
  if (inputBuffer.length() > 0)
    inputBuffer.remove(inputBuffer.length() - 1);
  lcd.setCursor(0, 1);
  char buf[17];
  if (inputBuffer.length() > 0)
    snprintf(buf, sizeof(buf), "%s=%s             ", labelPrefix, inputBuffer.c_str());
  else
    snprintf(buf, sizeof(buf), "%-16s", promptLine1);
  lcd.print(buf);
}

// ── Relay 1 scheduler ─────────────────────────────────────────────────────────
void updateRelay1(int h, int m) {
  if (!scheduleSet) return;
  int nowMins = h * 60 + m;
  int onMins  = onHour  * 60 + onMin;
  int offMins = offHour * 60 + offMin;
  bool shouldBeOn;
  if (onMins < offMins) {
    shouldBeOn = (nowMins >= onMins && nowMins < offMins);
  } else {
    shouldBeOn = (nowMins >= onMins || nowMins < offMins);
  }
  if (shouldBeOn != relay1State) {
    relay1State = shouldBeOn;
    applyRelay1();
    Serial.println(relay1State ? "RELAY1 ON" : "RELAY1 OFF");
  }
}

// ── Relay 2 LDR hysteresis ────────────────────────────────────────────────────
void updateRelay2() {
  if (ldrManual) return;
  int raw = readSmoothedLDR();
  bool shouldBeOn = relay2State;
  if      (raw < ldrThreshold - HYST_BAND) shouldBeOn = true;
  else if (raw > ldrThreshold + HYST_BAND) shouldBeOn = false;
  if (shouldBeOn != relay2State) {
    relay2State = shouldBeOn;
    applyRelay2();
    Serial.print("RELAY2 "); Serial.println(relay2State ? "ON" : "OFF");
  }
}

// ── Normal LCD screen ─────────────────────────────────────────────────────────
void showNormalScreen(RtcDateTime& now) {
  char row0[17], row1[17];
  snprintf(row0, sizeof(row0), "%02d:%02d:%02d R1:%s",
           now.Hour(), now.Minute(), now.Second(),
           relay1State ? "ON " : "OFF");
  snprintf(row1, sizeof(row1), "D:%02d/%02d/%02d R2:%s",
           now.Day(), now.Month(), now.Year() % 100,
           relay2State ? "ON " : "OFF");
  lcd.setCursor(0, 0); lcd.print(row0);
  lcd.setCursor(0, 1); lcd.print(row1);
}

// ── Keypad handler ────────────────────────────────────────────────────────────
void handleKey(char key) {
  switch (menuState) {

    case NORMAL:
      if (key == 'A') {
        menuState = SET_ON_HOUR; inputBuffer = "";
        printPrompt("Set ON Hour     ", "Enter HH then #:");
      } else if (key == 'B') {
        menuState = SET_THRESHOLD; inputBuffer = "";
        char buf[17];
        snprintf(buf, sizeof(buf), "Cur:%4d(0-4095)", ldrThreshold);
        printPrompt("Set LDR Thresh  ", buf);
      } else if (key == 'C') {
        ldrManual   = false;
        relay2State = !relay2State;
        applyRelay2();
        ldrManual = true;
        printPrompt(relay2State ? "R2 ON (manual)  " : "R2 OFF (manual) ", "");
        delay(1000);
      } else if (key == 'D') {
        scheduleSet = false;
        relay1State = !relay1State;
        applyRelay1();
        printPrompt(relay1State ? "R1 ON (manual)  " : "R1 OFF (manual) ", "");
        delay(1000);
      }
      break;

    case SET_THRESHOLD:
      if (key >= '0' && key <= '9') {
        if (inputBuffer.length() < 4) {
          inputBuffer += key;
          lcd.setCursor(0, 1);
          char buf[17];
          snprintf(buf, sizeof(buf), "Val=%s             ", inputBuffer.c_str());
          lcd.print(buf);
        }
      } else if (key == 'C') {
        handleBackspace("Enter 0-4095    ", "Val");
      } else if (key == '#') {
        if (inputBuffer.length() == 0) break;
        int val = inputBuffer.toInt();
        if (val < 0 || val > 4095) {
          printPrompt("Invalid!(0-4095)", "Try again:      "); inputBuffer = ""; break;
        }
        ldrThreshold = val; inputBuffer = ""; menuState = NORMAL;
        char buf[17];
        snprintf(buf, sizeof(buf), "Threshold=%4d  ", ldrThreshold);
        printPrompt("LDR Thresh Saved", buf);
        // Push new threshold to Firestore
        {
          JsonDocument d;
          JsonObject f = d["fields"].to<JsonObject>();
          addInt(f, "ldr_threshold", ldrThreshold);
          firestorePatch("device_controls", "1", d, "ldr_threshold");
        }
        delay(1500);
      } else if (key == '*') {
        menuState = NORMAL; inputBuffer = "";
        printPrompt("Cancelled.      ", ""); delay(800);
      }
      break;

    case SET_ON_HOUR:
      if (key >= '0' && key <= '9') {
        if (inputBuffer.length() < 2) {
          inputBuffer += key; lcd.setCursor(0, 1);
          char buf[17];
          snprintf(buf, sizeof(buf), "HH=%s             ", inputBuffer.c_str());
          lcd.print(buf);
        }
      } else if (key == 'C') { handleBackspace("Enter HH then #:", "HH");
      } else if (key == '#') {
        if (inputBuffer.length() == 0) break;
        onHour = inputBuffer.toInt();
        if (onHour < 0 || onHour > 23) {
          printPrompt("Invalid! (0-23) ", "Try again:      "); inputBuffer = ""; break;
        }
        inputBuffer = ""; menuState = SET_ON_MIN;
        printPrompt("Set ON Minute   ", "Enter MM then #:");
      } else if (key == '*') {
        menuState = NORMAL; inputBuffer = "";
        printPrompt("Cancelled.      ", ""); delay(800);
      }
      break;

    case SET_ON_MIN:
      if (key >= '0' && key <= '9') {
        if (inputBuffer.length() < 2) {
          inputBuffer += key; lcd.setCursor(0, 1);
          char buf[17];
          snprintf(buf, sizeof(buf), "MM=%s             ", inputBuffer.c_str());
          lcd.print(buf);
        }
      } else if (key == 'C') { handleBackspace("Enter MM then #:", "MM");
      } else if (key == '#') {
        if (inputBuffer.length() == 0) break;
        onMin = inputBuffer.toInt();
        if (onMin < 0 || onMin > 59) {
          printPrompt("Invalid! (0-59) ", "Try again:      "); inputBuffer = ""; break;
        }
        inputBuffer = ""; menuState = SET_OFF_HOUR;
        printPrompt("Set OFF Hour    ", "Enter HH then #:");
      } else if (key == '*') {
        menuState = NORMAL; inputBuffer = "";
        printPrompt("Cancelled.      ", ""); delay(800);
      }
      break;

    case SET_OFF_HOUR:
      if (key >= '0' && key <= '9') {
        if (inputBuffer.length() < 2) {
          inputBuffer += key; lcd.setCursor(0, 1);
          char buf[17];
          snprintf(buf, sizeof(buf), "HH=%s             ", inputBuffer.c_str());
          lcd.print(buf);
        }
      } else if (key == 'C') { handleBackspace("Enter HH then #:", "HH");
      } else if (key == '#') {
        if (inputBuffer.length() == 0) break;
        offHour = inputBuffer.toInt();
        if (offHour < 0 || offHour > 23) {
          printPrompt("Invalid! (0-23) ", "Try again:      "); inputBuffer = ""; break;
        }
        inputBuffer = ""; menuState = SET_OFF_MIN;
        printPrompt("Set OFF Minute  ", "Enter MM then #:");
      } else if (key == '*') {
        menuState = NORMAL; inputBuffer = "";
        printPrompt("Cancelled.      ", ""); delay(800);
      }
      break;

    case SET_OFF_MIN:
      if (key >= '0' && key <= '9') {
        if (inputBuffer.length() < 2) {
          inputBuffer += key; lcd.setCursor(0, 1);
          char buf[17];
          snprintf(buf, sizeof(buf), "MM=%s             ", inputBuffer.c_str());
          lcd.print(buf);
        }
      } else if (key == 'C') { handleBackspace("Enter MM then #:", "MM");
      } else if (key == '#') {
        if (inputBuffer.length() == 0) break;
        offMin = inputBuffer.toInt();
        if (offMin < 0 || offMin > 59) {
          printPrompt("Invalid! (0-59) ", "Try again:      "); inputBuffer = ""; break;
        }
        char buf0[17], buf1[17];
        snprintf(buf0, sizeof(buf0), "ON%02d:%02d OFF%02d:%02d", onHour, onMin, offHour, offMin);
        snprintf(buf1, sizeof(buf1), "#=Save  *=Cancel");
        printPrompt(buf0, buf1);
        menuState = CONFIRM; inputBuffer = "";
      } else if (key == '*') {
        menuState = NORMAL; inputBuffer = "";
        printPrompt("Cancelled.      ", ""); delay(800);
      }
      break;

    case CONFIRM:
      if (key == '#') {
        scheduleSet = true; menuState = NORMAL;
        printPrompt("Schedule Saved! ", "");
        Serial.printf("ON=%d:%d  OFF=%d:%d\n", onHour, onMin, offHour, offMin);
        // Push schedule to Firestore so dashboard reflects it
        {
          JsonDocument d;
          JsonObject f = d["fields"].to<JsonObject>();
          addInt(f,  "on_hour",       onHour);
          addInt(f,  "on_min",        onMin);
          addInt(f,  "off_hour",      offHour);
          addInt(f,  "off_min",       offMin);
          addBool(f, "schedule_set",  true);
          addBool(f, "relay1_manual", false);
          firestorePatch("device_controls", "1", d,
            "on_hour,on_min,off_hour,off_min,schedule_set,relay1_manual");
        }
        delay(1500);
      } else if (key == '*') {
        menuState = NORMAL;
        printPrompt("Cancelled.      ", ""); delay(800);
      }
      break;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  SETUP
// ══════════════════════════════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);

  Wire.begin(I2C_SDA, I2C_SCL);

  pinMode(RELAY1_PIN, OUTPUT);
  pinMode(RELAY2_PIN, OUTPUT);
  relay1State = false; relay2State = false;
  applyRelay1(); applyRelay2();

  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);

  int firstRead = analogRead(LDR_PIN);
  for (int i = 0; i < LDR_SAMPLES; i++) ldrBuffer[i] = firstRead;
  ldrReady = true;

  lcd.init();
  lcd.backlight();
  printPrompt("  Light Monitor ", "  Please Wait.. ");
  delay(1000);

  // ── WiFi ──────────────────────────────────────────────────────────────────
  connectWiFi();

  // ── RTC ───────────────────────────────────────────────────────────────────
  Rtc.Begin();
  if (Rtc.GetIsWriteProtected()) Rtc.SetIsWriteProtected(false);
  if (!Rtc.GetIsRunning())       Rtc.SetIsRunning(true);
  if (!Rtc.IsDateTimeValid()) {
    printPrompt("  RTC ERROR!!   ", " Upload Code 1! ");
    while (true) delay(1000);
  }

  // ── Fetch initial controls from Firestore ─────────────────────────────────
  if (wifiConnected) {
    printPrompt("Fetching ctrl...", "");
    pollAndApply();
  }

  printPrompt("A=Sched B=LDR   ", "C=TglR2 D=TglR1 ");
  delay(1500);
}

// ══════════════════════════════════════════════════════════════════════════════
//  LOOP
// ══════════════════════════════════════════════════════════════════════════════
void loop() {
  unsigned long now_ms = millis();

  // ── WiFi watchdog / auto-reconnect ────────────────────────────────────────
  if (WiFi.status() != WL_CONNECTED) {
    if (wifiConnected) {
      wifiConnected = false;
      Serial.println("[WiFi] Disconnected — will retry");
    }
    static unsigned long lastReconnect = 0;
    if (now_ms - lastReconnect > 30000UL) {
      lastReconnect = now_ms;
      WiFi.reconnect();
    }
  } else {
    wifiConnected = true;
  }

  // ── Keypad ────────────────────────────────────────────────────────────────
  char key = keypad.getKey();
  if (key) handleKey(key);

  // ── Normal operation ──────────────────────────────────────────────────────
  if (menuState == NORMAL) {
    RtcDateTime rtcNow = Rtc.GetDateTime();
    if (!Rtc.IsDateTimeValid()) {
      printPrompt("  RTC ERROR!!   ", "  Check Module  ");
      delay(1000); return;
    }

    updateRelay1(rtcNow.Hour(), rtcNow.Minute());
    updateRelay2();
    showNormalScreen(rtcNow);

    int raw = readSmoothedLDR();
    Serial.printf("Time=%02d:%02d:%02d  Light=%d  Thresh=%d  R1=%s  R2=%s\n",
                  rtcNow.Hour(), rtcNow.Minute(), rtcNow.Second(),
                  raw, ldrThreshold,
                  relay1State ? "ON" : "OFF",
                  relay2State ? "ON" : "OFF");

    // ── Firestore upload ─────────────────────────────────────────────────────
    if (wifiConnected && now_ms - lastUpload >= UPLOAD_INTERVAL_MS) {
      lastUpload = now_ms;
      uploadReading(raw);
    }

    // ── Firestore poll for remote commands ────────────────────────────────────
    if (wifiConnected && now_ms - lastPoll >= POLL_INTERVAL_MS) {
      lastPoll = now_ms;
      pollAndApply();
    }
  }

  delay(200);
}
