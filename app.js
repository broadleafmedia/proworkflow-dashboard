require('dotenv').config();
console.log('? OpenAI Key loaded:', process.env.OPENAI_API_KEY ? 'YES' : 'NO');
console.log('? OpenAI Key starts with sk-:', process.env.OPENAI_API_KEY?.startsWith('sk-'));
// ProWorkflow Combined App - Dashboard + Assignment Queue
// Single Heroku deployment serving both interfaces with SECURITY
const express = require('express');
const axios = require('axios');
const path = require('path');
const { OpenAI } = require('openai');
						
						
// --- Chat tools (function calling) ---
const CHAT_TOOLS = [
  {
    type: "function",
    function: {
      name: "fetchDashboardDigest",
      description: "Return a precomputed digest of current projects/requests for fast analysis.",
      parameters: {
        type: "object",
        properties: {
          managerId: { type: "string", description: "Optional filter by manager id" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "analyzeProjects",
      description: "Analyze a list of projects and return findings as structured JSON.",
      parameters: {
        type: "object",
        properties: {
          projects: { type: "array", items: { type: "object" } },
          focus: { type: "string", description: "e.g., 'overdue', 'stale', 'balance', 'risks'" }
        },
        required: ["projects"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "updateProjectStatus",
      description: "Update a project custom status by ID (uses customstatusid).",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          statusId: { type: "number" }
        },
        required: ["projectId", "statusId"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "updateTaskDate",
      description: "Update a task start or due date (YYYY-MM-DD).",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          field: { type: "string", enum: ["startdate", "duedate"] },
          value: { type: "string" }
        },
        required: ["taskId", "field", "value"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "setTaskCompletion",
      description: "Complete or reactivate a task.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          complete: { type: "boolean" }
        },
        required: ["taskId", "complete"]
      }
    }
  }
];

console.log('[AI] First tool:', JSON.stringify(CHAT_TOOLS[0], null, 2));


						
						
						
						
// SECURITY IMPORTS
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const session = require('express-session');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// TEAM MANAGER CONFIGURATION
const DEFAULT_TEAM_MANAGER_IDS = [1030, 4, 18, 605, 1029, 597, 801];
const YOUR_TEAM_MANAGER_IDS = (() => {
  const envManagerIds = process.env.YOUR_TEAM_MANAGER_IDS;
  if (!envManagerIds) {
    return DEFAULT_TEAM_MANAGER_IDS;
  }

  const parsedIds = envManagerIds
    .split(',')
    .map(id => Number(id.trim()))
    .filter(id => Number.isFinite(id));

  return parsedIds.length > 0 ? parsedIds : DEFAULT_TEAM_MANAGER_IDS;
})();



const TEAM_MANAGER_ID_SET = new Set(YOUR_TEAM_MANAGER_IDS);

const normalizeManagerId = value => {
  if (value === null || value === undefined) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const getProjectManagerId = project =>
  normalizeManagerId(
    project?.managerid ??
      project?.managerId ??
      project?.managerID ??
      project?.manager?.id
  );

const getProjectManagerName = project =>
  project?.managername || project?.manager?.name || null;

// SECURITY MIDDLEWARE - WORKING VERSION
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:", "http:"],
      connectSrc: ["'self'", "https://api.proworkflow.net"],
      fontSrc: ["'self'", "https:", "data:"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false,
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  },
  noSniff: true,
  frameguard: { action: 'deny' },
  xssFilter: true,
}));

// RATE LIMITING
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit login attempts
  message: 'Too many login attempts, please try again later.',
  skipSuccessfulRequests: true,
});
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // Limit API calls
  message: 'API rate limit exceeded',
});
// Apply rate limiting
app.use(generalLimiter);

// SESSION MANAGEMENT
app.use(session({
  secret: process.env.SESSION_SECRET || 'your_session_secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000
  },
  name: 'pwf_session'
}));

// Debug middleware
app.use((req, res, next) => {
  console.log('Session middleware - Path:', req.path, 'Session ID:', req.sessionID);
  next();
});

// AUTHENTICATION SYSTEM
const ADMIN_USERS = [
  {
    username: 'admin',
    passwordHash: process.env.ADMIN_PASSWORD_HASH || '$2b$10$placeholder_hash',
    role: 'admin'
  },
  {
    username: 'viewer',
    passwordHash: process.env.VIEWER_PASSWORD_HASH || '$2b$10$placeholder_hash',
    role: 'viewer'
  }
];
console.log('ADMIN_USERS config:', ADMIN_USERS[0]);

// Authentication middleware
function requireAuth(req, res, next) {
  console.log('Auth check for:', req.path);
  console.log('Session authenticated:', req.session?.authenticated);
  console.log('Session data:', req.session);
  
  if (req.session && req.session.authenticated) {
    console.log('User is authenticated, allowing access');
    return next();
  } else {
    console.log('User not authenticated, redirecting to login');
    return res.status(401).redirect('/login');
  }
}

// BASIC MIDDLEWARE
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// APPLY AUTHENTICATION TO ALL ROUTES EXCEPT LOGIN
app.use((req, res, next) => {
  if (req.path === '/login' || req.path.startsWith('/auth/') || req.path === '/health') {
    return next();
  }
  return requireAuth(req, res, next);
});


	
	
// =================================================================================
// BUSINESS DAY CALCULATOR
// =================================================================================

function getBusinessDaysDifference(startDate, endDate = new Date()) {
  if (!startDate || isNaN(startDate.getTime())) {
    return 0;
  }
  const start = new Date(startDate);
  const end = new Date(endDate);
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  let businessDays = 0;
  const currentDate = new Date(start);
  while (currentDate < end) {
    const dayOfWeek = currentDate.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      businessDays++;
    }
    currentDate.setDate(currentDate.getDate() + 1);
  }
  return businessDays;
}

function getCommunicationHealthBusiness(lastMessageDate, isRushProject = false) {
  if (!lastMessageDate) {
    return {
      status: 'unknown',
      businessDays: 0,
      className: 'communication-unknown',
      description: 'No communication data'
    };
  }
  const businessDays = getBusinessDaysDifference(lastMessageDate);
  const thresholds = isRushProject ? 
    { active: 1, attention: 2, stale: 3 } :     
    { active: 3, attention: 4, stale: 5 };
  let status, className, description;
  if (businessDays <= thresholds.active) {
    status = 'active';
    className = 'communication-active';
    description = `Active (${businessDays} business days)`;
  } else if (businessDays <= thresholds.attention) {
    status = 'attention';
    className = 'communication-attention';
    description = `Needs attention (${businessDays} business days)`;
  } else {
    status = 'stale';
    className = 'communication-stale';
    description = `Stale (${businessDays} business days)`;
  }
  return { status, businessDays, className, description, isRushProject };
}

// Test endpoint
app.get('/api/test/business-days', (req, res) => {
  const testDate = new Date();
  testDate.setDate(testDate.getDate() - 5);
  const result = getCommunicationHealthBusiness(testDate, false);
  const rushResult = getCommunicationHealthBusiness(testDate, true);
  res.json({
    message: 'Business day calculator test',
    testDate: testDate.toISOString(),
    normalProject: result,
    rushProject: rushResult,
    timestamp: new Date().toISOString()
  });
});
// =================================================================================
// END OF BUSINESS DAY CALCULATOR ADDITION
// =================================================================================

// =================================================================================
// ASSIGNMENT QUEUE MONITORING - Add this section to your app.js
// Place this AFTER the business day calculator (around line 150, before routes)
// =================================================================================

/**
 * Check if a project in Queue status is overdue for assignment
 * @param {Object} project - Project object with status and dates
 * @returns {Object} Assignment status info
 */
function getAssignmentQueueStatus(project) {
  const customStatus = (project.customstatus || '').toLowerCase();
  const isRushProject = customStatus.includes('rush');
  
  // Only check projects in Queue status
  const isInQueue = customStatus === 'queue' || customStatus === 'rush - queue';
  
  if (!isInQueue) {
    return {
      isInQueue: false,
      isOverdue: false,
      status: 'not_in_queue',
      description: null
    };
  }
  
  // Use project start date or creation date as queue entry time
  const queueEntryDate = project.startdate ? new Date(project.startdate) : null;
  
  if (!queueEntryDate) {
    return {
      isInQueue: true,
      isOverdue: false,
      status: 'unknown_entry_time',
      description: 'Queue entry time unknown'
    };
  }
  
  const businessDaysSinceQueued = getBusinessDaysDifference(queueEntryDate);
  
  // Assignment thresholds
  const assignmentThreshold = isRushProject ? 0 : 1; // RUSH = same day, Normal = 1 business day
  const isOverdue = businessDaysSinceQueued > assignmentThreshold;
  
  return {
    isInQueue: true,
    isOverdue: isOverdue,
    businessDays: businessDaysSinceQueued,
    status: isOverdue ? 'assignment_overdue' : 'in_queue',
    description: isOverdue 
      ? `Assignment overdue (${businessDaysSinceQueued} business days in queue)`
      : `In queue (${businessDaysSinceQueued} business days)`,
    rushProject: isRushProject,
    threshold: assignmentThreshold
  };
}

/**
 * Get enhanced project status with assignment monitoring
 * @param {Object} project - Project object
 * @returns {Object} Enhanced status info
 */
