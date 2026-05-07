"use client";

/**
 * ESP32 Light Control Dashboard
 * ─────────────────────────────────────────────────────────────────────────────
 * SUPABASE SETUP — run this SQL in your Supabase SQL editor:
 *
 *   create table sensor_readings (
 *     id            bigserial primary key,
 *     created_at    timestamptz default now(),
 *     ldr_value     int         not null,
 *     relay1_state  boolean     not null default false,
 *     relay2_state  boolean     not null default false
 *   );
 *
 *   create table device_controls (
 *     id             int primary key default 1,
 *     relay1_manual  boolean  default false,
 *     relay1_state   boolean  default false,
 *     relay2_manual  boolean  default false,
 *     relay2_state   boolean  default false,
 *     on_hour        int      default -1,
 *     on_min         int      default -1,
 *     off_hour       int      default -1,
 *     off_min        int      default -1,
 *     schedule_set   boolean  default false,
 *     ldr_threshold  int      default 1600,
 *     updated_at     timestamptz default now()
 *   );
 *   insert into device_controls (id) values (1);
 *
 *   create table power_settings (
 *     id              int primary key default 1,
 *     relay1_watts    numeric default 60,
 *     relay2_watts    numeric default 100,
 *     tariff_per_kwh  numeric default 0.12,
 *     currency        text    default 'USD'
 *   );
 *   insert into power_settings (id) values (1);
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ESP32 Arduino snippet — post a reading every ~5 s & poll controls:
 *
 *   #include <HTTPClient.h>
 *   #include <ArduinoJson.h>
 *   const char* SB_URL = "https://YOUR-PROJECT.supabase.co/rest/v1/";
 *   const char* SB_KEY = "your-anon-key";
 *
 *   void postReading(int ldr, bool r1, bool r2) {
 *     HTTPClient http;
 *     http.begin(String(SB_URL) + "sensor_readings");
 *     http.addHeader("Content-Type",  "application/json");
 *     http.addHeader("apikey",        SB_KEY);
 *     http.addHeader("Authorization", String("Bearer ") + SB_KEY);
 *     StaticJsonDocument<128> doc;
 *     doc["ldr_value"] = ldr; doc["relay1_state"] = r1; doc["relay2_state"] = r2;
 *     String body; serializeJson(doc, body);
 *     http.POST(body); http.end();
 *   }
 *
 *   void pollControls() {               // call every loop tick
 *     HTTPClient http;
 *     http.begin(String(SB_URL) + "device_controls?id=eq.1&select=*");
 *     http.addHeader("apikey", SB_KEY);
 *     http.addHeader("Authorization", String("Bearer ") + SB_KEY);
 *     if (http.GET() == 200) {
 *       StaticJsonDocument<512> doc;
 *       deserializeJson(doc, http.getString());
 *       JsonObject row = doc[0];
 *       relay1State    = row["relay1_state"].as<bool>();
 *       relay2State    = row["relay2_state"].as<bool>();
 *       ldrThreshold   = row["ldr_threshold"].as<int>();
 *       bool sched     = row["schedule_set"].as<bool>();
 *       if (sched) {
 *         onHour = row["on_hour"]; onMin = row["on_min"];
 *         offHour= row["off_hour"]; offMin= row["off_min"];
 *         scheduleSet = true;
 *       }
 *     }
 *     http.end();
 *   }
 */

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL      = process.env.NEXT_PUBLIC_SUPABASE_URL      ?? "https://your-project.supabase.co";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "your-anon-key";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Types ─────────────────────────────────────────────────────────────────────
interface SensorReading {
  id: number;
  created_at: string;
  ldr_value: number;
  relay1_state: boolean;
  relay2_state: boolean;
}
interface DeviceControls {
  relay1_manual: boolean;
  relay1_state: boolean;
  relay2_manual: boolean;
  relay2_state: boolean;
  on_hour: number;
  on_min: number;
  off_hour: number;
  off_min: number;
  schedule_set: boolean;
  ldr_threshold: number;
  updated_at: string;
}
interface PowerSettings {
  relay1_watts: number;
  relay2_watts: number;
  tariff_per_kwh: number;
  currency: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const pad2 = (n: number) => String(n).padStart(2, "0");

function calcPower(readings: SensorReading[], ps: PowerSettings) {
  if (readings.length < 2) return { kwh: 0, cost: 0, r1h: 0, r2h: 0 };
  let r1s = 0, r2s = 0;
  for (let i = 1; i < readings.length; i++) {
    const dt = (new Date(readings[i].created_at).getTime() -
                new Date(readings[i - 1].created_at).getTime()) / 1000;
    if (readings[i - 1].relay1_state) r1s += dt;
    if (readings[i - 1].relay2_state) r2s += dt;
  }
  const r1h = r1s / 3600, r2h = r2s / 3600;
  const kwh = (r1h * ps.relay1_watts + r2h * ps.relay2_watts) / 1000;
  return { kwh, cost: kwh * ps.tariff_per_kwh, r1h, r2h };
}

// ── Tiny components ───────────────────────────────────────────────────────────
function Pulse({ on }: { on: boolean }) {
  return (
    <span className="relative flex h-2.5 w-2.5 shrink-0">
      {on && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />}
      <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${on ? "bg-emerald-500" : "bg-slate-300"}`} />
    </span>
  );
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-white rounded-2xl border border-slate-100 shadow-[0_2px_20px_rgba(0,0,0,0.05)] ${className}`}>
      {children}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2">{children}</p>;
}

function Toggle({ on, onChange, disabled }: { on: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onChange} disabled={disabled} aria-pressed={on}
      className={`relative flex h-7 w-12 shrink-0 items-center rounded-full border-2 transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40 disabled:cursor-not-allowed ${
        on ? "border-blue-500 bg-blue-500" : "border-slate-200 bg-slate-100"
      }`}
    >
      <span
        style={{ width: 20, height: 20 }}
        className={`inline-block rounded-full bg-white shadow-sm transition-transform duration-200 ease-in-out ml-0.5 ${
          on ? "translate-x-[18px]" : "translate-x-0"
        }`}
      />
    </button>
  );
}

