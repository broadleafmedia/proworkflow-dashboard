require('dotenv').config();
// ProWorkflow Assignment Queue App - Independent Server
// Focused specifically on project request assignment workflow

const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.ASSIGNMENT_QUEUE_PORT || 3001;

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
const CACHE_DURATION = 2 * 60 * 1000; // 2 minutes (shorter for assignment queue)

function getCacheKey(endpoint) {
  return `assignment-queue:${endpoint}`;
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

// Assignment Queue API Functions
class AssignmentQueueAPI {
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
      
      console.log(`API ${method}: ${endpoint}`);
      const response = await axios(config);
      
      // Cache successful GET responses
      if (method === 'GET') {
        setCachedData(getCacheKey(endpoint), response.data);
      }
      
      return response.data;
    } catch (error) {
      console.error(`API Error: ${method} ${endpoint} - ${error.response?.status} ${error.response?.statusText}`);
      throw error;
    }
  }

  // Get all project requests
  static async getProjectRequests() {
    return await this.makeRequest('/projectrequests');
  }

  // Get specific project request details
  static async getProjectRequest(requestId) {
    return await this.makeRequest(`/projectrequests/${requestId}`);
  }

  // Approve/assign a project request
  static async approveProjectRequest(requestId, assigneeData) {
    return await this.makeRequest(`/projectrequests/${requestId}/approve`, 'PUT', assigneeData);
  }

  // Decline a project request
  static async declineProjectRequest(requestId, reason) {
    return await this.makeRequest(`/projectrequests/${requestId}/decline`, 'PUT', { reason });
  }

  // Get contacts/team members for assignment
  static async getContacts() {
    return await this.makeRequest('/contacts');
  }
}

// Routes

// Main assignment queue page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'assignment-queue.html'));
});

// Assignment queue page (alternative route)
app.get('/assignment-queue', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'assignment-queue.html'));
});

// API Routes for Assignment Queue

// Get all project requests
app.get('/api/rest/project-requests', async (req, res) => {
  try {
    console.log('=== FETCHING PROJECT REQUESTS ===');
    const requestsData = await AssignmentQueueAPI.getProjectRequests();
    
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
        
        // Calculate days until due
        const aDays = aDate ? Math.floor((aDate - today) / (1000 * 60 * 60 * 24)) : 999;
        const bDays = bDate ? Math.floor((bDate - today) / (1000 * 60 * 60 * 24)) : 999;
        
        // Sort by urgency: overdue first, then by ascending days until due
        return aDays - bDays;
      });
      
      // Update count to reflect filtered results
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
    
    const requestData = await AssignmentQueueAPI.getProjectRequest(requestId);
    
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
    
    // Call ProWorkflow approve endpoint
    const approvalData = await AssignmentQueueAPI.approveProjectRequest(requestId, assignmentData);
    
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

// Decline a project request
app.put('/api/rest/project-requests/:id/decline', async (req, res) => {
  try {
    const requestId = req.params.id;
    const { reason } = req.body;
    
    console.log(`=== DECLINING PROJECT REQUEST ${requestId} ===`);
    console.log('Decline reason:', reason);
    
    const declineData = await AssignmentQueueAPI.declineProjectRequest(requestId, reason);
    
    console.log(`Successfully declined project request ${requestId}`);
    
    // Clear cache to force refresh
    cache.clear();
    
    res.json(declineData);
  } catch (error) {
    console.error(`Error declining project request ${req.params.id}:`, error);
    res.status(500).json({ 
      error: 'Failed to decline project request',
      details: error.response?.data || error.message
    });
  }
});

// Get team members for assignment dropdown
app.get('/api/rest/team-members', async (req, res) => {
  try {
    console.log('=== FETCHING TEAM MEMBERS FOR ASSIGNMENT ===');
    
    const contactsData = await AssignmentQueueAPI.getContacts();
    const contacts = contactsData.contacts || [];
    
    // Filter to your team members only
    const YOUR_TEAM_MANAGER_IDS = [1030, 4, 18, 605, 1029, 597, 801];
    
    const teamMembers = contacts
      .filter(contact => YOUR_TEAM_MANAGER_IDS.includes(contact.id))
      .map(contact => ({
        id: contact.id,
        name: contact.name || `${contact.firstname || ''} ${contact.lastname || ''}`.trim(),
        email: contact.email
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    
    console.log(`Found ${teamMembers.length} team members`);
    
    res.json({ teamMembers });
  } catch (error) {
    console.error('Error fetching team members:', error);
    res.status(500).json({ error: 'Failed to fetch team members' });
  }
});

// Dashboard navigation (redirect to main dashboard)
app.get('/dashboard', (req, res) => {
  res.redirect('http://localhost:3000');
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    service: 'ProWorkflow Assignment Queue',
    status: 'OK', 
    timestamp: new Date().toISOString(),
    cacheSize: cache.size,
    cacheKeys: Array.from(cache.keys()).slice(0, 5)
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
    service: 'Assignment Queue Cache',
    totalCached: cache.size,
    cacheDuration: CACHE_DURATION / 1000 + 's',
    entries: cacheInfo.slice(0, 20)
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Assignment Queue Error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`ProWorkflow Assignment Queue running on port ${PORT}`);
  console.log(`Assignment Queue available at: http://localhost:${PORT}`);
  console.log(`Features: Project request assignment, approval workflow, team management`);
  
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