function getEnhancedProjectStatus(project) {
  const customStatus = (project.customstatus || '').toLowerCase();
  const assignmentStatus = getAssignmentQueueStatus(project);
  
  // Check for other status-specific monitoring
  let needsAttentionReason = null;
  
  // "Needs Attention" projects should be monitored daily
  if (customStatus === 'needs attention') {
    const lastUpdated = project.lastmodifiedutc ? new Date(project.lastmodifiedutc) : null;
    if (lastUpdated) {
      const daysSinceUpdate = getBusinessDaysDifference(lastUpdated);
      if (daysSinceUpdate > 1) {
        needsAttentionReason = `No progress in ${daysSinceUpdate} business days`;
      }
    }
  }
  
  // "Meeting Scheduled" projects that may need status updates
  if (customStatus === 'meeting scheduled') {
    const lastUpdated = project.lastmodifiedutc ? new Date(project.lastmodifiedutc) : null;
    if (lastUpdated) {
      const daysSinceUpdate = getBusinessDaysDifference(lastUpdated);
      if (daysSinceUpdate > 5) {
        needsAttentionReason = `Meeting may have occurred - status update needed (${daysSinceUpdate} days)`;
      }
    }
  }
  
  return {
    assignmentStatus: assignmentStatus,
    needsAttentionReason: needsAttentionReason,
    statusFlags: {
      assignmentOverdue: assignmentStatus.isOverdue,
      needsStatusUpdate: needsAttentionReason !== null,
      isRush: customStatus.includes('rush')
    }
  };
}

	
	// Smart contextual responses for dashboard and assignment queue queries
function generateContextualResponse(message, context, history) {
  const msg = message.toLowerCase();
  
  // Assignment Queue specific responses
  if (context === 'assignment-queue') {
    if (msg.includes('assign') || msg.includes('designer')) {
      return "I can help you assign projects to the right team members! Consider: workload balance, skill match (Richard for EMEA, Ella for APAC, Paul for AppSec), project complexity, and client preferences. What project are you looking to assign?";
    }
    
    if (msg.includes('overdue') || msg.includes('urgent')) {
      return "For overdue requests, prioritize by: 1) Days overdue, 2) Client importance, 3) Project complexity. RUSH projects need same-day assignment. Would you like me to help prioritize your current queue?";
    }
    
    if (msg.includes('capacity') || msg.includes('workload')) {
      return "Check team capacity using the Staff Workload Overview report in ProWorkflow. Aim for <=6 hours per person per day. I can help you balance assignments across Richard, Ella, and Paul.";
    }
    
    if (msg.includes('sla') || msg.includes('timeline')) {
      return "Standard SLA: Tier 1 (5 days), Tier 2 (10 days), Tier 3 (15 days). RUSH projects need immediate assignment. Assignment should happen within 1 business day (same day for RUSH). What's the project complexity?";
    }
    
    if (msg.includes('hello') || msg.includes('hi')) {
      return "Hi! I'm your assignment queue assistant. I can help you assign projects efficiently, manage team capacity, track SLAs, and optimize your workflow. What assignment challenge can I help you solve?";
    }
    
    // Default assignment queue response
    return `I understand you're asking about "${message}". I can help you with project assignments, team capacity planning, SLA management, and workflow optimization. What specific assignment challenge can I help you solve?`;
  }
  
  // Dashboard responses
  if (msg.includes('stale') || msg.includes('communication')) {
    return "I can see your communication health data. Projects with red badges (>7 days) need immediate attention. Would you like me to identify which clients to follow up with?";
  }
  
  if (msg.includes('overdue') || msg.includes('deadline')) {
    return "I can help you identify overdue projects and tasks. Check the red deadline badges in your project list. Would you like me to prioritize them by urgency?";
  }
  
  if (msg.includes('rush') || msg.includes('urgent')) {
    return "RUSH projects are highlighted in yellow. I can help you track their progress and ensure they're moving through the workflow quickly.";
  }
  
  if (msg.includes('assignment') || msg.includes('assign')) {
    return "For assignment management, check your Assignment Queue at /assignment-queue. I can help you match projects to the right team members based on skills and workload.";
  }
  
  if (msg.includes('task') || msg.includes('message')) {
    return "Your dashboard shows task assignments and communication health. Click the blue expand arrows to see detailed task lists for each project, and click the badges to see threaded task messages.";
  }
  
  if (msg.includes('dashboard') || msg.includes('help')) {
    return "Your dashboard shows: Active projects (<=2 days), Normal (3-7 days), Stale (>7 days). Use filters to sort by communication health, due dates, or manager. What specific area would you like help with?";
  }
  
  if (msg.includes('hello') || msg.includes('hi')) {
    return "Hi! I'm your ProWorkflow AI assistant. I can help you analyze project health, identify bottlenecks, suggest follow-ups, and navigate your dashboard. What would you like to know?";
  }
  
  // Default response
  return `I understand you're asking about "${message}". I can help you analyze your ProWorkflow data, identify communication gaps, track project health, and suggest actions. Your dashboard shows real-time project status with threaded messages. What specific insights would you like?`;
}
	
	
	
	
// Test endpoint to verify assignment monitoring works
app.get('/api/test/assignment-queue', (req, res) => {
  const testProjects = [
    {
      id: 'test1',
      number: '12345',
      title: 'Test Normal Queue Project',
      customstatus: 'Queue',
      startdate: new Date(Date.now() - (2 * 24 * 60 * 60 * 1000)).toISOString() // 2 days ago
    },
    {
      id: 'test2', 
      number: '12346',
      title: 'Test RUSH Queue Project',
      customstatus: 'RUSH - Queue',
      startdate: new Date(Date.now() - (1 * 24 * 60 * 60 * 1000)).toISOString() // 1 day ago
    },
    {
      id: 'test3',
      number: '12347', 
      title: 'Test Needs Attention Project',
      customstatus: 'Needs Attention',
      lastmodifiedutc: new Date(Date.now() - (3 * 24 * 60 * 60 * 1000)).toISOString() // 3 days ago
    }
  ];
  
  const results = testProjects.map(project => ({
    project: {
      number: project.number,
      title: project.title,
      status: project.customstatus
    },
    analysis: getEnhancedProjectStatus(project)
  }));
  
  res.json({
    message: 'Assignment queue monitoring test',
    results: results,
    timestamp: new Date().toISOString()
  });
});
// =================================================================================
// END OF ASSIGNMENT QUEUE MONITORING ADDITION
// =================================================================================

