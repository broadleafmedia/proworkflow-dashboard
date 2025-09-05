# ProWorkflow Dashboard Project Summary

## Project Status: ✅ WORKING
**Last Updated**: Working dashboard with full task assignment functionality

## Critical API Discovery
After extensive debugging, we discovered the correct ProWorkflow API field mappings:

### Key Field Mappings (CRITICAL - DO NOT CHANGE)
- **Task Titles**: `task.name` (NOT `task.title`)
- **Task Assignments**: `taskDetails.contacts[]` array from individual task calls
- **Contact Names**: `contact.name` (contains full name like "Ella He")
- **Project Manager**: `taskDetails.projectmanagername`

### Working API Pattern
```javascript
// 1. Get task list: GET /projects/{id}/tasks  
// 2. For each task: GET /tasks/{id} to get assignments
// 3. Extract from taskDetails.contacts[] array
```

## Team Configuration
```javascript
const YOUR_TEAM_MANAGER_IDS = [1030, 4, 18, 605, 1029, 597, 801];
```

## Current Architecture

### Backend (app.js) - Node.js/Express
- ProWorkflow API integration with proper authentication
- Team filtering by manager IDs  
- Project health calculations (idle time, due dates)
- Task assignment processing via individual API calls
- Enhanced error handling and logging

### Frontend (dashboard.html) - Vanilla JS
- Expandable project list with blue ▶ buttons
- Task assignment display in expandable sections
- Manager filtering and sorting options
- Statistics cards (total projects, overdue, etc.)
- Debug console (Ctrl+D to toggle)

### Key Routes
- `GET /` - Dashboard interface
- `GET /api/rest/projects-table` - Project list with team filtering
- `GET /api/rest/project/:id/tasks` - Tasks with assignments
- `GET /api/rest/test-task-contacts/:id` - Assignment testing
- `GET /health` - System health check

## What Was Broken vs Fixed

### Initial Issues
- Tasks showed "Untitled Task" → Fixed: Use `task.name` not `task.title`
- Assignments showed "Unassigned" → Fixed: Use `taskDetails.contacts[]` not separate API calls
- Complex async processing caused race conditions → Fixed: Simple sequential processing

### Final Working Solution
- Get project tasks list for names and basic info
- Call individual task endpoints for assignment details  
- Extract assignments from contacts array
- Handle empty assignments gracefully

## Environment Setup
```bash
PROWORKFLOW_API_KEY=your_key
PROWORKFLOW_USERNAME=your_username
PROWORKFLOW_PASSWORD=your_password
```

## Debugging Commands
- Visit `/health` - Check API connectivity
- Click "Test Task #155927" - Verify assignment extraction
- Enable debug mode - See detailed processing logs
- Check server console for API response details

## Success Indicators
Dashboard working correctly when:
- Project names appear (not "Untitled Project")
- Task names appear (not "Untitled Task")  
- Assignments show actual names (not "Unassigned")
- Blue expand buttons reveal task lists
- Statistics show actual counts

## Future Reference Notes
- ProWorkflow API responses are nested: `response.task.contacts[]`
- Many tasks legitimately have empty contacts arrays
- Individual task calls are required for assignment data
- Project list calls only provide basic task metadata
- Rate limit: Max 10 concurrent task detail calls per project

## Tested & Confirmed Working
- Task 155927: "Design – [ABM] Creatives..." assigned to "Ella He"
- Task 139849: "Upload to G‑drive, post link in ticket" assigned to "Paul Haroon"  
- Task 139848: "User Testing /Written Approval" unassigned (empty contacts array)

## Development Context
This dashboard was built to provide visibility into team project assignments within ProWorkflow. The main challenge was discovering the correct API field mappings through systematic testing with the ProWorkflow API tester tool. The solution required understanding that task assignments are only available through individual task API calls, not project task lists.