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
        document.body.classList.add('is-climate-analysis-visible');
    }

    function hideClimateAnalysis() {
        section.classList.remove('is-visible');
        document.body.classList.remove('is-climate-analysis-visible');
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

    /* ------------------------------------------------------------------
       Calendar — single custom-day picker
       Year | month dropdowns choose the month; clicking a day selects
       exactly one prediction target date.
       ------------------------------------------------------------------ */

    var calendarCard  = section.querySelector('.ca-calendar-card');
    var yearSelect    = section.querySelector('.ca-calendar__year-select');
    var monthSelect   = section.querySelector('.ca-calendar__month-select');
    var weekdaysRow   = section.querySelector('.ca-calendar__weekdays');
    var daysContainer = section.querySelector('.ca-calendar__days');
    var prevBtn       = calendarCard ? calendarCard.querySelector('.ca-calendar__nav-btn[aria-label="Previous month"]') : null;
    var nextBtn       = calendarCard ? calendarCard.querySelector('.ca-calendar__nav-btn[aria-label="Next month"]') : null;

    var MONTH_NAMES = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
    ];

    var today      = new Date();
    var viewYear   = today.getFullYear();
    var viewMonth  = today.getMonth();
    var selectedDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());

    // Scrollable year span: first year of the archive data through a
    // decade ahead — this is a prediction tab, so future possibilities
    // must be selectable.
    var FIRST_DATA_YEAR = 2005;
    var FUTURE_YEARS = 10;

    function isSameDay(a, b) {
        return a && b &&
            a.getFullYear() === b.getFullYear() &&
            a.getMonth() === b.getMonth() &&
            a.getDate() === b.getDate();
    }

    // Local-calendar ISO date. toISOString() shifts by the UTC offset,
    // which made every day cell one day early in UTC+5:30.
    function localISO(d) {
        var month = d.getMonth() + 1;
        var day = d.getDate();
        return d.getFullYear() + '-' + (month < 10 ? '0' + month : month) +
               '-' + (day < 10 ? '0' + day : day);
    }

    /* ---------- Year | month dropdowns ---------- */

    function initSelectors() {
        if (!yearSelect || !monthSelect) return;

        var years = '';
        var lastYear = today.getFullYear() + FUTURE_YEARS;
        // Past years are gone: predictions start from today, so the
        // dropdown begins at the current year.
        var firstYear = Math.max(FIRST_DATA_YEAR, today.getFullYear());
        for (var y = firstYear; y <= lastYear; y++) {
            years += '<option value="' + y + '"' + (y === viewYear ? ' selected' : '') + '>' + y + '</option>';
        }
        yearSelect.innerHTML = years;

        var months = '';
        for (var m = 0; m < 12; m++) {
            months += '<option value="' + m + '"' + (m === viewMonth ? ' selected' : '') + '>' + MONTH_NAMES[m] + '</option>';
        }
        monthSelect.innerHTML = months;

        yearSelect.addEventListener('change', function () {
            viewYear = parseInt(yearSelect.value, 10);
            renderCalendar();
        });
        monthSelect.addEventListener('change', function () {
            viewMonth = parseInt(monthSelect.value, 10);
            renderCalendar();
        });
    }

    function syncSelectors() {
        if (yearSelect && String(viewYear) !== yearSelect.value) yearSelect.value = String(viewYear);
        if (monthSelect && String(viewMonth) !== monthSelect.value) monthSelect.value = String(viewMonth);
    }

    /* ---------- Day view ---------- */

    function renderDays() {
        if (!daysContainer) return;

        syncSelectors();
        if (weekdaysRow) weekdaysRow.style.display = '';

        var firstDay      = new Date(viewYear, viewMonth, 1);
        var startOffset   = firstDay.getDay();
        var daysInMonth   = new Date(viewYear, viewMonth + 1, 0).getDate();
        var prevMonthDays = new Date(viewYear, viewMonth, 0).getDate();

        var html = '';

        for (var p = startOffset - 1; p >= 0; p--) {
            var pDay = prevMonthDays - p;
            html += '<span class="ca-calendar__day is-outside" data-date="' +
                localISO(new Date(viewYear, viewMonth - 1, pDay)) +
                '">' + pDay + '</span>';
        }

        for (var d = 1; d <= daysInMonth; d++) {
            var date = new Date(viewYear, viewMonth, d);
            var cls  = 'ca-calendar__day';
            if (isSameDay(date, today))          cls += ' is-today';
            if (isSameDay(date, selectedDate))   cls += ' is-selected';

            html += '<span class="' + cls + '" data-date="' +
                localISO(date) + '">' + d + '</span>';
        }

        var totalCells = startOffset + daysInMonth;
        var remaining  = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
        for (var n = 1; n <= remaining; n++) {
            html += '<span class="ca-calendar__day is-outside" data-date="' +
                localISO(new Date(viewYear, viewMonth + 1, n)) +
                '">' + n + '</span>';
        }

        daysContainer.innerHTML = html;
    }

    /* ---------- Unified render ---------- */

    function renderCalendar() {
        renderDays();
    }

    /* ---------- Click: day cells (single-day selection) ---------- */

    if (daysContainer) {
        daysContainer.addEventListener('click', function (e) {
            var cell = e.target.closest('.ca-calendar__day');
            if (!cell) return;

            if (!cell.dataset.date) return;
            var clicked = new Date(cell.dataset.date + 'T00:00:00');
            selectedDate = clicked;

            // If clicked day is in a different month, navigate there
            viewYear  = clicked.getFullYear();
            viewMonth = clicked.getMonth();
            renderCalendar();

            // Tell the prediction tab to run the trained model for this day.
            document.dispatchEvent(new CustomEvent('weatherly:prediction-date', {
                detail: { date: localISO(clicked) }
            }));
        });
    }

    /* ---------- Prev / Next buttons ---------- */

    if (prevBtn) {
        prevBtn.addEventListener('click', function () {
            viewMonth--;
            if (viewMonth < 0) { viewMonth = 11; viewYear--; }
            renderCalendar();
        });
    }

    if (nextBtn) {
        nextBtn.addEventListener('click', function () {
            viewMonth++;
            if (viewMonth > 11) { viewMonth = 0; viewYear++; }
            renderCalendar();
        });
    }

    // Initial render
    initSelectors();
    renderCalendar();

    /* Public accessor: the single prediction target day, for the
       Generate Analysis / prediction pipeline to consume. */
    window.CaCalendar = {
        getSelectedDate: function () {
            return selectedDate ? localISO(selectedDate) : null;
        }
    };

})();
