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

    /* ------------------------------------------------------------------
       Calendar — date-range picker with Day / Month / Year views
       Click the month-year label to drill up:  Days → Months → Years
       ------------------------------------------------------------------ */

    var calendarCard  = section.querySelector('.ca-calendar-card');
    var monthLabel    = section.querySelector('.ca-calendar__month-label');
    var weekdaysRow   = section.querySelector('.ca-calendar__weekdays');
    var daysContainer = section.querySelector('.ca-calendar__days');
    var prevBtn       = calendarCard ? calendarCard.querySelector('.ca-calendar__nav-btn[aria-label="Previous month"]') : null;
    var nextBtn       = calendarCard ? calendarCard.querySelector('.ca-calendar__nav-btn[aria-label="Next month"]') : null;

    var MONTH_NAMES = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
    ];
    var MONTH_SHORT = [
        'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
    ];

    var today      = new Date();
    var viewYear   = today.getFullYear();
    var viewMonth  = today.getMonth();
    var rangeStart = null;
    var rangeEnd   = null;

    // 'days' | 'months' | 'years'
    var calendarView = 'days';
    // Base year for the 12-year grid
    var yearRangeStart = viewYear - 5;

    function isSameDay(a, b) {
        return a && b &&
            a.getFullYear() === b.getFullYear() &&
            a.getMonth() === b.getMonth() &&
            a.getDate() === b.getDate();
    }

    function isBetween(date, start, end) {
        if (!start || !end) return false;
        var t = date.getTime();
        var s = Math.min(start.getTime(), end.getTime());
        var e = Math.max(start.getTime(), end.getTime());
        return t > s && t < e;
    }

    /* ---------- Day view ---------- */

    function renderDays() {
        if (!monthLabel || !daysContainer) return;

        monthLabel.textContent = MONTH_NAMES[viewMonth] + ' ' + viewYear;
        monthLabel.style.cursor = 'pointer';
        if (weekdaysRow) weekdaysRow.style.display = '';

        var firstDay      = new Date(viewYear, viewMonth, 1);
        var startOffset   = firstDay.getDay();
        var daysInMonth   = new Date(viewYear, viewMonth + 1, 0).getDate();
        var prevMonthDays = new Date(viewYear, viewMonth, 0).getDate();

        var html = '';

        for (var p = startOffset - 1; p >= 0; p--) {
            var pDay = prevMonthDays - p;
            html += '<span class="ca-calendar__day is-outside" data-date="' +
                new Date(viewYear, viewMonth - 1, pDay).toISOString().slice(0, 10) +
                '">' + pDay + '</span>';
        }

        for (var d = 1; d <= daysInMonth; d++) {
            var date = new Date(viewYear, viewMonth, d);
            var cls  = 'ca-calendar__day';
            if (isSameDay(date, today))      cls += ' is-today';
            if (isSameDay(date, rangeStart))  cls += ' is-selected';
            if (isSameDay(date, rangeEnd))    cls += ' is-selected';
            if (isBetween(date, rangeStart, rangeEnd)) cls += ' is-in-range';

            html += '<span class="' + cls + '" data-date="' +
                date.toISOString().slice(0, 10) + '">' + d + '</span>';
        }

        var totalCells = startOffset + daysInMonth;
        var remaining  = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
        for (var n = 1; n <= remaining; n++) {
            html += '<span class="ca-calendar__day is-outside" data-date="' +
                new Date(viewYear, viewMonth + 1, n).toISOString().slice(0, 10) +
                '">' + n + '</span>';
        }

        daysContainer.innerHTML = html;
    }

    /* ---------- Month view ---------- */

    function renderMonths() {
        if (!monthLabel || !daysContainer) return;

        monthLabel.textContent = String(viewYear);
        monthLabel.style.cursor = 'pointer';
        if (weekdaysRow) weekdaysRow.style.display = 'none';

        var html = '';
        for (var m = 0; m < 12; m++) {
            var cls = 'ca-calendar__day ca-calendar__cell--large';
            if (m === today.getMonth() && viewYear === today.getFullYear()) cls += ' is-today';
            html += '<span class="' + cls + '" data-month="' + m + '">' + MONTH_SHORT[m] + '</span>';
        }
        daysContainer.innerHTML = html;
    }

    /* ---------- Year view ---------- */

    function renderYears() {
        if (!monthLabel || !daysContainer) return;

        var end = yearRangeStart + 11;
        monthLabel.textContent = yearRangeStart + ' – ' + end;
        monthLabel.style.cursor = 'default';
        if (weekdaysRow) weekdaysRow.style.display = 'none';

        var html = '';
        for (var y = yearRangeStart; y <= end; y++) {
            var cls = 'ca-calendar__day ca-calendar__cell--large';
            if (y === today.getFullYear()) cls += ' is-today';
            html += '<span class="' + cls + '" data-year="' + y + '">' + y + '</span>';
        }
        daysContainer.innerHTML = html;
    }

    /* ---------- Unified render ---------- */

    function renderCalendar() {
        if (calendarView === 'years')  renderYears();
        else if (calendarView === 'months') renderMonths();
        else renderDays();
    }

    /* ---------- Click: month-year label to drill up ---------- */

    if (monthLabel) {
        monthLabel.addEventListener('click', function () {
            if (calendarView === 'days') {
                calendarView = 'months';
            } else if (calendarView === 'months') {
                calendarView = 'years';
                yearRangeStart = viewYear - 5;
            }
            renderCalendar();
        });
    }

    /* ---------- Click: day / month / year cells ---------- */

    if (daysContainer) {
        daysContainer.addEventListener('click', function (e) {
            var cell = e.target.closest('.ca-calendar__day');
            if (!cell) return;

            // Year view → pick year → go to month view
            if (cell.dataset.year !== undefined) {
                viewYear = parseInt(cell.dataset.year, 10);
                calendarView = 'months';
                renderCalendar();
                return;
            }

            // Month view → pick month → go to day view
            if (cell.dataset.month !== undefined) {
                viewMonth = parseInt(cell.dataset.month, 10);
                calendarView = 'days';
                renderCalendar();
                return;
            }

            // Day view → range selection
            if (!cell.dataset.date) return;
            var clicked = new Date(cell.dataset.date + 'T00:00:00');

            if (!rangeStart || (rangeStart && rangeEnd)) {
                rangeStart = clicked;
                rangeEnd   = null;
            } else {
                if (clicked.getTime() < rangeStart.getTime()) {
                    rangeEnd   = rangeStart;
                    rangeStart = clicked;
                } else {
                    rangeEnd = clicked;
                }
            }

            // If clicked day is in a different month, navigate there
            viewYear  = clicked.getFullYear();
            viewMonth = clicked.getMonth();
            renderCalendar();
        });
    }

    /* ---------- Prev / Next buttons ---------- */

    if (prevBtn) {
        prevBtn.addEventListener('click', function () {
            if (calendarView === 'years') {
                yearRangeStart -= 12;
            } else if (calendarView === 'months') {
                viewYear--;
            } else {
                viewMonth--;
                if (viewMonth < 0) { viewMonth = 11; viewYear--; }
            }
            renderCalendar();
        });
    }

    if (nextBtn) {
        nextBtn.addEventListener('click', function () {
            if (calendarView === 'years') {
                yearRangeStart += 12;
            } else if (calendarView === 'months') {
                viewYear++;
            } else {
                viewMonth++;
                if (viewMonth > 11) { viewMonth = 0; viewYear++; }
            }
            renderCalendar();
        });
    }

    // Initial render
    renderCalendar();

})();
