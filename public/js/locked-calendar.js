// public/js/locked-calendar.js
//
// Renders the /api/generate response as a locked teaser instead of full detail.
// Login is triggered ONLY by the "Get This Filed" button — every other interaction
// on the public page stays anonymous.

function renderTeaserCalendar(items, container) {
  container.innerHTML = '';

  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'teaser-row';
    row.innerHTML = `
      <div class="teaser-row__name">${escapeHtml(item.name)}</div>
      <div class="teaser-row__locked">
        <span class="lock-icon" aria-hidden="true">🔒</span>
        Due date, required documents & filing instructions locked
      </div>
    `;
    container.appendChild(row);
  });

  const ctaBar = document.createElement('div');
  ctaBar.className = 'teaser-cta-bar';
  ctaBar.innerHTML = `
    <button id="contact-us-btn" class="btn btn--secondary" type="button">Contact Us</button>
    <button id="get-filed-btn" class="btn btn--primary" type="button">Get This Filed</button>
  `;
  container.appendChild(ctaBar);

  document.getElementById('contact-us-btn').addEventListener('click', openContactModal);
  document.getElementById('get-filed-btn').addEventListener('click', openSignupModal);
}

function openContactModal() {
  // Wire this to your existing lead-capture form/modal — no account is created here.
  document.getElementById('contact-modal').classList.remove('hidden');
}

function openSignupModal() {
  // The ONLY entry point into auth anywhere on the public page.
  // On successful signup/login, carry the already-entered company fields (state,
  // entity type, incorporation date, etc.) forward into the authenticated company
  // profile form instead of asking the user to retype them.
  const pendingProfile = collectCurrentFormValues(); // implement to read your existing form fields
  sessionStorage.setItem('pendingCompanyProfile', JSON.stringify(pendingProfile));
  document.getElementById('signup-modal').classList.remove('hidden');
}

function collectCurrentFormValues() {
  // Adjust field ids to match your existing calculator form in public/index.html
  return {
    state: document.getElementById('state')?.value,
    entityType: document.getElementById('entityType')?.value,
    incorporationDate: document.getElementById('incorporationDate')?.value,
    foreignOwned: document.getElementById('foreignOwned')?.checked,
  };
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