// SECURITY ROUTES
app.get('/login', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>ProWorkflow Dashboard - Login</title>
      <style>
        body { 
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          display: flex; 
          justify-content: center; 
          align-items: center; 
          height: 100vh; 
          margin: 0; 
        }
        .login-form { 
          background: white; 
          padding: 2rem; 
          border-radius: 12px; 
          box-shadow: 0 10px 40px rgba(0,0,0,0.2);
          width: 300px;
        }
        .login-form h1 { 
          text-align: center; 
          color: #333; 
          margin-bottom: 1.5rem;
        }
        .form-group { 
          margin-bottom: 1rem; 
        }
        .form-group label { 
          display: block; 
          margin-bottom: 0.5rem; 
          font-weight: 600;
          color: #555;
        }
        .form-group input { 
          width: 100%; 
          padding: 0.75rem; 
          border: 2px solid #e1e8ed; 
          border-radius: 8px; 
          font-size: 1rem;
          box-sizing: border-box;
        }
        .form-group input:focus { 
          outline: none; 
          border-color: #667eea; 
        }
        .login-btn { 
          width: 100%; 
          padding: 0.75rem; 
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
          color: white; 
          border: none; 
          border-radius: 8px; 
          font-size: 1rem; 
          font-weight: 600;
          cursor: pointer;
          transition: transform 0.2s ease;
        }
        .login-btn:hover { 
          transform: translateY(-2px); 
        }
        .error { 
          color: #dc2626; 
          text-align: center; 
          margin-bottom: 1rem; 
        }
        .demo-info {
          background: #e0f2fe;
          border: 1px solid #0891b2;
          border-radius: 8px;
          padding: 1rem;
          margin-bottom: 1rem;
          font-size: 0.9rem;
        }
      </style>
    </head>
    <body>
      <form class="login-form" method="POST" action="/auth/login">
        <h1>ProWorkflow Dashboard</h1>
        ${req.query.error ? '<div class="error">Invalid credentials</div>' : ''}
               
        <div class="form-group">
          <label for="username">Username</label>
          <input type="text" id="username" name="username" required>
        </div>
        <div class="form-group">
          <label for="password">Password</label>
          <input type="password" id="password" name="password" required>
        </div>
        <button type="submit" class="login-btn">Login</button>
      </form>
    </body>
    </html>
  `);
});

app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  
  console.log('Login attempt:');
  console.log('Username:', username);
  console.log('Password:', password);
  
  const user = ADMIN_USERS.find(u => u.username === username);
  console.log('User found:', !!user);
  
  if (user) {
    console.log('Stored hash:', user.passwordHash);
    console.log('Hash length:', user.passwordHash.length);
    console.log('Hash starts with $2b$:', user.passwordHash.startsWith('$2b$'));
    
    try {
      const passwordMatch = await bcrypt.compare(password, user.passwordHash);
      console.log('Password match result:', passwordMatch);
      
      if (passwordMatch) {
        req.session.authenticated = true;
        req.session.user = { username: user.username, role: user.role };
        console.log('Login successful');
        res.redirect('/');
      } else {
        console.log('Password mismatch');
        res.redirect('/login?error=1');
      }
    } catch (error) {
      console.log('Bcrypt error:', error.message);
      res.redirect('/login?error=1');
    }
  } else {
    console.log('User not found');
    res.redirect('/login?error=1');
  }
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// Hide from search engines
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send(`User-agent: *\nDisallow: /`);
});

// Static files and API rate limiting
app.use(express.static('public'));
app.use('/api', apiLimiter);


	// ProWorkflow API Configuration
const PROWORKFLOW_CONFIG = {
  apiKey: process.env.PROWORKFLOW_API_KEY,
  username: process.env.PROWORKFLOW_USERNAME,
  password: process.env.PROWORKFLOW_PASSWORD,
  baseURL: 'https://api.proworkflow.net'
};

// OpenAI Configuration
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
	

// ===== NEW SMART CACHE SYSTEM =====
// PERFORMANCE: Enhanced Smart Cache System  
class SmartCache {
  constructor() {
    this.cache = new Map();
    this.dependencies = new Map();
    this.stats = { hits: 0, misses: 0, clears: 0, sets: 0 };
  }

  getCacheDuration(cacheType) {
    const durations = {
      'projects-list': 3 * 60 * 1000,      // 3 minutes - changes frequently
      'project-details': 5 * 60 * 1000,    // 5 minutes - moderate changes
      'status-options': 15 * 60 * 1000,    // 15 minutes - rarely changes
      'task-details': 2 * 60 * 1000,       // 2 minutes - changes often
      'messages': 1 * 60 * 1000,           // 1 minute - real-time data
      'team-members': 30 * 60 * 1000       // 30 minutes - very stable
    };
    return durations[cacheType] || 5 * 60 * 1000;
  }

  getCacheKey(endpoint, params = {}) {
    const paramString = Object.keys(params)
      .sort()
      .map(key => `${key}=${params[key]}`)
      .join('&');
    return paramString ? `${endpoint}?${paramString}` : endpoint;
  }

  get(key, cacheType = 'default') {
    const cached = this.cache.get(key);
    const duration = this.getCacheDuration(cacheType);
    
    if (cached && Date.now() - cached.timestamp < duration) {
      this.stats.hits++;
      console.log(`💾 Smart Cache HIT for ${key} (${cacheType})`);
      return cached.data;
    }
    
    this.stats.misses++;
    return null;
  }

  set(key, data, cacheType = 'default', dependencies = []) {
    this.cache.set(key, { 
      data, 
      timestamp: Date.now(), 
      cacheType,
      dependencies: [...dependencies]
    });
    
    dependencies.forEach(dep => {
      if (!this.dependencies.has(dep)) {
        this.dependencies.set(dep, new Set());
      }
      this.dependencies.get(dep).add(key);
    });
    
    this.stats.sets++;
    console.log(`🗄️ Smart Cache SET for ${key} (${cacheType})`);
  }

  clear() {
    const size = this.cache.size;
    this.cache.clear();
    this.dependencies.clear();
    this.stats.clears++;
    console.log(`🧹 Smart Cache cleared ALL (${size} entries)`);
  }

  invalidate(dependency) {
    const dependentKeys = this.dependencies.get(dependency);
    if (dependentKeys) {
      let cleared = 0;
      dependentKeys.forEach(key => {
        if (this.cache.has(key)) {
          this.cache.delete(key);
          cleared++;
        }
      });
      this.dependencies.delete(dependency);
      console.log(`🔄 Smart Cache invalidated ${cleared} entries for dependency: ${dependency}`);
      return cleared;
    }
    return 0;
  }

  getStats() {
    const total = this.stats.hits + this.stats.misses;
    const hitRate = total > 0 ? (this.stats.hits / total * 100) : 0;
    
    const typeStats = {};
    for (const [key, value] of this.cache.entries()) {
      const type = value.cacheType;
      if (!typeStats[type]) {
        typeStats[type] = { count: 0, avgAge: 0 };
      }
      typeStats[type].count++;
      typeStats[type].avgAge += (Date.now() - value.timestamp);
    }
    
    Object.keys(typeStats).forEach(type => {
      if (typeStats[type].count > 0) {
        typeStats[type].avgAge = Math.round(typeStats[type].avgAge / typeStats[type].count / 1000);
      }
    });

    return {
      ...this.stats,
      total,
      hitRate: hitRate.toFixed(1) + '%',
      size: this.cache.size,
      dependencies: this.dependencies.size,
      typeBreakdown: typeStats
    };
  }

  cleanup() {
    let cleaned = 0;
    const now = Date.now();
    
    for (const [key, value] of this.cache.entries()) {
      const duration = this.getCacheDuration(value.cacheType);
      if (now - value.timestamp > duration) {
        this.cache.delete(key);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      console.log(`🧽 Smart Cache auto-cleaned ${cleaned} expired entries`);
    }
    return cleaned;
  }

  clearByType(cacheType) {
    let cleared = 0;
    for (const [key, value] of this.cache.entries()) {
      if (value.cacheType === cacheType) {
        this.cache.delete(key);
        cleared++;
      }
    }
    console.log(`🗑️ Smart Cache cleared ${cleared} entries of type: ${cacheType}`);
    return cleared;
  }

  getDebugInfo() {
    const entries = Array.from(this.cache.entries()).map(([key, value]) => ({
      key: key.length > 50 ? key.substring(0, 50) + '...' : key,
      type: value.cacheType,
      age: Math.round((Date.now() - value.timestamp) / 1000) + 's',
      size: JSON.stringify(value.data).length + ' chars',
      deps: value.dependencies || [],
      expired: Date.now() - value.timestamp > this.getCacheDuration(value.cacheType)
    }));

    return {
      stats: this.getStats(),
      entries: entries.slice(0, 20),
      dependencies: Array.from(this.dependencies.entries()).map(([dep, keys]) => ({
        dependency: dep,
        affectedKeys: keys.size
      }))
    };
  }
}

	
// Initialize smart cache with legacy compatibility
const smartCache = new SmartCache();

// Legacy compatibility - keep existing code working
const cache = {
  get: (key) => smartCache.get(key),
  set: (key, value) => smartCache.set(key, value),
  has: (key) => smartCache.get(key) !== null,
  delete: (key) => {
    if (smartCache.cache.has(key)) {
      smartCache.cache.delete(key);
      return true;
    }
    return false;
  },
  clear: () => smartCache.clear(),
  get size() { return smartCache.cache.size; }
};

	
// Automatic cleanup every 5 minutes
setInterval(() => {
  smartCache.cleanup();
}, 5 * 60 * 1000);

console.log('🚀 Smart Cache initialized with automatic cleanup every 5 minutes');
	
	
// Legacy compatibility functions - keep existing functions working
function getCacheKey(endpoint) {
  return smartCache.getCacheKey(endpoint);
}

function getCachedData(key) {
  return smartCache.get(key, 'default');
}

function setCachedData(key, data) {
  smartCache.set(key, data, 'default');
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

// ENHANCED: Smart task-relevant message filtering
function getTaskContextMessages(projectMessages, task) {
  if (!projectMessages || !projectMessages.length) {
    return [];
  }
  
  const taskStart = task.startdate ? new Date(task.startdate) : null;
  const taskEnd = task.completedate ? new Date(task.completedate) : new Date();
  const taskTitle = (task.name || '').toLowerCase();
  const taskAssignees = (task.contacts || []).map(c => c.name?.toLowerCase()).filter(Boolean);
  
  console.log(`Filtering messages for task "${task.name}"`);
  console.log(`Task assignees: [${taskAssignees.join(', ')}]`);
  console.log(`Task period: ${taskStart?.toDateString()} to ${taskEnd?.toDateString()}`);
  
  const commonWords = ['the','and','or','but','in','on','at','to','for','of','with','by','a','an','is','are','was','were','be','been','have','has','had','do','does','did','will','would','could','should','may','might','can','must','shall','design','task','project','update','create','add','remove','edit','review'];
  const taskKeywords = taskTitle
    .split(/[\s\-_,()[\]{}|\\/:;"'<>?=+*&^%$#@!~`]+/)
    .map(word => word.toLowerCase().trim())
    .filter(word => word.length > 2 && !commonWords.includes(word))
    .slice(0, 5);
  
  console.log(`Task keywords: [${taskKeywords.join(', ')}]`);
  
  const relevantMessages = projectMessages.filter(message => {
    const messageDate = new Date(message.date);
    const messageContent = (message.content || '').toLowerCase();
    const messageAuthor = (message.authorname || '').toLowerCase();
    
    let relevanceScore = 0;
    let relevanceReasons = [];
    
    let withinTimeframe = true;
    if (taskStart && messageDate < taskStart) {
      const daysBefore = Math.floor((taskStart - messageDate) / (1000 * 60 * 60 * 24));
      if (daysBefore > 7) withinTimeframe = false;
    }
    if (task.completedate && messageDate > taskEnd) {
      withinTimeframe = false;
    }
    if (!withinTimeframe) return false;
    
    for (const assignee of taskAssignees) {
      if (messageContent.includes(assignee) || messageAuthor.includes(assignee)) {
        relevanceScore += 10;
        relevanceReasons.push(`mentions ${assignee}`);
        break;
      }
    }
    
    if (messageContent.includes('@')) {
      for (const assignee of taskAssignees) {
        const firstName = assignee.split(' ')[0];
        if (messageContent.includes(`@${firstName}`) || messageContent.includes(`@${assignee}`)) {
          relevanceScore += 15;
          relevanceReasons.push(`@mentions ${assignee}`);
          break;
        }
      }
    }
    
    let keywordMatches = 0;
    for (const keyword of taskKeywords) {
      if (messageContent.includes(keyword)) {
        keywordMatches++;
        relevanceScore += 3;
      }
    }
    if (keywordMatches > 0) {
      relevanceReasons.push(`${keywordMatches} keyword matches`);
    }
    
    if (taskAssignees.some(assignee => messageAuthor.includes(assignee))) {
      relevanceScore += 8;
      relevanceReasons.push('author is assignee');
    }
    
    if (message.files && message.files.length > 0) {
      const fileNames = message.files.map(f => (f.name || '').toLowerCase()).join(' ');
      for (const keyword of taskKeywords) {
        if (fileNames.includes(keyword)) {
          relevanceScore += 5;
          relevanceReasons.push('relevant file attachment');
          break;
        }
      }
    }
    
    if (messageContent.includes('re:') || messageContent.includes('?') || messageContent.includes('please')) {
      relevanceScore += 2;
      relevanceReasons.push('appears to be response/question');
    }
    
    const isRelevant = relevanceScore >= 5;
    if (isRelevant) {
      console.log(`Relevant message (score: ${relevanceScore}): "${message.content.substring(0, 50)}..." - ${relevanceReasons.join(', ')}`);
    }
    return isRelevant;
  });
  
  console.log(`Found ${relevantMessages.length} relevant messages out of ${projectMessages.length} total project messages`);
  
  return relevantMessages;
}


