/**
 * fragments/fixing-activity.js
 * Component for displaying daily fixing activity with programmer attribution
 * 
 * Data Structure:
 *   Each fixed finding provides: { fixId, fixedDate, programmer }
 *   Grouped by date to show daily activity
 * 
 * Dependencies:
 *   - window.GHASResult.getAllCacheEntries() - for cache reading
 *   - window.GHASShared.getCommittersForFindings() - for programmer attribution
 */

(() => {
  window.FixingActivity = window.FixingActivity || {};

  /**
   * Parse ALL findings from cache entries (active, fixed, and dismissed) with programmer
   * attribution where available. Used for the full findings export (not just fixed ones).
   * @param {Array} cacheEntries - from window.GHASResult.getAllCacheEntries()
   * @returns {Promise<Array>} Array of { fixId, fixedDate, lastSeenDate, status, programmer, ... }
   */
  async function getAllFindingsWithProgrammers(cacheEntries) {
   try {
     const all = [];

     for (const entry of cacheEntries) {
       if (!entry.data?.payload?.value) continue;

       const key = entry.key || '';
       const urlMatch = key.match(/\/repositories\/([^/]+)\//);
       const repoName = urlMatch ? urlMatch[1] : 'unknown';

       const findings = entry.data.payload.value;
       for (const f of findings) {
         const state = String(f?.state || '').toLowerCase();
         const { cve, cwe } = extractCveCwe(f);

         all.push({
           fixId: f?.alertId || 'unknown',
           fixedDate: f?.fixedDate || null,
           lastSeenDate: f?.lastSeenDate || null,
           title: f?.title || 'Unknown',
           severity: f?.severity || 'unknown',
           alertType: f?.alertType || 'unknown',
           status: state || 'unknown',
           cve, cwe,
           programmer: f?.attribution?.name || null,
           attribution: f?.attribution || null,
           repoName: repoName
         });
       }
     }

     return all;
   } catch (e) {
     console.error('[FixingActivity] Error:', e);
     return [];
   }
  }

  /**
   * Parse findings from cache entries and extract fixed findings with programmer info
   * @param {Array} cacheEntries - from window.GHASResult.getAllCacheEntries()
   * @returns {Promise<Array>} Array of { fixId, fixedDate, programmer, severity, title, alertType }
   */
  async function getFixedFindingsWithProgrammers(cacheEntries) {
   try {
     const fixed = [];
      
     for (const entry of cacheEntries) {
       if (!entry.data?.payload?.value) continue;
        
       // Extract repo name from cache entry key
       const key = entry.key || '';
       const urlMatch = key.match(/\/repositories\/([^/]+)\//);
       const repoName = urlMatch ? urlMatch[1] : 'unknown';
        
       const findings = entry.data.payload.value;
       for (const f of findings) {
         const state = String(f?.state || '').toLowerCase();
         if (state !== 'fixed' && state !== 'dismissed') continue;
          
         const fixedDate = f?.fixedDate;
         if (!fixedDate) continue;
          
         const { cve, cwe } = extractCveCwe(f);
          
         fixed.push({
           fixId: f?.alertId || 'unknown',
           fixedDate: fixedDate,
           lastSeenDate: f?.lastSeenDate || null,
           title: f?.title || 'Unknown',
           severity: f?.severity || 'unknown',
           alertType: f?.alertType || 'unknown',
           status: state,
           cve, cwe,
           programmer: f?.attribution?.name || 'Unknown',
           attribution: f?.attribution || null,
           repoName: repoName
         });
       }
     }
      
     return fixed;
   } catch (e) {
     console.error('[FixingActivity] Error:', e);
     return [];
   }
  }

  /**
   * Extract CVE/CWE identifiers from a raw finding's tool rule tags.
   * @param {Object} finding - raw finding (with tools[].rules[].tag/tags)
   * @returns {{cve: string[], cwe: string[]}}
   */
  function extractCveCwe(finding) {
    const cve = [];
    const cwe = [];
    const seenCve = new Set();
    const seenCwe = new Set();
    const rawTags = [];

    const pushTags = (v) => {
      if (!v) return;
      if (Array.isArray(v)) rawTags.push(...v);
      else rawTags.push(v);
    };

    if (Array.isArray(finding?.tools)) {
      for (const tool of finding.tools) {
        if (!Array.isArray(tool?.rules)) continue;
        for (const rule of tool.rules) {
          pushTags(rule?.tag);
          pushTags(rule?.tags);
          pushTags(rule?.properties?.tag);
          pushTags(rule?.properties?.tags);
        }
      }
    }
    pushTags(finding?.tags);
    pushTags(finding?.properties?.tags);

    for (const t of rawTags) {
      const text = typeof t === 'string' ? t : (t?.name || t?.id || t?.value || '');
      if (!text) continue;
      const up = text.toUpperCase();

      const cveMatches = up.match(/CVE[-_:\s]?(\d{4})[-_:\s]?(\d{4,7})/g) || [];
      const cweMatches = up.match(/CWE[-_:\s]?(\d{1,5})/g) || [];

      for (const m of cveMatches) {
        const n = m.match(/(\d{4}).*?(\d{4,7})/);
        if (!n) continue;
        const id = `CVE-${n[1]}-${n[2]}`;
        if (!seenCve.has(id)) { seenCve.add(id); cve.push(id); }
      }
      for (const m of cweMatches) {
        const n = m.match(/(\d{1,5})/);
        if (!n) continue;
        const id = `CWE-${n[1]}`;
        if (!seenCwe.has(id)) { seenCwe.add(id); cwe.push(id); }
      }
    }

    return { cve, cwe };
  }

  /**
   * Filter findings to those within [startDate, endDate] (inclusive), matched against
   * fixedDate when present, otherwise falling back to lastSeenDate (for active findings
   * that have no fixedDate). Dates are 'YYYY-MM-DD' strings; either bound may be omitted.
   * @param {Array} findings - array with fixedDate and/or lastSeenDate
   * @param {string|null} startDate
   * @param {string|null} endDate
   * @returns {Array} filtered findings
   */
  function filterByDateRange(findings, startDate, endDate) {
    if (!startDate && !endDate) return findings;
    const start = startDate ? new Date(startDate + 'T00:00:00Z').getTime() : -Infinity;
    const end = endDate ? new Date(endDate + 'T23:59:59Z').getTime() : Infinity;
    return findings.filter(f => {
      const t = new Date(f.fixedDate || f.lastSeenDate).getTime();
      return !isNaN(t) && t >= start && t <= end;
    });
  }

  /**
   * Build a map of sanitized repo name -> { project, cluster } from cluster config.
   * @param {Object} clusterConfig - from GHASCluster.json
   * @returns {Object} sanitizedRepo -> { project, cluster }
   */
  function buildRepoInfoMap(clusterConfig) {
    const sanitize = n => String(n).replace(/[\s_@#$%^&*!]/g, '-').toLowerCase();
    const map = {};
    if (!clusterConfig?.clusters) return map;
    for (const cluster of clusterConfig.clusters) {
      for (const project of (cluster.projects || [])) {
        const repos = Array.isArray(project.repos) ? project.repos : [project.repos];
        for (const repo of repos) {
          map[sanitize(repo)] = { project: project.name, cluster: cluster.name };
        }
      }
    }
    return map;
  }

  /**
   * Build the exportable dataset of ALL findings (active, fixed, and dismissed) within a
   * date range, enriched with project/cluster info for offline analysis (fixing-progress
   * knowledge base). Date range is matched against fixedDate, falling back to lastSeenDate
   * for active findings that have no fixedDate.
   * @param {Array} cacheEntries - from window.GHASResult.getAllCacheEntries()
   * @param {Object} clusterConfig - from GHASCluster.json
   * @param {string|null} startDate - 'YYYY-MM-DD'
   * @param {string|null} endDate - 'YYYY-MM-DD'
   * @returns {Promise<Array>} array of export records
   */
  async function exportFindingsJSON(cacheEntries, clusterConfig, startDate, endDate) {
    const sanitize = n => String(n).replace(/[\s_@#$%^&*!]/g, '-').toLowerCase();
    const repoInfo = buildRepoInfoMap(clusterConfig);
    const allFindings = await getAllFindingsWithProgrammers(cacheEntries);
    const filtered = filterByDateRange(allFindings, startDate, endDate);

    return filtered.map(f => {
      const info = repoInfo[sanitize(f.repoName)] || { project: null, cluster: null };
      return {
        findingsId: f.fixId,
        project: info.project,
        cluster: info.cluster,
        repo: f.repoName,
        title: f.title,
        severity: f.severity,
        alertType: f.alertType,
        cve: f.cve,
        cwe: f.cwe,
        status: f.status,
        fixedDate: f.fixedDate,
        lastSeenDate: f.lastSeenDate,
        attribution: f.attribution
      };
    });
  }

  /**
   * Match findings to clusters based on repo name
   * @param {Array} fixedFindings - array with { fixId, fixedDate, programmer, repoName, ... }
   * @param {Object} clusterConfig - from GHASCluster.json
   * @returns {Object} { clusterName -> [findings] }
   */
  function groupFindingsByCluster(fixedFindings, clusterConfig) {
   const sanitize = n => String(n).replace(/[\s_@#$%^&*!]/g, '-').toLowerCase();
   const byCluster = {};
    
   // Build a map of repo -> cluster name for faster lookup
   const repoToCluster = {};
   const allRepos = [];
    
   if (clusterConfig?.clusters) {
     for (const cluster of clusterConfig.clusters) {
       byCluster[cluster.name] = [];
        
       // Each cluster has projects with repos
       if (cluster.projects && Array.isArray(cluster.projects)) {
         for (const project of cluster.projects) {
           const repos = Array.isArray(project.repos) ? project.repos : [project.repos];
           for (const repo of repos) {
             const sanitized = sanitize(repo);
             repoToCluster[sanitized] = cluster.name;
             allRepos.push({ original: repo, sanitized });
           }
         }
       }
     }
   }
    
   console.log(`[FixingActivity] Built repoToCluster map with ${allRepos.length} repos`, {
     sample: allRepos.slice(0, 5)
   });
    
   // Map findings to clusters
   for (const finding of fixedFindings) {
     const repoName = finding.repoName || 'unknown';
     const sanitizedRepo = sanitize(repoName);
      
     const clusterName = repoToCluster[sanitizedRepo];
      
     if (clusterName) {
       console.log(`[FixingActivity] ✓ "${repoName}" → "${clusterName}"`);
       byCluster[clusterName].push(finding);
     } else {
       console.log(`[FixingActivity] ✗ "${repoName}" not found`, {
         looking_for: sanitizedRepo,
         available_repos: Object.keys(repoToCluster).slice(0, 10)
       });
       if (!byCluster['Unassigned']) {
         byCluster['Unassigned'] = [];
       }
       byCluster['Unassigned'].push(finding);
     }
   }
    
   return byCluster;
  }

  /**
  * Build pivot table: rows = dates, columns = programmers with severity breakdown
  * @param {Array} findings - findings for a cluster
  * @returns {Object} { dates: sorted array, programmers: unique array, pivot: { date -> { programmer -> { c,h,m,l } } } }
  */
  function buildPivotTable(findings) {
   const dateProgrammerSeverity = {}; // date -> programmer -> { c, h, m, l }
   const programmersSet = new Set();
   const datesSet = new Set();
    
   for (const finding of findings) {
     const dateStr = finding.fixedDate.split('T')[0];
     const prog = finding.programmer || 'Unknown';
     const sev = String(finding.severity || '').toLowerCase()[0];
      
     datesSet.add(dateStr);
     programmersSet.add(prog);
      
     if (!dateProgrammerSeverity[dateStr]) {
       dateProgrammerSeverity[dateStr] = {};
     }
     if (!dateProgrammerSeverity[dateStr][prog]) {
       dateProgrammerSeverity[dateStr][prog] = { c: 0, h: 0, m: 0, l: 0 };
     }
      
     if (sev === 'c') dateProgrammerSeverity[dateStr][prog].c++;
     else if (sev === 'h') dateProgrammerSeverity[dateStr][prog].h++;
     else if (sev === 'm') dateProgrammerSeverity[dateStr][prog].m++;
     else if (sev === 'l') dateProgrammerSeverity[dateStr][prog].l++;
   }
    
   // Sort dates descending
   const dates = Array.from(datesSet).sort((a, b) => new Date(b) - new Date(a));
   const programmers = Array.from(programmersSet).sort();
    
   return {
     dates,
     programmers,
     pivot: dateProgrammerSeverity
   };
  }

  /**
  * Render pivot table as HTML
  * @param {string} clusterName - cluster name for title
  * @param {Object} pivotData - from buildPivotTable()
  * @param {Object} options - { maxDays: 30 }
  * @returns {string} HTML table
  */
  function renderPivotTable(clusterName, pivotData, options = {}) {
   const { maxDays = 30 } = options;
   const { dates, programmers, pivot } = pivotData;
   const displayDates = dates.slice(0, maxDays);
    
   // Build header with programmer columns
   let headerHtml = '<tr><th>Date</th><th>Total</th>';
   for (const prog of programmers) {
     headerHtml += `<th title="${prog}" class="prog-col">${prog}</th>`;
   }
   headerHtml += '</tr>';
    
   // Build data rows
   let bodyHtml = '';
   for (const dateStr of displayDates) {
     const formatted = formatDate(dateStr);
     const rowData = pivot[dateStr] || {};
      
     // Calculate total for this date
     let total = 0;
     for (const prog of programmers) {
       const sev = rowData[prog] || { c: 0, h: 0, m: 0, l: 0 };
       total += sev.c + sev.h + sev.m + sev.l;
     }
      
     bodyHtml += `<tr><td class="date">${formatted}</td><td class="total">${total}</td>`;
      
     for (const prog of programmers) {
       const sev = rowData[prog] || { c: 0, h: 0, m: 0, l: 0 };
       const display = `C:${sev.c}|H:${sev.h}|M:${sev.m}|L:${sev.l}`;
       bodyHtml += `<td class="prog-severity" title="${display}"><span class="sev-c">${sev.c}</span>|<span class="sev-h">${sev.h}</span>|<span class="sev-m">${sev.m}</span>|<span class="sev-l">${sev.l}</span></td>`;
     }
      
     bodyHtml += '</tr>';
   }
    
   return `
     <div class="pivot-table">
       <h3>${clusterName}</h3>
       <table class="pivot-table-data">
         <thead>
           ${headerHtml}
         </thead>
         <tbody>
           ${bodyHtml}
         </tbody>
       </table>
     </div>
   `;
  }

  /**
   * Aggregate daily activity (total fixes per day, regardless of programmer)
   * @param {Array} fixedFindings - array of { fixId, fixedDate, programmer, ... }
   * @returns {Object} { date -> { total, bySeverity, byProgrammer } }
   */
  function aggregateDailyActivity(fixedFindings) {
    const daily = {}; // date -> { total, bySeverity: { c, h, m, l }, byProgrammer: { name -> count } }
    
    for (const finding of fixedFindings) {
      const dateStr = finding.fixedDate.split('T')[0];
      if (!daily[dateStr]) {
        daily[dateStr] = { total: 0, bySeverity: { c: 0, h: 0, m: 0, l: 0 }, byProgrammer: {} };
      }
      
      daily[dateStr].total++;
      
      const sev = String(finding.severity || '').toLowerCase()[0];
      if (sev === 'c') daily[dateStr].bySeverity.c++;
      else if (sev === 'h') daily[dateStr].bySeverity.h++;
      else if (sev === 'm') daily[dateStr].bySeverity.m++;
      else if (sev === 'l') daily[dateStr].bySeverity.l++;
      
      const prog = finding.programmer || 'Unknown';
      daily[dateStr].byProgrammer[prog] = (daily[dateStr].byProgrammer[prog] || 0) + 1;
    }
    
    return daily;
  }

  /**
   * Sort dates in descending order (most recent first)
   * @param {Object} dailyActivity - from aggregateDailyActivity()
   * @returns {Array} Sorted dates [date, data] tuples
   */
  function sortDates(dailyActivity) {
    return Object.entries(dailyActivity).sort((a, b) => {
      const dateA = new Date(a[0]);
      const dateB = new Date(b[0]);
      return dateB - dateA; // Descending (most recent first)
    });
  }

  /**
   * Format date for display (e.g., "2026-06-04" → "Jun 04, 2026")
   * @param {string} dateStr - ISO date string (YYYY-MM-DD)
   * @returns {string} Formatted date
   */
  function formatDate(dateStr) {
    const date = new Date(dateStr + 'T00:00:00Z');
    return date.toLocaleDateString('en-US', { 
      year: 'numeric', 
      month: 'short', 
      day: '2-digit' 
    });
  }

  /**
   * Render daily fixing activity as HTML rows
   * @param {Object} dailyActivity - from aggregateDailyActivity()
   * @param {Object} options - { maxDays: 30, showProgrammers: true }
   * @returns {string} HTML table rows
   */
  function renderDailyActivityRows(dailyActivity, options = {}) {
    const { maxDays = 30, showProgrammers = true } = options;
    const sortedDates = sortDates(dailyActivity).slice(0, maxDays);
    
    let html = '';
    for (const [dateStr, data] of sortedDates) {
      const formatted = formatDate(dateStr);
      const { total, bySeverity, byProgrammer } = data;
      
      let programmerList = '';
      if (showProgrammers) {
        const programmers = Object.entries(byProgrammer)
          .sort((a, b) => b[1] - a[1]) // Sort by count descending
          .map(([name, count]) => `<span class="programmer-badge" title="${count} fixes">${name}</span>`)
          .join(' ');
        programmerList = programmers ? `<div class="programmers">${programmers}</div>` : '';
      }
      
      html += `
        <tr>
          <td class="date">${formatted}</td>
          <td class="total">${total}</td>
          <td class="severity-c">${bySeverity.c}</td>
          <td class="severity-h">${bySeverity.h}</td>
          <td class="severity-m">${bySeverity.m}</td>
          <td class="severity-l">${bySeverity.l}</td>
          <td class="programmers-cell">${programmerList}</td>
        </tr>
      `;
    }
    
    return html;
  }

  /**
  * Build daily totals for combined chart - merge all clusters with date alignment
  * @param {Object} byCluster - findings grouped by cluster
  * @returns {Object} { dates: sorted array, clusters: { clusterName -> totals array } }
  */
  function buildDailyTotals(byCluster) {
   const allDates = new Set();
   const clusterData = {};
    
   // First pass: collect all dates and totals per cluster
   for (const [clusterName, findings] of Object.entries(byCluster)) {
     const dateToCount = {};
      
     for (const f of findings) {
       const dateStr = f.fixedDate.split('T')[0];
       dateToCount[dateStr] = (dateToCount[dateStr] || 0) + 1;
       allDates.add(dateStr);
     }
      
     clusterData[clusterName] = dateToCount;
   }
    
   // Sort all dates ascending for chart x-axis
   const dates = Array.from(allDates).sort((a, b) => new Date(a) - new Date(b));
    
   // Build totals array for each cluster, filling zeros for missing dates
   const clusters = {};
   for (const [clusterName, dateToCount] of Object.entries(clusterData)) {
     clusters[clusterName] = dates.map(d => dateToCount[d] || 0);
   }
    
   return { dates, clusters };
  }
  
  /**
  * Render a combined line chart showing daily fixing totals for all clusters
  * @param {HTMLElement} container - Element to render chart into
  * @param {Array} dates - Sorted dates (YYYY-MM-DD)
  * @param {Object} clusters - { clusterName -> totals array }
  */
  function renderCombinedLineChart(container, dates, clusters) {
   if (!dates || dates.length === 0 || Object.keys(clusters).length === 0) {
     console.warn('[FixingActivity] No data for combined chart');
     return;
   }
     
   // Create wrapper
   const chartDiv = document.createElement('div');
   chartDiv.className = 'combined-chart-container';
     
   const title = document.createElement('h3');
   title.textContent = 'Daily Fixing Activity Across All Clusters';
   title.style.marginTop = '0';
   title.style.marginBottom = '5px';
    
   const subtitle = document.createElement('p');
   subtitle.textContent = '(Click legend to select cluster and drill into programmer data)';
   subtitle.style.margin = '0 0 15px 0';
   subtitle.style.fontSize = '12px';
   subtitle.style.color = '#888';
     
   const canvas = document.createElement('canvas');
   canvas.id = 'combined-daily-chart';
   canvas.style.maxWidth = '100%';
   canvas.style.maxHeight = '400px';
    
   const programmersDiv = document.createElement('div');
   programmersDiv.id = 'programmer-breakdown-placeholder';
   programmersDiv.style.marginTop = '20px';
     
   chartDiv.appendChild(title);
   chartDiv.appendChild(subtitle);
   chartDiv.appendChild(canvas);
   chartDiv.appendChild(programmersDiv);
   container.appendChild(chartDiv);
     
   // Load Chart.js if not already loaded
   if (!window.Chart) {
     console.warn('[FixingActivity] Chart.js not loaded, skipping chart');
     return;
   }
     
   // Define colors for clusters
   const colors = [
     '#27ae60', // green
     '#e74c3c', // red
     '#3498db', // blue
     '#f39c12', // orange
     '#9b59b6', // purple
     '#1abc9c', // turquoise
     '#e67e22', // burnt orange
     '#34495e', // dark gray
   ];
    
   // Store cluster names and colors for legend click handling
   const clusterList = Object.entries(clusters).map(([name], idx) => ({
     name,
     color: colors[idx % colors.length]
   }));
    
   let chartInstance = null;
   let selectedCluster = null;
    
   // Build datasets for each cluster
   const buildDatasets = (hideUnselected = false) => {
     return Object.entries(clusters).map(([clusterName, totals], index) => {
       const color = colors[index % colors.length];
       const isSelected = !selectedCluster || selectedCluster === clusterName;
        
       return {
         label: clusterName,
         data: totals,
         borderColor: color,
         backgroundColor: color.replace(')', ', 0.1)').replace('rgb', 'rgba'),
         borderWidth: isSelected ? 2.5 : 1,
         opacity: isSelected ? 1 : 0.3,
         tension: 0.4,
         fill: false,
         pointRadius: isSelected ? 4 : 2,
         pointBackgroundColor: color,
         pointBorderColor: '#fff',
         pointBorderWidth: isSelected ? 2 : 1,
         pointHoverRadius: isSelected ? 6 : 4,
         hidden: hideUnselected && !isSelected
       };
     });
   };
   // Format dates to MM-DD only (remove year)
   const formattedDates = dates.map(dateStr => {
     // dateStr format: "2026-06-04"
     const parts = dateStr.split('-');
     return `${parts[1]}-${parts[2]}`; // MM-DD
   });
    
   // Create chart
   const ctx = canvas.getContext('2d');
   chartInstance = new window.Chart(ctx, {
     type: 'line',
     data: {
       labels: formattedDates,
       datasets: buildDatasets()
     },
     options: {
       responsive: true,
       maintainAspectRatio: true,
       interaction: {
         mode: 'index',
         intersect: false,
       },
       plugins: {
         legend: {
           display: true,
           position: 'top',
           labels: {
             font: { size: 12 },
             padding: 12,
             usePointStyle: true
           },
           onClick: async (e, legendItem, legend) => {
             // Prevent default behavior
             e.native.stopImmediatePropagation();
              
             const clickedCluster = legendItem.text;
             console.log('[FixingActivity] Legend clicked:', clickedCluster);
              
             // Toggle selection
             if (selectedCluster === clickedCluster) {
               selectedCluster = null;
               console.log('[FixingActivity] Deselected cluster, showing all');
             } else {
               selectedCluster = clickedCluster;
               console.log('[FixingActivity] Selected cluster:', selectedCluster);
             }
              
             // Update datasets
             chartInstance.data.datasets = buildDatasets();
             chartInstance.update();
              
             // If a cluster is selected, show programmer breakdown
             if (selectedCluster) {
               await renderProgrammerBreakdown(selectedCluster);
             } else {
               document.getElementById('programmer-breakdown-placeholder').innerHTML = '';
             }
           }
         },
         title: {
           display: false
         }
       },
       scales: {
         y: {
           beginAtZero: true,
           title: {
             display: true,
             text: 'Total Fixed Findings',
             font: { size: 12 }
           },
           grid: {
             drawBorder: true,
             color: 'rgba(0, 0, 0, 0.1)'
           }
         },
         x: {
           title: {
             display: true,
             text: 'Date',
             font: { size: 12 }
           },
           grid: {
             display: false
           }
         }
       }
     }
   });
    
   // Function to render programmer breakdown when cluster is selected
   async function renderProgrammerBreakdown(clusterName) {
     try {
       console.log('[FixingActivity] Rendering programmer breakdown for:', clusterName);
       const placeholder = document.getElementById('programmer-breakdown-placeholder');
        
       // Get cache entries
       const cacheEntries = await window.GHASResult.getAllCacheEntries();
       const fixedFindings = await getFixedFindingsWithProgrammers(cacheEntries);
        
       // Get cluster config to find repos in this cluster
       let clusterConfig = window.__clusterDef || {};
       if (!clusterConfig.clusters) {
         try {
           const resp = await fetch('../GHASCluster.json');
           if (resp.ok) clusterConfig = await resp.json();
         } catch (e) {
           console.warn('[FixingActivity] Could not load cluster config for programmer breakdown');
         }
       }
        
       // Find repos in this cluster
       const clusterRepos = new Set();
       if (clusterConfig.clusters) {
         for (const cl of clusterConfig.clusters) {
           if (cl.name === clusterName && cl.projects) {
             for (const proj of cl.projects) {
               const repos = Array.isArray(proj.repos) ? proj.repos : [proj.repos];
               repos.forEach(r => clusterRepos.add(r.replace(/[\s_@#$%^&*!]/g, '-')));
             }
           }
         }
       }
        
       // Filter findings for this cluster
       const clusterFindings = fixedFindings.filter(f => clusterRepos.has(f.repoName));
       console.log('[FixingActivity] Found', clusterFindings.length, 'findings in cluster', clusterName);
        
       if (clusterFindings.length === 0) {
         placeholder.innerHTML = '<div style="padding:10px;color:#888;font-size:12px;">No findings for this cluster.</div>';
         return;
       }
        
       // Group by programmer and date
       const byProgrammer = {};
       for (const finding of clusterFindings) {
         const prog = finding.programmer || 'Unknown';
         if (!byProgrammer[prog]) {
           byProgrammer[prog] = {};
         }
         const dateStr = finding.fixedDate.split('T')[0];
         byProgrammer[prog][dateStr] = (byProgrammer[prog][dateStr] || 0) + 1;
       }
        
       // Ensure all dates exist for all programmers (align with main chart)
       const allDates = new Set(dates);
       for (const prog in byProgrammer) {
         for (const date of allDates) {
           if (!(date in byProgrammer[prog])) {
             byProgrammer[prog][date] = 0;
           }
         }
       }
        
       // Build programmer datasets (lighter styling)
       const programmers = Object.keys(byProgrammer).sort();
       const progDatasets = programmers.map((prog, idx) => {
         const progData = dates.map(d => byProgrammer[prog][d] || 0);
         const progColor = `hsl(${(idx * 360 / programmers.length) % 360}, 60%, 70%)`;
          
         return {
           label: prog,
           data: progData,
           borderColor: progColor,
           backgroundColor: 'transparent',
           borderWidth: 1.5,
           borderDash: [5, 5],
           tension: 0.2,
           fill: false,
           pointRadius: 2,
           pointBackgroundColor: progColor,
           pointBorderColor: '#fff',
           pointBorderWidth: 1,
           pointHoverRadius: 4
         };
       });
        
       // Create programmer chart
       const progChartDiv = document.createElement('div');
       progChartDiv.style.marginTop = '10px';
       progChartDiv.style.padding = '15px';
       progChartDiv.style.backgroundColor = '#fafbfc';
       progChartDiv.style.borderRadius = '6px';
        
       const progTitle = document.createElement('h4');
       progTitle.textContent = `Programmer Activity in ${clusterName}`;
       progTitle.style.margin = '0 0 10px 0';
       progTitle.style.fontSize = '13px';
       progTitle.style.color = '#1e2a38';
        
       const progCanvas = document.createElement('canvas');
       progCanvas.id = 'programmer-chart-' + clusterName.replace(/\s/g, '-');
       progCanvas.style.maxWidth = '100%';
       progCanvas.style.maxHeight = '250px';
        
       progChartDiv.appendChild(progTitle);
       progChartDiv.appendChild(progCanvas);
       placeholder.innerHTML = '';
       placeholder.appendChild(progChartDiv);
        
       // Render programmer chart
       const progCtx = progCanvas.getContext('2d');
       new window.Chart(progCtx, {
         type: 'line',
         data: {
           labels: formattedDates,
           datasets: progDatasets
         },
         options: {
           responsive: true,
           maintainAspectRatio: true,
           interaction: {
             mode: 'index',
             intersect: false,
           },
           plugins: {
             legend: {
               display: true,
               position: 'bottom',
               labels: {
                 font: { size: 11 },
                 padding: 8,
                 usePointStyle: true
               }
             },
             title: {
               display: false
             }
           },
           scales: {
             y: {
               beginAtZero: true,
               title: {
                 display: true,
                 text: 'Fixes by Programmer',
                 font: { size: 11 }
               }
             },
             x: {
               grid: {
                 display: false
               }
             }
           }
         }
       });
     } catch (e) {
       console.error('[FixingActivity] Error rendering programmer breakdown:', e);
       document.getElementById('programmer-breakdown-placeholder').innerHTML = 
         `<div style="padding:10px;color:#c0392b;font-size:12px;">Error: ${e.message}</div>`;
     }
   }
  }
  
  /**
  * Render a line chart showing daily fixing totals
  * @param {HTMLElement} container - Element to render chart into
  * @param {String} clusterName - Cluster name for chart title
  * @param {Array} dates - Sorted dates (YYYY-MM-DD)
  * @param {Array} totals - Count per date
  * @deprecated Use renderCombinedLineChart instead
  */
  function renderLineChart(container, clusterName, dates, totals) {
   if (!dates || dates.length === 0) {
     console.warn('[FixingActivity] No data for chart:', clusterName);
     return;
   }
    
   const chartId = `chart-${clusterName.replace(/\s+/g, '-')}`;
   const canvasId = `${chartId}-canvas`;
    
   // Create canvas element
   const chartDiv = document.createElement('div');
   chartDiv.className = 'daily-chart-container';
   chartDiv.style.marginBottom = '30px';
    
   const title = document.createElement('h4');
   title.textContent = `Daily Fixes - ${clusterName}`;
   title.style.marginTop = '20px';
   title.style.marginBottom = '10px';
    
   const canvas = document.createElement('canvas');
   canvas.id = canvasId;
   canvas.style.maxWidth = '100%';
   canvas.style.maxHeight = '300px';
    
   chartDiv.appendChild(title);
   chartDiv.appendChild(canvas);
   container.appendChild(chartDiv);
    
   // Load Chart.js if not already loaded
   if (!window.Chart) {
     console.warn('[FixingActivity] Chart.js not loaded, rendering table instead');
     return;
   }
    
   // Create chart
   const ctx = canvas.getContext('2d');
   new window.Chart(ctx, {
     type: 'line',
     data: {
       labels: dates,
       datasets: [{
         label: 'Fixed Findings',
         data: totals,
         borderColor: '#27ae60',
         backgroundColor: 'rgba(39, 174, 96, 0.1)',
         borderWidth: 2,
         tension: 0.4,
         fill: true,
         pointRadius: 4,
         pointBackgroundColor: '#27ae60',
         pointBorderColor: '#fff',
         pointBorderWidth: 2
       }]
     },
     options: {
       responsive: true,
       maintainAspectRatio: true,
       plugins: {
         legend: {
           display: true,
           position: 'top'
         }
       },
       scales: {
         y: {
           beginAtZero: true,
           title: {
             display: true,
             text: 'Total Fixed Findings'
           }
         },
         x: {
           title: {
             display: true,
             text: 'Date'
           }
         }
       }
     }
   });
  }

  /**
  * Main public API - Load and render daily activity from cache as pivot tables by cluster
  * @param {HTMLElement} container - Element to render into
  * @param {Object} options - { maxDays: 30, embedded: false, clusterConfig: null }
  */
  async function renderDailyActivity(container, options = {}) {
   try {
     console.log('[FixingActivity] Starting renderDailyActivity', { container: !!container, options });
       
     if (!container) {
       console.error('[FixingActivity] No container provided');
       return;
     }
      
     const { embedded = false, clusterConfig: providedConfig = null, startDate = null, endDate = null } = options;
       
     // Get cache entries
     if (!window.GHASResult?.getAllCacheEntries) {
       console.error('[FixingActivity] Cache getAllCacheEntries not available');
       container.innerHTML = '<div class="error">Cache not available</div>';
       return;
     }
       
     console.log('[FixingActivity] Getting cache entries...');
     const cacheEntries = await window.GHASResult.getAllCacheEntries();
     console.log('[FixingActivity] Cache entries:', cacheEntries ? cacheEntries.length : 0);
       
     if (!cacheEntries || cacheEntries.length === 0) {
       console.warn('[FixingActivity] No cache entries found');
       container.innerHTML = '<div class="error">No cached data found</div>';
       return;
     }
       
     // Extract fixed findings
     console.log('[FixingActivity] Extracting fixed findings...');
     let fixedFindings = await getFixedFindingsWithProgrammers(cacheEntries);
     console.log('[FixingActivity] Fixed findings (before date filter):', fixedFindings.length);
       
     // Apply date-range filter (startDate/endDate are 'YYYY-MM-DD' or null)
     if (startDate || endDate) {
       fixedFindings = filterByDateRange(fixedFindings, startDate, endDate);
       console.log(`[FixingActivity] Fixed findings (after date filter ${startDate || '…'} to ${endDate || '…'}):`, fixedFindings.length);
     }
       
     if (fixedFindings.length === 0) {
       console.warn('[FixingActivity] No fixed findings in selected range');
       container.innerHTML = '<div class="no-data">No fixed findings in the selected date range</div>';
       return;
     }
       
     // Load cluster config
     console.log('[FixingActivity] Loading cluster config...');
     let clusterConfig = providedConfig || {};
      
     // If no config provided, try to load from file (fallback for standalone)
     if (!providedConfig) {
       try {
         // Try relative path for standalone (fragments directory)
         let configPath = '../GHASCluster.json';
         let response = await fetch(configPath);
          
         // If that fails (embedded), try root path
         if (!response.ok) {
           console.log('[FixingActivity] ../GHASCluster.json not found, trying ./GHASCluster.json');
           configPath = './GHASCluster.json';
           response = await fetch(configPath);
         }
          
         if (response.ok) {
           clusterConfig = await response.json();
           console.log('[FixingActivity] ✓ Cluster config loaded from ' + configPath, clusterConfig);
         } else {
           console.warn('[FixingActivity] Could not load cluster config from any path');
         }
       } catch (e) {
         console.warn('[FixingActivity] Could not load cluster config:', e.message);
       }
     } else {
       console.log('[FixingActivity] Using provided cluster config');
     }
      
     console.log('[FixingActivity] Cluster summary:', {
       clusterCount: clusterConfig?.clusters?.length || 0,
       clusters: clusterConfig?.clusters?.map(c => ({
         name: c.name,
         projectCount: c.projects?.length || 0
       })) || []
     });
       
     // Group by cluster
     console.log('[FixingActivity] Grouping by cluster...');
     const byCluster = groupFindingsByCluster(fixedFindings, clusterConfig);
     console.log('[FixingActivity] Clusters:', Object.keys(byCluster));
       
     // Render combined chart + pivot tables
     console.log('[FixingActivity] Building daily totals...');
     const dailyData = buildDailyTotals(byCluster);
       
     console.log('[FixingActivity] Building pivot tables...');
     let html = '<div class="fixing-activity">';
       
     // Render combined chart at the top
     html += '<div class="combined-chart-placeholder"></div>';
       
     for (const [clusterName, clusterFindings] of Object.entries(byCluster)) {
       if (clusterFindings.length === 0) {
         console.log(`[FixingActivity] Skipping empty cluster: ${clusterName}`);
         continue;
       }
           
       console.log(`[FixingActivity] Rendering cluster: ${clusterName} (${clusterFindings.length} findings)`);
         
       // Create cluster section with collapsible header
       const collapsedClass = embedded ? 'collapsed' : '';
       html += `<div class="cluster-section ${collapsedClass}" data-cluster="${clusterName}">`;
       html += `<div class="cluster-section-header" style="cursor:pointer; user-select:none; padding:8px 0; font-weight:600; color:#1e2a38;">
                  <span class="cluster-section-toggle">▼</span>${clusterName}
                </div>`;
       html += `<div class="cluster-section-body" style="display:${embedded ? 'none' : 'block'};">`;
          
       const pivotData = buildPivotTable(clusterFindings);
       console.log(`[FixingActivity] Pivot dates: ${pivotData.dates.length}, programmers: ${pivotData.programmers.length}`);
       html += renderPivotTable(clusterName, pivotData, options);
        
       html += '</div></div>';
     }
     html += '</div>';
         
     console.log('[FixingActivity] Setting HTML:', html.length, 'chars');
     container.innerHTML = html;
      
     // Set up collapsible toggles
     if (embedded) {
       const headers = container.querySelectorAll('.cluster-section-header');
       headers.forEach(header => {
         header.addEventListener('click', (e) => {
           const section = header.parentElement;
           const body = section.querySelector('.cluster-section-body');
           const toggle = header.querySelector('.cluster-section-toggle');
            
           const isCollapsed = section.classList.contains('collapsed');
           if (isCollapsed) {
             section.classList.remove('collapsed');
             body.style.display = 'block';
             toggle.textContent = '▼';
             console.log(`[FixingActivity] Expanded ${section.dataset.cluster}`);
           } else {
             section.classList.add('collapsed');
             body.style.display = 'none';
             toggle.textContent = '▶';
             console.log(`[FixingActivity] Collapsed ${section.dataset.cluster}`);
           }
         });
       });
     }
       
     // Now render combined chart into the placeholder (after DOM is ready)
     const chartPlaceholder = container.querySelector('.combined-chart-placeholder');
     if (chartPlaceholder) {
       renderCombinedLineChart(chartPlaceholder, dailyData.dates, dailyData.clusters);
     }
       
     console.log(`[FixingActivity] ✓ Rendered ${fixedFindings.length} fixed findings in ${Object.keys(byCluster).length} cluster tables`);
   } catch (e) {
     console.error('[FixingActivity] Error rendering:', e);
     if (container) {
       container.innerHTML = `<div class="error">Error: ${e.message}</div>`;
     }
   }
  }

 // Export public API
 window.FixingActivity.getFixedFindingsWithProgrammers = getFixedFindingsWithProgrammers;
 window.FixingActivity.getAllFindingsWithProgrammers = getAllFindingsWithProgrammers;
 window.FixingActivity.extractCveCwe = extractCveCwe;
 window.FixingActivity.filterByDateRange = filterByDateRange;
 window.FixingActivity.buildRepoInfoMap = buildRepoInfoMap;
 window.FixingActivity.exportFindingsJSON = exportFindingsJSON;
 window.FixingActivity.groupFindingsByCluster = groupFindingsByCluster;
 window.FixingActivity.buildPivotTable = buildPivotTable;
 window.FixingActivity.buildDailyTotals = buildDailyTotals;
 window.FixingActivity.renderCombinedLineChart = renderCombinedLineChart;
 window.FixingActivity.renderLineChart = renderLineChart;
 window.FixingActivity.renderPivotTable = renderPivotTable;
 window.FixingActivity.aggregateDailyActivity = aggregateDailyActivity;
 window.FixingActivity.sortDates = sortDates;
 window.FixingActivity.formatDate = formatDate;
 window.FixingActivity.renderDailyActivityRows = renderDailyActivityRows;
 window.FixingActivity.renderDailyActivity = renderDailyActivity;

 console.log('[FixingActivity] Component loaded');
})();
