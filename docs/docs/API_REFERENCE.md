# ProWorkflow API Reference (Team 9 – Shared Services)

This document collects the most important ProWorkflow API endpoints, notes, and references for this project.  
It’s based on the ProWorkflow API Dashboard:

- [API Calls Explorer](https://api.proworkflow.net/?calls)  
- [API Dashboard](https://api.proworkflow.net/?dashboard#!)

---

## 🔑 Authentication

All calls require authentication via API key, username, and password.

- **API Key**: from ProWorkflow Client Area  
- **Username**: stored in `.env` (`PROWORKFLOW_USERNAME`)  
- **Password**: stored in `.env` (`PROWORKFLOW_PASSWORD`)  

In code, headers are set with:

```js
{
  "apikey": process.env.PROWORKFLOW_API_KEY,
  "Content-Type": "application/json",
  "Authorization": "Basic <base64(username:password)>"
}

📋 Key Endpoints for This Project
1. Get Custom Status Options
Fetch custom statuses for Team 9 (Shared Services):
GET /settings/projects/customstatuses?teamid=9

Returns array of statuses:
{
  "customstatuses": [
    { "id": 123, "name": "In Progress", "color": "00FF00" },
    { "id": 124, "name": "RUSH", "color": "FF0000" }
  ]
}


2. Get Project
Fetch a single project’s full payload (all fields required for updates):
GET /projects/{id}

Returns project object with fields like:
id, title, description, companyid, managerid, categoryid,
duedate, startdate, budget, groupid, divisionid,
customstatusid, customstatuscolor.

3. Update Project (Change Status)
PUT /projects/{id}

Body must include all fields, not just customstatusid.
Example payload:

{
  "customstatusid": 124,
  "title": "Example Project",
  "description": "Updated by API",
  "companyid": 567,
  "managerid": 1030,
  "categoryid": null,
  "duedate": "2025-09-30",
  "startdate": "2025-09-01",
  "budget": 0,
  "groupid": null,
  "divisionid": null
}

4. Get Projects List
GET /projects

Returns summary info for all projects.
Often followed by detailed GET /projects/{id} for each.

5. Get Project Messages
GET /projects/{id}/messages
Returns communication history, used in dashboard to assess “stale” projects.

📝 Notes
Caching: Status options cached for 15 min (statusOptionsCache).
RUSH: Any status with color=FF0000 should highlight the row in UI.
Error handling:
400/403/404 → Show message + rollback UI.
Network failure → rollback + toast.

📂 Related Files
Backend: app.js (/api/rest/status-options, /api/rest/project/:id/status)
Frontend: public/dashboard.html (updateProjectStatus, dropdown logic)
Config: .env holds API key, username, password

✅ Test Checklist
Load dashboard → statuses populate dropdown (GET /settings/projects/customstatuses?teamid=9).
Change project status → badge updates optimistically.
Refresh page → status persists (confirm via ProWorkflow UI).
Invalid status → rollback UI + error toast.
RUSH status (FF0000) → row highlighted amber.