// =================================================================================
// BUSINESS DAY CALCULATOR HELPERS
// =================================================================================

/**
 * Calculate business days between two dates (excludes weekends).
 * @param {Date} startDate - Starting date
 * @param {Date} endDate - Ending date (default: today)
 * @returns {number} Number of business days
 */
function getBusinessDaysDifference(startDate, endDate = new Date()) {
  if (!startDate || isNaN(startDate.getTime())) {
    return 0;
  }
  
  const start = new Date(startDate);
  const end = new Date(endDate);

  // Normalize to midnight
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  
  let businessDays = 0;
  const currentDate = new Date(start);
  
  while (currentDate < end) {
    const dayOfWeek = currentDate.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      businessDays++;
    }
    currentDate.setDate(currentDate.getDate() + 1);
  }
  
  return businessDays;
}

/**
 * Get communication health status using business days.
 * @param {Date} lastMessageDate - Date of last message
 * @param {boolean} isRushProject - Whether this is a rush project
 * @returns {Object} Health status info
 */
function getCommunicationHealthBusiness(lastMessageDate, isRushProject = false) {
  if (!lastMessageDate) {
    return {
      status: 'unknown',
      businessDays: 0,
      className: 'communication-unknown',
      description: 'No communication data'
    };
  }
  
  const businessDays = getBusinessDaysDifference(lastMessageDate);
  
  const thresholds = isRushProject
    ? { active: 1, attention: 2, stale: 3 }   // RUSH projects
    : { active: 3, attention: 4, stale: 5 };  // Normal projects
  
  let status, className, description;
  
  if (businessDays <= thresholds.active) {
    status = 'active';
    className = 'communication-active';
    description = `Active (${businessDays} business days)`;
  } else if (businessDays <= thresholds.attention) {
    status = 'attention';
    className = 'communication-attention';
    description = `Needs attention (${businessDays} business days)`;
  } else {
    status = 'stale';
    className = 'communication-stale';
    description = `Stale (${businessDays} business days)`;
  }
  
  return {
    status,
    businessDays,
    className,
    description,
    isRushProject
  };
}

/**
 * Check if a project in Queue status is overdue for assignment.
 * @param {Object} project - Project object with status and dates
 * @returns {Object} Assignment status info
 */
function getAssignmentQueueStatus(project) {
  const customStatus = (project.customstatus || '').toLowerCase();
  const isRushProject = customStatus.includes('rush');
  
  const isInQueue = customStatus === 'queue' || customStatus === 'rush - queue';
  if (!isInQueue) {
    return {
      isInQueue: false,
      isOverdue: false,
      status: 'not_in_queue',
      description: null
    };
  }
  
  const queueEntryDate = project.startdate ? new Date(project.startdate) : null;
  if (!queueEntryDate) {
    return {
      isInQueue: true,
      isOverdue: false,
      status: 'unknown_entry_time',
      description: 'Queue entry time unknown'
    };
  }
  
  const businessDaysSinceQueued = getBusinessDaysDifference(queueEntryDate);
  const assignmentThreshold = isRushProject ? 0 : 1; // RUSH same-day, normal next-day
  const isOverdue = businessDaysSinceQueued > assignmentThreshold;
  
  return {
    isInQueue: true,
    isOverdue,
    businessDays: businessDaysSinceQueued,
    status: isOverdue ? 'assignment_overdue' : 'in_queue',
    description: isOverdue
      ? `Assignment overdue (${businessDaysSinceQueued} business days in queue)`
      : `In queue (${businessDaysSinceQueued} business days)`,
    rushProject: isRushProject,
    threshold: assignmentThreshold
  };
}

/**
 * Get enhanced project status with assignment monitoring.
 * @param {Object} project - Project object
 * @returns {Object} Enhanced status info
 */
function getEnhancedProjectStatus(project) {
  const customStatus = (project.customstatus || '').toLowerCase();
  const assignmentStatus = getAssignmentQueueStatus(project);
  
  let needsAttentionReason = null;
  
  if (customStatus === 'needs attention') {
    const lastUpdated = project.lastmodifiedutc ? new Date(project.lastmodifiedutc) : null;
    if (lastUpdated) {
      const daysSinceUpdate = getBusinessDaysDifference(lastUpdated);
      if (daysSinceUpdate > 1) {
        needsAttentionReason = `No progress in ${daysSinceUpdate} business days`;
      }
    }
  }
  
  if (customStatus === 'meeting scheduled') {
    const lastUpdated = project.lastmodifiedutc ? new Date(project.lastmodifiedutc) : null;
    if (lastUpdated) {
      const daysSinceUpdate = getBusinessDaysDifference(lastUpdated);
      if (daysSinceUpdate > 5) {
        needsAttentionReason = `Meeting may have occurred - status update needed (${daysSinceUpdate} days)`;
      }
    }
  }
  
  return {
    assignmentStatus,
    needsAttentionReason,
    statusFlags: {
      assignmentOverdue: assignmentStatus.isOverdue,
      needsStatusUpdate: needsAttentionReason !== null,
      isRush: customStatus.includes('rush')
    }
  };
}




// =================================================================================
// MAIN ROUTES - Serve HTML Pages
// =================================================================================



class ProWorkflowAPI {
  static async makeRequest(endpoint, method = 'GET', data = null) {
    try {
      // Check cache first (only for GET requests) with smart cache types
      if (method === 'GET') {
        let cacheType = 'default';
        
        // Determine cache type based on endpoint
        if (endpoint.includes('/projects') && !endpoint.includes('/messages') && !endpoint.includes('/tasks')) {
          cacheType = endpoint === '/projects' ? 'projects-list' : 'project-details';
        } else if (endpoint.includes('/customstatuses')) {
          cacheType = 'status-options';
        } else if (endpoint.includes('/tasks/')) {
          cacheType = 'task-details';
        } else if (endpoint.includes('/messages')) {
          cacheType = 'messages';
        }
        
        const cacheKey = smartCache.getCacheKey(endpoint);
        const cached = smartCache.get(cacheKey, cacheType);
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

      // Cache successful GET responses with appropriate types
      if (method === 'GET') {
        let cacheType = 'default';
        let dependencies = [];
        
        // Smart cache classification and dependencies
        if (endpoint.includes('/projects') && !endpoint.includes('/messages') && !endpoint.includes('/tasks')) {
          cacheType = endpoint === '/projects' ? 'projects-list' : 'project-details';
          dependencies = ['projects'];
        } else if (endpoint.includes('/customstatuses')) {
          cacheType = 'status-options';
          dependencies = ['status-config'];
        } else if (endpoint.includes('/tasks/')) {
          cacheType = 'task-details';
          dependencies = ['tasks', 'projects'];
        } else if (endpoint.includes('/messages')) {
          cacheType = 'messages';
          // Messages don't get dependencies - always fresh
        }
        
        const cacheKey = smartCache.getCacheKey(endpoint);
        smartCache.set(cacheKey, response.data, cacheType, dependencies);
      }

      return response.data;
    } catch (error) {
      console.error(`API Error: ${error.response?.status} ${error.response?.statusText}`);
      throw error;
    }
  }


  // Projects
  static async getProjects() {
    return await this.makeRequest('/projects');
  }

  static async getProject(projectId) {
    return await this.makeRequest(`/projects/${projectId}`);
  }

  // Tasks
  static async getTasks() {
    return await this.makeRequest('/tasks');
  }

  static async getProjectTasks(projectId) {
    return await this.makeRequest(`/projects/${projectId}/tasks`);
  }

  // Companies
  static async getCompanies() {
    return await this.makeRequest('/companies');
  }

  // Messages
  static async getProjectMessages(projectId) {
    return await this.makeRequest(`/projects/${projectId}/messages`);
  }

  static async getTaskMessages(taskId) {
    return await this.makeRequest(`/tasks/${taskId}/messages`);
  }

  // Project Requests
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



// Update project status
app.put('/api/rest/project/:id/status', async (req, res) => {
  try {
    const projectId = req.params.id;
    const { statusId } = req.body;

    // Get the current status name from status options
    const statusOptionsResponse = await ProWorkflowAPI.makeRequest('/settings/projects/customstatuses?teamid=9');
    const statusOptions = statusOptionsResponse.customstatuses || [];
    const selectedStatus = statusOptions.find(s => s.id == statusId);

    if (!selectedStatus) {
      throw new Error(`Status ID ${statusId} not found in available statuses`);
    }

    // Debug logs
    console.log('[DEBUG] Updating project', projectId, 'to status', selectedStatus.name);
    const updateUrl = `/projects/${projectId}`;
    console.log('[DEBUG] Update URL:', updateUrl);

    // Call PWF with body payload
    const result = await ProWorkflowAPI.makeRequest(updateUrl, 'PUT', {
      customstatusid: selectedStatus.id   // numeric ID
    });

    // Log PWF response
    console.log('[DEBUG] PWF response:', JSON.stringify(result));

    // Smart cache invalidation - only clear related data
    smartCache.invalidate('projects');  // Clear project-related caches
    smartCache.invalidate('status-config'); // Clear status-related caches
    console.log('✨ Smart cache invalidation completed - only cleared relevant project data');

    res.json({ 
      success: true, 
      message: 'Status updated successfully',
      result: result 
    });
  } catch (error) {
    console.error('Status update error:', error);
    console.error('Error details:', error.response?.data);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to update project status',
      details: error.response?.data || error.message
    });
  }
});



