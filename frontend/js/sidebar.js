(() => {
    const sidebar = document.querySelector('.sidebar');
    const menuToggle = document.querySelector('.sidebar-menu-toggle');
    const closeButton = document.querySelector('.sidebar-close');
    const backdrop = document.querySelector('.sidebar-backdrop');
    if (!sidebar || !menuToggle || !closeButton || !backdrop) return;

    const links = Array.from(sidebar.querySelectorAll('.sidebar-content__link'));
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const mobileQuery = window.matchMedia('(max-width: 900px)');
    let isOpen = false;

    function setOpen(open, returnFocus = true) {
        isOpen = open && mobileQuery.matches;
        sidebar.classList.toggle('is-open', isOpen);
        backdrop.classList.toggle('is-visible', isOpen);
        sidebar.setAttribute('aria-hidden', String(mobileQuery.matches && !isOpen));
        menuToggle.setAttribute('aria-expanded', String(isOpen));
        document.body.classList.toggle('sidebar-open', isOpen);

        if (isOpen) {
            closeButton.focus();
        } else if (returnFocus && mobileQuery.matches) {
            menuToggle.focus();
        }
    }

    function handleViewportChange() {
        if (!mobileQuery.matches) {
            const shouldRestoreFocus = isOpen && sidebar.contains(document.activeElement);
            isOpen = false;
            sidebar.classList.remove('is-open');
            backdrop.classList.remove('is-visible');
            sidebar.setAttribute('aria-hidden', 'false');
            menuToggle.setAttribute('aria-expanded', 'false');
            document.body.classList.remove('sidebar-open');
            if (shouldRestoreFocus) {
                sidebar.querySelector('.sidebar-content__link.is-active')?.focus();
            }
            return;
        }

        sidebar.setAttribute('aria-hidden', String(!isOpen));
    }

    menuToggle.addEventListener('click', () => setOpen(!isOpen));
    closeButton.addEventListener('click', () => setOpen(false));
    backdrop.addEventListener('click', () => setOpen(false));
    mobileQuery.addEventListener('change', handleViewportChange);
    handleViewportChange();

    document.addEventListener('keydown', (event) => {
        if (!isOpen) return;

        if (event.key === 'Escape') {
            setOpen(false);
            return;
        }

        if (event.key !== 'Tab') return;

        const focusable = Array.from(sidebar.querySelectorAll(
            'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )).filter((element) => element.offsetParent !== null);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    });

    links.forEach((link) => {
        link.addEventListener('click', (event) => {
            event.preventDefault();

            links.forEach((item) => {
                const active = item === link;
                item.classList.toggle('is-active', active);
                if (active) item.setAttribute('aria-current', 'page');
                else item.removeAttribute('aria-current');
            });

            const target = link.dataset.target
                ? document.querySelector(link.dataset.target)
                : null;
            if (target) {
                target.scrollIntoView({
                    behavior: prefersReducedMotion ? 'auto' : 'smooth',
                    block: 'start',
                });
            }

            document.dispatchEvent(new CustomEvent('weatherly:navigate', {
                detail: { view: link.dataset.view },
            }));

            if (mobileQuery.matches) setOpen(false);
        });
    });
})();
