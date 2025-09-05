require('dotenv').config();
// ProWorkflow Dashboard App for Heroku - PERFORMANCE OPTIMIZED
// This is a complete Node.js/Express application with both REST and GraphQL implementations

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

// REST API Functions
class ProWorkflowREST {
  static async makeRequest(endpoint, method = 'GET', data = null) {
    try {
      // Check cache first
      const cacheKey = getCacheKey(endpoint);
      const cached = getCachedData(cacheKey);
      if (cached) {
        return cached;
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
      
      // Cache successful responses
      setCachedData(cacheKey, response.data);
      
      return response.data;
    } catch (error) {
      console.error(`API Error: ${error.response?.status} ${error.response?.statusText}`);
      throw error;
    }
  }

  // Get all projects
  static async getProjects() {
    return await this.makeRequest('/projects');
  }

  // Get project details
  static async getProject(projectId) {
    return await this.makeRequest(`/projects/${projectId}`);
  }

  // Get all tasks
  static async getTasks() {
    return await this.makeRequest('/tasks');
  }

  // Get tasks for a specific project
  static async getProjectTasks(projectId) {
    return await this.makeRequest(`/projects/${projectId}/tasks`);
  }

  // Get all companies
  static async getCompanies() {
    return await this.makeRequest('/companies');
  }

  // Get all contacts
  static async getContacts() {
    return await this.makeRequest('/contacts');
  }

  // Get time entries
  static async getTimeEntries() {
    return await this.makeRequest('/time');
  }

  // Get invoices
  static async getInvoices() {
    return await this.makeRequest('/invoices');
  }

  // Search functionality
  static async search(query) {
    return await this.makeRequest(`/search?query=${encodeURIComponent(query)}`);
  }
}

// Dashboard Routes

// Main dashboard page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// REST API Routes
app.get('/api/rest/projects', async (req, res) => {
  try {
    const projects = await ProWorkflowREST.getProjects();
    res.json(projects);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

app.get('/api/rest/project/:id', async (req, res) => {
  try {
    const project = await ProWorkflowREST.getProject(req.params.id);
    res.json(project);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch project' });
  }
});

app.get('/api/rest/tasks', async (req, res) => {
  try {
    const tasks = await ProWorkflowREST.getTasks();
    res.json(tasks);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

app.get('/api/rest/companies', async (req, res) => {
  try {
    const companies = await ProWorkflowREST.getCompanies();
    res.json(companies);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

app.get('/api/rest/dashboard', async (req, res) => {
  try {
    const projectsData = await ProWorkflowREST.getProjects();
    const tasksData = await ProWorkflowREST.getTasks();
    const companiesData = await ProWorkflowREST.getCompanies();
    
    const projects = projectsData.projects || projectsData.data || projectsData || [];
    const tasks = tasksData.tasks || tasksData.data || tasksData || [];
    const companies = companiesData.companies || companiesData.data || companiesData || [];
    
    res.json({
      projects: Array.isArray(projects) ? projects.slice(0, 10) : [],
      tasks: Array.isArray(tasks) ? tasks.slice(0, 10) : [],
      companies: Array.isArray(companies) ? companies.slice(0, 10) : [],
      summary: {
        totalProjects: Array.isArray(projects) ? projects.length : 0,
        totalTasks: Array.isArray(tasks) ? tasks.length : 0,
        totalCompanies: Array.isArray(companies) ? companies.length : 0
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

// PERFORMANCE OPTIMIZED: projects-table route with progress tracking
app.get('/api/rest/projects-table', async (req, res) => {
  const { manager, sort } = req.query;
  try {
    console.log('=== STARTING OPTIMIZED PROJECT LOAD ===');
    
    // Get basic projects list
    const projectsData = await ProWorkflowREST.getProjects();
    const projects = projectsData.projects || projectsData.data || projectsData || [];
    
    console.log(`📊 Found ${projects.length} total projects`);
    
    // PERFORMANCE: Create rate-limited requests for project details
    const projectRequests = projects.map(project => 
      () => ProWorkflowREST.makeRequest(`/projects/${project.id}`)
        .then(details => ({ ...details.project, originalId: project.id }))
        .catch(error => {
          console.error(`Failed to get details for project ${project.id}`);
          return { ...project, error: true }; // Fall back to basic project data
        })
    );
    
    console.log(`🚀 Starting rate-limited API calls (max 8 concurrent)...`);
    const startTime = Date.now();
    
    // PERFORMANCE: Process in batches with rate limiting
    const detailedProjects = await rateLimitedRequest(projectRequests, 8);
    
    const loadTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ Completed ${detailedProjects.length} API calls in ${loadTime}s`);
    
    // Filter by YOUR team members as managers (your original team IDs)
    const YOUR_TEAM_MANAGER_IDS = [1030, 4, 18, 605, 1029, 597, 801]; 
    
    let tableProjects = detailedProjects
      .filter(project => {
        // First filter by team
        const isTeamProject = YOUR_TEAM_MANAGER_IDS.includes(project.managerid);
        
        // Then optionally filter by specific manager if requested
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
        
        // Calculate days until due date
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
          dueDate: dueDate ? dueDate.toLocaleDateString() : null, // FIXED: Return null instead of text for empty due dates
          daysUntilDue: daysUntilDue,
          isOverdue: isOverdue,
          isUpcoming: isUpcoming,
          client: project.companyname || 'Unknown Client',
          priority: project.priority || 'Medium',
          startDate: startDate ? new Date(startDate).toLocaleDateString() : 'No start date',
          status: project.status || 'active' // Add basic status for filtering
        };
      });

    // Apply sorting based on query parameter
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
        // Default sort by days idle (most idle first)
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

    console.log(`📋 Returning ${tableProjects.length} team projects`);
    console.log('=== OPTIMIZED PROJECT LOAD COMPLETE ===');

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

// PERFORMANCE OPTIMIZED: Project tasks with pagination - FIXED COMPLETION LOGIC
app.get('/api/rest/project/:id/tasks', async (req, res) => {
  try {
    const projectId = req.params.id;
    const limit = parseInt(req.query.limit) || 20;
    const offset = parseInt(req.query.offset) || 0;
    
    console.log(`\n=== OPTIMIZED: Fetching tasks for project ${projectId} (limit: ${limit}, offset: ${offset}) ===`);
    
    // Get task list for this project - INCLUDE ALL TASKS (completed + active)
    const tasksResponse = await ProWorkflowREST.makeRequest(`/projects/${projectId}/tasks?status=all`);
    const tasks = tasksResponse.tasks || [];
    
    console.log(`📋 Found ${tasks.length} total tasks in project ${projectId}`);
    
    // Get the slice of tasks for this request
    const tasksToProcess = tasks.slice(offset, offset + limit);
    console.log(`🎯 Processing tasks ${offset + 1}-${offset + tasksToProcess.length} of ${tasks.length}`);
    
    // PERFORMANCE: Create rate-limited requests for task details
    const taskRequests = tasksToProcess.map(task => 
      () => ProWorkflowREST.makeRequest(`/tasks/${task.id}`)
        .then(taskDetails => {
          const taskInfo = taskDetails.task;
          
          // Extract assignments from contacts array
          const assignedNames = (taskInfo.contacts || [])
            .map(contact => contact.name)
            .filter(name => name && name.trim());

          // Calculate due date status
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

          // FIXED: ProWorkflow uses "complete" not "completed"
          const isCompleted = taskInfo.status === 'complete';
          
          console.log(`Task ${task.id} (${task.name}): status="${taskInfo.status}", completed=${isCompleted}, assigned to: ${assignedNames.join(', ') || 'Unassigned'}`);
          
          return {
            id: task.id,
            title: task.name, // CRITICAL: use task.name not task.title
            status: taskInfo.status || 'active',
            completed: isCompleted,
            assignedTo: assignedNames.length > 0 ? assignedNames.join(', ') : 'Unassigned',
            dueDate: dueDate ? dueDate.toLocaleDateString() : null, // FIXED: Return null instead of text
            dueDateStatus: dueDateStatus,
            daysUntilDue: daysUntilDue,
            priority: taskInfo.priority || 3,
            description: taskInfo.description || null,
            order: task.order1 || 0,
            // NEW FIELDS for enhanced task display
            taskNumber: task.ordernumber || task.id, // Use ordernumber or fallback to id
            startDate: taskInfo.startdate ? new Date(taskInfo.startdate).toLocaleDateString() : null, // FIXED: Return null instead of text
            completeDate: taskInfo.completedate ? new Date(taskInfo.completedate).toLocaleDateString() : null, // FIXED: Return null instead of text
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
    
    // PERFORMANCE: Process task details with rate limiting (max 5 concurrent)
    const tasksWithAssignments = await rateLimitedRequest(taskRequests, 5);
    
    // Sort by order
    tasksWithAssignments.sort((a, b) => a.order - b.order);
    
    const hasMore = offset + limit < tasks.length;
    const remaining = hasMore ? tasks.length - (offset + limit) : 0;
    
    console.log(`✅ Successfully processed ${tasksWithAssignments.length} tasks with assignments`);
    
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

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    cacheSize: cache.size,
    cacheKeys: Array.from(cache.keys()).slice(0, 5) // Show first 5 cache keys
  });
});

// PERFORMANCE: Cache status endpoint
app.get('/api/cache-status', (req, res) => {
  const cacheInfo = Array.from(cache.entries()).map(([key, value]) => ({
    key: key.length > 50 ? key.substring(0, 50) + '...' : key,
    age: Math.round((Date.now() - value.timestamp) / 1000) + 's',
    size: JSON.stringify(value.data).length + ' chars'
  }));

  res.json({
    totalCached: cache.size,
    cacheDuration: CACHE_DURATION / 1000 + 's',
    entries: cacheInfo.slice(0, 20) // Show first 20 entries
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`ProWorkflow Dashboard running on port ${PORT}`);
  console.log(`Dashboard available at: http://localhost:${PORT}`);
  console.log(`Performance optimizations: ✅ Rate limiting ✅ Caching ✅ Progress logging`);
  
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