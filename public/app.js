const byId = (id) => document.getElementById(id);

const capabilityGrid = byId("capabilityGrid");
const healthBadge = byId("healthBadge");

const renderCapabilities = (capabilities) => {
  const entries = Object.entries(capabilities);
  capabilityGrid.innerHTML = "";
  for (const [key, value] of entries) {
    const node = document.createElement("article");
    node.className = "capability";
    const title = key.replace(/_/g, " ");

    node.innerHTML = `
      <p class="title">${title}</p>
      <span class="pill ${value ? "ready" : "pending"}">${value ? "ready" : "pending"}</span>
    `;
    capabilityGrid.appendChild(node);
  }
};

const setBadge = (text, mode) => {
  healthBadge.textContent = text;
  if (mode === "ok") {
    healthBadge.style.borderColor = "rgba(78, 227, 196, 0.45)";
    healthBadge.style.color = "#9ff7e7";
  }
  if (mode === "warn") {
    healthBadge.style.borderColor = "rgba(246, 111, 131, 0.45)";
    healthBadge.style.color = "#ffb8c3";
  }
};

const loadStatus = async () => {
  try {
    const [healthRes, statusRes] = await Promise.all([
      fetch("/health"),
      fetch("/v1/platform/status")
    ]);

    if (!healthRes.ok || !statusRes.ok) {
      throw new Error("status fetch failed");
    }

    const health = await healthRes.json();
    const status = await statusRes.json();

    setBadge(`Service ${health.status.toUpperCase()} | ${status.environment}`, "ok");
    byId("providerValue").textContent = status.provider;
    byId("timeoutValue").textContent = `${status.runtime.timeout_ms} ms`;
    byId("stepsValue").textContent = `${status.runtime.max_plan_steps}`;
    byId("retentionValue").textContent = `${status.runtime.retention_days} days`;
    byId("firstTokenValue").textContent = `${status.slo?.firstTokenP95Ms ?? 0} ms`;
    byId("canaryValue").textContent = `${status.canary?.config?.trafficPercent ?? 0}%`;

    byId("runCount").textContent = String(status.summary.runCount);
    byId("sessionCount").textContent = String(status.summary.sessionCount);
    byId("eventCount").textContent = String(status.summary.totalEventCount);

    renderCapabilities(status.capabilities);
  } catch {
    setBadge("Service unavailable", "warn");
  }
};

loadStatus();
setInterval(loadStatus, 20000);
