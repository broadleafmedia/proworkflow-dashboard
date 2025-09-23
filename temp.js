        let allProjects = [];
        let availableManagers = [];
        let expandedProjects = new Set();
        let currentSort = { field: 'idle', direction: 'desc' };
        let chatHistory = [];
// TODO: Replace with the actual IDs from your PWF account
const ACTIVE_STATUS_ID = 1;     // check a task that is "Active" to confirm
const COMPLETE_STATUS_ID = 3;   // check a task that is "Complete" to confirm

			
			
			
// PHASE 2: Status Update Functionality

let statusOptionsCache = null;

async function loadStatusOptions() {
    // Return cached if valid
    if (statusOptionsCache && statusOptionsCache.length > 0) {
        return statusOptionsCache;
    }

    try {
        console.log('🔄 Loading status options...');
        const response = await fetch('/api/rest/status-options');
        const data = await response.json();

        if (data.statuses && data.statuses.length > 0) {
            statusOptionsCache = data.statuses;
            console.log(`✅ Loaded ${statusOptionsCache.length} status options`);
            return statusOptionsCache;
        } else {
            console.warn('⚠️ No statuses returned from API');
            return [];
        }
    } catch (error) {
        console.error('❌ Failed to load status options:', error);
        return [];
    }
}

			
			  // 🔹 Helper to append messages to the chat window
    function addMessage(text, sender) {
      const messages = document.getElementById('chatMessages');

      const messageDiv = document.createElement('div');
      messageDiv.className = `chat-message ${sender}`;
      messageDiv.textContent = text;

      messages.appendChild(messageDiv);
      messages.scrollTop = messages.scrollHeight; // auto-scroll
    }

    // 🔹 Update sendMessage to use the backend API
    async function sendMessage() {
      const input = document.getElementById('chatInput');
      const userMessage = input.value.trim();
      if (!userMessage) return;

      addMessage(userMessage, "user");
      input.value = "";

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: userMessage, history: chatHistory })
        });
        const data = await response.json();
        const reply = data.reply.content || "No reply";

        addMessage(reply, "agent");
        chatHistory.push({ role: "user", content: userMessage });
        chatHistory.push({ role: "assistant", content: reply });
      } catch (err) {
        addMessage("⚠️ Error talking to assistant", "agent");
      }
    }
			
			    // Event listeners
    document.addEventListener('DOMContentLoaded', function() {
			
        // Create ProWorkflow-style dropdown
        function createStatusDropdown(statuses, currentStatusText, onSelect) {
            const dropdown = document.createElement('div');
            dropdown.className = 'pwf-status-dropdown';
            
            statuses.forEach(status => {
                const item = document.createElement('div');
                item.className = 'status-dropdown-item';
                item.style.background = '#' + status.color;
                item.style.color = 'white';
                item.textContent = status.name;
                
                if (status.name === currentStatusText) {
                    item.classList.add('current');
                }
                
                item.onclick = () => onSelect(status);
                dropdown.appendChild(item);
            });
            
            return dropdown;
        }

// FIXED: Status dropdown positioning that follows scroll
document.addEventListener('click', async function(e) {
    // Remove any existing dropdowns
    document.querySelectorAll('.pwf-status-dropdown').forEach(d => d.remove());
    
    if (e.target.classList.contains('status-badge')) {
        e.preventDefault();
        e.stopPropagation();
        
        const statusBadge = e.target;
        const projectId = statusBadge.getAttribute('data-project-id');
        const currentStatusText = e.target.textContent.trim();
        
        console.log(`📋 Status badge clicked - Project: ${projectId}, Current: ${currentStatusText}`);
        
        // Load status options
        const statuses = await loadStatusOptions();
        if (statuses.length === 0) {
            alert('Unable to load status options. Please try again.');
            return;
        }
        
        // Create dropdown
        const dropdown = createStatusDropdown(statuses, currentStatusText, async (selectedStatus) => {
            dropdown.remove();
            await updateProjectStatus(projectId, selectedStatus, e.target);
        });
        
// Position dropdown near the clicked badge (FIXED for scroll)
        document.body.appendChild(dropdown);
        const rect = e.target.getBoundingClientRect();

        // Account for page scroll
        dropdown.style.position = 'absolute';
        dropdown.style.left = (rect.left + window.scrollX) + 'px';
        dropdown.style.top = (rect.bottom + window.scrollY + 5) + 'px';
        dropdown.style.zIndex = '10000';
        
        // Ensure dropdown stays within viewport
        const dropdownRect = dropdown.getBoundingClientRect();
        if (dropdownRect.right > window.innerWidth) {
            dropdown.style.left = (window.innerWidth - dropdownRect.width - 10 + window.scrollX) + 'px';
        }
        if (dropdownRect.bottom > window.innerHeight) {
            dropdown.style.top = (rect.top + window.scrollY - dropdownRect.height - 5) + 'px';
        }
    }
});

// ENHANCED: Close dropdown on scroll to prevent positioning issues
window.addEventListener('scroll', function() {
    document.querySelectorAll('.pwf-status-dropdown').forEach(d => d.remove());
});

// Also close on window resize
window.addEventListener('resize', function() {
    document.querySelectorAll('.pwf-status-dropdown').forEach(d => d.remove());
});

// Update project status from dashboard
async function updateProjectStatus(projectId, statusObj, badgeElement) {
  console.log('WILL UPDATE → project', projectId, 'to status NAME:', statusObj?.name, 'ID:', statusObj?.id);
	console.log('=== updateProjectStatus START ===');
    console.log('Project ID:', projectId, 'Status:', statusObj);

    if (!projectId) {
        alert(`Cannot update status: Invalid project ID (${projectId}). Please refresh the page and try again.`);
        return;
    }

    const apiUrl = `/api/rest/project/${projectId}/status`;
    console.log('API URL:', apiUrl);

    // Optimistic UI update
    const originalText = badgeElement.textContent;
    const originalColor = badgeElement.style.background;

    badgeElement.textContent = statusObj.name;
    badgeElement.style.background = '#' + statusObj.color;

    try {
        const response = await fetch(apiUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ statusId: statusObj.id })
        });

        const result = await response.json();
        console.log('Response:', result);

if (result.success) {
    console.log('✅ Status updated successfully');

    // Refresh just this project row
    setTimeout(async () => {
        try {
            const res = await fetch(`/api/rest/project/${projectId}`);
            const data = await res.json();
					console.log('🔍 Reloaded project data:', data);


            if (data.project) {
                console.log('🔄 Updated project data:', data.project);

                // Update badge text + color in case backend differs
                badgeElement.textContent = data.project.customstatus || statusObj.name;
                if (data.project.customstatuscolor) {
                    badgeElement.style.background = '#' + data.project.customstatuscolor;
                }
            }
        } catch (err) {
            console.error('Failed to reload single project', err);
        }
    }, 500);
}

			
			else {
            throw new Error(result.error || 'Update failed');
        }
    } catch (error) {
        console.error('❌ Error updating status:', error);

        // Rollback optimistic update
        badgeElement.textContent = originalText;
        badgeElement.style.background = originalColor;

        alert('Failed to update status: ' + error.message);
    }

    console.log('=== updateProjectStatus END ===');
}
		
			
        // THREADING HELPER FUNCTIONS
        function buildMessageThreads(messages) {
            const messageMap = new Map();
            const rootMessages = [];
            
            const sortedMessages = messages.sort((a, b) => new Date(a.date) - new Date(b.date));
            
            sortedMessages.forEach(message => {
                messageMap.set(message.id, {
                    ...message,
                    replies: []
                });
            });
            
            sortedMessages.forEach(message => {
                const messageObj = messageMap.get(message.id);
                
                if (message.originalmessageid && messageMap.has(message.originalmessageid)) {
                    const parent = messageMap.get(message.originalmessageid);
                    parent.replies.push(messageObj);
                } else {
                    rootMessages.push(messageObj);
                }
            });
            
            return rootMessages;
        }

        function renderThreadedMessages(threadedMessages, tasks = []) {
            return threadedMessages.map(message => {
                let messageHtml = `
                    <div class="message-item">
                        <img src="${message.authorimage}" alt="${message.authorname}" class="message-avatar" onerror="this.style.display='none'">
                        <div class="message-content">
                            <div class="message-header">
                                <span class="message-author-name message-author ${message.authortype}">${message.authorname}</span>
                                <span class="message-date">${new Date(message.date).toLocaleDateString()} ${new Date(message.date).toLocaleTimeString()}</span>
                            </div>
                            <div class="message-text">${stripHtmlTags(message.content)}</div>
                            ${message.files && message.files.length > 0 ? `
                                <div class="message-files">
                                    ${message.files.map(file => `
                                        <a href="${file.link}" target="_blank" class="message-file">
                                            📎 ${file.name} (${formatFileSize(file.size)})
                                        </a>
                                    `).join('')}
                                </div>
                            ` : ''}
                        </div>
                    </div>
                `;
                
                if (message.replies && message.replies.length > 0) {
                    const repliesHtml = message.replies.map(reply => `
                        <div class="message-item thread-reply">
                            <img src="${reply.authorimage}" alt="${reply.authorname}" class="message-avatar" onerror="this.style.display='none'">
                            <div class="message-content">
                                <div class="message-header">
                                    <span class="message-author-name message-author ${reply.authortype}">${reply.authorname}</span>
                                    <span class="message-date">${new Date(reply.date).toLocaleDateString()} ${new Date(reply.date).toLocaleTimeString()}</span>
                                </div>
                                <div class="message-text">${stripHtmlTags(reply.content)}</div>
                                ${reply.files && reply.files.length > 0 ? `
                                    <div class="message-files">
                                        ${reply.files.map(file => `
                                            <a href="${file.link}" target="_blank" class="message-file">
                                                📎 ${file.name} (${formatFileSize(file.size)})
                                            </a>
                                        `).join('')}
                                    </div>
                                ` : ''}
                            </div>
                        </div>
                    `).join('');
                    
                    messageHtml += repliesHtml;
                }
                
                return messageHtml;
            }).join('');
        }

        function stripHtmlTags(html) {
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = html;
            return tempDiv.textContent || tempDiv.innerText || '';
        }

        function formatFileSize(bytes) {
            if (bytes === 0) return '0 Bytes';
            const k = 1024;
            const sizes = ['Bytes', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        }

        async function loadProjects() {
					    console.log("🚀 loadProjects() triggered, about to fetch");
					    console.log('🚀 loadProjects() function triggered');

            const manager = document.getElementById('managerSelect').value;
            
            document.getElementById('projectsContent').innerHTML = '<div class="loading">Loading projects...</div>';
            
            try {
                let url = '/api/rest/projects-table';
                const params = new URLSearchParams();
                
                if (manager) params.append('manager', manager);
                if (currentSort.field) params.append('sort', currentSort.field);
                
                if (params.toString()) {
                    url += '?' + params.toString();
                }
                
                console.log('Loading with sort:', currentSort.field, currentSort.direction);
                
                const response = await fetch(url);
                const data = await response.json();
                
                allProjects = data.projects || [];
                availableManagers = data.availableManagers || [];
                
                console.log('✅ Projects loaded:', allProjects.length);
                
                updateManagerDropdown();
                updateStats(data);
                renderProjects(allProjects);
                
            } catch (error) {
                console.error('❌ Error loading projects:', error);
                document.getElementById('projectsContent').innerHTML = 
                    '<div class="no-projects">Error loading projects. Please try again.</div>';
            }
        }

        function sortByHeader(field) {
            console.log('Sorting by header:', field);
            
            if (currentSort.field === field) {
                currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
            } else {
                currentSort.field = field;
                currentSort.direction = 'asc';
            }
            
            const dropdown = document.getElementById('sortSelect');
            dropdown.value = field;
            
            loadProjects();
        }

        function getProjectCommunication(project) {
            if (!project.lastMessageDate) {
                return {
                    status: 'none',
                    text: 'No Messages',
                    class: 'none',
                    extraInfo: ''
                };
            }
            
            const days = project.daysSinceLastMessage;
            let status, text, className;
            
            if (days <= 2) {
                status = 'active';
                text = 'Active';
                className = 'active';
            } else if (days <= 7) {
                status = 'normal';
                text = 'Normal';
                className = 'normal';
            } else {
                status = 'stale';
                text = 'Stale';
                className = 'stale';
            }
            
            const authorClass = project.lastMessageType === 'staff' ? 'staff' : 'client';
            const extraInfo = `<span class="message-author ${authorClass}">${project.lastMessageAuthor}</span> • ${days}d ago`;
            
            return {
                status: status,
                text: text,
                class: className,
                extraInfo: extraInfo
            };
        }

			
			
// Fixed renderProjects function - extract this section from your dashboard.html
function renderProjects(projects) {
    console.log('🎨 Rendering projects:', projects.length);
    
    if (!projects || projects.length === 0) {
        document.getElementById('projectsContent').innerHTML = 
            '<div class="no-projects">No projects found with current filters.</div>';
        return;
    }

    const container = document.getElementById('projectsContent');
    container.innerHTML = '';
    
    const table = document.createElement('table');
    table.className = 'projects-table';
    
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    
    const headerConfig = [
        { text: '', field: null },
        { text: 'Project #', field: 'number' },
        { text: 'Title', field: 'title' },
        { text: 'Manager', field: 'manager' },
        { text: 'Custom Status', field: 'status' },
        { text: 'Start', field: null },
        { text: 'Due Date', field: 'dueDate' },
        { text: 'Communication', field: 'communication' },
        { text: 'Days Idle', field: 'idle' }
    ];

    headerConfig.forEach(config => {
        const th = document.createElement('th');
        th.textContent = config.text;
        
        if (config.field) {
            th.className = 'sortable';
            th.onclick = () => sortByHeader(config.field);
            
            const indicator = document.createElement('span');
            indicator.className = 'sort-indicator';
            
            if (currentSort.field === config.field) {
                indicator.className += ' active';
                indicator.textContent = currentSort.direction === 'asc' ? ' ↑' : ' ↓';
            } else {
                indicator.textContent = ' ↕';
            }
            
            th.appendChild(indicator);
        }
        
        headerRow.appendChild(th);
    });

    thead.appendChild(headerRow);
    table.appendChild(thead);
    
    const tbody = document.createElement('tbody');
    
    projects.forEach((project, index) => {
        const row = document.createElement('tr');
        
        const isRush = project.customStatus && project.customStatus.toLowerCase().includes('rush');
        if (isRush) {
            row.style.backgroundColor = '#fef3c7';
        }
        
        const expandCell = document.createElement('td');
        const expandBtn = document.createElement('button');
        expandBtn.className = 'expand-btn';
        expandBtn.onclick = () => toggleProject(project.projectId, expandBtn);
        
        const arrow = document.createElement('div');
        arrow.className = 'expand-arrow';
        expandBtn.appendChild(arrow);
        expandCell.appendChild(expandBtn);
        row.appendChild(expandCell);
        
        const communicationInfo = getProjectCommunication(project);
        
        // FIXED: Use project.id consistently (confirmed via API test)
        console.log(`🔍 Project ${index}: ID=${project.id}, Number=${project.number}, Title=${project.title}`);
        
        const cells = [
            { content: project.number, class: 'project-number' },
            { 
                content: project.title, 
                link: project.projectUrl, 
                class: 'project-link'
            },
            { content: project.owner },
            { 
                content: project.customstatus || project.customStatus || 'Unknown', 
                style: `background: ${project.statusColor}; color: white;`, 
                class: 'status-badge', 

dataProjectId: project.projectId || project.originalId || project.id || project.number
							
							
            },
            { content: project.startdate || '-' },
            { content: project.dueDate || '-' },
            { 
                content: communicationInfo.text, 
                class: `communication-badge ${communicationInfo.class}`,
                extraContent: communicationInfo.extraInfo
            },
            { content: project.daysIdle > 0 ? project.daysIdle + ' days' : 'Active', class: getDaysClass(project.daysIdle) }
        ];

        cells.forEach(cellData => {
            const td = document.createElement('td');
            
            if (cellData.link) {
                const link = document.createElement('a');
                link.href = cellData.link;
                link.target = '_blank';
                link.className = cellData.class || '';
                link.textContent = cellData.content;
                td.appendChild(link);
            } else {
                const span = document.createElement('span');
                if (cellData.class) span.className = cellData.class;
                if (cellData.style) span.setAttribute('style', cellData.style);
if (cellData.dataProjectId) span.setAttribute('data-project-id', cellData.dataProjectId);
                span.textContent = cellData.content;
                td.appendChild(span);
                
                if (cellData.extraContent) {
                    const extraDiv = document.createElement('div');
                    extraDiv.className = 'last-message-info';
                    extraDiv.innerHTML = cellData.extraContent;
                    td.appendChild(extraDiv);
                }
            }
            
            row.appendChild(td);
        });

        tbody.appendChild(row);
        
        const expansionRow = document.createElement('tr');
        const expansionCell = document.createElement('td');
        expansionCell.colSpan = 9;
        
        const expansionSection = document.createElement('div');
        expansionSection.className = 'project-expansion';
        expansionSection.id = `expansion-${project.projectId}`;
        
        expansionCell.appendChild(expansionSection);
        expansionRow.appendChild(expansionCell);
        tbody.appendChild(expansionRow);
    });
    
    table.appendChild(tbody);
    container.appendChild(table);
    
    console.log('✅ Projects rendered successfully');
}
			
			
// NEW: Missing toggleProject function that renderProjects is calling
async function toggleProject(projectId, expandBtn) {
    const expansionSection = document.getElementById(`expansion-${projectId}`);
    
    if (expandedProjects.has(projectId)) {
        // Collapse
        expandedProjects.delete(projectId);
        expansionSection.classList.remove('expanded');
        expandBtn.classList.remove('expanded');
    } else {
        // Expand and load content
        expandedProjects.add(projectId);
        expansionSection.classList.add('expanded');
        expandBtn.classList.add('expanded');
        
        // Load enhanced project content
        expansionSection.innerHTML = '<div class="loading">Loading project details...</div>';
        await loadProjectExpansion(projectId);
    }
}

// NEW: Enhanced project expansion with tasks
async function loadProjectExpansion(projectId) {
    try {
        // Load project details, tasks, and messages in parallel
        const [projectResponse, tasksResponse, messagesResponse] = await Promise.all([
            fetch(`/api/rest/project/${projectId}`),
            fetch(`/api/rest/project/${projectId}/tasks`),
            fetch(`/api/rest/project/${projectId}/messages`)
        ]);
        
        const projectData = await projectResponse.json();
        const tasksData = await tasksResponse.json();
        const messagesData = await messagesResponse.json();
        
        const expansionSection = document.getElementById(`expansion-${projectId}`);
        
        let html = '<div class="expansion-content">';
        
        // Project Description
        if (projectData.project?.description) {
            html += `
                <div class="message-timeline">
                    <div class="timeline-header">
                        <div class="timeline-title">Project Description</div>
                    </div>
                    <div style="padding: 1rem; color: #475569; line-height: 1.4;">
                        ${projectData.project.description}
                    </div>
                </div>
            `;
        }
        
// Recent Messages with Threading (FIXED: Newest at bottom)
        if (messagesData.messages?.length > 0) {
            const recentMessages = messagesData.messages
                .sort((a, b) => new Date(a.date) - new Date(b.date))  // Changed: a.date - b.date (oldest first)
                .slice(-5);  // Changed: Take last 5 instead of first 5
            
            html += `
                <div class="message-timeline">
                    <div class="timeline-header">
                        <div class="timeline-title">Recent Messages (${messagesData.count || 0} total)</div>
                    </div>
                    ${renderRecentMessages(recentMessages, tasksData.tasks)}
                </div>
            `;
        }
        
        // Tasks Table
        if (tasksData.tasks?.length > 0) {
            const tasksToShow = tasksData.tasks.slice(0, 20);
            
            html += `
                <div class="message-timeline">
                    <div class="timeline-header">
                        <div class="timeline-title">Tasks (${tasksData.tasks.length} total)</div>
                    </div>
                    ${renderTasksTable(tasksToShow, projectId)}
                </div>
            `;
            
            if (tasksData.tasks.length > 20) {
                html += `<div style="padding: 1rem; color: #64748b; font-style: italic; text-align: center;">Showing first 20 of ${tasksData.tasks.length} tasks</div>`;
            }
        } else {
            html += `
                <div class="message-timeline">
                    <div class="timeline-header">
                        <div class="timeline-title">Tasks</div>
                    </div>
                    <div style="padding: 2rem; text-align: center; color: #64748b; font-style: italic;">No tasks found for this project</div>
                </div>
            `;
        }
        
        html += '</div>';
        expansionSection.innerHTML = html;
        
    } catch (error) {
        console.error('Error loading project expansion:', error);
        const expansionSection = document.getElementById(`expansion-${projectId}`);
        expansionSection.innerHTML = '<div class="expansion-content"><div style="color: #ef4444; padding: 2rem; text-align: center;">Error loading project details</div></div>';
    }
}

function renderRecentMessages(messages, tasks = []) {
    // Build message threads
    const messageMap = new Map();
    const rootMessages = [];
    
    // First pass: create message objects
    messages.forEach(message => {
        messageMap.set(message.id, {
            ...message,
            replies: []
        });
    });
    
    // Second pass: build thread structure
    messages.forEach(message => {
        const messageObj = messageMap.get(message.id);
        
        if (message.originalmessageid && messageMap.has(message.originalmessageid)) {
            // This is a reply - add to parent's replies
            const parent = messageMap.get(message.originalmessageid);
            parent.replies.push(messageObj);
        } else {
            // This is a root message
            rootMessages.push(messageObj);
        }
    });
    
    // Sort root messages by date (oldest first)
    rootMessages.sort((a, b) => new Date(a.date) - new Date(b.date));
    
    // Sort replies within each thread by date (oldest first)
    rootMessages.forEach(rootMessage => {
        rootMessage.replies.sort((a, b) => new Date(a.date) - new Date(b.date));
    });
    
    // Render threaded messages
    return rootMessages.map(rootMessage => {
        let html = renderSingleMessage(rootMessage, tasks, false); // false = not a reply
        
        // Add replies
        if (rootMessage.replies.length > 0) {
            html += rootMessage.replies.map(reply => 
                renderSingleMessage(reply, tasks, true) // true = is a reply
            ).join('');
        }
        
        return html;
    }).join('');
}

// Helper function to render a single message
function renderSingleMessage(message, tasks, isReply) {
    const messageDate = new Date(message.date).toLocaleDateString();
    const messageTime = new Date(message.date).toLocaleTimeString();
    
    // Find task title for root messages only
    let taskTitle = null;
    if (!isReply && tasks && tasks.length > 0) {
        const messageContent = (message.content || '').toLowerCase();
        
        const taskMatches = tasks.map(task => {
            const taskTitleLower = (task.title || '').toLowerCase();
            let score = 0;
            
            const taskWords = taskTitleLower.split(/[\s\-_,()[\]{}|\\/:;"'<>?=+*&^%$#@!~`]+/)
                .filter(word => word.length > 2)
                .filter(word => !['the', 'and', 'or', 'but', 'for', 'with', 'from', 'this', 'that'].includes(word));
            
            taskWords.forEach(word => {
                if (messageContent.includes(word)) {
                    score += word.length;
                }
            });
            
            return { task, score };
        });
        
        const bestMatch = taskMatches.find(match => match.score > 0);
        if (bestMatch) {
            taskTitle = bestMatch.task.title;
        }
    }
    
return `
    <div class="message-item ${isReply ? 'thread-reply' : 'root-message'}">
        <div class="message-content">
            <div class="message-header">
                    <span class="message-author-name message-author ${message.authortype}">
                        ${isReply ? '↳ ' : ''}${message.authorname}
                    </span>
                    <span class="message-date">${messageDate} ${messageTime}</span>
                </div>
                ${taskTitle ? `
                    <div class="message-task-context">
                        📋 ${taskTitle}
                    </div>
                ` : ''}
                <div class="message-text">${stripHtmlTags(message.content)}</div>
                ${message.files && message.files.length > 0 ? `
                    <div class="message-files">
                        ${message.files.map(file => `
                            <a href="${file.link}" target="_blank" class="message-file">
                                📎 ${file.name} (${formatFileSize(file.size) || 'unknown size'})
                            </a>
                        `).join('')}
                    </div>
                ` : ''}
            </div>
        </div>
    `;
}


function renderTasksTable(tasks, projectId) {
    let html = `
        <table class="projects-table">
            <thead>
                <tr>
					          <th style="width: 40px;"></th>
                    <th style="width: 60px;">Number</th>
                    <th style="width: 250px;">Title</th>
                    <th style="width: 100px;">Priority</th>
                    <th style="width: 120px;">Assigned</th>
                    <th style="width: 100px;">Start Date</th>
                    <th style="width: 100px;">Due Date</th>
                    <th style="width: 80px;">Complete</th>
                    <th style="width: 80px;">Time Alloc</th>
                    <th style="width: 80px;">Time Spent</th>
                    <th style="width: 60px;">Messages</th>
                </tr>
            </thead>
            <tbody>
    `;
    
    tasks.forEach(task => {
        const isCompleted = task.status === 'complete';
        const isOverdue = task.dueDate && new Date(task.dueDate) < new Date() && !isCompleted;
        
        // Format dates for editing
        const startDateISO = task.startDate ? new Date(task.startDate).toISOString().split('T')[0] : '';
        const dueDateISO = task.dueDate ? new Date(task.dueDate).toISOString().split('T')[0] : '';
        const startDateDisplay = task.startDate ? new Date(task.startDate).toLocaleDateString() : '-';
        const dueDateDisplay = task.dueDate ? new Date(task.dueDate).toLocaleDateString() : '-';
        
html += `
    <tr style="${isOverdue ? 'background-color: #fef2f2;' : ''} ${isCompleted ? 'opacity: 0.7;' : ''}">
        <td>
            <button class="expand-btn task-expand-btn" onclick="toggleTask(${task.id}, this)">
                <div class="expand-arrow"></div>
            </button>
        </td>
        <td>${task.order || task.order1 || index + 1}</td>
        <td style="${isCompleted ? 'text-decoration: line-through;' : ''}">${task.title}</td>
        <td>${task.priority || 'Normal'}</td>
        <td>${task.assignedTo || 'Unassigned'}</td>
        <td>
            <span class="editable-date" onclick="editTaskDate('start', ${task.id}, '${startDateISO}', this)">
                ${startDateDisplay}
            </span>
        </td>
        <td style="${isOverdue ? 'color: #ef4444; font-weight: 600;' : ''}">
            <span class="editable-date" onclick="editTaskDate('due', ${task.id}, '${dueDateISO}', this)">
                ${dueDateDisplay}
            </span>
        </td>
        <td style="text-align: center;">
            <input type="checkbox" ${isCompleted ? 'checked' : ''} 
                   onchange="updateTaskCompletion(${task.id}, this.checked, this)"
                   style="transform: scale(1.2); cursor: pointer;">
        </td>
        <td style="font-family: monospace; font-size: 0.8rem;">${task.timeAllocated || '0:00'}</td>
        <td style="font-family: monospace; font-size: 0.8rem;">${task.timeSpent || '0:00'}</td>
        <td>💬</td>
    </tr>
`;
    });
    
    html += '</tbody></table>';
    return html;
}

// Task date editing
function editTaskDate(dateType, taskId, currentValue, element) {
    const input = document.createElement('input');
    input.type = 'date';
    input.value = currentValue;
    input.style.cssText = 'position: absolute; z-index: 1000; padding: 0.5rem; border: 2px solid #667eea; border-radius: 4px;';
    
    const rect = element.getBoundingClientRect();
    input.style.left = rect.left + 'px';
    input.style.top = (rect.bottom + window.scrollY + 5) + 'px';
    
    document.body.appendChild(input);
    input.focus();
    input.click();
    
    input.onchange = async () => {
        if (input.value !== currentValue) {
            await updateTaskDate(taskId, dateType, input.value);
            element.textContent = input.value ? new Date(input.value).toLocaleDateString() : '-';
        }
        document.body.removeChild(input);
    };
    
    input.onblur = () => {
        setTimeout(() => {
            if (document.body.contains(input)) {
                document.body.removeChild(input);
            }
        }, 200);
    };
}

async function updateTaskDate(taskId, dateType, newDate) {
    try {
        const field = dateType === 'start' ? 'startdate' : 'duedate';
        const response = await fetch(`/api/rest/task/${taskId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [field]: newDate })
        });
        
        const result = await response.json();
        if (!result.success) {
            throw new Error(result.error || 'Update failed');
        }
        
        console.log(`Updated task ${taskId} ${dateType} date`);
    } catch (error) {
        console.error(`Error updating ${dateType} date:`, error);
        alert(`Failed to update ${dateType} date: ${error.message}`);
    }
}


async function updateTaskCompletion(taskId, isCompleted, checkboxElement) {
  const endpoint = isCompleted
    ? `/api/rest/task/${taskId}/complete`
    : `/api/rest/task/${taskId}/reactivate`;

  const body = isCompleted
    ? JSON.stringify({ completedate: new Date().toISOString().split('T')[0] })
    : null;

  try {
    const response = await fetch(endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body
    });

    const result = await response.json();
    console.log('[DEBUG] Task update response:', result);

    if (!result.success && result.status !== 'Success') {
      throw new Error(result.error || result.message || 'Update failed');
    }

    // Update UI
    const row = checkboxElement.closest('tr');
    const titleCell = row.children[1];
    if (isCompleted) {
      row.style.opacity = '0.7';
      titleCell.style.textDecoration = 'line-through';
    } else {
      row.style.opacity = '1';
      titleCell.style.textDecoration = 'none';
    }
  } catch (err) {
    console.error(`❌ Failed to update task ${taskId}:`, err);
    checkboxElement.checked = !isCompleted; // rollback
    alert(`Failed to update task completion: ${err.message}`);
  }
}

	
	
		
	
	// Track expanded tasks
let expandedTasks = new Set();

async function toggleTask(taskId, expandBtn) {
    console.log(`Toggling task ${taskId}`);
    
    // Find the task row and create expansion row if needed
    const taskRow = expandBtn.closest('tr');
    let expansionRow = taskRow.nextElementSibling;
    
    // Check if next row is our expansion row
    if (!expansionRow || !expansionRow.classList.contains('task-expansion-row')) {
        // Create new expansion row
        expansionRow = document.createElement('tr');
        expansionRow.className = 'task-expansion-row';
        expansionRow.style.display = 'none';
        
        const expansionCell = document.createElement('td');
        expansionCell.colSpan = 11; // All columns
        
        const expansionContent = document.createElement('div');
        expansionContent.className = 'task-expansion-content';
        expansionContent.id = `task-expansion-${taskId}`;
        
        expansionCell.appendChild(expansionContent);
        expansionRow.appendChild(expansionCell);
        
        // Insert after current row
        taskRow.parentNode.insertBefore(expansionRow, taskRow.nextSibling);
    }
    
    if (expandedTasks.has(taskId)) {
        // Collapse
        expandedTasks.delete(taskId);
        expansionRow.style.display = 'none';
        expandBtn.classList.remove('expanded');
    } else {
        // Expand and load content
        expandedTasks.add(taskId);
        expansionRow.style.display = 'table-row';
        expandBtn.classList.add('expanded');
        
        // Load task messages
        const expansionContent = document.getElementById(`task-expansion-${taskId}`);
        expansionContent.innerHTML = '<div class="loading">Loading task messages...</div>';
        await loadTaskMessages(taskId, expansionContent);
    }
}

async function loadTaskMessages(taskId, container) {
    try {
        console.log(`Loading messages for task ${taskId}`);
        
        // Load task messages and task details
        const [taskMessagesResponse, taskDetailsResponse] = await Promise.all([
            fetch(`/api/rest/task/${taskId}/messages`),
            fetch(`/api/rest/task/${taskId}`)
        ]);
        
        const taskMessagesData = await taskMessagesResponse.json();
        const taskDetailsData = await taskDetailsResponse.json();
        
        const taskMessages = taskMessagesData.messages || [];
        const taskDetails = taskDetailsData.task || {};
        
        console.log(`Found ${taskMessages.length} task-specific messages`);
        
        let html = '<div class="task-expansion-inner">';
        
        if (taskMessages.length > 0) {
            // Has task-specific messages
            const sortedMessages = taskMessages.sort((a, b) => new Date(a.date) - new Date(b.date));
            html += `
                <div class="task-message-header">
                    <h4>Task Messages (${taskMessages.length} total)</h4>
                    <p>Messages specifically attached to this task</p>
                </div>
                <div class="task-messages-list">
                    ${renderTaskMessages(sortedMessages)}
                </div>
            `;
        } else {
            // No task messages - try to find relevant project messages
            console.log('No task messages, checking for relevant project messages...');
            
            const projectId = taskDetails.projectid;
            if (projectId) {
                const projectMessagesResponse = await fetch(`/api/rest/project/${projectId}/messages`);
                const projectMessagesData = await projectMessagesResponse.json();
                const projectMessages = projectMessagesData.messages || [];
                
                // Use existing function to find relevant messages
                const relevantMessages = getTaskContextMessages(projectMessages, taskDetails);
                
                if (relevantMessages.length > 0) {
                    const sortedMessages = relevantMessages.sort((a, b) => new Date(a.date) - new Date(b.date));
                    html += `
                        <div class="task-message-header">
                            <h4>Related Project Messages (${relevantMessages.length} found)</h4>
                            <p>Project messages that appear related to this task</p>
                        </div>
                        <div class="task-messages-list">
                            ${renderTaskMessages(sortedMessages)}
                        </div>
                    `;
                } else {
                    html += `
                        <div class="task-message-header">
                            <h4>No Messages Found</h4>
                            <p>This task has no specific messages and no related project messages were found.</p>
                        </div>
                    `;
                }
            } else {
                html += `
                    <div class="task-message-header">
                        <h4>No Messages Found</h4>
                        <p>This task has no associated messages.</p>
                    </div>
                `;
            }
        }
        
        html += '</div>';
        container.innerHTML = html;
        
    } catch (error) {
        console.error('Error loading task messages:', error);
        container.innerHTML = `
            <div class="task-expansion-inner">
                <div class="task-message-header">
                    <h4>Error Loading Messages</h4>
                    <p>Could not load messages for this task.</p>
                </div>
            </div>
        `;
    }
}

	
	// Helper function to render task messages (ADD THIS)
function renderTaskMessages(messages) {
    return messages.map(message => {
        const messageDate = new Date(message.date).toLocaleDateString();
        const messageTime = new Date(message.date).toLocaleTimeString();
        
        return `
            <div class="message-item">
                <div class="message-content">
                    <div class="message-header">
                        <span class="message-author-name message-author ${message.authortype}">
                            ${message.authorname}
                        </span>
                        <span class="message-date">${messageDate} ${messageTime}</span>
                    </div>
                    <div class="message-text">${stripHtmlTags(message.content)}</div>
                    ${message.files && message.files.length > 0 ? `
                        <div class="message-files">
                            ${message.files.map(file => `
                                <a href="${file.link}" target="_blank" class="message-file">
                                    📎 ${file.name} (${formatFileSize(file.size) || 'unknown size'})
                                </a>
                            `).join('')}
                        </div>
                    ` : ''}
                </div>
            </div>
        `;
    }).join('');
}
	
	function openTaskMessages(taskId, taskTitle) {
    // You can implement task message modal here if needed
    // For now, just log the task
    console.log(`Opening messages for task ${taskId}: ${taskTitle}`);
    alert(`Task messages feature - Task ${taskId}: ${taskTitle}`);
}

document.addEventListener('DOMContentLoaded', () => {
    console.log('🚀 Dashboard loaded, starting project load…');

    const managerSelect = document.getElementById('managerSelect');
    const sortSelect = document.getElementById('sortSelect');

    if (managerSelect) {
        managerSelect.addEventListener('change', () => {
            currentSort.direction = 'desc';
            loadProjects();
        });
    }

    if (sortSelect) {
        sortSelect.addEventListener('change', (e) => {
            currentSort.field = e.target.value || 'idle';
            currentSort.direction = 'desc';
            loadProjects();
        });
    }

    const chatInput = document.getElementById('chatInput');
    if (chatInput) {
        chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });
    }

    if (typeof loadStatusOptions === 'function') {
        loadStatusOptions().catch(() => {/* non-fatal */});
    }

    console.log('🚀 loadProjects() triggered, about to fetch');
    if (typeof loadProjects === 'function') {
        loadProjects();
    } else {
        console.error('❌ loadProjects is not defined');
    }
});   // closes the event listener