function Sparkline({ data, threshold }: { data: number[]; threshold: number }) {
  if (data.length < 2) return (
    <div className="h-16 flex items-center justify-center">
      <span className="text-xs text-slate-300">Awaiting data…</span>
    </div>
  );
  const W = 300, H = 64;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * W},${H - (v / 4095) * H}`);
  const ty  = H - (threshold / 4095) * H;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none">
      <defs>
        <linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.15" />
          <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map(f => (
        <line key={f} x1="0" y1={f * H} x2={W} y2={f * H} stroke="#f1f5f9" strokeWidth="1" />
      ))}
      <path d={`M0,${H} L${pts.join(" L")} L${W},${H} Z`} fill="url(#sg)" />
      <polyline points={pts.join(" ")} fill="none" stroke="#3b82f6" strokeWidth="1.8"
        strokeLinejoin="round" strokeLinecap="round" />
      <line x1="0" y1={ty} x2={W} y2={ty} stroke="#f97316" strokeWidth="1.2"
        strokeDasharray="5,3" opacity="0.7" />
      <circle cx={W} cy={H - (data[data.length - 1] / 4095) * H} r="3.5" fill="#3b82f6" />
    </svg>
  );
}

// ── Main Dashboard ────────────────────────────────────────────────────────────
export default function Dashboard() {
  const [latest,   setLatest]   = useState<SensorReading | null>(null);
  const [controls, setControls] = useState<DeviceControls | null>(null);
  const [history,  setHistory]  = useState<SensorReading[]>([]);
  const [power,    setPower]    = useState<PowerSettings>({ relay1_watts: 60, relay2_watts: 100, tariff_per_kwh: 0.12, currency: "USD" });

  const [online,    setOnline]    = useState(false);
  const [loadingR1, setLoadingR1] = useState(false);
  const [loadingR2, setLoadingR2] = useState(false);
  const [tab, setTab] = useState<"overview" | "schedule" | "power">("overview");

  // Schedule form
  const [sched,      setSched]      = useState({ onH: "", onM: "", offH: "", offM: "" });
  const [schedSaving, setSchedSaving] = useState(false);
  const [schedMsg,    setSchedMsg]    = useState<{ ok: boolean; text: string } | null>(null);

  // LDR threshold
  const [thrInput,  setThrInput]  = useState("");
  const [thrSaving, setThrSaving] = useState(false);

  // Power settings
  const [pwrForm,    setPwrForm]    = useState({ r1w: "60", r2w: "100", tariff: "0.12", currency: "USD" });
  const [pwrEditing, setPwrEditing] = useState(false);
  const [pwrSaving,  setPwrSaving]  = useState(false);

  // ── Load initial data ─────────────────────────────────────────────────────
  const fetchAll = useCallback(async () => {
    const [{ data: rows }, { data: ctrl }, { data: ps }] = await Promise.all([
      supabase.from("sensor_readings").select("*").order("created_at", { ascending: false }).limit(40),
      supabase.from("device_controls").select("*").eq("id", 1).single(),
      supabase.from("power_settings").select("*").eq("id", 1).single(),
    ]);
    if (rows?.length) { setLatest(rows[0]); setHistory([...rows].reverse()); setOnline(true); }
    if (ctrl) { setControls(ctrl); setThrInput(String(ctrl.ldr_threshold)); }
    if (ps)   { setPower(ps); setPwrForm({ r1w: String(ps.relay1_watts), r2w: String(ps.relay2_watts), tariff: String(ps.tariff_per_kwh), currency: ps.currency }); }
  }, []);

  useEffect(() => {
    fetchAll();
    const ch = supabase.channel("esp32")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "sensor_readings" }, (p) => {
        const row = p.new as SensorReading;
        setLatest(row); setHistory(prev => [...prev.slice(-39), row]); setOnline(true);
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "device_controls" }, (p) => {
        setControls(p.new as DeviceControls);
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [fetchAll]);

  // ── Write helpers ─────────────────────────────────────────────────────────
  const patchCtrl = async (data: Partial<DeviceControls>) => {
    const { error } = await supabase.from("device_controls")
      .update({ ...data, updated_at: new Date().toISOString() }).eq("id", 1);
    if (!error) setControls(p => p ? { ...p, ...data } : p);
    return !error;
  };

  const toggleR1 = async () => {
    if (!controls) return; setLoadingR1(true);
    await patchCtrl({ relay1_state: !controls.relay1_state, relay1_manual: true, schedule_set: false });
    setLoadingR1(false);
  };
  const toggleR2 = async () => {
    if (!controls) return; setLoadingR2(true);
    await patchCtrl({ relay2_state: !controls.relay2_state, relay2_manual: true });
    setLoadingR2(false);
  };

  const saveSchedule = async () => {
    const oh = parseInt(sched.onH), om = parseInt(sched.onM);
    const fh = parseInt(sched.offH), fm = parseInt(sched.offM);
    if ([oh,om,fh,fm].some(isNaN) || oh<0||oh>23||om<0||om>59||fh<0||fh>23||fm<0||fm>59) {
      setSchedMsg({ ok: false, text: "Invalid times — check values (0-23 h, 0-59 m)" }); return;
    }
    setSchedSaving(true);
    const ok = await patchCtrl({ on_hour: oh, on_min: om, off_hour: fh, off_min: fm, schedule_set: true, relay1_manual: false });
    setSchedSaving(false);
    setSchedMsg({ ok, text: ok ? "Schedule saved!" : "Save failed." });
    setTimeout(() => setSchedMsg(null), 3500);
  };

  const saveThreshold = async () => {
    const v = parseInt(thrInput);
    if (isNaN(v) || v < 0 || v > 4095) return;
    setThrSaving(true); await patchCtrl({ ldr_threshold: v }); setThrSaving(false);
  };

  const savePower = async () => {
    const r1w = parseFloat(pwrForm.r1w), r2w = parseFloat(pwrForm.r2w), tariff = parseFloat(pwrForm.tariff);
    if ([r1w, r2w, tariff].some(isNaN)) return;
    setPwrSaving(true);
    const { error } = await supabase.from("power_settings")
      .update({ relay1_watts: r1w, relay2_watts: r2w, tariff_per_kwh: tariff, currency: pwrForm.currency }).eq("id", 1);
    if (!error) setPower({ relay1_watts: r1w, relay2_watts: r2w, tariff_per_kwh: tariff, currency: pwrForm.currency });
    setPwrSaving(false); setPwrEditing(false);
  };

  // ── Derived data ──────────────────────────────────────────────────────────
  const stats    = calcPower(history, power);
  const ldrPct   = latest ? Math.round((latest.ldr_value / 4095) * 100) : 0;
  const thr      = controls?.ldr_threshold ?? 1600;
  const ldrLabel = !latest ? "—" : latest.ldr_value < thr - 80 ? "Dark" : latest.ldr_value > thr + 80 ? "Bright" : "Ambient";

  const windowH  = history.length > 1
    ? (new Date(history[history.length-1].created_at).getTime() - new Date(history[0].created_at).getTime()) / 3_600_000 : 0;
  const dailyKwh  = windowH > 0 ? (stats.kwh / windowH) * 24 : 0;
  const dailyCost = dailyKwh * power.tariff_per_kwh;
  const monthCost = dailyCost * 30;
  const lastSeen  = latest ? new Date(latest.created_at).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit", second:"2-digit" }) : null;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#f6f7fb]" style={{ fontFamily: "'DM Sans', 'Segoe UI', sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=DM+Mono:wght@400;500&display=swap');`}</style>

      {/* Header */}
      <header className="bg-white border-b border-slate-100 sticky top-0 z-40 shadow-[0_1px_0_0_#f1f5f9]">
        <div className="max-w-5xl mx-auto px-5 sm:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl bg-blue-600 flex items-center justify-center shadow-md shadow-blue-200">
              <svg className="h-5 w-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M13 10V3L4 14h7v7l9-11h-7z"/>
              </svg>
            </div>
            <div>
              <h1 className="text-[15px] font-semibold text-slate-800 leading-none">LightControl ESP32</h1>
              <p className="text-[11px] text-slate-400 mt-0.5 leading-none" style={{ fontFamily: "'DM Mono', monospace" }}>DS1302 · Relay×2 · LDR · Supabase</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Pulse on={online} />
            <span className="text-xs font-medium text-slate-500">
              {online ? (lastSeen ? `Live · ${lastSeen}` : "Connected") : "Waiting for device…"}
            </span>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-5 sm:px-8 py-7 space-y-5">

        {/* Stat strip */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { emoji: "🌤", label: "Light Level",  val: latest ? `${ldrPct}%` : "—",       sub: ldrLabel,                                            vc: "text-amber-500" },
            { emoji: "⚡", label: "Relay 1",      val: controls?.relay1_state ? "ON":"OFF", sub: controls?.schedule_set ? "Scheduled" : controls?.relay1_manual ? "Manual" : "Idle", vc: controls?.relay1_state ? "text-emerald-600":"text-slate-400" },
            { emoji: "💡", label: "Relay 2",      val: controls?.relay2_state ? "ON":"OFF", sub: controls?.relay2_manual ? "Manual" : "Auto-LDR",    vc: controls?.relay2_state ? "text-emerald-600":"text-slate-400" },
            { emoji: "🔋", label: "Daily Est.",   val: dailyKwh > 0 ? `${dailyKwh.toFixed(3)} kWh`:"—", sub: dailyCost>0?`${power.currency} ${dailyCost.toFixed(3)}`:"No data", vc: "text-blue-600" },
          ].map(s => (
            <Card key={s.label} className="p-4">
              <div className="flex items-center gap-1.5 mb-2">
                <span className="text-base">{s.emoji}</span>
                <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{s.label}</span>
              </div>
              <div className={`text-xl font-bold ${s.vc}`} style={{ fontFamily: "'DM Mono', monospace" }}>{s.val}</div>
              <div className="text-[11px] text-slate-400 mt-0.5">{s.sub}</div>
            </Card>
          ))}
        </div>

        {/* Tabs */}
        <div className="flex gap-1 bg-slate-100 rounded-xl p-1 w-fit">
          {(["overview","schedule","power"] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium capitalize transition-all ${
                tab===t ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"
              }`}>
              {t === "power" ? "Power & Billing" : t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        {/* ═══════════════════════════ OVERVIEW ════════════════════════════ */}
        {tab === "overview" && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">

            {/* Relay 1 */}
            <Card className="p-5">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <Label>Relay 1 — Scheduled</Label>
                  <h3 className="text-base font-semibold text-slate-800">Main Light</h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {controls?.schedule_set
                      ? `${pad2(controls.on_hour)}:${pad2(controls.on_min)} → ${pad2(controls.off_hour)}:${pad2(controls.off_min)}`
                      : "No schedule set"}
                  </p>
                </div>
                {loadingR1
                  ? <svg className="animate-spin h-5 w-5 text-blue-400 mt-1" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
                  : <Toggle on={controls?.relay1_state ?? false} onChange={toggleR1} disabled={loadingR1} />}
              </div>
              <div className={`rounded-xl px-3 py-2.5 flex items-center gap-2.5 ${controls?.relay1_state ? "bg-emerald-50" : "bg-slate-50"}`}>
                <Pulse on={controls?.relay1_state ?? false} />
                <span className={`text-sm font-semibold ${controls?.relay1_state ? "text-emerald-700":"text-slate-400"}`}
                  style={{ fontFamily:"'DM Mono',monospace" }}>
                  {controls?.relay1_state ? "ENERGISED" : "DE-ENERGISED"}
                </span>
                {controls?.relay1_manual && (
                  <span className="ml-auto text-[10px] font-bold text-amber-600 bg-amber-50 border border-amber-100 px-2 py-0.5 rounded-full">MANUAL</span>
                )}
              </div>
            </Card>

            {/* Relay 2 */}
            <Card className="p-5">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <Label>Relay 2 — LDR Controlled</Label>
                  <h3 className="text-base font-semibold text-slate-800">Ambient Light</h3>
                  <p className="text-xs text-slate-400 mt-0.5">Threshold: <span style={{ fontFamily:"'DM Mono',monospace" }}>{controls?.ldr_threshold ?? "—"}</span> / 4095</p>
                </div>
                {loadingR2
                  ? <svg className="animate-spin h-5 w-5 text-blue-400 mt-1" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
                  : <Toggle on={controls?.relay2_state ?? false} onChange={toggleR2} disabled={loadingR2} />}
              </div>
              <div className={`rounded-xl px-3 py-2.5 flex items-center gap-2.5 ${controls?.relay2_state ? "bg-emerald-50":"bg-slate-50"}`}>
                <Pulse on={controls?.relay2_state ?? false} />
                <span className={`text-sm font-semibold ${controls?.relay2_state ? "text-emerald-700":"text-slate-400"}`}
                  style={{ fontFamily:"'DM Mono',monospace" }}>
                  {controls?.relay2_state ? "ENERGISED" : "DE-ENERGISED"}
                </span>
                {controls?.relay2_manual && (
                  <span className="ml-auto text-[10px] font-bold text-amber-600 bg-amber-50 border border-amber-100 px-2 py-0.5 rounded-full">MANUAL</span>
                )}
              </div>
            </Card>

            {/* LDR sensor */}
            <Card className="p-5">
              <Label>LDR Live Sensor (GPIO 34)</Label>
              <div className="flex items-end gap-2 mb-3">
                <span className="text-3xl font-bold text-slate-800" style={{ fontFamily:"'DM Mono',monospace" }}>{latest?.ldr_value ?? "—"}</span>
                <span className="text-sm text-slate-400 mb-1">/ 4095</span>
                <span className="ml-auto text-xs font-semibold text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">{ldrLabel}</span>
              </div>
              <div className="relative h-2.5 bg-slate-100 rounded-full overflow-hidden mb-1">
                <div className="h-full rounded-full bg-gradient-to-r from-blue-400 to-blue-600 transition-all duration-700"
                  style={{ width: `${ldrPct}%` }} />
                <div className="absolute top-0 bottom-0 w-0.5 bg-orange-400"
                  style={{ left: `${Math.round((thr/4095)*100)}%` }} />
              </div>
              <div className="flex justify-between text-[10px] text-slate-300 mb-4" style={{ fontFamily:"'DM Mono',monospace" }}>
                <span>Dark</span><span className="text-orange-400">▲ {thr}</span><span>Bright</span>
              </div>
              <div className="flex gap-2">
                <input type="number" min={0} max={4095} placeholder="Set threshold (0–4095)"
                  value={thrInput} onChange={e => setThrInput(e.target.value)}
                  className="flex-1 text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all"
                  style={{ fontFamily:"'DM Mono',monospace" }} />
                <button onClick={saveThreshold} disabled={thrSaving}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl shadow-sm shadow-blue-200 transition-all active:scale-95 disabled:opacity-50">
                  {thrSaving ? "…" : "Set"}
                </button>
              </div>
            </Card>

            {/* Sparkline + log */}
            <Card className="p-5">
              <Label>LDR History — {history.length} readings</Label>
              <Sparkline data={history.map(r => r.ldr_value)} threshold={thr} />
              <div className="flex justify-between text-[10px] text-slate-300 mt-1 mb-3" style={{ fontFamily:"'DM Mono',monospace" }}>
                <span>← oldest</span>
                <span className="text-orange-400 flex items-center gap-1">
                  <svg width="14" height="3"><line x1="0" y1="1.5" x2="14" y2="1.5" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4,2"/></svg>
                  threshold
                </span>
                <span>latest →</span>
              </div>
              <div className="space-y-0.5 max-h-28 overflow-y-auto">
                {[...history].reverse().slice(0,7).map(r => (
                  <div key={r.id} className="grid grid-cols-4 text-[11px] py-1 border-b border-slate-50 last:border-0"
                    style={{ fontFamily:"'DM Mono',monospace" }}>
                    <span className="text-slate-400">{new Date(r.created_at).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"})}</span>
                    <span className="text-blue-500 text-center">LDR {r.ldr_value}</span>
                    <span className={`text-center ${r.relay1_state?"text-emerald-500":"text-slate-300"}`}>R1 {r.relay1_state?"ON":"OFF"}</span>
                    <span className={`text-right  ${r.relay2_state?"text-emerald-500":"text-slate-300"}`}>R2 {r.relay2_state?"ON":"OFF"}</span>
                  </div>
                ))}
                {!history.length && <p className="text-xs text-slate-300 text-center py-2">No data yet.</p>}
              </div>
            </Card>
          </div>
        )}

        {/* ═══════════════════════════ SCHEDULE ════════════════════════════ */}
        {tab === "schedule" && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <Card className="p-6">
              <Label>Relay 1 — ON / OFF Schedule</Label>
              <h3 className="text-base font-semibold text-slate-800 mb-5">Set Timer</h3>

              {controls?.schedule_set && (
                <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-100 rounded-xl px-3 py-2.5 mb-5">
                  <svg className="h-4 w-4 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
                  </svg>
                  <span className="text-sm font-semibold text-emerald-700" style={{ fontFamily:"'DM Mono',monospace" }}>
                    {pad2(controls.on_hour)}:{pad2(controls.on_min)} → {pad2(controls.off_hour)}:{pad2(controls.off_min)}
                  </span>
                </div>
              )}

              {[
                { label:"Turn ON at",  keys:["onH","onM"]  as const, ring:"focus:border-emerald-400 focus:ring-emerald-100" },
                { label:"Turn OFF at", keys:["offH","offM"] as const, ring:"focus:border-red-400    focus:ring-red-100"     },
              ].map(row => (
                <div key={row.label} className="mb-4">
                  <label className="block text-xs font-semibold text-slate-500 mb-2">{row.label}</label>
                  <div className="grid grid-cols-2 gap-3">
                    {row.keys.map((k,i) => (
                      <input key={k} type="number" min={0} max={i===0?23:59}
                        placeholder={i===0?"Hour (0-23)":"Min (0-59)"}
                        value={sched[k]} onChange={e => setSched(p => ({...p,[k]:e.target.value}))}
                        className={`border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 transition-all ${row.ring}`}
                        style={{ fontFamily:"'DM Mono',monospace" }} />
                    ))}
                  </div>
                </div>
              ))}

              <button onClick={saveSchedule} disabled={schedSaving}
                className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm rounded-xl shadow-sm shadow-blue-200 transition-all active:scale-95 disabled:opacity-50 mt-2">
                {schedSaving ? "Saving…" : "Save Schedule"}
              </button>
              {schedMsg && (
                <p className={`mt-3 text-sm text-center font-semibold ${schedMsg.ok?"text-emerald-600":"text-red-500"}`}>{schedMsg.text}</p>
              )}
            </Card>

            {/* Timeline */}
            <Card className="p-6">
              <Label>24-Hour Visual Timeline</Label>
              <div className="mt-2 mb-5">
                <div className="h-9 bg-slate-100 rounded-full overflow-hidden relative">
                  {controls?.schedule_set && (() => {
                    const op = ((controls.on_hour*60+controls.on_min)/1440)*100;
                    const fp = ((controls.off_hour*60+controls.off_min)/1440)*100;
                    return op < fp
                      ? <div className="absolute top-0 bottom-0 bg-blue-400/40 rounded-full" style={{left:`${op}%`,width:`${fp-op}%`}}/>
                      : <><div className="absolute top-0 bottom-0 bg-blue-400/40" style={{left:`${op}%`,right:0}}/><div className="absolute top-0 bottom-0 bg-blue-400/40" style={{left:0,width:`${fp}%`}}/></>;
                  })()}
                  {(() => {
                    const n = new Date();
                    const p = ((n.getHours()*60+n.getMinutes())/1440)*100;
                    return <div className="absolute top-0 bottom-0 w-0.5 bg-slate-500/60" style={{left:`${p}%`}}/>;
                  })()}
                </div>
                <div className="flex justify-between text-[10px] text-slate-300 mt-1.5 px-0.5" style={{ fontFamily:"'DM Mono',monospace" }}>
                  {[0,6,12,18,24].map(h => <span key={h}>{pad2(h)}:00</span>)}
                </div>
              </div>

              {[
                { label:"Status",   val: controls?.schedule_set ? "ACTIVE" : "NOT SET",  vc: controls?.schedule_set?"text-emerald-600":"text-slate-400" },
                { label:"ON time",  val: controls?.schedule_set ? `${pad2(controls.on_hour)}:${pad2(controls.on_min)}`:"—",  vc:"text-slate-800" },
                { label:"OFF time", val: controls?.schedule_set ? `${pad2(controls.off_hour)}:${pad2(controls.off_min)}`:"—",vc:"text-slate-800" },
                { label:"Duration", val: controls?.schedule_set ? (() => { let m=(controls.off_hour*60+controls.off_min)-(controls.on_hour*60+controls.on_min); if(m<0)m+=1440; return `${Math.floor(m/60)}h ${m%60}m`; })() : "—", vc:"text-slate-800" },
              ].map(row => (
                <div key={row.label} className="flex justify-between items-center py-2.5 border-b border-slate-50 last:border-0 text-sm">
                  <span className="text-slate-500">{row.label}</span>
                  <span className={`font-semibold ${row.vc}`} style={{ fontFamily:"'DM Mono',monospace" }}>{row.val}</span>
                </div>
              ))}
            </Card>
          </div>
        )}

        {/* ════════════════════════ POWER & BILLING ════════════════════════ */}
        {tab === "power" && (
          <div className="space-y-5">

            {/* Summary cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label:"Session Energy",    val:`${stats.kwh.toFixed(4)} kWh`,     sub:`${power.currency} ${stats.cost.toFixed(4)}`,       vc:"text-blue-600" },
                { label:"Relay 1 Runtime",   val:`${stats.r1h.toFixed(2)}h`,        sub:`${(stats.r1h*power.relay1_watts/1000).toFixed(4)} kWh`,vc:"text-slate-800" },
                { label:"Relay 2 Runtime",   val:`${stats.r2h.toFixed(2)}h`,        sub:`${(stats.r2h*power.relay2_watts/1000).toFixed(4)} kWh`,vc:"text-slate-800" },
                { label:"Monthly Estimate",  val:`${power.currency} ${monthCost.toFixed(2)}`, sub:`${dailyKwh.toFixed(3)} kWh/day`,          vc:"text-violet-600" },
              ].map(s => (
                <Card key={s.label} className="p-4">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">{s.label}</p>
                  <p className={`text-xl font-bold ${s.vc}`} style={{ fontFamily:"'DM Mono',monospace" }}>{s.val}</p>
                  <p className="text-[11px] text-slate-400 mt-0.5">{s.sub}</p>
                </Card>
              ))}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">

              {/* Usage breakdown */}
              <Card className="p-5">
                <Label>Relay Usage Breakdown</Label>
                {[
                  { label:"Relay 1", watts:power.relay1_watts, hours:stats.r1h, bar:"bg-blue-500",   bg:"bg-blue-50"   },
                  { label:"Relay 2", watts:power.relay2_watts, hours:stats.r2h, bar:"bg-violet-500", bg:"bg-violet-50" },
                ].map(r => {
                  const kwh = (r.hours * r.watts) / 1000;
                  const cost = kwh * power.tariff_per_kwh;
                  const pct  = stats.kwh > 0 ? (kwh / stats.kwh) * 100 : 0;
                  return (
                    <div key={r.label} className="mb-5 last:mb-0">
                      <div className="flex justify-between items-baseline mb-1.5">
                        <span className="text-sm font-semibold text-slate-700">{r.label} — {r.watts}W</span>
                        <span className="text-xs text-slate-500" style={{ fontFamily:"'DM Mono',monospace" }}>
                          {kwh.toFixed(4)} kWh · {power.currency} {cost.toFixed(4)}
                        </span>
                      </div>
                      <div className={`h-2.5 rounded-full ${r.bg} overflow-hidden`}>
                        <div className={`h-full rounded-full ${r.bar} transition-all duration-700`} style={{width:`${pct}%`}}/>
                      </div>
                      <p className="text-[10px] text-slate-300 mt-1" style={{ fontFamily:"'DM Mono',monospace" }}>
                        {r.hours.toFixed(2)}h · {pct.toFixed(1)}% of session
                      </p>
                    </div>
                  );
                })}

                {/* Cost projection bars (weekly) */}
                <div className="mt-5 pt-4 border-t border-slate-50">
                  <Label>Projected Weekly Spend</Label>
                  <div className="grid grid-cols-7 gap-1.5 mt-2">
                    {["M","T","W","T","F","S","S"].map((d,i) => {
                      const fac = 0.55 + Math.sin(i*1.3+1)*0.45;
                      const h   = Math.max(8, fac*52);
                      const c   = (dailyCost * fac).toFixed(3);
                      return (
                        <div key={i} title={`${power.currency} ${c}`} className="flex flex-col items-center gap-1">
                          <div className="w-full bg-slate-100 rounded-lg overflow-hidden relative" style={{height:52}}>
                            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-blue-500 to-blue-400 rounded-lg transition-all duration-700"
                              style={{height: h}}/>
                          </div>
                          <span className="text-[9px] text-slate-400" style={{ fontFamily:"'DM Mono',monospace" }}>{d}</span>
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-[10px] text-slate-300 mt-2" style={{ fontFamily:"'DM Mono',monospace" }}>
                    * Bars reflect usage pattern from session
                  </p>
                </div>
              </Card>

              {/* Power settings */}
              <Card className="p-5">
                <div className="flex items-center justify-between mb-4">
                  <Label>Power & Tariff Settings</Label>
                  {!pwrEditing && (
                    <button onClick={() => setPwrEditing(true)}
                      className="text-xs font-semibold text-blue-600 hover:text-blue-700 -mt-2">Edit</button>
                  )}
                </div>

                {pwrEditing ? (
                  <div className="space-y-3">
                    {[
                      { label:"Relay 1 load (W)",     key:"r1w"      as const },
                      { label:"Relay 2 load (W)",     key:"r2w"      as const },
                      { label:"Tariff (cost/kWh)",    key:"tariff"   as const },
                      { label:"Currency (e.g. USD)",  key:"currency" as const },
                    ].map(f => (
                      <div key={f.key}>
                        <label className="block text-xs font-semibold text-slate-500 mb-1">{f.label}</label>
                        <input value={pwrForm[f.key]} onChange={e => setPwrForm(p => ({...p,[f.key]:e.target.value}))}
                          className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all"
                          style={{ fontFamily:"'DM Mono',monospace" }} />
                      </div>
                    ))}
                    <div className="flex gap-2 pt-1">
                      <button onClick={savePower} disabled={pwrSaving}
                        className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl transition-all active:scale-95 disabled:opacity-50">
                        {pwrSaving ? "Saving…" : "Save"}
                      </button>
                      <button onClick={() => setPwrEditing(false)}
                        className="flex-1 py-2.5 bg-slate-100 text-slate-600 text-sm font-semibold rounded-xl hover:bg-slate-200 transition-all">
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-0.5">
                    {[
                      { label:"Relay 1 load",      val:`${power.relay1_watts} W` },
                      { label:"Relay 2 load",      val:`${power.relay2_watts} W` },
                      { label:"Tariff",             val:`${power.currency} ${power.tariff_per_kwh} / kWh` },
                      { label:"Daily estimate",     val:`${power.currency} ${dailyCost.toFixed(3)}` },
                      { label:"Monthly estimate",   val:`${power.currency} ${monthCost.toFixed(2)}` },
                      { label:"Yearly estimate",    val:`${power.currency} ${(monthCost*12).toFixed(2)}` },
                    ].map(r => (
                      <div key={r.label} className="flex justify-between py-2.5 border-b border-slate-50 last:border-0 text-sm">
                        <span className="text-slate-500">{r.label}</span>
                        <span className="font-semibold text-slate-800" style={{ fontFamily:"'DM Mono',monospace" }}>{r.val}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>
          </div>
        )}

        {/* Footer */}
        <footer className="flex flex-col sm:flex-row justify-between items-center gap-1 text-[11px] text-slate-300 pt-3 border-t border-slate-100"
          style={{ fontFamily:"'DM Mono',monospace" }}>
          <span>ESP32 · DS1302 RTC · GPIO 26/27 Relay · GPIO 34 LDR</span>
          <span>SDA=21 SCL=22 · DAT=17 CLK=16 RST=5 · Supabase Realtime</span>
        </footer>
      </main>
    </div>
  );
}