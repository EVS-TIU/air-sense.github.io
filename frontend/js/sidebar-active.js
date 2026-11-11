(function () {
  const page = document.body.classList.contains("ai-recommendation-page") ? "ai-recommendation" :
    document.body.classList.contains("smart-alert-page") ? "smart-alert" :
    document.body.classList.contains("history-page") ? "history-analysis" :
    document.body.classList.contains("climate-analysis-page") ? "climate-analysis" : "current-weather";
  const links = document.querySelectorAll(".sidebar__nav a[data-nav]");
  const setActive = activeLink => links.forEach(link => {
    const active = link === activeLink;
    link.classList.toggle("is-active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });

  links.forEach(link => {
    if (link.dataset.nav === page) setActive(link);
    link.addEventListener("click", () => setActive(link));
    if (link.dataset.nav === "current-weather" && page !== "current-weather") {
      link.href = document.body.classList.contains("climate-analysis-page") ? "../index.html#current-weather" : "./index.html#current-weather";
    }
  });
})();
