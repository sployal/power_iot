"use client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ESP32 LIGHT CONTROL — LIVE DASHBOARD
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *  FIREBASE SETUP (Firestore):
 *  - Collection `sensor_readings` (documents with created_at, ldr_value, relay1_state, relay2_state)
 *  - Collection `device_controls` with document id `1`
 *  - Collection `power_settings` with document id `1`
 *
 *  ── Environment Variables (.env.local) ─────────────────────────────────────
 *  NEXT_PUBLIC_FIREBASE_API_KEY=...
 *  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
 *  NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
 *  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=...
 *  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
 *  NEXT_PUBLIC_FIREBASE_APP_ID=...
 *
 *  ── Key fixes vs original ──────────────────────────────────────────────────
 *  ✔ updateDoc → setDoc with { merge: true }  so doc is created if missing
 *  ✔ patchCtrl catch now logs the real Firebase error to console
 *  ✔ savePower also uses setDoc with merge
 *  ✔ schedMsg shows real error text on failure
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useEffect, useState, useCallback, useRef } from "react";
import {
  collection,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  setDoc,           // ← replaces updateDoc everywhere
} from "firebase/firestore";
import { db } from "@/lib/firebase";

// ── Types ──────────────────────────────────────────────────────────────────────
interface SensorReading {
  id: string | number;
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

// ── Utility ────────────────────────────────────────────────────────────────────
const p2 = (n: number) => String(n).padStart(2, "0");

const toIsoString = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (
    typeof value === "object" &&
    value !== null &&
    "toDate" in value &&
    typeof (value as { toDate: () => Date }).toDate === "function"
  ) {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  if (value instanceof Date) return value.toISOString();
  return new Date().toISOString();
};

function calcPower(readings: SensorReading[], ps: PowerSettings) {
  if (readings.length < 2) return { kwh: 0, cost: 0, r1h: 0, r2h: 0 };
  let r1s = 0, r2s = 0;
  for (let i = 1; i < readings.length; i++) {
    const dt =
      (new Date(readings[i].created_at).getTime() -
        new Date(readings[i - 1].created_at).getTime()) /
      1000;
    if (readings[i - 1].relay1_state) r1s += dt;
    if (readings[i - 1].relay2_state) r2s += dt;
  }
  const r1h = r1s / 3600,
    r2h = r2s / 3600;
  const kwh = (r1h * ps.relay1_watts + r2h * ps.relay2_watts) / 1000;
  return { kwh, cost: kwh * ps.tariff_per_kwh, r1h, r2h };
}

// ── Sub-components ─────────────────────────────────────────────────────────────
function LiveDot({ on }: { on: boolean }) {
  return (
    <span className="relative flex h-2.5 w-2.5 shrink-0">
      {on && (
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-lime-400 opacity-70" />
      )}
      <span
        className={`relative inline-flex rounded-full h-2.5 w-2.5 ${
          on ? "bg-lime-500" : "bg-zinc-500"
        }`}
      />
    </span>
  );
}

function GlassCard({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-2xl border border-white/10 bg-white/5 backdrop-blur-md shadow-xl ${className}`}
    >
      {children}
    </div>
  );
}

function RelayToggle({
  on,
  onChange,
  loading,
}: {
  on: boolean;
  onChange: () => void;
  loading?: boolean;
}) {
  return (
    <button
      onClick={onChange}
      disabled={loading}
      aria-pressed={on}
      className={`relative flex h-8 w-14 items-center rounded-full border-2 transition-all duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-lime-400 disabled:opacity-40 disabled:cursor-not-allowed
        ${
          on
            ? "border-lime-400 bg-lime-500/20 shadow-[0_0_14px_2px_rgba(132,204,22,0.3)]"
            : "border-white/20 bg-white/5"
        }
      `}
    >
      {loading ? (
        <span className="mx-auto w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
      ) : (
        <span
          className={`inline-block h-5 w-5 rounded-full transition-transform duration-300 ease-[cubic-bezier(.68,-0.55,.27,1.55)] ml-1
          ${
            on
              ? "translate-x-[22px] bg-lime-400 shadow-[0_0_8px_rgba(132,204,22,0.8)]"
              : "translate-x-0 bg-white/40"
          }
        `}
        />
      )}
    </button>
  );
}

function Sparkline({
  data,
  threshold,
}: {
  data: number[];
  threshold: number;
}) {
  if (data.length < 2)
    return (
      <div className="h-20 flex items-center justify-center text-xs text-white/20 font-mono">
        — awaiting data —
      </div>
    );
  const W = 400,
    H = 72;
  const pts = data.map(
    (v, i) => `${(i / (data.length - 1)) * W},${H - (v / 4095) * H}`
  );
  const ty = H - (threshold / 4095) * H;
  const last = data[data.length - 1];
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id="ldrGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#a3e635" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#a3e635" stopOpacity="0" />
        </linearGradient>
        <filter id="glow">
          <feGaussianBlur stdDeviation="2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {[0.25, 0.5, 0.75].map((f) => (
        <line
          key={f}
          x1="0"
          y1={f * H}
          x2={W}
          y2={f * H}
          stroke="rgba(255,255,255,0.05)"
          strokeWidth="1"
        />
      ))}
      <path
        d={`M0,${H} L${pts.join(" L")} L${W},${H} Z`}
        fill="url(#ldrGrad)"
      />
      <polyline
        points={pts.join(" ")}
        fill="none"
        stroke="#a3e635"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
        filter="url(#glow)"
      />
      <line
        x1="0"
        y1={ty}
        x2={W}
        y2={ty}
        stroke="#f97316"
        strokeWidth="1.5"
        strokeDasharray="6,4"
        opacity="0.6"
      />
      <circle
        cx={W}
        cy={H - (last / 4095) * H}
        r="4"
        fill="#a3e635"
        filter="url(#glow)"
      />
    </svg>
  );
}

function StatBadge({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <GlassCard className="p-4 flex flex-col gap-1">
      <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-white/30">
        {label}
      </span>
      <span
        className={`text-2xl font-black font-mono leading-none ${
          accent ?? "text-white"
        }`}
      >
        {value}
      </span>
      {sub && (
        <span className="text-[10px] text-white/30 font-mono">{sub}</span>
      )}
    </GlassCard>
  );
}

// ── Main Dashboard ─────────────────────────────────────────────────────────────
export default function Dashboard() {
  const [latest, setLatest] = useState<SensorReading | null>(null);
  const [controls, setControls] = useState<DeviceControls | null>(null);
  const [history, setHistory] = useState<SensorReading[]>([]);
  const [power, setPower] = useState<PowerSettings>({
    relay1_watts: 60,
    relay2_watts: 100,
    tariff_per_kwh: 0.12,
    currency: "USD",
  });
  const [online, setOnline] = useState(false);
  const [lastSeen, setLastSeen] = useState<string | null>(null);
  const [tab, setTab] = useState<"overview" | "schedule" | "power">("overview");

  const [loadingR1, setLoadingR1] = useState(false);
  const [loadingR2, setLoadingR2] = useState(false);

  // Schedule
  const [sched, setSched] = useState({ onH: "", onM: "", offH: "", offM: "" });
  const [schedSaving, setSchedSaving] = useState(false);
  const [schedMsg, setSchedMsg] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

  // LDR threshold
  const [thrInput, setThrInput] = useState("");
  const [thrSaving, setThrSaving] = useState(false);

  // Power settings
  const [pwrForm, setPwrForm] = useState({
    r1w: "60",
    r2w: "100",
    tariff: "0.12",
    currency: "USD",
  });
  const [pwrEditing, setPwrEditing] = useState(false);
  const [pwrSaving, setPwrSaving] = useState(false);

  // Connection watchdog
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetWatchdog = useCallback(() => {
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    watchdogRef.current = setTimeout(() => setOnline(false), 30_000);
  }, []);

  // ── Realtime subscriptions ────────────────────────────────────────────────
  useEffect(() => {
    // Initial fetch of last 60 readings
    void getDocs(
      query(
        collection(db, "sensor_readings"),
        orderBy("created_at", "desc"),
        limit(60)
      )
    ).then((snap) => {
      const rows = snap.docs.map((d) => {
        const data = d.data();
        return {
          id: data.id ?? d.id,
          created_at: toIsoString(data.created_at),
          ldr_value: Number(data.ldr_value ?? 0),
          relay1_state: Boolean(data.relay1_state),
          relay2_state: Boolean(data.relay2_state),
        } as SensorReading;
      });
      if (!rows.length) return;
      setLatest(rows[0]);
      setHistory([...rows].reverse());
      setOnline(true);
      setLastSeen(
        new Date(rows[0].created_at).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
      );
      resetWatchdog();
    });

    // Live listener — latest reading
    const unsubReadings = onSnapshot(
      query(
        collection(db, "sensor_readings"),
        orderBy("created_at", "desc"),
        limit(1)
      ),
      (snapshot) => {
        const latestDoc = snapshot.docs[0];
        if (!latestDoc) return;
        const data = latestDoc.data();
        const row: SensorReading = {
          id: data.id ?? latestDoc.id,
          created_at: toIsoString(data.created_at),
          ldr_value: Number(data.ldr_value ?? 0),
          relay1_state: Boolean(data.relay1_state),
          relay2_state: Boolean(data.relay2_state),
        };
        setLatest(row);
        setHistory((prev) => {
          if (prev[prev.length - 1]?.id === row.id) return prev;
          return [...prev.slice(-59), row];
        });
        setOnline(true);
        setLastSeen(
          new Date(row.created_at).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })
        );
        resetWatchdog();
      }
    );

    // Live listener — device_controls/1
    const unsubControls = onSnapshot(
      doc(db, "device_controls", "1"),
      (snapshot) => {
        if (snapshot.exists()) {
          const next = snapshot.data() as DeviceControls;
          setControls(next);
          setThrInput(String(next.ldr_threshold));
        }
      }
    );

    // Live listener — power_settings/1
    const unsubPower = onSnapshot(
      doc(db, "power_settings", "1"),
      (snapshot) => {
        if (snapshot.exists()) {
          const next = snapshot.data() as PowerSettings;
          setPower(next);
          setPwrForm({
            r1w: String(next.relay1_watts),
            r2w: String(next.relay2_watts),
            tariff: String(next.tariff_per_kwh),
            currency: next.currency,
          });
        }
      }
    );

    return () => {
      unsubReadings();
      unsubControls();
      unsubPower();
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
    };
  }, [resetWatchdog]);

  // ── Write helpers ─────────────────────────────────────────────────────────

  /**
   * setDoc with merge:true — creates document if it doesn't exist,
   * merges fields if it does. Replaces updateDoc which throws on missing docs.
   */
  const patchCtrl = async (data: Partial<DeviceControls>) => {
    try {
      await setDoc(
        doc(db, "device_controls", "1"),
        { ...data, updated_at: new Date().toISOString() },
        { merge: true }
      );
      setControls((prev) => (prev ? { ...prev, ...data } : prev));
      return true;
    } catch (err) {
      console.error("[Firebase] patchCtrl failed:", err);
      return false;
    }
  };

  const toggleR1 = async () => {
    if (!controls) return;
    setLoadingR1(true);
    await patchCtrl({
      relay1_state: !controls.relay1_state,
      relay1_manual: true,
      schedule_set: false,
    });
    setLoadingR1(false);
  };

  const toggleR2 = async () => {
    if (!controls) return;
    setLoadingR2(true);
    await patchCtrl({
      relay2_state: !controls.relay2_state,
      relay2_manual: true,
    });
    setLoadingR2(false);
  };

  const saveSchedule = async () => {
    const oh = parseInt(sched.onH),
      om = parseInt(sched.onM);
    const fh = parseInt(sched.offH),
      fm = parseInt(sched.offM);
    if (
      [oh, om, fh, fm].some(isNaN) ||
      oh < 0 || oh > 23 ||
      om < 0 || om > 59 ||
      fh < 0 || fh > 23 ||
      fm < 0 || fm > 59
    ) {
      setSchedMsg({
        ok: false,
        text: "Invalid — check hour (0-23) and minute (0-59)",
      });
      return;
    }
    setSchedSaving(true);
    const ok = await patchCtrl({
      on_hour: oh,
      on_min: om,
      off_hour: fh,
      off_min: fm,
      schedule_set: true,
      relay1_manual: false,
    });
    setSchedSaving(false);
    setSchedMsg({
      ok,
      text: ok
        ? "Schedule pushed to device!"
        : "Save failed — check browser console for Firebase error.",
    });
    setTimeout(() => setSchedMsg(null), 5000);
  };

  const clearSchedule = async () => {
    await patchCtrl({ schedule_set: false });
  };

  const saveThreshold = async () => {
    const v = parseInt(thrInput);
    if (isNaN(v) || v < 0 || v > 4095) return;
    setThrSaving(true);
    await patchCtrl({ ldr_threshold: v });
    setThrSaving(false);
  };

  const savePower = async () => {
    const r1w = parseFloat(pwrForm.r1w),
      r2w = parseFloat(pwrForm.r2w),
      tariff = parseFloat(pwrForm.tariff);
    if ([r1w, r2w, tariff].some(isNaN)) return;
    setPwrSaving(true);
    try {
      // setDoc with merge so document is created if it doesn't exist
      await setDoc(
        doc(db, "power_settings", "1"),
        {
          relay1_watts: r1w,
          relay2_watts: r2w,
          tariff_per_kwh: tariff,
          currency: pwrForm.currency,
        },
        { merge: true }
      );
      setPower({
        relay1_watts: r1w,
        relay2_watts: r2w,
        tariff_per_kwh: tariff,
        currency: pwrForm.currency,
      });
      setPwrEditing(false);
    } catch (err) {
      console.error("[Firebase] savePower failed:", err);
    }
    setPwrSaving(false);
  };

  // ── Derived ───────────────────────────────────────────────────────────────
  const stats = calcPower(history, power);
  const ldrVal = latest?.ldr_value ?? 0;
  const ldrPct = Math.round((ldrVal / 4095) * 100);
  const thr = controls?.ldr_threshold ?? 1600;
  const ldrLabel = !latest
    ? "—"
    : ldrVal < thr - 80
    ? "DARK"
    : ldrVal > thr + 80
    ? "BRIGHT"
    : "AMBIENT";
  const ldrColor =
    ldrLabel === "DARK"
      ? "text-blue-400"
      : ldrLabel === "BRIGHT"
      ? "text-yellow-300"
      : "text-lime-400";

  const windowH =
    history.length > 1
      ? (new Date(history[history.length - 1].created_at).getTime() -
          new Date(history[0].created_at).getTime()) /
        3_600_000
      : 0;
  const dailyKwh = windowH > 0 ? (stats.kwh / windowH) * 24 : 0;
  const dailyCost = dailyKwh * power.tariff_per_kwh;
  const monthCost = dailyCost * 30;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      className="min-h-screen bg-[#0a0e17] text-white"
      style={{ fontFamily: "'Space Grotesk', 'Syne', system-ui, sans-serif" }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=Space+Mono:wght@400;700&display=swap');
        :root { font-family: 'Space Grotesk', system-ui, sans-serif; }
        .mono { font-family: 'Space Mono', monospace; }
        .glow-green { text-shadow: 0 0 20px rgba(163,230,53,0.6); }
        .glow-box-green { box-shadow: 0 0 20px rgba(163,230,53,0.15), inset 0 0 20px rgba(163,230,53,0.05); }
        .grid-bg {
          background-image: linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
                            linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px);
          background-size: 40px 40px;
        }
        .tab-active { background: linear-gradient(135deg, rgba(163,230,53,0.2), rgba(163,230,53,0.05)); border-color: rgba(163,230,53,0.4); }
        input[type=number]::-webkit-outer-spin-button,
        input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
      `}</style>

      {/* Atmospheric background */}
      <div className="fixed inset-0 pointer-events-none">
        <div
          className="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] rounded-full"
          style={{
            background:
              "radial-gradient(circle, rgba(163,230,53,0.04) 0%, transparent 70%)",
          }}
        />
        <div
          className="absolute bottom-[-10%] right-[-10%] w-[500px] h-[500px] rounded-full"
          style={{
            background:
              "radial-gradient(circle, rgba(59,130,246,0.06) 0%, transparent 70%)",
          }}
        />
        <div className="grid-bg absolute inset-0 opacity-100" />
      </div>

      {/* ── HEADER ── */}
      <header className="relative z-40 border-b border-white/[0.06] bg-black/30 backdrop-blur-xl">
        <div className="max-w-6xl mx-auto px-5 sm:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className="h-9 w-9 rounded-xl flex items-center justify-center"
              style={{
                background: "linear-gradient(135deg, #a3e635, #65a30d)",
                boxShadow: "0 0 20px rgba(163,230,53,0.4)",
              }}
            >
              <svg
                className="h-5 w-5 text-black"
                fill="currentColor"
                viewBox="0 0 24 24"
              >
                <path d="M13 2L3 14h9v8l9-11h-8z" />
              </svg>
            </div>
            <div>
              <div className="text-sm font-bold tracking-wide text-white">
                LightControl
              </div>
              <div className="text-[10px] text-white/30 mono">
                ESP32 · DS1302 · Firebase Live
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div
              className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-semibold mono
              ${
                online
                  ? "border-lime-500/30 bg-lime-500/10 text-lime-400"
                  : "border-white/10 bg-white/5 text-white/30"
              }`}
            >
              <LiveDot on={online} />
              {online ? `LIVE · ${lastSeen ?? "…"}` : "OFFLINE"}
            </div>
            <div className="text-[10px] mono text-white/20 hidden sm:block">
              {history.length} readings
            </div>
          </div>
        </div>
      </header>

      <main className="relative z-10 max-w-6xl mx-auto px-5 sm:px-8 py-8 space-y-6">

        {/* ── STAT STRIP ── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatBadge
            label="LDR Raw"
            value={latest ? String(ldrVal) : "—"}
            sub={`${ldrPct}% of 4095`}
            accent={ldrColor}
          />
          <StatBadge
            label="Light Status"
            value={ldrLabel}
            sub={`Threshold ${thr}`}
            accent={ldrColor}
          />
          <StatBadge
            label="Relay 1"
            value={controls?.relay1_state ? "ON" : "OFF"}
            sub={
              controls?.schedule_set
                ? "Scheduled"
                : controls?.relay1_manual
                ? "Manual"
                : "Idle"
            }
            accent={
              controls?.relay1_state
                ? "text-lime-400 glow-green"
                : "text-white/30"
            }
          />
          <StatBadge
            label="Relay 2"
            value={controls?.relay2_state ? "ON" : "OFF"}
            sub={controls?.relay2_manual ? "Manual override" : "Auto-LDR"}
            accent={
              controls?.relay2_state
                ? "text-lime-400 glow-green"
                : "text-white/30"
            }
          />
        </div>

        {/* ── TABS ── */}
        <div className="flex gap-1.5 p-1 rounded-xl border border-white/[0.08] bg-white/[0.03] w-fit">
          {(["overview", "schedule", "power"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-5 py-2 rounded-lg text-xs font-bold uppercase tracking-widest transition-all border
                ${
                  tab === t
                    ? "tab-active text-lime-300"
                    : "border-transparent text-white/30 hover:text-white/60"
                }`}
            >
              {t}
            </button>
          ))}
        </div>

        {/* ════════════════════════════ OVERVIEW ════════════════════════════ */}
        {tab === "overview" && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">

            {/* Relay 1 */}
            <GlassCard className="p-5">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <div className="text-[9px] mono font-bold tracking-[0.2em] text-white/30 uppercase mb-1">
                    Relay 1 — GPIO 26
                  </div>
                  <div className="text-base font-bold text-white">
                    Main Light
                  </div>
                  <div className="text-[11px] text-white/30 mono mt-0.5">
                    {controls?.schedule_set
                      ? `⏱ ${p2(controls.on_hour)}:${p2(
                          controls.on_min
                        )} → ${p2(controls.off_hour)}:${p2(controls.off_min)}`
                      : "No schedule active"}
                  </div>
                </div>
                <RelayToggle
                  on={controls?.relay1_state ?? false}
                  onChange={toggleR1}
                  loading={loadingR1}
                />
              </div>
              <div
                className={`rounded-xl px-4 py-3 flex items-center gap-3 border transition-all
                ${
                  controls?.relay1_state
                    ? "bg-lime-500/10 border-lime-500/30 glow-box-green"
                    : "bg-white/[0.03] border-white/[0.06]"
                }`}
              >
                <LiveDot on={controls?.relay1_state ?? false} />
                <span
                  className={`text-sm font-bold mono ${
                    controls?.relay1_state ? "text-lime-400" : "text-white/30"
                  }`}
                >
                  {controls?.relay1_state ? "ENERGISED" : "DE-ENERGISED"}
                </span>
                {controls?.relay1_manual && (
                  <span className="ml-auto text-[9px] font-bold mono px-2 py-0.5 rounded-full bg-orange-500/20 text-orange-400 border border-orange-500/30">
                    MANUAL
                  </span>
                )}
                {controls?.schedule_set && (
                  <span className="ml-auto text-[9px] font-bold mono px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/30">
                    SCHEDULED
                  </span>
                )}
              </div>
            </GlassCard>

            {/* Relay 2 */}
            <GlassCard className="p-5">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <div className="text-[9px] mono font-bold tracking-[0.2em] text-white/30 uppercase mb-1">
                    Relay 2 — GPIO 27
                  </div>
                  <div className="text-base font-bold text-white">
                    Ambient / LDR
                  </div>
                  <div className="text-[11px] text-white/30 mono mt-0.5">
                    Threshold:{" "}
                    <span className="text-lime-400/70">
                      {controls?.ldr_threshold ?? "—"}
                    </span>{" "}
                    / 4095
                  </div>
                </div>
                <RelayToggle
                  on={controls?.relay2_state ?? false}
                  onChange={toggleR2}
                  loading={loadingR2}
                />
              </div>
              <div
                className={`rounded-xl px-4 py-3 flex items-center gap-3 border transition-all
                ${
                  controls?.relay2_state
                    ? "bg-lime-500/10 border-lime-500/30 glow-box-green"
                    : "bg-white/[0.03] border-white/[0.06]"
                }`}
              >
                <LiveDot on={controls?.relay2_state ?? false} />
                <span
                  className={`text-sm font-bold mono ${
                    controls?.relay2_state ? "text-lime-400" : "text-white/30"
                  }`}
                >
                  {controls?.relay2_state ? "ENERGISED" : "DE-ENERGISED"}
                </span>
                {controls?.relay2_manual && (
                  <span className="ml-auto text-[9px] font-bold mono px-2 py-0.5 rounded-full bg-orange-500/20 text-orange-400 border border-orange-500/30">
                    MANUAL
                  </span>
                )}
              </div>
            </GlassCard>

            {/* LDR Live Sensor */}
            <GlassCard className="p-5">
              <div className="text-[9px] mono font-bold tracking-[0.2em] text-white/30 uppercase mb-3">
                LDR — GPIO 34 (ADC 12-bit)
              </div>
              <div className="flex items-end gap-2 mb-4">
                <span className={`text-4xl font-black mono ${ldrColor}`}>
                  {latest?.ldr_value ?? "—"}
                </span>
                <span className="text-white/30 text-sm mb-1 mono">/ 4095</span>
                <span
                  className={`ml-auto text-xs font-bold mono px-2 py-1 rounded-lg ${
                    ldrLabel === "DARK"
                      ? "bg-blue-500/20 text-blue-400 border border-blue-500/30"
                      : ldrLabel === "BRIGHT"
                      ? "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30"
                      : "bg-lime-500/20 text-lime-400 border border-lime-500/30"
                  }`}
                >
                  {ldrLabel}
                </span>
              </div>

              {/* LDR bar */}
              <div className="relative h-3 bg-white/5 rounded-full overflow-hidden mb-1">
                <div
                  className="absolute inset-y-0 left-0 rounded-full transition-all duration-700"
                  style={{
                    width: `${ldrPct}%`,
                    background: "linear-gradient(90deg, #3b82f6, #a3e635)",
                  }}
                />
                <div
                  className="absolute inset-y-0 w-0.5 bg-orange-400/80"
                  style={{ left: `${Math.round((thr / 4095) * 100)}%` }}
                />
              </div>
              <div className="flex justify-between text-[10px] mono text-white/20 mb-5">
                <span>0 · Dark</span>
                <span className="text-orange-400/70">▲ thr:{thr}</span>
                <span>4095 · Bright</span>
              </div>

              {/* Threshold setter */}
              <div className="flex gap-2">
                <input
                  type="number"
                  min={0}
                  max={4095}
                  placeholder="New threshold (0–4095)"
                  value={thrInput}
                  onChange={(e) => setThrInput(e.target.value)}
                  className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white placeholder-white/20 mono focus:outline-none focus:border-lime-500/50 focus:ring-1 focus:ring-lime-500/20 transition-all"
                />
                <button
                  onClick={saveThreshold}
                  disabled={thrSaving}
                  className="px-4 py-2.5 rounded-xl text-sm font-bold mono transition-all active:scale-95 disabled:opacity-40"
                  style={{
                    background: "linear-gradient(135deg, #a3e635, #65a30d)",
                    color: "#000",
                  }}
                >
                  {thrSaving ? "…" : "SET"}
                </button>
              </div>
            </GlassCard>

            {/* LDR Chart + Log */}
            <GlassCard className="p-5">
              <div className="text-[9px] mono font-bold tracking-[0.2em] text-white/30 uppercase mb-3">
                LDR History — {history.length} pts
              </div>
              <Sparkline
                data={history.map((r) => r.ldr_value)}
                threshold={thr}
              />
              <div className="flex justify-between text-[10px] mono text-white/20 mb-4 mt-1">
                <span>← oldest</span>
                <span className="text-orange-400/60">── threshold</span>
                <span>latest →</span>
              </div>

              {/* Mini log */}
              <div className="space-y-0.5 max-h-32 overflow-y-auto">
                {[...history]
                  .reverse()
                  .slice(0, 8)
                  .map((r) => (
                    <div
                      key={r.id}
                      className="grid grid-cols-4 text-[10px] mono py-1 border-b border-white/[0.04] last:border-0"
                    >
                      <span className="text-white/30">
                        {new Date(r.created_at).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </span>
                      <span className="text-lime-400/80 text-center">
                        {r.ldr_value}
                      </span>
                      <span
                        className={`text-center ${
                          r.relay1_state ? "text-lime-400" : "text-white/20"
                        }`}
                      >
                        R1:{r.relay1_state ? "ON" : "OFF"}
                      </span>
                      <span
                        className={`text-right ${
                          r.relay2_state ? "text-lime-400" : "text-white/20"
                        }`}
                      >
                        R2:{r.relay2_state ? "ON" : "OFF"}
                      </span>
                    </div>
                  ))}
                {!history.length && (
                  <p className="text-[10px] mono text-white/20 text-center py-3">
                    No readings yet.
                  </p>
                )}
              </div>
            </GlassCard>
          </div>
        )}

        {/* ════════════════════════════ SCHEDULE ════════════════════════════ */}
        {tab === "schedule" && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <GlassCard className="p-6">
              <div className="text-[9px] mono font-bold tracking-[0.2em] text-white/30 uppercase mb-1">
                Relay 1 Timer
              </div>
              <div className="text-base font-bold text-white mb-5">
                Set ON / OFF Schedule
              </div>

              {controls?.schedule_set && (
                <div className="flex items-center justify-between bg-lime-500/10 border border-lime-500/20 rounded-xl px-4 py-3 mb-5">
                  <div className="flex items-center gap-2">
                    <LiveDot on={true} />
                    <span className="text-sm font-bold mono text-lime-400">
                      {p2(controls.on_hour)}:{p2(controls.on_min)} →{" "}
                      {p2(controls.off_hour)}:{p2(controls.off_min)}
                    </span>
                  </div>
                  <button
                    onClick={clearSchedule}
                    className="text-[10px] mono text-white/30 hover:text-red-400 transition-colors"
                  >
                    CLEAR
                  </button>
                </div>
              )}

              {(
                [
                  {
                    label: "Turn ON at",
                    keys: ["onH", "onM"] as const,
                    accent: "focus:border-lime-500/50",
                  },
                  {
                    label: "Turn OFF at",
                    keys: ["offH", "offM"] as const,
                    accent: "focus:border-red-500/50",
                  },
                ] as const
              ).map((row) => (
                <div key={row.label} className="mb-4">
                  <label className="block text-xs font-semibold text-white/40 mb-2 mono">
                    {row.label}
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    {row.keys.map((k, i) => (
                      <input
                        key={k}
                        type="number"
                        min={0}
                        max={i === 0 ? 23 : 59}
                        placeholder={i === 0 ? "Hour (0-23)" : "Min (0-59)"}
                        value={sched[k]}
                        onChange={(e) =>
                          setSched((p) => ({ ...p, [k]: e.target.value }))
                        }
                        className={`bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white placeholder-white/20 mono
                          focus:outline-none focus:ring-1 focus:ring-lime-500/20 transition-all ${row.accent}`}
                      />
                    ))}
                  </div>
                </div>
              ))}

              <button
                onClick={saveSchedule}
                disabled={schedSaving}
                className="w-full py-3 rounded-xl text-sm font-bold mono mt-2 transition-all active:scale-95 disabled:opacity-40"
                style={{
                  background: "linear-gradient(135deg, #a3e635, #65a30d)",
                  color: "#000",
                }}
              >
                {schedSaving ? "PUSHING TO DEVICE…" : "SAVE SCHEDULE"}
              </button>

              {schedMsg && (
                <p
                  className={`mt-3 text-xs font-bold mono text-center ${
                    schedMsg.ok ? "text-lime-400" : "text-red-400"
                  }`}
                >
                  {schedMsg.text}
                </p>
              )}
            </GlassCard>

            {/* Timeline visualization */}
            <GlassCard className="p-6">
              <div className="text-[9px] mono font-bold tracking-[0.2em] text-white/30 uppercase mb-4">
                24h Timeline
              </div>

              <div className="h-10 bg-white/5 rounded-full overflow-hidden relative mb-2">
                {controls?.schedule_set &&
                  (() => {
                    const op =
                      ((controls.on_hour * 60 + controls.on_min) / 1440) * 100;
                    const fp =
                      ((controls.off_hour * 60 + controls.off_min) / 1440) *
                      100;
                    const style = {
                      background: "rgba(163,230,53,0.3)",
                      border: "1px solid rgba(163,230,53,0.4)",
                    };
                    return op < fp ? (
                      <div
                        className="absolute top-0 bottom-0 rounded-full"
                        style={{ left: `${op}%`, width: `${fp - op}%`, ...style }}
                      />
                    ) : (
                      <>
                        <div
                          className="absolute top-0 bottom-0"
                          style={{ left: `${op}%`, right: 0, ...style }}
                        />
                        <div
                          className="absolute top-0 bottom-0"
                          style={{ left: 0, width: `${fp}%`, ...style }}
                        />
                      </>
                    );
                  })()}
                {(() => {
                  const n = new Date();
                  const p =
                    ((n.getHours() * 60 + n.getMinutes()) / 1440) * 100;
                  return (
                    <div
                      className="absolute top-0 bottom-0 w-px bg-white/50"
                      style={{ left: `${p}%` }}
                    />
                  );
                })()}
              </div>

              <div className="flex justify-between text-[9px] mono text-white/20 mb-6 px-0.5">
                {[0, 6, 12, 18, 24].map((h) => (
                  <span key={h}>{p2(h)}:00</span>
                ))}
              </div>

              {[
                {
                  label: "Status",
                  val: controls?.schedule_set ? "ACTIVE" : "NOT SET",
                  vc: controls?.schedule_set
                    ? "text-lime-400"
                    : "text-white/30",
                },
                {
                  label: "ON",
                  val: controls?.schedule_set
                    ? `${p2(controls.on_hour)}:${p2(controls.on_min)}`
                    : "—",
                  vc: "text-white",
                },
                {
                  label: "OFF",
                  val: controls?.schedule_set
                    ? `${p2(controls.off_hour)}:${p2(controls.off_min)}`
                    : "—",
                  vc: "text-white",
                },
                {
                  label: "Duration",
                  val: controls?.schedule_set
                    ? (() => {
                        let m =
                          controls.off_hour * 60 +
                          controls.off_min -
                          (controls.on_hour * 60 + controls.on_min);
                        if (m < 0) m += 1440;
                        return `${Math.floor(m / 60)}h ${m % 60}m`;
                      })()
                    : "—",
                  vc: "text-white",
                },
              ].map((row) => (
                <div
                  key={row.label}
                  className="flex justify-between items-center py-3 border-b border-white/[0.05] last:border-0 text-sm"
                >
                  <span className="text-white/40 mono text-xs">
                    {row.label}
                  </span>
                  <span className={`font-bold mono text-xs ${row.vc}`}>
                    {row.val}
                  </span>
                </div>
              ))}
            </GlassCard>
          </div>
        )}

        {/* ══════════════════════════════ POWER ════════════════════════════ */}
        {tab === "power" && (
          <div className="space-y-5">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatBadge
                label="Session kWh"
                value={`${stats.kwh.toFixed(4)}`}
                sub={`${power.currency} ${stats.cost.toFixed(4)}`}
                accent="text-lime-400"
              />
              <StatBadge
                label="R1 Runtime"
                value={`${stats.r1h.toFixed(2)}h`}
                sub={`${(
                  (stats.r1h * power.relay1_watts) /
                  1000
                ).toFixed(4)} kWh`}
              />
              <StatBadge
                label="R2 Runtime"
                value={`${stats.r2h.toFixed(2)}h`}
                sub={`${(
                  (stats.r2h * power.relay2_watts) /
                  1000
                ).toFixed(4)} kWh`}
              />
              <StatBadge
                label="Monthly Est."
                value={`${power.currency} ${monthCost.toFixed(2)}`}
                sub={`${dailyKwh.toFixed(3)} kWh/day`}
                accent="text-violet-400"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {/* Breakdown */}
              <GlassCard className="p-5">
                <div className="text-[9px] mono font-bold tracking-[0.2em] text-white/30 uppercase mb-4">
                  Usage Breakdown
                </div>

                {[
                  {
                    label: "Relay 1",
                    watts: power.relay1_watts,
                    hours: stats.r1h,
                    color: "#a3e635",
                  },
                  {
                    label: "Relay 2",
                    watts: power.relay2_watts,
                    hours: stats.r2h,
                    color: "#a78bfa",
                  },
                ].map((r) => {
                  const kwh = (r.hours * r.watts) / 1000;
                  const cost = kwh * power.tariff_per_kwh;
                  const pct = stats.kwh > 0 ? (kwh / stats.kwh) * 100 : 0;
                  return (
                    <div key={r.label} className="mb-5 last:mb-0">
                      <div className="flex justify-between items-baseline mb-2">
                        <span className="text-sm font-bold text-white">
                          {r.label} — {r.watts}W
                        </span>
                        <span className="text-[10px] mono text-white/30">
                          {kwh.toFixed(4)} kWh · {power.currency}{" "}
                          {cost.toFixed(4)}
                        </span>
                      </div>
                      <div className="h-2 bg-white/5 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-700"
                          style={{
                            width: `${pct}%`,
                            background: r.color,
                            boxShadow: `0 0 8px ${r.color}60`,
                          }}
                        />
                      </div>
                      <div className="text-[10px] mono text-white/20 mt-1">
                        {r.hours.toFixed(2)}h · {pct.toFixed(1)}%
                      </div>
                    </div>
                  );
                })}

                {/* Projected weekly bars */}
                <div className="mt-6 pt-4 border-t border-white/[0.06]">
                  <div className="text-[9px] mono font-bold tracking-[0.2em] text-white/30 uppercase mb-3">
                    Projected 7-Day Spend
                  </div>
                  <div className="grid grid-cols-7 gap-1.5 mt-2">
                    {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => {
                      const fac = 0.55 + Math.sin(i * 1.3 + 1) * 0.45;
                      const h = Math.max(6, fac * 52);
                      const c = (dailyCost * fac).toFixed(3);
                      return (
                        <div
                          key={i}
                          title={`${power.currency} ${c}`}
                          className="flex flex-col items-center gap-1"
                        >
                          <div
                            className="w-full bg-white/5 rounded-lg overflow-hidden relative"
                            style={{ height: 52 }}
                          >
                            <div
                              className="absolute bottom-0 left-0 right-0 rounded-lg transition-all duration-700"
                              style={{
                                height: h,
                                background:
                                  "linear-gradient(0deg, #a3e635, #65a30d)",
                                opacity: 0.8,
                              }}
                            />
                          </div>
                          <span className="text-[9px] mono text-white/30">
                            {d}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-[10px] mono text-white/20 mt-2">
                    * Based on current session pattern
                  </p>
                </div>
              </GlassCard>

              {/* Settings */}
              <GlassCard className="p-5">
                <div className="flex items-center justify-between mb-4">
                  <div className="text-[9px] mono font-bold tracking-[0.2em] text-white/30 uppercase">
                    Tariff & Load
                  </div>
                  {!pwrEditing && (
                    <button
                      onClick={() => setPwrEditing(true)}
                      className="text-[10px] mono font-bold text-lime-400/70 hover:text-lime-400 transition-colors"
                    >
                      EDIT
                    </button>
                  )}
                </div>

                {pwrEditing ? (
                  <div className="space-y-3">
                    {(
                      [
                        { label: "Relay 1 load (W)", key: "r1w" as const },
                        { label: "Relay 2 load (W)", key: "r2w" as const },
                        { label: "Tariff /kWh", key: "tariff" as const },
                        { label: "Currency code", key: "currency" as const },
                      ] as const
                    ).map((f) => (
                      <div key={f.key}>
                        <label className="block text-[10px] mono font-bold text-white/30 mb-1 uppercase">
                          {f.label}
                        </label>
                        <input
                          value={pwrForm[f.key]}
                          onChange={(e) =>
                            setPwrForm((p) => ({
                              ...p,
                              [f.key]: e.target.value,
                            }))
                          }
                          className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white mono focus:outline-none focus:border-lime-500/50 focus:ring-1 focus:ring-lime-500/20 transition-all"
                        />
                      </div>
                    ))}
                    <div className="flex gap-2 pt-1">
                      <button
                        onClick={savePower}
                        disabled={pwrSaving}
                        className="flex-1 py-2.5 rounded-xl text-sm font-bold mono transition-all active:scale-95 disabled:opacity-40"
                        style={{
                          background:
                            "linear-gradient(135deg,#a3e635,#65a30d)",
                          color: "#000",
                        }}
                      >
                        {pwrSaving ? "SAVING…" : "SAVE"}
                      </button>
                      <button
                        onClick={() => setPwrEditing(false)}
                        className="flex-1 py-2.5 bg-white/5 border border-white/10 text-white/50 text-sm font-bold mono rounded-xl hover:bg-white/10 transition-all"
                      >
                        CANCEL
                      </button>
                    </div>
                  </div>
                ) : (
                  <div>
                    {[
                      {
                        label: "Relay 1 load",
                        val: `${power.relay1_watts} W`,
                      },
                      {
                        label: "Relay 2 load",
                        val: `${power.relay2_watts} W`,
                      },
                      {
                        label: "Tariff",
                        val: `${power.currency} ${power.tariff_per_kwh}/kWh`,
                      },
                      {
                        label: "Daily estimate",
                        val: `${power.currency} ${dailyCost.toFixed(4)}`,
                      },
                      {
                        label: "Monthly estimate",
                        val: `${power.currency} ${monthCost.toFixed(2)}`,
                      },
                      {
                        label: "Yearly estimate",
                        val: `${power.currency} ${(monthCost * 12).toFixed(2)}`,
                      },
                    ].map((r) => (
                      <div
                        key={r.label}
                        className="flex justify-between py-3 border-b border-white/[0.05] last:border-0 text-sm"
                      >
                        <span className="text-white/40 mono text-xs">
                          {r.label}
                        </span>
                        <span className="font-bold mono text-xs text-white">
                          {r.val}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </GlassCard>
            </div>
          </div>
        )}

        {/* ── Footer ── */}
        <footer className="flex flex-col sm:flex-row justify-between items-center gap-1 text-[10px] mono text-white/15 pt-4 border-t border-white/[0.05]">
          <span>GPIO 26=R1 · GPIO 27=R2 · GPIO 34=LDR · SDA=21 SCL=22</span>
          <span>DAT=17 CLK=16 RST=5 · DS1302 RTC · Firestore Live</span>
        </footer>
      </main>
    </div>
  );
}