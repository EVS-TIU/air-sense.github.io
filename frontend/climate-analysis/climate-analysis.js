/* ==========================================================================
   Climate Analysis Module — Tab switching & view integration
   ========================================================================== */

(function () {
    'use strict';

    /* ------------------------------------------------------------------
       DOM references
       ------------------------------------------------------------------ */

    const section       = document.getElementById('climate-analysis-section');
    const tabButtons    = section ? Array.from(section.querySelectorAll('.ca-tabs__btn')) : [];
    const tabPanels     = section ? Array.from(section.querySelectorAll('.ca-tab-panel')) : [];

    /* Existing dashboard sections that should hide when Climate Analysis is shown */
    const weatherSections = [
        document.querySelector('.current-weather'),
        document.querySelector('.hourly-forecast'),
        document.querySelector('.weather-details'),
        document.querySelector('.week-forecast'),
    ].filter(Boolean);

    if (!section) {
        return;
    }

    /* ------------------------------------------------------------------
       Tab switching
       ------------------------------------------------------------------ */

    function activateTab(targetId) {
        tabButtons.forEach(function (btn) {
            const isTarget = btn.dataset.tab === targetId;
            btn.classList.toggle('is-active', isTarget);
            btn.setAttribute('aria-selected', isTarget ? 'true' : 'false');
        });

        tabPanels.forEach(function (panel) {
            const isTarget = panel.id === targetId;
            panel.classList.toggle('is-active', isTarget);
            panel.setAttribute('aria-hidden', isTarget ? 'false' : 'true');
        });
    }

    tabButtons.forEach(function (btn) {
        btn.addEventListener('click', function () {
            activateTab(btn.dataset.tab);
        });
    });

    /* ------------------------------------------------------------------
       View switching — show / hide Climate Analysis vs weather panels
       ------------------------------------------------------------------ */

    function showClimateAnalysis() {
        weatherSections.forEach(function (el) { el.style.display = 'none'; });
        section.classList.add('is-visible');
    }

    function hideClimateAnalysis() {
        section.classList.remove('is-visible');
        weatherSections.forEach(function (el) { el.style.display = ''; });
    }

    /* Listen for topbar navigation events */
    document.addEventListener('weatherly:navigate', function (e) {
        var view = e.detail && e.detail.view;
        if (view === 'climate-analysis') {
            showClimateAnalysis();
        } else {
            hideClimateAnalysis();
        }
    });

    /* If Climate Analysis is the default active nav link, show on load */
    var activeNavLink = document.querySelector('.topbar-nav a.is-active');
    if (activeNavLink && activeNavLink.dataset.view === 'climate-analysis') {
        showClimateAnalysis();
    }

})();
