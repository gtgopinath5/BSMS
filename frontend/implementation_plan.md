# Job Assignment & Queue Workflow Redesign

This document details the implementation plan to redesign the "Job Assignment & Queue" page, creating an enterprise-grade workshop workflow engine with a highly optimized Triumph/Bajaj Job Card PDF Extraction.

## User Review Required

> [!IMPORTANT]
> The PDF Extraction review screen will be implemented as a read-only "Pending Review" stage as suggested. You must click "Save to Queue" after reviewing the extracted details. The UI will use premium styling with a glassmorphism effect.

## Open Questions

> [!WARNING]
> 1. Should the Service Mapping Engine's mappings (e.g., 'Oil Replace' -> 'Engine Oil Service') be hardcoded in the frontend, or do you have a specific backend API endpoint/data structure where these will be stored? I'll hardcode a robust initial list if not specified.
> 2. For the Live Bay Dashboard buttons (Start, Pause, Resume, Complete), I will implement the UI and state updates. Are there any actual APIs or hardware integration logic (like Camera Recording triggers) that need to be mocked out or called?

## Proposed Changes

We will modify the frontend React features (`jobintake.jsx` and `queue.jsx`) to fulfill the requirements.

### Frontend Application Layer

#### [MODIFY] [jobintake.jsx](file:///Users/gopinathgt/bsms/frontend/features/jobintake.jsx)
- **Top Section Cards:** Replace the current method selection with two large, professional cards for "Manual Job Card" and "PDF Job Card Extraction" (supporting PDF uploads only for the extraction route).
- **PDF Extraction Engine:**
  - Enhance the validation function (`validateJobCard`) to strictly check for exactly the required Triumph/Bajaj keywords: `JOB CARD`, `Customer Name`, `Chassis No`, `Engine No`, `Technician Name`, `SA Name`, `Repair Type`, `Customer Voice`. If validation fails, halt immediately and show the specific "Invalid Job Card" message.
  - Implement strict field extraction using standard regex tailored to the Triumph/Bajaj format for the sections: Job Card, Vehicle, Customer, Service, Staff, and Customer Voice.
- **Service Mapping Engine:**
  - Create a mapping utility that scans the "Customer Voice" and "Repair Type" to map text (e.g., "Chain Spray", "Brake Check") to standard Service Descriptions and Parts.
- **Parts & Time Matching:**
  - Update the matching logic to prioritize: Product Code -> Product Name -> Service Mapping Match.
  - Automatically calculate total estimated time (no manual entry).
- **Pending Review Screen:**
  - Introduce a premium, glassmorphism-styled review screen with the 6 required sections (Vehicle, Customer, Service, Staff, Customer Voice, Parts & Time Analysis).
  - Add a Summary Card (Matched/Unmatched Parts, Est. Time, Job Status) and a "Save to Queue" button.

#### [MODIFY] [queue.jsx](file:///Users/gopinathgt/bsms/frontend/features/queue.jsx)
- **Job Queue Redesign:**
  - Refine `UnifiedJobQueue` to use a robust, perfectly aligned table structure within worker-wise expandable sections. Ensure the layout handles scrolling gracefully without breaking the layout.
  - Ensure the table columns display: Customer Name, Vehicle Number, Job Card Number, Service Type, Estimated Time, Queue Position, Created Time, and Status.
- **Queue Actions:**
  - Ensure "View Details" opens a side drawer with all 6 sections extracted from the PDF.
  - Implement robust "Move Up" and "Move Down" functions to instantly update queue positions.
  - Implement "Change Worker" functionality.
- **Assign Workflow:**
  - Ensure the "Assign" button acts as the definitive action to send a job to execution. It will validate worker, bay, and estimated time, and transition the job status from `queued` to `assigned` (moving it to the Live Bay Dashboard).

#### [MODIFY] [baymgmt.jsx](file:///Users/gopinathgt/bsms/frontend/features/baymgmt.jsx) (or new live bay component)
- **Live Bay Dashboard:**
  - Update the Live Bay Dashboard to display jobs that are in the `assigned` state.
  - Add standard operation buttons: `Start`, `Pause`, `Resume`, `Complete`.
  - When `Start` is clicked, trigger a mock `JOB_STARTED` event that starts the timer.

## Verification Plan

### Manual Verification
- Upload a sample Triumph/Bajaj job card PDF. Verify it strictly validates keywords and fails gracefully if it's an incorrect format.
- Verify that data extraction accurately grabs the text and parses the 6 sections.
- Ensure the Service Mapping correctly maps items like "Chain Spray" to "Chain Maintenance" and assigns time automatically.
- Check the Premium Review Screen for visual quality.
- Verify adding a job to the Queue creates a table row under the chosen worker.
- Click a queue item and verify the right-side drawer displays all details correctly.
- Test "Move Up", "Move Down", "Change Worker", and "Assign" button interactions.
- Ensure the Job correctly transitions to the Live Bay Dashboard and the "Start" action starts the bay timer.
