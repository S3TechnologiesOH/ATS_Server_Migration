/**
 * PowerHR Jobs Embed Widget v1.3.3
 *
 * A fully self-contained, plug-and-play job board widget.
 *
 * Usage:
 *   <div id="powerhr-jobs"></div>
 *   <script src="https://ats.s3protection.com/api/ats/api/ats/public/embed/widget.js"></script>
 *   <script>
 *     PowerHRJobs.init({
 *       apiKey: 'pk_live_xxxx',
 *       container: '#powerhr-jobs',
 *       theme: 'auto'
 *     });
 *   </script>
 */

(function() {
  'use strict';

  // Detect the base URL from where this script was loaded
  // Try multiple methods since document.currentScript may be null in some loading scenarios
  function detectBaseUrl() {
    // Method 1: document.currentScript (works for synchronously loaded scripts)
    if (document.currentScript?.src) {
      return document.currentScript.src.replace(/\/public\/embed\/widget\.js.*$/, '');
    }
    // Method 2: Find script by src attribute
    const scripts = document.querySelectorAll('script[src*="widget.js"]');
    for (const script of scripts) {
      if (script.src.includes('powerhr') || script.src.includes('ats')) {
        return script.src.replace(/\/public\/embed\/widget\.js.*$/, '');
      }
    }
    // Method 3: Fallback to production URL
    return 'https://ats.s3protection.com/api/ats/api/ats';
  }
  const API_BASE_URL = detectBaseUrl();

  // Widget styles
  const WIDGET_STYLES = `
    .phr-widget {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      color: #333;
      line-height: 1.6;
      --phr-primary: #0066cc;
      --phr-primary-hover: #0052a3;
      --phr-bg: #fff;
      --phr-text: #333;
      --phr-text-muted: #666;
      --phr-border: #e0e0e0;
      --phr-card-bg: #fff;
    }
    .phr-widget * { box-sizing: border-box; }
    .phr-widget.phr-theme-dark {
      --phr-bg: #121212;
      --phr-text: #e0e0e0;
      --phr-text-muted: #aaa;
      --phr-border: #333;
      --phr-card-bg: #1e1e1e;
    }

    /* Loading & Error */
    .phr-widget .phr-loading,
    .phr-widget .phr-error,
    .phr-widget .phr-empty {
      text-align: center;
      padding: 3rem 1rem;
      color: var(--phr-text-muted);
    }
    .phr-widget .phr-error { color: #c00; }
    .phr-widget .phr-spinner {
      width: 40px; height: 40px;
      border: 3px solid var(--phr-border);
      border-top-color: var(--phr-primary);
      border-radius: 50%;
      animation: phr-spin 0.8s linear infinite;
      margin: 0 auto 1rem;
    }
    @keyframes phr-spin { to { transform: rotate(360deg); } }

    /* Job List */
    .phr-widget .phr-jobs-list {
      list-style: none;
      padding: 0;
      margin: 0;
      display: grid;
      gap: 1rem;
    }
    .phr-widget .phr-job-card {
      border: 1px solid var(--phr-border);
      border-radius: 8px;
      padding: 1.25rem;
      background: var(--phr-card-bg);
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    .phr-widget .phr-job-card:hover {
      border-color: var(--phr-primary);
      box-shadow: 0 4px 12px rgba(0,0,0,0.1);
    }
    .phr-widget .phr-job-meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.85rem;
      color: var(--phr-text-muted);
      margin-bottom: 0.5rem;
    }
    .phr-widget .phr-badge {
      background: var(--phr-primary);
      color: #fff;
      padding: 0.2rem 0.6rem;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 500;
    }
    .phr-widget .phr-job-title {
      font-size: 1.25rem;
      font-weight: 600;
      margin: 0 0 0.5rem;
      color: var(--phr-text);
    }
    .phr-widget .phr-job-summary {
      color: var(--phr-text-muted);
      margin: 0 0 1rem;
      font-size: 0.95rem;
    }
    .phr-widget .phr-job-actions {
      display: flex;
      gap: 0.75rem;
    }

    /* Buttons */
    .phr-widget .phr-btn {
      padding: 0.6rem 1.2rem;
      border-radius: 6px;
      font-size: 0.9rem;
      font-weight: 500;
      cursor: pointer;
      border: none;
      transition: all 0.2s;
    }
    .phr-widget .phr-btn-primary {
      background: var(--phr-primary);
      color: #fff;
    }
    .phr-widget .phr-btn-primary:hover { background: var(--phr-primary-hover); }
    .phr-widget .phr-btn-primary:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .phr-widget .phr-btn-ghost {
      background: transparent;
      color: var(--phr-primary);
      border: 1px solid var(--phr-primary);
    }
    .phr-widget .phr-btn-ghost:hover { background: rgba(0,102,204,0.05); }

    /* Modal */
    .phr-widget .phr-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.2s, visibility 0.2s;
      padding: 1rem;
    }
    .phr-widget .phr-overlay.phr-active {
      opacity: 1;
      visibility: visible;
    }
    .phr-widget .phr-modal {
      background: var(--phr-card-bg);
      border-radius: 12px;
      width: 100%;
      max-width: 600px;
      max-height: 90vh;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    .phr-widget .phr-modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1rem 1.5rem;
      border-bottom: 1px solid var(--phr-border);
      flex-shrink: 0;
    }
    .phr-widget .phr-modal-header h3 {
      margin: 0;
      font-size: 1.25rem;
      color: var(--phr-text);
    }
    .phr-widget .phr-modal-close {
      background: none;
      border: none;
      font-size: 1.5rem;
      cursor: pointer;
      color: var(--phr-text-muted);
      padding: 0.25rem;
      line-height: 1;
    }
    .phr-widget .phr-modal-body {
      padding: 1.5rem;
      overflow-y: auto;
      flex: 1;
    }
    .phr-widget .phr-modal-footer {
      padding: 1rem 1.5rem;
      border-top: 1px solid var(--phr-border);
      display: flex;
      justify-content: flex-end;
      gap: 0.75rem;
      flex-shrink: 0;
    }

    /* Job Detail */
    .phr-widget .phr-section {
      margin-bottom: 1.5rem;
    }
    .phr-widget .phr-section h4 {
      font-size: 1rem;
      font-weight: 600;
      margin: 0 0 0.5rem;
      color: var(--phr-text);
    }
    .phr-widget .phr-section p {
      margin: 0;
      color: var(--phr-text-muted);
      white-space: pre-wrap;
    }

    /* Form */
    .phr-widget .phr-form-section {
      margin-bottom: 1.5rem;
    }
    .phr-widget .phr-form-section h4 {
      font-size: 0.9rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--phr-text-muted);
      margin: 0 0 1rem;
      padding-bottom: 0.5rem;
      border-bottom: 1px solid var(--phr-border);
    }
    .phr-widget .phr-form-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
    }
    .phr-widget .phr-form-grid .phr-full { grid-column: 1 / -1; }
    .phr-widget .phr-field {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }
    .phr-widget .phr-field label {
      font-size: 0.9rem;
      font-weight: 500;
      color: var(--phr-text);
    }
    .phr-widget .phr-field .phr-optional {
      font-weight: 400;
      color: var(--phr-text-muted);
      font-size: 0.85rem;
    }
    .phr-widget .phr-field input,
    .phr-widget .phr-field textarea,
    .phr-widget .phr-field select {
      padding: 0.6rem 0.8rem;
      border: 1px solid var(--phr-border);
      border-radius: 6px;
      font-size: 0.95rem;
      background: var(--phr-bg);
      color: var(--phr-text);
      transition: border-color 0.2s;
    }
    .phr-widget .phr-field input:focus,
    .phr-widget .phr-field textarea:focus,
    .phr-widget .phr-field select:focus {
      outline: none;
      border-color: var(--phr-primary);
    }
    .phr-widget .phr-field textarea { resize: vertical; min-height: 100px; }
    .phr-widget .phr-fieldset {
      border: none;
      padding: 0;
      margin: 0;
    }
    .phr-widget .phr-fieldset legend {
      font-size: 0.9rem;
      font-weight: 500;
      color: var(--phr-text);
      margin-bottom: 0.5rem;
    }
    .phr-widget .phr-options {
      display: flex;
      flex-wrap: wrap;
      gap: 1rem;
    }
    .phr-widget .phr-options label {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      font-weight: 400;
      cursor: pointer;
    }
    .phr-widget .phr-file-input {
      padding: 1rem;
      border: 2px dashed var(--phr-border);
      border-radius: 6px;
      text-align: center;
      cursor: pointer;
      transition: border-color 0.2s;
    }
    .phr-widget .phr-file-input:hover { border-color: var(--phr-primary); }
    .phr-widget .phr-file-input input {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    .phr-widget .phr-file-name {
      margin-top: 0.5rem;
      font-size: 0.85rem;
      color: var(--phr-primary);
    }

    /* Success */
    .phr-widget .phr-success {
      text-align: center;
      padding: 2rem;
    }
    .phr-widget .phr-success-icon {
      width: 60px;
      height: 60px;
      background: #22c55e;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 1rem;
      color: #fff;
      font-size: 2rem;
    }
    .phr-widget .phr-success h3 { color: var(--phr-text); margin: 0 0 0.5rem; }
    .phr-widget .phr-success p { color: var(--phr-text-muted); margin: 0; }
  `;

  function htmlEscape(str) {
    return String(str || '').replace(/[&<>"']/g, ch =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
    );
  }

  function stripHtml(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html || '';
    return tmp.textContent || '';
  }

  class PowerHRJobsWidget {
    constructor(config) {
      this.apiKey = config.apiKey;
      this.container = typeof config.container === 'string'
        ? document.querySelector(config.container)
        : config.container;
      this.theme = config.theme || 'auto';
      this.baseUrl = config.baseUrl || API_BASE_URL;
      this.jobs = [];
      this.questions = [];
      this.branding = {};
      this.currentJob = null;

      if (!this.container) {
        console.error('[PowerHRJobs] Container not found:', config.container);
        return;
      }
      if (!this.apiKey) {
        console.error('[PowerHRJobs] API key is required');
        return;
      }

      this.init();
    }

    async init() {
      this.injectStyles();
      this.container.classList.add('phr-widget');
      this.applyTheme();
      this.showLoading();

      try {
        await this.fetchBranding();
        await this.fetchJobs();
        this.renderJobList();
      } catch (err) {
        console.error('[PowerHRJobs] Init error:', err);
        this.showError('Unable to load jobs. Please try again later.');
      }
    }

    injectStyles() {
      if (document.getElementById('phr-widget-styles')) return;
      const style = document.createElement('style');
      style.id = 'phr-widget-styles';
      style.textContent = WIDGET_STYLES;
      document.head.appendChild(style);
    }

    applyTheme() {
      let theme = this.theme;
      if (theme === 'auto') {
        theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
      this.container.classList.toggle('phr-theme-dark', theme === 'dark');
    }

    async apiFetch(endpoint, options = {}) {
      const url = `${this.baseUrl}${endpoint}`;
      console.log('[PowerHRJobs] Fetching:', url);
      try {
        const res = await fetch(url, {
          ...options,
          headers: {
            'X-API-Key': this.apiKey,
            'Accept': 'application/json',
            ...options.headers,
          },
        });
        if (!res.ok) {
          const errorText = await res.text().catch(() => '');
          console.error('[PowerHRJobs] API error:', res.status, errorText);
          throw new Error(`HTTP ${res.status}`);
        }
        const data = await res.json();
        console.log('[PowerHRJobs] Response:', endpoint, data);
        return data;
      } catch (err) {
        console.error('[PowerHRJobs] Fetch failed:', url, err);
        throw err;
      }
    }

    async fetchBranding() {
      try {
        const data = await this.apiFetch('/public/embed/branding');
        this.branding = data.branding || {};
        if (this.branding.primary_color) {
          this.container.style.setProperty('--phr-primary', this.branding.primary_color);
        }
      } catch (e) {
        console.warn('[PowerHRJobs] Branding fetch failed:', e.message);
      }
    }

    async fetchJobs() {
      const data = await this.apiFetch('/public/embed/jobs');
      this.jobs = data.jobs || [];
    }

    async fetchQuestions(jobId) {
      try {
        const data = await this.apiFetch(`/public/embed/questions/${jobId}`);
        return data.questions || [];
      } catch (e) {
        console.warn('[PowerHRJobs] Questions fetch failed:', e.message);
        return [];
      }
    }

    render(html) {
      this.container.innerHTML = html;
    }

    showLoading() {
      this.render(`
        <div class="phr-loading">
          <div class="phr-spinner"></div>
          <p>Loading jobs...</p>
        </div>
      `);
    }

    showError(message) {
      this.render(`<div class="phr-error">${htmlEscape(message)}</div>`);
    }

    renderJobList() {
      if (!this.jobs.length) {
        this.render('<div class="phr-empty">No open positions at this time. Check back soon!</div>');
        return;
      }

      const cards = this.jobs.map(job => `
        <li class="phr-job-card" data-job-id="${job.job_listing_id}">
          <div class="phr-job-meta">
            <span class="phr-badge">${htmlEscape(job.department || 'General')}</span>
            <span>\u2022</span>
            <span>${htmlEscape(job.location || 'Remote')}</span>
            ${job.employment_type ? `<span>\u2022</span><span>${htmlEscape(job.employment_type)}</span>` : ''}
          </div>
          <h3 class="phr-job-title">${htmlEscape(job.job_title)}</h3>
          <p class="phr-job-summary">${htmlEscape(this.getSummary(job))}</p>
          <div class="phr-job-actions">
            <button class="phr-btn phr-btn-ghost" data-action="view" data-job-id="${job.job_listing_id}">View Details</button>
            <button class="phr-btn phr-btn-primary" data-action="apply" data-job-id="${job.job_listing_id}">Apply Now</button>
          </div>
        </li>
      `).join('');

      this.render(`<ul class="phr-jobs-list">${cards}</ul>`);
      this.attachListeners();
    }

    attachListeners() {
      this.container.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const jobId = btn.dataset.jobId;
        const action = btn.dataset.action;
        if (action === 'view') this.showJobDetail(jobId);
        if (action === 'apply') this.showApplyForm(jobId);
      });
    }

    getSummary(job) {
      const text = stripHtml(job.role_snapshot || job.description || '');
      return text.length > 150 ? text.slice(0, 147) + '...' : text;
    }

    getJob(jobId) {
      return this.jobs.find(j => String(j.job_listing_id) === String(jobId));
    }

    showJobDetail(jobId) {
      const job = this.getJob(jobId);
      if (!job) return;

      const sections = [];
      const addSection = (title, content) => {
        if (content?.trim()) {
          sections.push(`<div class="phr-section"><h4>${title}</h4><p>${htmlEscape(content)}</p></div>`);
        }
      };
      addSection('Role Snapshot', job.role_snapshot);
      addSection('A Day in the Life', job.day_in_the_life);
      addSection("You'll Thrive Here If...", job.thrive_here_if);
      addSection('What You Bring', job.what_you_bring);
      addSection('What We Offer', job.what_s3_brings);
      addSection('Description', job.description);

      this.showModal(`
        <div class="phr-modal-header">
          <h3>${htmlEscape(job.job_title)}</h3>
          <button class="phr-modal-close" data-close>&times;</button>
        </div>
        <div class="phr-modal-body">
          <div class="phr-job-meta" style="margin-bottom:1rem">
            <span class="phr-badge">${htmlEscape(job.department || 'General')}</span>
            <span>\u2022</span>
            <span>${htmlEscape(job.location || 'Remote')}</span>
          </div>
          ${sections.join('') || '<p>No additional details available.</p>'}
        </div>
        <div class="phr-modal-footer">
          <button class="phr-btn phr-btn-ghost" data-close>Close</button>
          <button class="phr-btn phr-btn-primary" data-action="apply" data-job-id="${jobId}">Apply Now</button>
        </div>
      `);
    }

    async showApplyForm(jobId) {
      const job = this.getJob(jobId);
      if (!job) return;
      this.currentJob = job;

      // Show loading while fetching questions
      this.showModal(`
        <div class="phr-modal-header">
          <h3>Apply: ${htmlEscape(job.job_title)}</h3>
          <button class="phr-modal-close" data-close>&times;</button>
        </div>
        <div class="phr-modal-body">
          <div class="phr-loading"><div class="phr-spinner"></div><p>Loading application form...</p></div>
        </div>
      `);

      // Fetch questions
      this.questions = await this.fetchQuestions(jobId);

      // Build form
      const questionsHtml = this.questions.length > 0
        ? this.renderQuestions(this.questions)
        : this.renderDefaultQuestions();

      const formHtml = `
        <div class="phr-modal-header">
          <h3>Apply: ${htmlEscape(job.job_title)}</h3>
          <button class="phr-modal-close" data-close>&times;</button>
        </div>
        <div class="phr-modal-body">
          <form id="phr-apply-form" class="phr-apply-form">
            <input type="hidden" name="job_id" value="${jobId}">

            <div class="phr-form-section">
              <h4>Contact Information</h4>
              <div class="phr-form-grid">
                <div class="phr-field">
                  <label>Full Name *</label>
                  <input type="text" name="name" required autocomplete="name">
                </div>
                <div class="phr-field">
                  <label>Email *</label>
                  <input type="email" name="email" required autocomplete="email">
                </div>
                <div class="phr-field">
                  <label>Phone *</label>
                  <input type="tel" name="phone" required autocomplete="tel">
                </div>
                <div class="phr-field">
                  <label>LinkedIn/Portfolio <span class="phr-optional">(optional)</span></label>
                  <input type="url" name="link" placeholder="https://...">
                </div>
              </div>
            </div>

            <div class="phr-form-section">
              <h4>Questions</h4>
              <div class="phr-form-grid">
                ${questionsHtml}
              </div>
            </div>

            <div class="phr-form-section">
              <h4>Documents</h4>
              <div class="phr-form-grid">
                <div class="phr-field phr-full">
                  <label>Resume *</label>
                  <div class="phr-file-input" data-file="resume">
                    <input type="file" name="resumeFile" accept=".pdf,.doc,.docx" required>
                    <p>Click to upload or drag and drop</p>
                    <p style="font-size:0.8rem;color:var(--phr-text-muted)">PDF, DOC, DOCX (max 10MB)</p>
                    <div class="phr-file-name"></div>
                  </div>
                </div>
                <div class="phr-field phr-full">
                  <label>Cover Letter <span class="phr-optional">(optional)</span></label>
                  <div class="phr-file-input" data-file="cover">
                    <input type="file" name="coverLetterFile" accept=".pdf,.doc,.docx">
                    <p>Click to upload or drag and drop</p>
                    <div class="phr-file-name"></div>
                  </div>
                </div>
              </div>
            </div>
          </form>
        </div>
        <div class="phr-modal-footer">
          <button class="phr-btn phr-btn-ghost" data-close>Cancel</button>
          <button class="phr-btn phr-btn-primary" id="phr-submit-btn">Submit Application</button>
        </div>
      `;

      this.updateModal(formHtml);
      this.attachFormListeners();
    }

    renderQuestions(questions) {
      return questions.map(q => this.renderQuestion(q)).join('');
    }

    renderQuestion(q) {
      const key = htmlEscape(q.question_key);
      const label = htmlEscape(q.label);
      const req = q.is_required;
      const optMark = req ? ' *' : ' <span class="phr-optional">(optional)</span>';

      switch (q.question_type) {
        case 'textarea':
          return `
            <div class="phr-field phr-full">
              <label>${label}${optMark}</label>
              <textarea name="q_${key}" rows="3" ${req ? 'required' : ''}></textarea>
            </div>`;

        case 'radio':
          const radioOpts = (q.options || []).map((opt, i) => {
            const val = typeof opt === 'object' ? (opt.value || opt.label) : opt;
            const lbl = typeof opt === 'object' ? opt.label : opt;
            return `<label><input type="radio" name="q_${key}" value="${htmlEscape(val)}" ${i === 0 && req ? 'required' : ''}> ${htmlEscape(lbl)}</label>`;
          }).join('');
          return `
            <fieldset class="phr-fieldset phr-full">
              <legend>${label}${optMark}</legend>
              <div class="phr-options">${radioOpts}</div>
            </fieldset>`;

        case 'yes_no':
          return `
            <fieldset class="phr-fieldset">
              <legend>${label}${optMark}</legend>
              <div class="phr-options">
                <label><input type="radio" name="q_${key}" value="yes" ${req ? 'required' : ''}> Yes</label>
                <label><input type="radio" name="q_${key}" value="no"> No</label>
              </div>
            </fieldset>`;

        case 'dropdown':
          const selectOpts = (q.options || []).map(opt => {
            const val = typeof opt === 'object' ? (opt.value || opt.label) : opt;
            const lbl = typeof opt === 'object' ? opt.label : opt;
            return `<option value="${htmlEscape(val)}">${htmlEscape(lbl)}</option>`;
          }).join('');
          return `
            <div class="phr-field">
              <label>${label}${optMark}</label>
              <select name="q_${key}" ${req ? 'required' : ''}>
                <option value="">Select...</option>
                ${selectOpts}
              </select>
            </div>`;

        default: // text
          return `
            <div class="phr-field phr-full">
              <label>${label}${optMark}</label>
              <input type="text" name="q_${key}" ${req ? 'required' : ''}>
            </div>`;
      }
    }

    renderDefaultQuestions() {
      // Fallback questions if tenant has none configured
      return `
        <div class="phr-field phr-full">
          <label>Why are you interested in this position? *</label>
          <textarea name="q_interest" rows="3" required></textarea>
        </div>
        <div class="phr-field phr-full">
          <label>What is your expected salary range? <span class="phr-optional">(optional)</span></label>
          <input type="text" name="q_salary" placeholder="e.g., $50,000 - $60,000">
        </div>
        <fieldset class="phr-fieldset">
          <legend>Are you authorized to work in the US? *</legend>
          <div class="phr-options">
            <label><input type="radio" name="q_work_auth" value="yes" required> Yes</label>
            <label><input type="radio" name="q_work_auth" value="no"> No</label>
          </div>
        </fieldset>
      `;
    }

    attachFormListeners() {
      const form = document.getElementById('phr-apply-form');
      const submitBtn = document.getElementById('phr-submit-btn');

      // File input handling
      this.container.querySelectorAll('.phr-file-input').forEach(div => {
        const input = div.querySelector('input[type="file"]');
        const nameDisplay = div.querySelector('.phr-file-name');

        div.addEventListener('click', () => input.click());
        input.addEventListener('change', () => {
          nameDisplay.textContent = input.files[0]?.name || '';
        });
      });

      // Submit handling
      submitBtn?.addEventListener('click', async () => {
        if (!form.checkValidity()) {
          form.reportValidity();
          return;
        }
        await this.submitApplication(form);
      });
    }

    async submitApplication(form) {
      const submitBtn = document.getElementById('phr-submit-btn');
      const originalText = submitBtn.textContent;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting...';

      try {
        const formData = new FormData(form);

        // Collect question responses
        const responses = {};
        for (const [key, value] of formData.entries()) {
          if (key.startsWith('q_')) {
            responses[key.substring(2)] = value;
          }
        }
        formData.append('question_responses', JSON.stringify(responses));

        const res = await fetch(`${this.baseUrl}/public/embed/apply`, {
          method: 'POST',
          headers: { 'X-API-Key': this.apiKey },
          body: formData,
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.message || `HTTP ${res.status}`);
        }

        this.showSuccess();
      } catch (err) {
        console.error('[PowerHRJobs] Submit error:', err);
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;
        alert('Failed to submit application: ' + err.message);
      }
    }

    showSuccess() {
      this.updateModal(`
        <div class="phr-modal-body">
          <div class="phr-success">
            <div class="phr-success-icon">\u2713</div>
            <h3>Application Submitted!</h3>
            <p>Thank you for applying to ${htmlEscape(this.currentJob?.job_title)}. We'll review your application and be in touch soon.</p>
          </div>
        </div>
        <div class="phr-modal-footer">
          <button class="phr-btn phr-btn-primary" data-close>Close</button>
        </div>
      `);
    }

    showModal(content) {
      // Remove existing modal
      this.container.querySelector('.phr-overlay')?.remove();

      const overlay = document.createElement('div');
      overlay.className = 'phr-overlay';
      overlay.innerHTML = `<div class="phr-modal">${content}</div>`;
      this.container.appendChild(overlay);

      // Animate in
      requestAnimationFrame(() => overlay.classList.add('phr-active'));

      // Close handlers
      overlay.querySelectorAll('[data-close]').forEach(el => {
        el.addEventListener('click', () => this.closeModal());
      });
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) this.closeModal();
      });

      // Handle apply button in detail modal
      overlay.querySelector('[data-action="apply"]')?.addEventListener('click', (e) => {
        const jobId = e.target.dataset.jobId;
        this.closeModal();
        setTimeout(() => this.showApplyForm(jobId), 200);
      });
    }

    updateModal(content) {
      const modal = this.container.querySelector('.phr-modal');
      if (modal) {
        modal.innerHTML = content;
        // Re-attach close handlers
        modal.querySelectorAll('[data-close]').forEach(el => {
          el.addEventListener('click', () => this.closeModal());
        });
      }
    }

    closeModal() {
      const overlay = this.container.querySelector('.phr-overlay');
      if (overlay) {
        overlay.classList.remove('phr-active');
        setTimeout(() => overlay.remove(), 200);
      }
    }
  }

  // Auto-init function for data-attribute containers
  function autoInit() {
    const containers = document.querySelectorAll('[data-phr-api-key]');
    if (containers.length > 0) {
      console.log('[PowerHRJobs] Auto-init found', containers.length, 'container(s)');
    }
    containers.forEach(el => {
      // Skip if already initialized
      if (el.dataset.phrInitialized) return;
      el.dataset.phrInitialized = 'true';

      window.PowerHRJobs.init({
        apiKey: el.dataset.phrApiKey,
        container: el,
        theme: el.dataset.phrTheme || 'auto'
      });
    });
  }

  // Global API
  window.PowerHRJobs = {
    init: (config) => {
      console.log('[PowerHRJobs] Initializing widget with config:', {
        apiKey: config.apiKey ? config.apiKey.substring(0, 12) + '...' : 'MISSING',
        container: config.container,
        theme: config.theme
      });
      return new PowerHRJobsWidget(config);
    },
    autoInit: autoInit,
    version: '1.3.3'
  };

  // Auto-init: Handle both early and late loading scenarios
  if (document.readyState === 'loading') {
    // DOM not ready, wait for it
    document.addEventListener('DOMContentLoaded', autoInit);
  } else {
    // DOM already ready (late load scenario - common in SPAs like Next.js)
    // Run immediately but use setTimeout to ensure script execution completes first
    setTimeout(autoInit, 0);
  }

  console.log('[PowerHRJobs] Widget v1.3.3 loaded. Base URL:', API_BASE_URL);
})();
