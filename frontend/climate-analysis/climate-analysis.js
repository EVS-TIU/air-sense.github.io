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

    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var viewYear   = today.getFullYear();
    var viewMonth  = today.getMonth();
    var selectedDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());

    // The prediction API supports today through 365 days ahead. Keep the
    // picker inside that window so the UI never asks for a date the backend
    // is guaranteed to reject.
    var PREDICTION_RANGE_DAYS = 365;
    var PREDICTION_RANGE_MESSAGE =
        'You have selected out of the predict range. Choose a date from today up to 1 year ahead.';
    var maxDate = new Date(today);
    maxDate.setDate(maxDate.getDate() + PREDICTION_RANGE_DAYS);

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

    function isOutOfRange(date) {
        return date < today || date > maxDate;
    }

    function monthHasAllowedDays(year, month) {
        var first = new Date(year, month, 1);
        var last = new Date(year, month + 1, 0);
        return last >= today && first <= maxDate;
    }

    function showRangeError() {
        document.dispatchEvent(new CustomEvent('weatherly:prediction-range-error', {
            detail: { message: PREDICTION_RANGE_MESSAGE }
        }));
    }

    /* ---------- Year | month dropdowns ---------- */

    function initSelectors() {
        if (!yearSelect || !monthSelect) return;

        var years = '';
        // Only years that can contain a selectable day: the current year
        // through the year containing today + 365 days.
        var firstYear = today.getFullYear();
        var lastYear = maxDate.getFullYear();
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
            var prevDate = new Date(viewYear, viewMonth - 1, pDay);
            var prevCls = 'ca-calendar__day is-outside' +
                (isOutOfRange(prevDate) ? ' is-disabled' : '');
            html += '<span class="' + prevCls + '" data-date="' +
                localISO(prevDate) + '">' + pDay + '</span>';
        }

        for (var d = 1; d <= daysInMonth; d++) {
            var date = new Date(viewYear, viewMonth, d);
            var cls  = 'ca-calendar__day';
            if (isOutOfRange(date))              cls += ' is-disabled';
            if (isSameDay(date, today))          cls += ' is-today';
            if (isSameDay(date, selectedDate))   cls += ' is-selected';

            html += '<span class="' + cls + '" data-date="' +
                localISO(date) + '">' + d + '</span>';
        }

        var totalCells = startOffset + daysInMonth;
        var remaining  = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
        for (var n = 1; n <= remaining; n++) {
            var nextDate = new Date(viewYear, viewMonth + 1, n);
            var nextCls = 'ca-calendar__day is-outside' +
                (isOutOfRange(nextDate) ? ' is-disabled' : '');
            html += '<span class="' + nextCls + '" data-date="' +
                localISO(nextDate) + '">' + n + '</span>';
        }

        daysContainer.innerHTML = html;
    }

    /* ---------- Unified render ---------- */

    function syncNavButtons() {
        var prevY = viewYear, prevM = viewMonth - 1;
        if (prevM < 0) { prevM = 11; prevY--; }
        if (prevBtn) prevBtn.disabled = !monthHasAllowedDays(prevY, prevM);

        var nextY = viewYear, nextM = viewMonth + 1;
        if (nextM > 11) { nextM = 0; nextY++; }
        if (nextBtn) nextBtn.disabled = !monthHasAllowedDays(nextY, nextM);
    }

    function renderCalendar() {
        renderDays();
        syncNavButtons();
    }

    /* ---------- Click: day cells (single-day selection) ---------- */

    if (daysContainer) {
        daysContainer.addEventListener('click', function (e) {
            var cell = e.target.closest('.ca-calendar__day');
            if (!cell) return;

            if (!cell.dataset.date) return;
            var clicked = new Date(cell.dataset.date + 'T00:00:00');

            // Never run a prediction for a date outside the 1-year window.
            if (isOutOfRange(clicked)) {
                showRangeError();
                return;
            }

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
            var y = viewYear, m = viewMonth - 1;
            if (m < 0) { m = 11; y--; }
            if (!monthHasAllowedDays(y, m)) return;
            viewYear = y;
            viewMonth = m;
            renderCalendar();
        });
    }

    if (nextBtn) {
        nextBtn.addEventListener('click', function () {
            var y = viewYear, m = viewMonth + 1;
            if (m > 11) { m = 0; y++; }
            if (!monthHasAllowedDays(y, m)) return;
            viewYear = y;
            viewMonth = m;
            renderCalendar();
        });
    }

    // Initial render
    initSelectors();
    renderCalendar();

    /* Visible reminder of the supported window, so a disabled day is not
       mistaken for a broken calendar. */
    var rangeHint = section.querySelector('.ca-calendar__range-hint');
    if (rangeHint) {
        var prettyDate = function (d) {
            return d.toLocaleDateString(undefined,
                { day: 'numeric', month: 'short', year: 'numeric' });
        };
        rangeHint.textContent = 'Prediction range: ' + prettyDate(today) +
            ' – ' + prettyDate(maxDate) + ' (1 year).';
    }

    /* Public accessor: the single prediction target day, for the
       Generate Analysis / prediction pipeline to consume. */
    window.CaCalendar = {
        getSelectedDate: function () {
            return selectedDate ? localISO(selectedDate) : null;
        }
    };

})();
