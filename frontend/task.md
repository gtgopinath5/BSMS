# Tasks for Job Assignment & Queue Workflow

- `[x]` **CSS Redesign:** Add styling to `frontend/css/admin.css` or `styles.css` for the new premium glassmorphism review screen and the worker queue table layout. Include scrollable containers to fix the reported scrolling issues.
- `[x]` **`jobintake.jsx` Updates:**
  - `[x]` Create Top Section Cards (Manual vs PDF Extraction).
  - `[x]` Update `validateJobCard` to strictly check for Triumph/Bajaj keywords.
  - `[x]` Update `parseJobCard` to parse the 6 sections exactly as requested.
  - `[x]` Build the **Service Mapping Engine** to map words like "Oil Replace" to "Engine Oil Service".
  - `[x]` Build the Premium Review Screen with glassmorphism UI showing all 6 sections + Parts Analysis.
- `[x]` **`queue.jsx` Updates:**
  - `[x]` Redesign `UnifiedJobQueue` (or equivalent) to have a highly scrollable and aligned table structure per worker.
  - `[x]` Ensure worker queue expansion works and shows the tabular layout.
  - `[x]` Implement "View Details" right-side drawer showing all extracted details.
  - `[x]` Ensure Move Up/Move Down/Change Worker buttons are robust.
  - `[x]` Implement the definitive `Assign` action that validates rules and changes state to `assigned`.
- `[ ]` **`baymgmt.jsx` Updates:**
  - `[ ]` Display `assigned` jobs.
  - `[ ]` Add `Start`, `Pause`, `Resume`, `Complete` buttons.
  - `[ ]` Map `Start` to a fake `JOB_STARTED` event that kicks off the bay timer.
