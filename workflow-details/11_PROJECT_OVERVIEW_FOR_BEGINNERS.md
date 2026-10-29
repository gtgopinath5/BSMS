# 11 — Project Overview for Beginners

> Written so a 15-year-old can follow it. No assumed knowledge.
> Want more detail later? Every section links to a deeper document.

---

## What is this project?

**Baywatch Service OS** is software for a **bike service centre** (the workshop where
you drop off your motorbike for repairs). It keeps track of:

* every bike that comes in for repair,
* which mechanic is working on it and in which work spot ("bay"),
* a countdown timer for how long the repair should take,
* a **live video** of the repair, and a saved recording afterward,
* and it keeps the customer updated the whole time.

Think of it like the screen at a pizza shop that shows "Your order: being prepared →
baking → out for delivery" — but for fixing motorbikes, with a real video.

## Who uses it? (four kinds of people)

| Person | What they do |
|---|---|
| **Master Admin** | The boss of all branches. Sees every location, creates branches and admins, watches everything. |
| **Admin** | Runs one branch. Takes in jobs, assigns mechanics, presses Start/Pause/Complete, manages cameras and timers. |
| **Worker** (mechanic) | Sees their own current job, the countdown, and the job details. They *watch* — they don't press the buttons. |
| **Customer** | The bike owner. Watches their repair live on their phone, gets messages, and later watches the saved video. |

Each person logs in and gets their **own screen** ("portal"). A worker can never see
the admin's screen — the login decides what you're allowed to see. More detail:
[02_FRONTEND_WORKFLOW.md](02_FRONTEND_WORKFLOW.md).

## How does a repair actually flow? (the story)

```
1. Your bike arrives.
   The admin types in your details — or uploads the paper job-card PDF and the
   computer reads it automatically (name, bike model, what's wrong).

2. The computer estimates how long it'll take
   by matching the work to a price/time list ("Parts Time").

3. The admin assigns your bike to a mechanic and a work-bay (Bay 3, say).

4. The admin presses START. Now everything happens at once:
   • a countdown timer starts (e.g. 45:00 counting down),
   • the bay's camera starts recording,
   • a physical timer screen on the bay lights up,
   • you (the customer) get a text: "Your service has started."

5. You open your phone and WATCH your bike being repaired, live.

6. If the mechanic stops for a break, the admin presses PAUSE (timer freezes,
   recording pauses). RESUME continues it.

7. When it's done, the admin presses COMPLETE:
   • the timer stops and the final time is saved,
   • the video clips are joined into one saved recording,
   • the bay is freed for the next bike,
   • you get a text: "Your service is complete — report & recording are available."

8. You can download a PDF report and watch the full recording for 14 days.
   After 14 days the recording is automatically deleted.
```

The full version with every step: [03_COMPLETE_WORKFLOW_ENGINE.md](03_COMPLETE_WORKFLOW_ENGINE.md).

## How do the cameras work?

* Each bay has an **IP camera** (a network camera) pointed at the work area.
* The camera sends video using a format called **RTSP** (think of it as a video pipe
  on the local network).
* The backend uses a tool called **FFmpeg** to grab that video pipe and save it to the
  computer's hard drive (SSD) while recording.
* For *live* watching, it also makes a browser-friendly version (**HLS**) protected by
  a secret link so only the right people can watch.
* Important: the customer never gets the camera's real address — only a safe, temporary
  link. Details: [09_EXTERNAL_DEVICE_INTEGRATION.md](09_EXTERNAL_DEVICE_INTEGRATION.md).

## How do the timers work?

There are **two** timers that always show the same number:

1. **The software timer** — the real one, kept by the backend. It stores the *start
   time* and does the maths "now minus start = elapsed", so even if the computer
   restarts, it recalculates correctly and never loses track.
2. **The physical timer** — a small **ESP32** gadget with a glowing display on the
   bay. It does **not** do any maths; the backend sends it the number every second
   over **MQTT** (a tiny messaging system). The screen just shows what it's told.

