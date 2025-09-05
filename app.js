require('dotenv').config();
// ProWorkflow Combined App - Dashboard + Assignment Queue
// Single Heroku deployment serving both interfaces

const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// ProWorkflow API Configuration
const PROWORKFLOW_CONFIG = {
  apiKey: process.env.PROWORKFLOW_API_KEY,
  username: process.env.PROWORKFLOW_USERNAME,
  password: process.env.PROWORKFLOW_PASSWORD,
  baseURL: 'https://api.proworkflow.net'
};

// PERFORMANCE: Simple memory cache
const cache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

function getCacheKey(endpoint) {
  return `${endpoint}`;
}

function getCachedData(key) {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    console.log(`Cache HIT for ${key}`);
    return cached.data;
  }
  return null;
}

function setCachedData(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
  console.log(`Cache SET for ${key}`);
}

// Authentication headers for REST API
function getAuthHeaders() {
  return {
    'apikey': PROWORKFLOW_CONFIG.apiKey,
    'Content-Type': 'application/json',
    'Authorization': `Basic ${Buffer.from(`${PROWORKFLOW_CONFIG.username}:${PROWORKFLOW_CONFIG.password}`).toString('base64')}`
  };
}

// PERFORMANCE: Rate-limited request function
async function rateLimitedRequest(requests, maxConcurrent = 10) {
  const results = [];
  const executing = [];
  
  for (const request of requests) {
    const promise = request().then(result => {
      executing.splice(executing.indexOf(promise), 1);
      return result;
    });
    
    results.push(promise);
    executing.push(promise);
    
    if (executing.length >= maxConcurrent) {
      await Promise.race(executing);
    }
  }
  
  return Promise.all(results);
}

// Shared API Functions
class ProWorkflowAPI {
  static async makeRequest(endpoint, method = 'GET', data = null) {
    try {
      // Check cache first (only for GET requests)
      if (method === 'GET') {
        const cacheKey = getCacheKey(endpoint);
        const cached = getCachedData(cacheKey);
        if (cached) {
          return cached;
        }
      }

      const config = {
        method,
        url: `${PROWORKFLOW_CONFIG.baseURL}${endpoint}`,
        headers: getAuthHeaders()
      };
      
      if (data) {
        config.data = data;
      }
      
      const response = await axios(config);
      
      // Cache successful GET responses
      if (method === 'GET') {
        setCachedData(getCacheKey(endpoint), response.data);
      }
      
      return response.data;
    } catch (error) {
      console.error(`API Error: ${error.response?.status} ${error.response?.statusText}`);
      throw error;
    }
  }

  // Dashboard methods
  static async getProjects() {
    return await this.makeRequest('/projects');
  }

  static async getProject(projectId) {
    return await this.makeRequest(`/projects/${projectId}`);
  }

  static async getTasks() {
    return await this.makeRequest('/tasks');
  }

  static async getProjectTasks(projectId) {
    return await this.makeRequest(`/projects/${projectId}/tasks`);
  }

  static async getCompanies() {
    return await this.makeRequest('/companies');
  }

  // Assignment Queue methods
  static async getProjectRequests() {
    return await this.makeRequest('/projectrequests');
  }

  static async getProjectRequest(requestId) {
    return await this.makeRequest(`/projectrequests/${requestId}`);
  }

  static async approveProjectRequest(requestId, assigneeData) {
    return await this.makeRequest(`/projectrequests/${requestId}/approve`, 'PUT', assigneeData);
  }
}

// MAIN ROUTES - Serve HTML Pages

// Dashboard (main page)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Assignment Queue
app.get('/assignment-queue', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'assignment-queue.html'));
});

// DASHBOARD API ROUTES

