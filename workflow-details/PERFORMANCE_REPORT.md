# PERFORMANCE_REPORT — Phase 11

> Measured, not estimated. Numbers come from `.verify/bw_hardening.py` "PHASE 11",
> which creates real bays via the API, samples the hot fleet endpoint, and writes
> [`.verify/reports/perf.json`](../.verify/reports/perf.json). Honest about what was
> instrumented in this pass vs. what is bounded by design.
>
> **Environment:** dev host (Apple Silicon, macOS), backend uvicorn, **PostgreSQL 16**,
> **Redis** (persistent), **MQTT** broker live, FFmpeg present. Single local client,
> `GET /api/v1/bays/operations` (the batched fleet call that does the most per-bay work).

## Headline: fleet endpoint vs. bay count

| Bays | p50 latency | min | max | payload |
|----:|----:|----:|----:|----:|
| 10  | **5.3 ms** | 5.0 | 5.6 | 4.3 KB |
| 25  | **5.8 ms** | 5.7 | 6.2 | 9.7 KB |
| 50  | **6.8 ms** | 6.7 | 7.1 | 18.8 KB |
| 100 | **8.9 ms** | 8.3 | 9.5 | 36.9 KB |

```
p50 ms   ^
   9 |                                   ● 100
   8 |
   7 |                     ● 50
   6 |        ● 25
   5 |  ● 10
     +------------------------------------------>  bays
```

**Reading it:** latency grows ~linearly and stays **single-digit milliseconds at
100 bays** — a 10× fleet costs ~1.7× latency. Payload scales linearly (~0.37 KB/bay).
The endpoint batches all per-bay work (worker resolution, camera/timer/ESP32/MQTT
status, current job, today's count, attention flag) into one call, so the client makes
**one** request regardless of fleet size — the basis for the Fleet View's 3 s poll.

This is the back-end half of the scaling story; the **front-end** half (windowed
virtualization that renders only ~25 DOM rows of 100) was proven separately in
`.verify/verify_ui.js` (the 52-bay test). Together they make 100 bays a non-event.

## Metric-by-metric

| Requested metric | Result | How |
|---|---|---|
| **API response** | 5.3–8.9 ms p50 (10→100 bays) | measured, table above |
| **Page load** | one batched `operations` call + windowed render (~25 rows) | back end measured here; render proven in `verify_ui.js` |
| **MQTT latency** | ≤ 1 s by design — the publisher pushes every active timer state on a **1 s** tick (retained), and on reconnect immediately | `mqtt_service._publish_loop` (`sleep(1)`) |
| **Timer drift** | **0** — timestamp-anchored; remaining is recomputed from absolute `start_time`, not decremented | proven in the restart test (elapsed/remaining exact after a cold process boot) |
| **Recording startup** | START returns immediately; FFmpeg spawns async, RTSP watchdog at 2 s | `recording_service.start` is non-blocking (`_spawn_segment` + daemon guard) |
| **Memory usage** | bounded: in-memory state is only active timers (Redis-backed) + live ffmpeg handles; no per-bay polling threads | not separately profiled this pass — see "not instrumented" |
| **Database queries** | `operations` is a small fixed set of batched selects; no N+1 explosion observed (flat latency curve) | inferred from the linear curve; not query-counted this pass |

## What is bounded by design (not a benchmark, but safe to reason about)

- **Timer accuracy is independent of load and uptime.** Because every read recomputes
  from `time.time() - start_time - accumulated_pause`, neither a busy server nor a
  restart introduces drift. The Phase 7 restart test is the proof: after a cold boot
  the recovered timer read `elapsed=2s, remaining=1798s` exactly.
- **MQTT cost is O(active timers), once per second**, not O(bays). An idle 100-bay
  fleet publishes nothing; only running bays tick.
- **Recording cost is O(active recordings)** — one FFmpeg child per *running* job, not
  per bay. Codec-copy for real RTSP (no transcode) keeps CPU low.

## Honest "not instrumented this pass"

| Gap | Why | How to close |
|---|---|---|
| Concurrent-client load (e.g. 50 admins polling) | single-client measurement only | `wrk`/`locust` against `/bays/operations`; the endpoint is read-only + cacheable |
| Exact DB query count per request | not query-logged | enable SQLAlchemy `echo` or `pg_stat_statements` under load |
| Process RSS at 100 bays under live jobs | needs sustained live recordings | `psutil` sampling during a soak test |
| Real-camera recording startup latency | dev uses the synthetic source | measure on the target NVR/RTSP hardware |

These are load-test/instrumentation tasks, not code changes — the architecture
(batched endpoint, windowed UI, O(active) device work) is already shaped for scale,
and the measured curve confirms it through 100 bays.

## Verdict

At the target ceiling (the user specified up to 100 bays), the operational endpoint
serves the whole fleet in **< 10 ms** with a **< 40 KB** payload, the UI renders a
constant ~25 rows, timers are drift-free across restarts, and device/recording work is
O(active) not O(fleet). No redesign is needed to reach 100 bays; beyond that, the next
lever is a short-TTL cache on `operations` and a concurrent-client load test.
