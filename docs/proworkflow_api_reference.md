# ProWorkflow API Reference & Schema Documentation

## API Base Configuration
```javascript
const PROWORKFLOW_CONFIG = {
  apiKey: process.env.PROWORKFLOW_API_KEY,
  username: process.env.PROWORKFLOW_USERNAME, 
  password: process.env.PROWORKFLOW_PASSWORD,
  baseURL: 'https://api.proworkflow.net'
};

// Authentication Headers
{
  'apikey': PROWORKFLOW_CONFIG.apiKey,
  'Content-Type': 'application/json',
  'Authorization': `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
}
```

## Critical Field Mappings (Discovered Through Testing)

### Task Fields
- **Task Title**: `task.name` (NOT `task.title`)
- **Task Status**: `task.status`
- **Task Priority**: `task.priority`
- **Task Description**: `task.description` (only in detailed calls)

### Assignment Fields
- **Task Assignments**: `taskDetails.contacts[]` array (from individual task calls)
- **Project Team**: `taskDetails.projectcontacts[]` (all project contacts)
- **Project Manager**: `taskDetails.projectmanagername`

### Contact Fields
- **Full Name**: `contact.name` (e.g., "Ella He")
- **First Name**: `contact.firstname`
- **Last Name**: `contact.lastname`
- **Contact ID**: `contact.id`
- **Type**: `contact.type` ("staff" or "client")

## API Endpoints & Usage

### 1. Project Tasks List
```
GET /projects/{projectid}/tasks
```
**Purpose**: Get lightweight task list for a project  
**Returns**: Basic task metadata only  
**Key Fields**: `id`, `name`, `status`, `order1`, `duedate`, `type`

**Important**: 
- Contains task names in `name` field
- Does NOT contain assignment information
- Use this for getting the task list, then call individual tasks for details

### 2. Individual Task Details
```
GET /tasks/{taskid}
```
**Purpose**: Get complete task information including assignments  
**Returns**: Full task object with contacts, project info, budget data

**Key Response Structure**:
```json
{
  "count": 1,
  "status": "Success",
  "task": {
    "name": "Task Title Here",
    "contacts": [
      {
        "name": "Ella He",
        "firstname": "Ella", 
        "lastname": "He",
        "id": 18,
        "type": "staff"
      }
    ],
    "projectcontacts": [...],
    "projectmanagername": "Paul Haroon",
    "description": "Task description",
    "status": "active",
    "priority": "medium"
  }
}
```

### 3. Task Contacts (Alternative)
```
GET /tasks/{taskid}/contacts
```
**Purpose**: Get only the contacts assigned to a specific task  
**Returns**: Simple contacts array with contact details  
**Use Case**: If you only need assignments without other task data

## Team Manager IDs (Your Organization)
```javascript
const YOUR_TEAM_MANAGER_IDS = [1030, 4, 18, 605, 1029, 597, 801];
```

## Data Processing Patterns

### Getting Project Tasks with Assignments
```javascript
// 1. Get task list from project
const tasksResponse = await makeRequest(`/projects/${projectId}/tasks`);
const tasks = tasksResponse.tasks || [];

// 2. For each task, get detailed info
for (const task of tasks) {
  const taskDetails = await makeRequest(`/tasks/${task.id}`);
  const taskInfo = taskDetails.task;
  
  // 3. Extract assignments from contacts array
  const assignedNames = taskInfo.contacts
    .map(contact => contact.name)
    .filter(name => name);
    
  // 4. Use task.name for title, assignedNames for assignments
  const processedTask = {
    title: task.name, // Critical: use 'name' not 'title'
    assignedTo: assignedNames.join(', ') || 'Unassigned'
  };
}
```

### Assignment Status Logic
- **Empty contacts array** → "Unassigned"
- **Has contacts** → Join names with commas
- **Error loading** → "Error loading assignments"

## Common Gotchas & Fixes

### 1. Task Title Issues
❌ **Wrong**: `task.title` (field doesn't exist)  
✅ **Correct**: `task.name`

### 2. Assignment Data
❌ **Wrong**: Separate `/contacts` API calls for each task  
✅ **Correct**: Use `taskDetails.contacts` from individual task calls

### 3. Empty Assignments
- Many tasks have empty `contacts` arrays
- This is normal - not all tasks are assigned to specific people
- Some tasks only have project-level contacts

### 4. Performance Considerations
- Limit concurrent task detail calls (we use 10 max)
- Project tasks list is lightweight, individual calls are heavy
- Consider caching for frequently accessed data

## API Response Patterns

### Successful Response
```json
{
  "count": 1,
  "status": "Success", 
  "totalcount": 1,
  "data": [...]
}
```

### Error Response
```json
{
  "status": "Error",
  "message": "Error description"
}
```

## Authentication Notes
- Requires API key in header
- Basic auth with username/password
- All requests must include proper headers
- Test with `/health` endpoint first

## Dashboard Implementation Notes
- Filter projects by team manager IDs
- Use project list for basic info, individual calls for assignments
- Handle empty assignments gracefully
- Provide clear loading states for async data
- Cache responses when possible to reduce API calls

## Debugging Tips
1. Always log the field names: `Object.keys(response)`
2. Check data types: `Array.isArray(contacts)`
3. Test with known working task IDs (like 155927)
4. Use the ProWorkflow API tester to verify data structures
5. Compare working vs non-working tasks to find patterns