// Update task (general update, not complete/reactivate)
app.put('/api/rest/task/:id', async (req, res) => {
  try {
    const taskId = req.params.id;
    let updateData = { ...req.body };

    // Normalize frontend payload to what PWF expects
    if (updateData.statusid && !updateData.status) {
      updateData.status = updateData.statusid;  // remap numeric code
      delete updateData.statusid;
    }

    console.log(`[DEBUG] Normalized task update ${taskId}:`, updateData);

    const result = await ProWorkflowAPI.makeRequest(`/tasks/${taskId}`, 'PUT', updateData);

    console.log(`[DEBUG] ProWorkflow response for task ${taskId}:`, JSON.stringify(result, null, 2));

    // Clear cache
    cache.clear();

    res.json({ 
      success: true,
      message: 'Task updated successfully',
      result
    });
  } catch (error) {
    console.error('Task update error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to update task',
      details: error.response?.data || error.message
    });
  }
});

// Complete a task
app.put('/api/rest/task/:id/complete', async (req, res) => {
  try {
    const taskId = req.params.id;
    const payload = req.body.completedate
      ? { completedate: req.body.completedate }
      : {}; // let PWF use "now"

    const result = await ProWorkflowAPI.makeRequest(`/tasks/${taskId}/complete`, 'PUT', payload);
    res.json({ success: true, result });
  } catch (err) {
    console.error('Complete task error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

// Reactivate a task
app.put('/api/rest/task/:id/reactivate', async (req, res) => {
  try {
    const taskId = req.params.id;
    const result = await ProWorkflowAPI.makeRequest(`/tasks/${taskId}/reactivate`, 'PUT');
    res.json({ success: true, result });
  } catch (err) {
    console.error('Reactivate task error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

// Get task details
app.get('/api/rest/task/:id', async (req, res) => {
  try {
    const taskId = req.params.id;
    const taskData = await ProWorkflowAPI.makeRequest(`/tasks/${taskId}`);
    res.json(taskData);
  } catch (error) {
    console.error(`Error fetching task ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to fetch task details' });
  }
});

// Get custom status options for Team 9 (Shared Services)
app.get('/api/rest/status-options', async (req, res) => {
  try {
    console.log('Fetching custom status options...');
    
    const statusData = await ProWorkflowAPI.makeRequest('/settings/projects/customstatuses?teamid=9');
    
    console.log(`Found ${statusData.count || 0} custom statuses for Team 9`);
    
    // Sort by display order
    if (statusData.customstatuses) {
      statusData.customstatuses.sort((a, b) => a.displayorder - b.displayorder);
    }
    
    res.json({
      statuses: statusData.customstatuses || [],
      count: statusData.count || 0
    });
  } catch (error) {
    console.error('Error fetching custom statuses:', error);
    res.status(500).json({ 
      error: 'Failed to fetch status options',
      statuses: [],
      count: 0
    });
  }
});


// PERFORMANCE OPTIMIZED: projects-table route with team filtering and messages
app.get('/api/rest/projects-table', async (req, res) => {
	
	const { manager, sort } = req.query;
  try {
    console.log('=== STARTING OPTIMIZED PROJECT LOAD WITH MESSAGES ===');

    // Get basic projects list
    const projectsData = await ProWorkflowAPI.getProjects();
    const projects = projectsData.projects || projectsData.data || projectsData || [];

    console.log(`Found ${projects.length} total projects`);

    // Build requests for each project
    const projectRequests = projects.map(project =>
      () =>
        Promise.all([
          ProWorkflowAPI.makeRequest(`/projects/${project.id}`),
          ProWorkflowAPI.makeRequest(`/projects/${project.id}/messages`).catch(() => {
            console.warn(`Failed to get messages for project ${project.id}`);
            return { messages: [], count: 0 };
          })
        ])
          .then(([details, messages]) => {
            const originalProjectId = project.id;
            return {
              ...details.project,
              id: originalProjectId,
              originalId: originalProjectId,
              messageData: messages
            };
          })
          .catch(() => {
            console.error(`Failed to get details for project ${project.id}`);
            return {
              ...project,
              id: project.id,
              error: true,
              messageData: { messages: [], count: 0 }
            };
          })
    );

    console.log('Starting rate-limited API calls (max 8 concurrent)...');
    const startTime = Date.now();
    const detailedProjects = await rateLimitedRequest(projectRequests, 8);
    const loadTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Completed ${detailedProjects.length} API calls in ${loadTime}s`);


// ALWAYS apply team filtering first, then manager filtering
const teamFilteredProjects = detailedProjects.filter(project => {
  const managerId = Number(project.managerid);
  return !Number.isNaN(managerId) && YOUR_TEAM_MANAGER_IDS.includes(managerId);
});

console.log(`Team filtered: ${teamFilteredProjects.length} projects from team managers (from ${detailedProjects.length} total)`);

// Then apply manager filtering if requested
let filteredProjects;
if (manager) {
  console.log(`Filtering team projects by manager: ${manager}`);
  filteredProjects = teamFilteredProjects.filter(project => {
    const managerId = Number(project.managerid);
    const managerIdMatch = managerId === Number(manager);
    const managerNameMatch = (project.managername || '').toLowerCase().includes(manager.toLowerCase());
    
    if (managerIdMatch || managerNameMatch) {
      console.log(`? Project ${project.number} matches manager filter`);
      return true;
    }
    return false;
  });
  console.log(`Manager filtered: ${filteredProjects.length} projects`);
} else {
  // No specific manager filter - show all team projects
  filteredProjects = teamFilteredProjects;
}

const managerMap = new Map();
teamFilteredProjects.forEach(project => {  // <-- Use teamFilteredProjects here
  const managerId = Number(project.managerid);
  if (!Number.isNaN(managerId) && !managerMap.has(managerId)) {
    managerMap.set(managerId, {
      id: managerId,
      name: project.managername || 'Unassigned'
    });
  }
});
const availableManagers = Array.from(managerMap.values());
		
		
    console.log('Filtered projects count:', filteredProjects.length);

    let tableProjects = filteredProjects.map(project => {
		
      const startDate = project.startdate || new Date();
      const dueDate = project.duedate ? new Date(project.duedate) : null;
      const lastUpdated = project.lastmodifiedutc || project.startdate || new Date();
      const daysSinceStart = Math.floor((new Date() - new Date(startDate)) / (1000 * 60 * 60 * 24));
      const daysSinceActivity = Math.floor((new Date() - new Date(lastUpdated)) / (1000 * 60 * 60 * 24));

      const daysUntilDue = dueDate ? Math.floor((dueDate - new Date()) / (1000 * 60 * 60 * 24)) : null;
      const isOverdue = daysUntilDue !== null && daysUntilDue < 0;
      const isUpcoming = daysUntilDue !== null && daysUntilDue <= 30 && daysUntilDue >= 0;

      const messages = project.messageData?.messages || [];
      const messageCount = messages.length;

      let lastMessageDate = null;
      let lastMessageAuthor = null;
      let lastMessageType = null;
      let daysSinceLastMessage = null;
      let communicationHealth = 'none';

      if (messages.length > 0) {
        const sortedMessages = messages.sort((a, b) => new Date(b.date) - new Date(a.date));
        const lastMessage = sortedMessages[0];

        lastMessageDate = new Date(lastMessage.date);
        lastMessageAuthor = lastMessage.authorname;
        lastMessageType = lastMessage.authortype;

        const isRushProject = (project.customstatus || '').toLowerCase().includes('rush');
        const healthResult = getCommunicationHealthBusiness(lastMessageDate, isRushProject);

        communicationHealth = healthResult.status;
        daysSinceLastMessage = healthResult.businessDays;

        console.log(`Project ${project.number}: ${healthResult.description} ${isRushProject ? '(RUSH)' : ''}`);
      }

      const enhancedStatus = getEnhancedProjectStatus(project);

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
        daysSinceStart,
        dueDate: dueDate ? dueDate.toLocaleDateString() : null,
        daysUntilDue,
        isOverdue,
        isUpcoming,
        client: project.companyname || 'Unknown Client',
        priority: project.priority || 'Medium',
        startDate: startDate ? new Date(startDate).toLocaleDateString() : 'No start date',
        status: project.status || 'active',

        messageCount,
        lastMessageDate,
        lastMessageAuthor,
        lastMessageType,
        daysSinceLastMessage,
        communicationHealth,
        messages,

        assignmentStatus: enhancedStatus.assignmentStatus,
        needsAttentionReason: enhancedStatus.needsAttentionReason,
        statusFlags: enhancedStatus.statusFlags,

        isAssignmentOverdue: enhancedStatus.statusFlags.assignmentOverdue,
        needsStatusUpdate: enhancedStatus.statusFlags.needsStatusUpdate,
        isRush: enhancedStatus.statusFlags.isRush
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
      case 'communication':
        tableProjects.sort((a, b) => {
          if (a.daysSinceLastMessage === null) return 1;
          if (b.daysSinceLastMessage === null) return -1;
          return b.daysSinceLastMessage - a.daysSinceLastMessage;
        });
        break;
      default:
        tableProjects.sort((a, b) => b.daysIdle - a.daysIdle);
    }

    // Debug log
    console.log('Detailed projects:', detailedProjects.length);
    console.log('Returned (table) projects:', tableProjects.length);
    if (tableProjects.length > 0) {
      console.log('First project keys:', Object.keys(tableProjects[0]));
    }

		 res.json({
      projects: tableProjects,
      availableManagers,
			totalProjects: tableProjects.length,
      loadTime,
      cacheHits: detailedProjects.filter(p => !p.error).length
    });
  } catch (error) {
    console.error('REST Table error:', error);
    res.status(500).json({ error: 'Failed to fetch REST table data' });
  }
});


// ENHANCED: Project tasks with smart task-relevant message integration
app.get('/api/rest/project/:id/tasks', async (req, res) => {
  try {
    const projectId = req.params.id;
    const limit = parseInt(req.query.limit) || 20;
    const offset = parseInt(req.query.offset) || 0;
    
    console.log(`=== SMART TASK-RELEVANT MESSAGE INTEGRATION FOR PROJECT ${projectId} ===`);
    console.log(`Limit: ${limit}, Offset: ${offset}`);
    
    // Get project tasks and project messages in parallel
    const [tasksResponse, projectMessagesResponse] = await Promise.all([
      ProWorkflowAPI.makeRequest(`/projects/${projectId}/tasks?status=all`),
      ProWorkflowAPI.makeRequest(`/projects/${projectId}/messages`).catch(error => {
        console.warn(`Failed to get project messages for ${projectId}: ${error.message}`);
        return { messages: [], count: 0 };
      })
    ]);
    
    const tasks = tasksResponse.tasks || [];
    const projectMessages = projectMessagesResponse.messages || [];
    
    console.log(`Found ${tasks.length} total tasks and ${projectMessages.length} project messages`);
    
    const tasksToProcess = tasks.slice(offset, offset + limit);
    console.log(`Processing tasks ${offset + 1}-${offset + tasksToProcess.length} of ${tasks.length}`);
    
    const taskRequests = tasksToProcess.map(task => 
      () => Promise.all([
        ProWorkflowAPI.makeRequest(`/tasks/${task.id}`),
        ProWorkflowAPI.makeRequest(`/tasks/${task.id}/messages`).catch(error => {
          console.warn(`Failed to get task messages for ${task.id}: ${error.message}`);
          return { messages: [], count: 0 };
        })
      ]).then(([taskDetails, taskMessages]) => {
        const taskInfo = taskDetails.task;
        const directTaskMessages = taskMessages.messages || [];
        
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
        
        // Smart task-relevant message filtering
        let allTaskMessages = directTaskMessages;
        let messageSource = 'task';
        
        if (directTaskMessages.length === 0 && projectMessages.length > 0) {
          const smartContextMessages = getTaskContextMessages(projectMessages, taskInfo);
          allTaskMessages = smartContextMessages;
          messageSource = 'project-context';
          console.log(`Task ${task.id}: Using ${smartContextMessages.length} smart context messages from project`);
        } else if (directTaskMessages.length > 0) {
          console.log(`Task ${task.id}: Using ${directTaskMessages.length} direct task messages`);
        } else {
          console.log(`Task ${task.id}: No relevant messages found`);
        }
        
        // Calculate communication health
        let lastTaskMessageDate = null;
        let daysSinceLastTaskMessage = null;
        let taskCommunicationHealth = 'none';
        
        if (allTaskMessages.length > 0) {
          const sortedMessages = allTaskMessages.sort((a, b) => new Date(b.date) - new Date(a.date));
          const lastMessage = sortedMessages[0];
          
          lastTaskMessageDate = new Date(lastMessage.date);
          daysSinceLastTaskMessage = Math.floor((new Date() - lastTaskMessageDate) / (1000 * 60 * 60 * 24));
          
          if (daysSinceLastTaskMessage <= 2) {
            taskCommunicationHealth = 'active';
          } else if (daysSinceLastTaskMessage <= 7) {
            taskCommunicationHealth = 'normal';
          } else {
            taskCommunicationHealth = 'stale';
          }
        }
        
        return {
          id: task.id,
          title: task.name,
          status: taskInfo.status || 'active',
          completed: isCompleted,
					assignedTo: assignedNames.length > 0 ? assignedNames.join(', ') : '-',
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
          timeTracked: taskInfo.timetracked || 0,
          
          taskMessages: allTaskMessages,
          taskMessageCount: allTaskMessages.length,
          lastTaskMessageDate: lastTaskMessageDate,
          daysSinceLastTaskMessage: daysSinceLastTaskMessage,
          taskCommunicationHealth: taskCommunicationHealth,
          messageSource: messageSource,
          contacts: taskInfo.contacts || []
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
          order: task.order1 || 0,
          taskMessages: [],
          taskMessageCount: 0,
          lastTaskMessageDate: null,
          daysSinceLastTaskMessage: null,
          taskCommunicationHealth: 'none',
          messageSource: 'error'
        };
      })
    );
	
		
    const tasksWithAssignments = await rateLimitedRequest(taskRequests, 5);
    tasksWithAssignments.sort((a, b) => a.order - b.order);
    
    const hasMore = offset + limit < tasks.length;
    const remaining = hasMore ? tasks.length - (offset + limit) : 0;
    
    // Enhanced logging with smart filtering results
    const tasksWithMessages = tasksWithAssignments.filter(t => t.taskMessageCount > 0);
    const tasksWithDirectMessages = tasksWithAssignments.filter(t => t.messageSource === 'task');
    const tasksWithSmartContextMessages = tasksWithAssignments.filter(t => t.messageSource === 'project-context');
    
    console.log('SMART TASK-RELEVANT MESSAGE RESULTS:');
    console.log(`   ${tasksWithAssignments.length} tasks processed`);
    console.log(`   ${tasksWithMessages.length} tasks with relevant messages`);
    console.log(`   ${tasksWithDirectMessages.length} tasks with direct messages`);
    console.log(`   ${tasksWithSmartContextMessages.length} tasks with smart context messages`);
    console.log(`   ${projectMessages.length} total project messages analyzed`);
    
    res.json({
      tasks: tasksWithAssignments,
      hasMore: hasMore,
      totalTasks: tasks.length,
      displayedTasks: offset + tasksWithAssignments.length,
      remaining: remaining,
      nextOffset: hasMore ? offset + limit : null,
      messageStats: {
        total: tasksWithMessages.length,
        direct: tasksWithDirectMessages.length,
        smartContext: tasksWithSmartContextMessages.length,
        projectMessages: projectMessages.length
      }
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

// Message-related API endpoints
app.get('/api/rest/project/:id/messages', async (req, res) => {
  try {
    const projectId = req.params.id;
    console.log(`=== FETCHING MESSAGES FOR PROJECT ${projectId} ===`);
    
    const messagesData = await ProWorkflowAPI.getProjectMessages(projectId);
    console.log(`Found ${messagesData.count || 0} messages for project ${projectId}`);
    
    res.json(messagesData);
  } catch (error) {
    console.error(`Error fetching messages for project ${req.params.id}:`, error);
    res.status(500).json({ 
      error: 'Failed to fetch project messages',
      messages: [],
      count: 0
    });
  }
});

app.get('/api/rest/task/:id/messages', async (req, res) => {
  try {
    const taskId = req.params.id;
    console.log(`=== FETCHING MESSAGES FOR TASK ${taskId} ===`);
    
    const messagesData = await ProWorkflowAPI.getTaskMessages(taskId);
    console.log(`Found ${messagesData.count || 0} messages for task ${taskId}`);
    
    res.json(messagesData);
  } catch (error) {
    console.error(`Error fetching messages for task ${req.params.id}:`, error);
    res.status(500).json({ 
      error: 'Failed to fetch task messages',
      messages: [],
      count: 0
    });
  }
});

// ASSIGNMENT QUEUE API ROUTES
app.get('/api/rest/project-requests', async (req, res) => {
  try {
    console.log('=== FETCHING PROJECT REQUESTS ===');
    const requestsData = await ProWorkflowAPI.getProjectRequests();
    
    console.log(`Found ${requestsData.count || 0} total project requests`);
    
    if (requestsData.projectrequests) {
      requestsData.projectrequests = requestsData.projectrequests.filter(request => 
        request.recipientgroupname === 'Creative Services'
      );
      
      console.log(`Filtered to ${requestsData.projectrequests.length} Creative Services requests`);
      
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

app.put('/api/rest/project-requests/:id/approve', async (req, res) => {
  try {
    const requestId = req.params.id;
    const assignmentData = req.body;
    
    console.log(`=== APPROVING PROJECT REQUEST ${requestId} ===`);
    console.log('Assignment data:', assignmentData);
    
    const approvalData = await ProWorkflowAPI.approveProjectRequest(requestId, assignmentData);
    console.log(`Successfully approved project request ${requestId}`);
    
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



// --- Tool executors ---
async function tool_fetchDashboardDigest({ managerId }) {
  const projectsRes = await ProWorkflowAPI.getProjects();
  const raw = projectsRes.projects || projectsRes.data || [];

  const today = new Date();
  const projects = raw.map(p => {
    const due = p.duedate || p.dueDate || null;
    const dueDays = due ? Math.floor((new Date(due) - today) / 86400000) : null;
    return {
      id: String(p.id || p.projectId || p.number),
      title: p.title,
      manager: p.owner || p.manager,
      status: p.customstatus || p.customStatus,
      statusColor: p.statusColor || p.customstatuscolor,
      startDate: p.startdate || p.startDate || null,
      dueDate: due,
      daysIdle: p.daysIdle ?? 0,
      daysSinceLastMessage: typeof p.daysSinceLastMessage === 'number' ? p.daysSinceLastMessage : null,
      lastMessageType: p.lastMessageType || null,
      dueDays
    };
  }).filter(p => (managerId ? String(p.managerId) === String(managerId) : true));

  const overdue = projects.filter(p => p.dueDate && new Date(p.dueDate) < today);
  const urgent = projects.filter(p => typeof p.dueDays === 'number' && p.dueDays >= 0 && p.dueDays <= 7);
  const staleComm = projects.filter(p => (p.daysSinceLastMessage ?? 99) > 7);

  return {
    totals: {
      projects: projects.length,
      overdue: overdue.length,
      urgent: urgent.length,
      staleComm: staleComm.length
    },
    highlights: {
      overdue: overdue.slice(0, 10),
      urgent: urgent.slice(0, 10),
      staleComm: staleComm.slice(0, 10)
    },
    projects
  };
}

async function tool_analyzeProjects({ projects = [], focus }) {
  if (!Array.isArray(projects) || projects.length === 0) {
    return { stats: { total: 0 }, notes: ["No projects provided"] };
  }


const today = new Date();
  const stats = { total: projects.length, overdue: 0, urgent: 0, noDue: 0, maxIdle: 0, avgIdle: 0 };
  let idleSum = 0;
  const notes = [];

  projects.forEach(p => {
    const due = p.dueDate || p.duedate;
    const dueDays = due ? Math.floor((new Date(due) - today) / 86400000) : null;
    if (due && new Date(due) < today) stats.overdue++;
    if (typeof dueDays === 'number' && dueDays >= 0 && dueDays <= 7) stats.urgent++;
    if (!due) stats.noDue++;
    const idle = p.daysIdle ?? 0;
    idleSum += idle;
    if (idle > stats.maxIdle) stats.maxIdle = idle;

    if (focus === 'overdue' && due && new Date(due) < today) {
      notes.push(`� ${p.title} � due ${due} (${Math.abs(dueDays)}d late)`);
    }
  });

  stats.avgIdle = projects.length ? Math.round(idleSum / projects.length) : 0;
  return { stats, notes, focus: focus || null };
}

async function tool_updateProjectStatus({ projectId, statusId }) {
  // Use customstatusid (your fixed persistence path)
  const result = await ProWorkflowAPI.makeRequest(`/projects/${projectId}`, 'PUT', { customstatusid: statusId });
  return { ok: true, result };
}

async function tool_updateTaskDate({ taskId, field, value }) {
  const result = await ProWorkflowAPI.makeRequest(`/tasks/${taskId}`, 'PUT', { [field]: value });
  return { ok: true, result };
}

async function tool_setTaskCompletion({ taskId, complete }) {
  const endpoint = complete ? `/tasks/${taskId}/complete` : `/tasks/${taskId}/reactivate`;
  const body = complete ? { completedate: new Date().toISOString().split('T')[0] } : {};
  const result = await ProWorkflowAPI.makeRequest(endpoint, 'PUT', body);
  return { ok: true, result };
}



/* 
// OLD AI Assistant Chat endpoint


// AI Assistant Chat endpoint - COMPREHENSIVE with ChatGPT and fallback
app.post('/api/chat', async (req, res) => {
  try {
    const { message, context, history } = req.body;
    
    console.log('AI Assistant Request:', message, 'Context:', context);

		console.log('? Calling ChatGPT with context:', context);
    
    // Try ChatGPT first if available
// Try ChatGPT first if available
if (process.env.OPENAI_API_KEY) {
  try {
    // Get current dashboard data for context
    let dashboardContext = '';
    
    if (context === 'assignment-queue') {
      try {
        console.log('? Fetching assignment queue data for ChatGPT context...');
        
        // Get actual project requests data
        const requestsData = await ProWorkflowAPI.getProjectRequests();
        const requests = requestsData.projectrequests || [];
        
        // Analyze the current queue
        const totalRequests = requests.length;
        const rushProjects = requests.filter(r => 
          r.title.toLowerCase().includes('rush') || 
          r.customstatus?.toLowerCase().includes('rush')
        );
        
        const overdueProjects = requests.filter(r => {
          if (!r.duedate) return false;
          return new Date(r.duedate) < new Date();
        });
        
        const urgentProjects = requests.filter(r => {
          if (!r.duedate) return false;
          const daysUntilDue = Math.floor((new Date(r.duedate) - new Date()) / (1000 * 60 * 60 * 24));
          return daysUntilDue <= 7 && daysUntilDue >= 0;
        });
        
        // Get recent requests for context
        const recentRequests = requests.slice(0, 5);
        
        dashboardContext = `CURRENT ASSIGNMENT QUEUE DATA:

Queue Summary:
- Total requests: ${totalRequests}
- RUSH projects: ${rushProjects.length}
- Overdue projects: ${overdueProjects.length}
- Due within 7 days: ${urgentProjects.length}

${rushProjects.length > 0 ? `RUSH Projects (need same-day assignment):
${rushProjects.map(r => `- "${r.title}" (Client: ${r.clientname}, Due: ${r.duedate ? new Date(r.duedate).toLocaleDateString() : 'No date'})`).join('\n')}

` : ''}${overdueProjects.length > 0 ? `OVERDUE Projects (immediate attention):
${overdueProjects.map(r => `- "${r.title}" (Client: ${r.clientname}, Due: ${new Date(r.duedate).toLocaleDateString()})`).join('\n')}

` : ''}Recent Requests:
${recentRequests.map(r => `- "${r.title}" (Client: ${r.clientname}${r.duedate ? `, Due: ${new Date(r.duedate).toLocaleDateString()}` : ''})`).join('\n')}`;
        
        console.log('? Assignment queue context prepared for ChatGPT');
        
      } catch (err) {
        console.log('? Could not fetch assignment queue data:', err.message);
        dashboardContext = 'Unable to fetch current queue data.';
      }
    }

    // Build messages array for ChatGPT
    const messages = [
      {
        role: "system",
        content: context === 'assignment-queue' 
          ? `You are a ProWorkflow assignment queue assistant for Creative Services team.

${dashboardContext}

Your team:
- Richard (EMEA clients)
- Ella (APAC clients) 
- Paul (AppSec clients)

SLA Guidelines:
- Tier 1: 5 business days (simple tasks)
- Tier 2: 10 business days (standard work)
- Tier 3: 15 business days (complex projects)
- RUSH projects: same-day assignment required

Use the CURRENT QUEUE DATA above to give specific, actionable advice. Reference actual project names, clients, and due dates when relevant. Be concise but thorough.`
          : `You are a ProWorkflow dashboard assistant. Help analyze project communication health, identify bottlenecks, and track project status. Be specific and actionable.`
      }
    ];





        // Add conversation history
        if (history && Array.isArray(history)) {
          history.slice(-6).forEach(msg => {
            messages.push({
              role: msg.role,
              content: msg.content
            });
          });
        }
        
        // Add current message
        messages.push({
          role: "user",
          content: message
        });


// Add current message
        messages.push({
          role: "user",
          content: message
        });

        // ADD DEBUG LINES HERE (after messages array is complete):
        console.log('? ChatGPT Messages being sent:');
        console.log('? System message:', messages[0].content);
        console.log('? User message:', message);
        console.log('? Context:', context);

        console.log('? Calling ChatGPT with context:', context);
        
        // Call ChatGPT
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: messages,
          max_tokens: 400,
          temperature: 0.7,
        });



        const aiReply = completion.choices[0].message.content;
        
        console.log('? ChatGPT responded:', aiReply.substring(0, 100) + '...');
        
        return res.json({ 
          response: aiReply,
          reply: { content: aiReply }, // For backward compatibility
          timestamp: new Date().toISOString(),
          context: context || 'chatgpt-intelligent-analysis'
        });
        
      } catch (chatGptError) {
        console.error('? ChatGPT Error:', chatGptError.message);
        // Fall through to contextual responses
      }
    }
    
    // Fallback to contextual responses
    console.log('? Using contextual fallback responses');
    const response = generateContextualResponse(message, context, history);
    
    res.json({ 
      response: response,
      reply: { content: response }, // For backward compatibility
      timestamp: new Date().toISOString(),
      context: context || 'fallback-contextual'
    });
    
  } catch (error) {
    console.error('AI Assistant Error:', error);
    res.status(500).json({ 
      error: 'AI Assistant temporarily unavailable',
      response: context === 'assignment-queue' 
        ? 'I can help you with assignment queue management. Please try again.'
        : 'I can help you analyze your projects. Please try again.',
      fallback: true
    });
  }
});


*/

// NEW AI Assistant Chat endpoint with GPT-5 tools
// NEW AI Assistant Chat endpoint with GPT-5 tools
	app.post('/api/chat', async (req, res) => {
		try {
			const { message, history, context } = req.body;

			// Build context as before
			const dashboardData = await getDashboardContext();
			const messages = [
				{ role: "system", content: generateProWorkflowSystemPrompt(dashboardData) },
				...(history || []).slice(-6),
				{ role: "user", content: message }
			];

			// First pass: model decides if it wants to call a tool
			const first = await openai.chat.completions.create({
				model: "gpt-5", // or "gpt-4o-mini" if needed
				messages,
				tools: CHAT_TOOLS,
				tool_choice: "auto",
				max_completion_tokens: 400
			});

			const choice = first.choices[0].message;

			// If model just answered in text, return that
			if (!choice.tool_calls || choice.tool_calls.length === 0) {
				return res.json({
					reply: { content: choice.content || "OK." },
					dashboardInsights: generateQuickInsights(dashboardData),
					timestamp: new Date().toISOString(),
					context: context || 'chat-text-only'
				});
			}

			// If model wants to call tools, run them
			const toolMsgs = [];
			for (const call of choice.tool_calls) {
				const { name } = call.function;
				const args = JSON.parse(call.function.arguments || "{}");

				console.log(`? Tool requested: ${name}`, args);

				let result;

				if (name === "fetchDashboardDigest") {
					result = await tool_fetchDashboardDigest(args);

				} else if (name === "analyzeProjects") {
					// Safety net: inject digest.projects if missing or empty
					if (!args.projects || args.projects.length === 0) {
						console.log("?? analyzeProjects called without projects � injecting digest.projects (capped at 25)");
						const digest = await tool_fetchDashboardDigest({});
						args.projects = digest.projects.slice(0, 25);
					}
					result = await tool_analyzeProjects(args);

				} else if (name === "updateProjectStatus") {
					result = await tool_updateProjectStatus(args);

				} else if (name === "updateTaskDate") {
					result = await tool_updateTaskDate(args);

				} else if (name === "setTaskCompletion") {
					result = await tool_setTaskCompletion(args);

				} else {
					result = { ok: false, error: `Unknown tool: ${name}` };
				}

				toolMsgs.push({
					role: "tool",
					tool_call_id: call.id,
					content: JSON.stringify(result)
				});
			}

			// Second pass: give tool results back to model, let it explain in natural language
			const second = await openai.chat.completions.create({
				model: "gpt-5",
				messages: [...messages, choice, ...toolMsgs],
				max_completion_tokens: 600
			});

			const finalMsg = second.choices[0].message;
			console.log('? Final reply from GPT:', finalMsg);

			return res.json({
				reply: { content: finalMsg.content || "Done." },
				dashboardInsights: generateQuickInsights(dashboardData),
				timestamp: new Date().toISOString(),
				context: context || 'chat-tools-mode'
			});

		} catch (error) {
			console.error('AI error:', error);
			const fallback = "I can analyze and suggest next steps, but I�m temporarily offline. Try again shortly.";
			res.json({
				reply: { content: `${fallback}\n\n(Note: fallback active)` },
				error: 'AI unavailable',
				timestamp: new Date().toISOString(),
				context: 'fallback'
			});
		}
	});



// Helper: Get live dashboard data for AI context - FIXED with detailed project data
async function getDashboardContext() {
  try {
    console.log('? Loading dashboard context for AI...');
    
    // Get all projects first
    const projectsData = await ProWorkflowAPI.getProjects();
    let allProjects = projectsData.projects || projectsData.data || projectsData || [];
    
    console.log(`? AI Context: Found ${allProjects.length} total projects`);

    // Get detailed data for first 50 projects (like your dashboard does)
    console.log('? Getting detailed project data for AI analysis...');
    const detailedProjectRequests = allProjects.slice(0, 50).map(project =>
      () => ProWorkflowAPI.makeRequest(`/projects/${project.id}`)
        .then(details => ({
          ...details.project,
          id: project.id,
          originalId: project.id
        }))
        .catch(() => {
          console.warn(`Failed to get details for project ${project.id}`);
          return null;
        })
    );

    // Use your existing rate-limited request function
    const detailedProjects = await rateLimitedRequest(detailedProjectRequests, 8);
    const validProjects = detailedProjects.filter(p => p !== null);

    console.log(`? Got detailed data for ${validProjects.length} projects`);

    // Now filter using the detailed project data (same logic as your dashboard)
    const teamProjects = validProjects.filter(project => {
      const managerId = Number(project.managerid);
      const isTeamProject = !Number.isNaN(managerId) && YOUR_TEAM_MANAGER_IDS.includes(managerId);
      if (isTeamProject) {
        console.log(`? Team project: ${project.number} - ${project.title} (Manager: ${project.managername}, ID: ${managerId})`);
      }
      return isTeamProject;
    });

    console.log(`? AI Context: ${teamProjects.length} team projects after filtering`);

    // Calculate project health metrics
    const staleProjects = teamProjects.filter(p => {
      const lastModified = p.lastmodifiedutc ? new Date(p.lastmodifiedutc) : null;
      if (!lastModified) return false;
      const daysSince = Math.floor((new Date() - lastModified) / (1000 * 60 * 60 * 24));
      return daysSince > 7;
    });

    const overdueProjects = teamProjects.filter(p => {
      const dueDate = p.duedate ? new Date(p.duedate) : null;
      return dueDate && dueDate < new Date();
    });

    const rushProjects = teamProjects.filter(p => 
      (p.customstatus || '').toLowerCase().includes('rush')
    );

    const inProgressProjects = teamProjects.filter(p => 
      (p.customstatus || '').toLowerCase().includes('progress')
    );

    const queueProjects = teamProjects.filter(p => 
      (p.customstatus || '').toLowerCase().includes('queue')
    );

    const managers = [...new Set(teamProjects.map(p => p.managername).filter(Boolean))];

    console.log(`? AI Metrics: ${teamProjects.length} total, ${staleProjects.length} stale, ${overdueProjects.length} overdue, ${rushProjects.length} rush`);

    return {
      totalProjects: teamProjects.length,
      staleProjects: staleProjects.length,
      overdueProjects: overdueProjects.length,
      rushProjects: rushProjects.length,
      inProgressProjects: inProgressProjects.length,
      queueProjects: queueProjects.length,
      managers: managers,
      topProjects: teamProjects.slice(0, 5).map(p => ({
        number: p.number,
        title: p.title?.substring(0, 50) + (p.title?.length > 50 ? '...' : ''),
        status: p.customstatus,
        owner: p.managername,
        daysIdle: p.lastmodifiedutc ? Math.floor((new Date() - new Date(p.lastmodifiedutc)) / (1000 * 60 * 60 * 24)) : 0
      })),
      statusBreakdown: getStatusBreakdown(teamProjects)
    };
  } catch (error) {
    console.error('? Error getting dashboard context:', error);
    return {
      totalProjects: 0,
      staleProjects: 0,
      overdueProjects: 0,
      rushProjects: 0,
      managers: [],
      topProjects: [],
      error: 'Unable to load current data',
      errorMessage: error.message
    };
  }
}






// Helper: Generate smart system prompt with real data
function generateProWorkflowSystemPrompt(dashboardData) {
  return `
You are a ProWorkflow triage assistant for the Creative Services team.

## How to work:
- **Always call \`fetchDashboardDigest\` first** to get the current list of projects.
- Then, when analyzing (e.g. overdue, urgent, stale), call \`analyzeProjects\` and pass the \`projects\` array from the digest.
- Do not call \`analyzeProjects\` with an empty or missing projects array.
- If you need to propose a change (status update, due date adjustment, task completion), use the correct tool (\`updateProjectStatus\`, \`updateTaskDate\`, \`setTaskCompletion\`).
- Only make write changes if the user clearly asks, or after you propose and the user confirms.
- Keep answers brief and actionable: use bullets and highlight counts (e.g. "2 overdue, 3 urgent").
- Always explain *why* an item is flagged (e.g. "10 days overdue, client waiting").

## Current Context Summary:
- Total projects: ${dashboardData.totalProjects || 0}
- Overdue: ${dashboardData.overdueProjects || 0}
- Stale: ${dashboardData.staleProjects || 0}
- Recent examples: ${dashboardData.recentTitles ? dashboardData.recentTitles.join(', ') : 'n/a'}

Remember: prefer tool calls over inventing answers. 
  `;
}

// Helper: Quick insights for dashboard
function generateQuickInsights(data) {
  const insights = [];
  
  if (data.staleProjects > 0) {
    insights.push(`?? ${data.staleProjects} projects need communication attention`);
  }
  
  if (data.overdueProjects > 0) {
    insights.push(`? ${data.overdueProjects} overdue projects require immediate action`);
  }
  
  if (data.rushProjects > 0) {
    insights.push(`? ${data.rushProjects} RUSH projects in progress`);
  }
  
  if (data.totalProjects > 20) {
    insights.push(`? High project load: ${data.totalProjects} active projects`);
  }
  
  return insights;
}

// Helper: Get status breakdown
function getStatusBreakdown(projects) {
  const statusCounts = {};
  projects.forEach(p => {
    const status = p.customstatus || 'Unknown';
    statusCounts[status] = (statusCounts[status] || 0) + 1;
  });
  return statusCounts;
}





// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    service: 'ProWorkflow Combined Suite',
    status: 'OK', 
    timestamp: new Date().toISOString(),
    cacheSize: cache.size,
    routes: ['Dashboard: /', 'Assignment Queue: /assignment-queue'],
    security: 'ENABLED',
    user: req.session?.user?.username || 'anonymous'
  });
});

// Enhanced cache status endpoint with smart cache stats
app.get('/api/cache-status', (req, res) => {
  const cacheStats = smartCache.getStats();
  
  const entries = Array.from(smartCache.cache.entries()).map(([key, value]) => ({
    key: key.length > 50 ? key.substring(0, 50) + '...' : key,
    type: value.cacheType,
    age: Math.round((Date.now() - value.timestamp) / 1000) + 's',
    size: JSON.stringify(value.data).length + ' chars',
    dependencies: value.dependencies || []
  }));

  res.json({
    service: 'Enhanced ProWorkflow Smart Cache',
    stats: cacheStats,
    totalCached: smartCache.cache.size,
    dependencyTracking: smartCache.dependencies.size,
    entries: entries.slice(0, 15), // Show first 15 entries
    cacheTypes: {
      'projects-list': '3 min',
      'project-details': '5 min', 
      'status-options': '15 min',
      'task-details': '2 min',
      'messages': '1 min',
      'team-members': '30 min'
    }
  });
});

		
// Enhanced debug endpoint
app.get('/api/cache-debug', (req, res) => {
  const debugInfo = smartCache.getDebugInfo();
  
  res.json({
    service: 'SmartCache Debug Console',
    timestamp: new Date().toISOString(),
    ...debugInfo,
    performance: {
      memoryUsage: process.memoryUsage(),
      uptime: process.uptime() + 's'
    }
  });
});		
		
		
// Security validation function
function validateSecurityConfig() {
  const requiredEnvVars = [
    'PROWORKFLOW_API_KEY',
    'PROWORKFLOW_USERNAME', 
    'PROWORKFLOW_PASSWORD'
  ];
  
  const missing = requiredEnvVars.filter(env => !process.env[env]);
  
  if (missing.length > 0) {
    console.error('Missing required ProWorkflow environment variables:');
    missing.forEach(env => console.error(`   - ${env}`));
    return false;
  }
  
  // Check if demo password hashes are still being used
  if (!process.env.ADMIN_PASSWORD_HASH || process.env.ADMIN_PASSWORD_HASH.includes('placeholder')) {
    console.warn('Using demo password hash - generate secure passwords for production');
    console.warn('Run: const bcrypt = require("bcrypt"); console.log(bcrypt.hashSync("your_password", 10));');
  }
  
  console.log('Basic security configuration validated');
  return true;
}

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('ProWorkflow Suite Error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`ProWorkflow Combined Suite running on port ${PORT}`);
  console.log(`Login at: http://localhost:${PORT}/login`);
  console.log(`Dashboard available at: /`);
  console.log(`Assignment Queue available at: /assignment-queue`);
  console.log(`AI Assistant ready (configure API keys for full functionality)`);
  console.log(`Security: Authentication required, rate limiting enabled, Helmet CSP configured`);
  
  if (!validateSecurityConfig()) {
    console.error('CONFIGURATION INCOMPLETE - See errors above');
  } else {
    console.log('Server started successfully with security enabled');
  }
});

module.exports = app;