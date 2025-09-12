# ProWorkflow Custom Status Update Integration

## Overview
This document explains the process, issues encountered, and the final solution for enabling **custom status updates** directly from the ProWorkflow dashboard.

## Architecture
- **Frontend** (`dashboard.html`):  
  - Displays project list with status badges.  
  - On badge click → opens a dropdown of available statuses (via `/api/rest/status-options`).  
  - Sends a `PUT` request to `/api/rest/project/:id/status` when a new status is chosen.

- **Backend** (`app.js`):  
  - Receives the request at `/api/rest/project/:id/status`.  
  - Proxies the call to ProWorkflow’s REST API.  
  - Clears local cache to ensure subsequent fetches reflect the latest project state.

## Initial Problem
- When attempting to update a project’s custom status:  
  - ProWorkflow returned a response like:  
    ```json
    { "message": "Project Updated", "status": "Success" }
    ```
  - However, when re-fetching the project (`/projects/:id`), the `customstatus` field remained unchanged (e.g., still `"Needs Attention"`).  
  - The dashboard badge would update optimistically but then revert after reload.

## Investigation Timeline
1. **Frontend verified**: Confirmed `fetch` call was correct.  
2. **Backend verified**: Confirmed `cache.clear()` ran after updates.  
3. **Raw logging**: Added `[DEBUG]` logs to capture the outgoing URL, payload, and ProWorkflow response.  
4. **Payload inspection**: Project detail payload included both:  
   ```json
   "customstatus": "Needs Attention",
   "customstatusid": 162
   ```
5. **Discovery**: ProWorkflow requires `customstatusid` (numeric) to persist changes, not `customstatus` (string).

## Fix Implemented
Changed backend `PUT` call from:

```js
// ❌ Did not persist
const result = await ProWorkflowAPI.makeRequest(updateUrl, 'PUT', {
  customstatus: selectedStatus.name
});
```

to:

```js
// ✅ Correct — persists status changes
const result = await ProWorkflowAPI.makeRequest(updateUrl, 'PUT', {
  customstatusid: selectedStatus.id
});
```

## Results
- Status updates now persist in ProWorkflow.  
- Dashboard badge updates immediately and remains correct after reload.  
- Reduced confusion between UI optimistic update and backend state.

## Lessons Learned
- **Field mismatch**: Always confirm whether ProWorkflow expects a string name or a numeric ID.  
- **Inspect payloads**: The project detail payload (`/projects/:id`) shows the authoritative field (`customstatusid`).  
- **Debugging approach**: Logging on both backend (`[DEBUG] Update URL`, `[DEBUG] PWF response`) and frontend (`🔍 Reloaded project data`) was crucial.

## Example Logs

**Successful update flow**:
```
[DEBUG] Updating project 33916 to status Edits Received
[DEBUG] Update URL: /projects/33916
[DEBUG] PWF response: {"message":"Project Updated","status":"Success","details":[{"id":33916}]}
✅ Cache cleared, status should update on next load

🔍 Reloaded project data: { customstatus: "Edits Received", customstatusid: 102, ... }
```

## Conclusion
After several iterations, the root cause was identified as using the wrong field (`customstatus` instead of `customstatusid`). With this fix in place, ProWorkflow custom statuses can be updated reliably from the dashboard.
