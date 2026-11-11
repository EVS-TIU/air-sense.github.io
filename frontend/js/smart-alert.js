(function () {
  const form = document.getElementById("smart-alert-form");
  const status = document.getElementById("smart-alert-status");
  if (!form || !status) return;
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    const data = new FormData(form);
    const days = data.getAll("days");
    if (!days.length) { status.textContent = "Select at least one repeat day."; status.style.color = "#ffb14a"; return; }
    const alert = { name: data.get("name"), time: data.get("time"), start: data.get("start"), end: data.get("end"), days, method: data.get("method") };
    localStorage.setItem("airsense-smart-alert", JSON.stringify(alert));
    status.style.color = "#54dfa8";
    status.textContent = `Smart Alert saved for ${alert.time}, ${days.join(", ")} through ${alert.end}. Weather advice will be sent automatically.`;
  });
})();