app.get('/api/rest/projects', async (req, res) => {
  try {
    const projects = await ProWorkflowAPI.getProjects();
    res.json(projects);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

app.get('/api/rest/project/:id', async (req, res) => {
  try {
    const project = await ProWorkflowAPI.getProject(req.params.id);
    res.json(project);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch project' });
  }
});

app.get('/api/rest/tasks', async (req, res) => {
  try {
    const tasks = await ProWorkflowAPI.getTasks();
    res.json(tasks);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

// PERFORMANCE OPTIMIZED: projects-table route with team filtering
app.get('/api/rest/projects-table', async (req, res) => {
  const { manager, sort } = req.query;
  try {
    console.log('=== STARTING OPTIMIZED PROJECT LOAD ===');
    
    // Get basic projects list
    const projectsData = await ProWorkflowAPI.getProjects();
    const projects = projectsData.projects || projectsData.data || projectsData || [];
    
    console.log(`Found ${projects.length} total projects`);
    
    // PERFORMANCE: Create rate-limited requests for project details
    const projectRequests = projects.map(project => 
      () => ProWorkflowAPI.makeRequest(`/projects/${project.id}`)
        .then(details => ({ ...details.project, originalId: project.id }))
        .catch(error => {
          console.error(`Failed to get details for project ${project.id}`);
          return { ...project, error: true };
        })
    );
    
    console.log(`Starting rate-limited API calls (max 8 concurrent)...`);
    const startTime = Date.now();
    
    // PERFORMANCE: Process in batches with rate limiting
    const detailedProjects = await rateLimitedRequest(projectRequests, 8);
    
    const loadTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Completed ${detailedProjects.length} API calls in ${loadTime}s`);
    
    // Filter by YOUR team members as managers
    const YOUR_TEAM_MANAGER_IDS = [1030, 4, 18, 605, 1029, 597, 801]; 
    
    let tableProjects = detailedProjects
      .filter(project => {
        const isTeamProject = YOUR_TEAM_MANAGER_IDS.includes(project.managerid);
        
        if (manager && isTeamProject) {
          return project.managerid == manager || project.managername.toLowerCase().includes(manager.toLowerCase());
        }
        
        return isTeamProject;
      })
      .map(project => {
        const startDate = project.startdate || new Date();
        const dueDate = project.duedate ? new Date(project.duedate) : null;
        const lastUpdated = project.lastmodifiedutc || project.startdate || new Date();
        const daysSinceStart = Math.floor((new Date() - new Date(startDate)) / (1000 * 60 * 60 * 24));
        const daysSinceActivity = Math.floor((new Date() - new Date(lastUpdated)) / (1000 * 60 * 60 * 24));
        
        const daysUntilDue = dueDate ? Math.floor((dueDate - new Date()) / (1000 * 60 * 60 * 24)) : null;
        const isOverdue = daysUntilDue !== null && daysUntilDue < 0;
        const isUpcoming = daysUntilDue !== null && daysUntilDue <= 30 && daysUntilDue >= 0;
        
        return {
          number: project.number,
          title: project.title,
          projectId: project.id,
          projectUrl: `https://app.proworkflow.com/SafeNet/?fuseaction=jobs&fusesubaction=jobdetails&Jobs_currentJobID=${project.id}`,
          owner: project.managername || 'Unassigned',
          managerId: project.managerid,
          customStatus: project.customstatus || project.status || 'Active',
          statusColor: project.customstatuscolor ? `#${project.customstatuscolor}` : '#4CAF50',
          daysIdle: daysSinceActivity > 7 ? daysSinceActivity : 0,
          daysSinceStart: daysSinceStart,
          dueDate: dueDate ? dueDate.toLocaleDateString() : null,
          daysUntilDue: daysUntilDue,
          isOverdue: isOverdue,
          isUpcoming: isUpcoming,
          client: project.companyname || 'Unknown Client',
          priority: project.priority || 'Medium',
          startDate: startDate ? new Date(startDate).toLocaleDateString() : 'No start date',
          status: project.status || 'active'
        };
      });

    // Apply sorting
    switch (sort) {
      case 'idle':
        tableProjects.sort((a, b) => b.daysIdle - a.daysIdle);
        break;
      case 'age':
        tableProjects.sort((a, b) => b.daysSinceStart - a.daysSinceStart);
        break;
      case 'manager':
        tableProjects.sort((a, b) => a.owner.localeCompare(b.owner));
        break;
      case 'number':
        tableProjects.sort((a, b) => b.number.localeCompare(a.number));
        break;
      case 'status':
        tableProjects.sort((a, b) => a.customStatus.localeCompare(b.customStatus));
        break;
      case 'title':
        tableProjects.sort((a, b) => a.title.localeCompare(b.title));
        break;
      default:
        tableProjects.sort((a, b) => b.daysIdle - a.daysIdle);
    }

    // Get unique managers for filtering options
    const uniqueManagersMap = new Map();
    detailedProjects
      .filter(p => YOUR_TEAM_MANAGER_IDS.includes(p.managerid))
      .forEach(p => {
        if (p.managerid && p.managername) {
          uniqueManagersMap.set(p.managerid, { id: p.managerid, name: p.managername });
        }
      });
    
    const availableManagers = Array.from(uniqueManagersMap.values());

    console.log(`Returning ${tableProjects.length} team projects`);

    res.json({ 
      projects: tableProjects,
      availableManagers: availableManagers,
      totalProjects: tableProjects.length,
      loadTime: loadTime,
      cacheHits: detailedProjects.filter(p => !p.error).length
    });
  } catch (error) {
    console.error('REST Table error:', error);
    res.status(500).json({ error: 'Failed to fetch REST table data' });
  }
});

// PERFORMANCE OPTIMIZED: Project tasks with pagination
app.get('/api/rest/project/:id/tasks', async (req, res) => {
  try {
    const projectId = req.params.id;
    const limit = parseInt(req.query.limit) || 20;
    const offset = parseInt(req.query.offset) || 0;
    
    console.log(`Fetching tasks for project ${projectId} (limit: ${limit}, offset: ${offset})`);
    
    const tasksResponse = await ProWorkflowAPI.makeRequest(`/projects/${projectId}/tasks?status=all`);
    const tasks = tasksResponse.tasks || [];
    
    console.log(`Found ${tasks.length} total tasks in project ${projectId}`);
    
    const tasksToProcess = tasks.slice(offset, offset + limit);
    console.log(`Processing tasks ${offset + 1}-${offset + tasksToProcess.length} of ${tasks.length}`);
    
    const taskRequests = tasksToProcess.map(task => 
      () => ProWorkflowAPI.makeRequest(`/tasks/${task.id}`)
        .then(taskDetails => {
          const taskInfo = taskDetails.task;
          
          const assignedNames = (taskInfo.contacts || [])
            .map(contact => contact.name)
            .filter(name => name && name.trim());

          const dueDate = taskInfo.duedate ? new Date(taskInfo.duedate) : null;
          let dueDateStatus = 'none';
          let daysUntilDue = null;
          
          if (dueDate) {
            daysUntilDue = Math.floor((dueDate - new Date()) / (1000 * 60 * 60 * 24));
            if (daysUntilDue < 0) {
              dueDateStatus = 'overdue';
            } else if (daysUntilDue <= 7) {
              dueDateStatus = 'due-soon';
            } else {
              dueDateStatus = 'normal';
            }
          }

          const isCompleted = taskInfo.status === 'complete';
          
          return {
            id: task.id,
            title: task.name,
            status: taskInfo.status || 'active',
            completed: isCompleted,
            assignedTo: assignedNames.length > 0 ? assignedNames.join(', ') : 'Unassigned',
            dueDate: dueDate ? dueDate.toLocaleDateString() : null,
            dueDateStatus: dueDateStatus,
            daysUntilDue: daysUntilDue,
            priority: taskInfo.priority || 3,
            description: taskInfo.description || null,
            order: task.order1 || 0,
            taskNumber: task.ordernumber || task.id,
            startDate: taskInfo.startdate ? new Date(taskInfo.startdate).toLocaleDateString() : null,
            completeDate: taskInfo.completedate ? new Date(taskInfo.completedate).toLocaleDateString() : null,
            timeAllocated: taskInfo.timeallocated || 0,
            timeTracked: taskInfo.timetracked || 0
          };
        })
        .catch(taskError => {
          console.error(`Error fetching task ${task.id}:`, taskError.message);
          return {
            id: task.id,
            title: task.name || 'Untitled Task',
            status: 'unknown',
            completed: false,
            assignedTo: 'Error loading assignments',
            dueDate: null,
            dueDateStatus: 'none',
            daysUntilDue: null,
            priority: 3,
            description: null,
            order: task.order1 || 0
          };
        })
    );
    
    const tasksWithAssignments = await rateLimitedRequest(taskRequests, 5);
    tasksWithAssignments.sort((a, b) => a.order - b.order);
    
    const hasMore = offset + limit < tasks.length;
    const remaining = hasMore ? tasks.length - (offset + limit) : 0;
    
    console.log(`Successfully processed ${tasksWithAssignments.length} tasks with assignments`);
    
    res.json({
      tasks: tasksWithAssignments,
      hasMore: hasMore,
      totalTasks: tasks.length,
      displayedTasks: offset + tasksWithAssignments.length,
      remaining: remaining,
      nextOffset: hasMore ? offset + limit : null
    });
    
  } catch (error) {
    console.error(`Error fetching tasks for project ${req.params.id}:`, error);
    res.status(500).json({ 
      error: 'Failed to fetch project tasks',
      tasks: [],
      hasMore: false,
      totalTasks: 0,
      displayedTasks: 0,
      remaining: 0
    });
  }
});

// ASSIGNMENT QUEUE API ROUTES

// Get all project requests (Creative Services only)
app.get('/api/rest/project-requests', async (req, res) => {
  try {
    console.log('=== FETCHING PROJECT REQUESTS ===');
    const requestsData = await ProWorkflowAPI.getProjectRequests();
    
    console.log(`Found ${requestsData.count || 0} total project requests`);
    
    // Filter to Creative Services only
    if (requestsData.projectrequests) {
      requestsData.projectrequests = requestsData.projectrequests.filter(request => 
        request.recipientgroupname === 'Creative Services'
      );
      
      console.log(`Filtered to ${requestsData.projectrequests.length} Creative Services requests`);
      
      // Sort by urgency (overdue first, then by due date)
      requestsData.projectrequests.sort((a, b) => {
        const aDate = a.duedate ? new Date(a.duedate) : null;
        const bDate = b.duedate ? new Date(b.duedate) : null;
        const today = new Date();
        
        const aDays = aDate ? Math.floor((aDate - today) / (1000 * 60 * 60 * 24)) : 999;
        const bDays = bDate ? Math.floor((bDate - today) / (1000 * 60 * 60 * 24)) : 999;
        
        return aDays - bDays;
      });
      
      requestsData.count = requestsData.projectrequests.length;
    }
    
    res.json(requestsData);
  } catch (error) {
    console.error('Error fetching project requests:', error);
    res.status(500).json({ error: 'Failed to fetch project requests' });
  }
});

// Get specific project request details
app.get('/api/rest/project-requests/:id', async (req, res) => {
  try {
    const requestId = req.params.id;
    console.log(`=== FETCHING PROJECT REQUEST ${requestId} ===`);
    
    const requestData = await ProWorkflowAPI.getProjectRequest(requestId);
    
    console.log(`Loaded project request: ${requestData.projectrequest?.title || 'Unknown'}`);
    
    res.json(requestData);
  } catch (error) {
    console.error(`Error fetching project request ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to fetch project request details' });
  }
});

// Approve/assign a project request
app.put('/api/rest/project-requests/:id/approve', async (req, res) => {
  try {
    const requestId = req.params.id;
    const assignmentData = req.body;
    
    console.log(`=== APPROVING PROJECT REQUEST ${requestId} ===`);
    console.log('Assignment data:', assignmentData);
    
    const approvalData = await ProWorkflowAPI.approveProjectRequest(requestId, assignmentData);
    
    console.log(`Successfully approved project request ${requestId}`);
    
    // Clear cache to force refresh
    cache.clear();
    
    res.json(approvalData);
  } catch (error) {
    console.error(`Error approving project request ${req.params.id}:`, error);
    res.status(500).json({ 
      error: 'Failed to approve project request',
      details: error.response?.data || error.message
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    service: 'ProWorkflow Combined Suite',
    status: 'OK', 
    timestamp: new Date().toISOString(),
    cacheSize: cache.size,
    routes: ['Dashboard: /', 'Assignment Queue: /assignment-queue']
  });
});

// Cache status endpoint
app.get('/api/cache-status', (req, res) => {
  const cacheInfo = Array.from(cache.entries()).map(([key, value]) => ({
    key: key.length > 50 ? key.substring(0, 50) + '...' : key,
    age: Math.round((Date.now() - value.timestamp) / 1000) + 's',
    size: JSON.stringify(value.data).length + ' chars'
  }));

  res.json({
    service: 'Combined ProWorkflow Suite Cache',
    totalCached: cache.size,
    cacheDuration: CACHE_DURATION / 1000 + 's',
    entries: cacheInfo.slice(0, 20)
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('ProWorkflow Suite Error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`ProWorkflow Combined Suite running on port ${PORT}`);
  console.log(`Dashboard available at: /`);
  console.log(`Assignment Queue available at: /assignment-queue`);
  console.log(`Features: Project monitoring, task management, request assignment`);
  
  // Validate configuration
  if (!PROWORKFLOW_CONFIG.apiKey) {
    console.warn('WARNING: PROWORKFLOW_API_KEY environment variable not set');
  }
  if (!PROWORKFLOW_CONFIG.username) {
    console.warn('WARNING: PROWORKFLOW_USERNAME environment variable not set');
  }
  if (!PROWORKFLOW_CONFIG.password) {
    console.warn('WARNING: PROWORKFLOW_PASSWORD environment variable not set');
  }
});

module.exports = app;