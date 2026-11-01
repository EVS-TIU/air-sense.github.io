(() => {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;

    const links = Array.from(sidebar.querySelectorAll('.sidebar-content__link'));
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
        });
    });
})();