The display changes colour: **green** (plenty of time) → **orange** (getting close) →
**red** (almost out / over time). Deep dive: [01 §6 Timer Architecture](01_SYSTEM_ARCHITECTURE.md#6-timer-architecture).

## How do recordings work?

* While recording, video is saved in small chunks (so a pause never corrupts it).
* At COMPLETE, the chunks are joined into one `video.mp4` file.
* The recording is private: only the admin/master, the mechanic who did the job, and
  the bike's owner can watch it — checked by the login.
* Later, the file is copied to **Google Drive** for safe long-term storage, and the
  copy on the local drive is deleted **only after** Google Drive confirms it has the
  exact same file.
* After **14 days** everything (Drive + local) is deleted automatically, and any old
  link politely says *"This recording has expired"* instead of breaking.

Storage details: [04_STORAGE_AND_DATA_FLOW.md](04_STORAGE_AND_DATA_FLOW.md).

## How do PDFs work?

Two places use PDFs:

1. **Reading a PDF (input):** when a bike arrives, the admin can upload the paper
   job-card as a PDF. The computer reads the text and pulls out the customer name,
   bike model, and the list of problems — so the admin doesn't retype it.
2. **Making a PDF (output):** when the job is done, the system creates a **Completion
   Report** PDF (job summary + the recording info + the 14-day-expiry notice) that the
   customer can download.

## How do databases work (here)?

A **database** is just a very organised set of tables, like a spreadsheet with strict
rules. This project uses **PostgreSQL**. Examples of tables:

* `users` — everyone who can log in.
* `job_cards` — one row per bike repair job.
* `service_sessions` — one row per actual repair happening in a bay.
* `recording_sessions` — info about each saved video.

When the admin presses START, the system *updates rows* in these tables (the job's
session becomes "running"). When something important happens, it's also written to an
`audit_logs` table so there's a permanent history of who did what. All 17 tables:
[05_DATABASE_DOCUMENTATION.md](05_DATABASE_DOCUMENTATION.md).

## The two halves of the app

```
   What you see (Frontend)                 The brain (Backend)
   ──────────────────────                  ───────────────────
   A web page made with React        ⇄     A Python program (FastAPI)
   Runs in your browser (port 7890)        Runs on a server (port 8000)
   Shows buttons, timers, video            Does all the real work + remembers
                                           everything in the database
```

They talk over the internet using small JSON messages. The frontend never touches the
database directly — it always asks the backend politely, and the backend checks "are
you allowed to do this?" first. Architecture: [01_SYSTEM_ARCHITECTURE.md](01_SYSTEM_ARCHITECTURE.md).

## A few words you'll keep seeing

| Word | Plain meaning |
|---|---|
| **API** | The list of requests the frontend can make to the backend ("get my jobs", "start bay 3"). |
| **JWT / token** | A secure digital wristband you get when you log in; it proves who you are on every request. |
| **Bay** | A work spot in the garage where one bike is serviced. |
| **Session** | One bike's repair happening in a bay, from start to complete. |
| **RTSP** | The camera's live-video pipe on the network. |
| **HLS** | A browser-friendly way to watch live video. |
| **MQTT** | A tiny messaging system the backend uses to talk to the physical timer. |
| **FFmpeg** | The tool that records and converts video. |
| **Redis** | Super-fast temporary memory; here it holds the running timers. |
| **Google Drive** | Where finished recordings are stored long-term. |

## Why is it built this way? (the clever bits)

* **One brain, one truth.** The backend decides everything; screens and devices just
  show what it says. That's why the wall timer and the on-screen timer can never
  disagree.
* **Nothing breaks the repair.** If a camera, the internet, the video tool, or the
  messaging system fails, the **job keeps going** — those parts are optional helpers,
  not blockers.
* **Privacy first.** Customers see only their own bike; nobody gets the camera's real
  address; recordings auto-delete after 14 days.

## Want to go deeper?

* The whole picture → [01_SYSTEM_ARCHITECTURE.md](01_SYSTEM_ARCHITECTURE.md)
* Every screen and button → [02_FRONTEND_WORKFLOW.md](02_FRONTEND_WORKFLOW.md)
* Every step of a repair → [03_COMPLETE_WORKFLOW_ENGINE.md](03_COMPLETE_WORKFLOW_ENGINE.md)
* How to run it yourself → [10_DEVELOPER_GUIDE.md](10_DEVELOPER_GUIDE.md)
