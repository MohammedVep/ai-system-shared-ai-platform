const byId = (id) => document.getElementById(id);

const setText = (id, value) => {
  const node = byId(id);
  if (node) {
    node.textContent = String(value);
  }
};

const loadOps = async () => {
  const [sloRes, canaryRes, evalRes] = await Promise.all([
    fetch("/v1/ops/slo-dashboard"),
    fetch("/v1/ops/canary"),
    fetch("/v1/ops/evals/latest")
  ]);

  if (sloRes.ok) {
    const slo = await sloRes.json();
    setText("availability", `${slo.availabilityPct}%`);
    setText("success", `${slo.orchestratorSuccessPct}%`);
    setText("policyBlock", `${slo.policyBlockRatePct}%`);
    setText("firstToken", `${slo.firstTokenP95Ms} ms`);
  }

  if (canaryRes.ok) {
    const canary = await canaryRes.json();
    const enabled = Boolean(canary.config?.enabled);
    setText("canaryEnabled", enabled ? "enabled" : "disabled");
    byId("canaryEnabled")?.classList.add(enabled ? "ready" : "pending");
    setText("canaryTraffic", `${canary.config?.trafficPercent ?? 0}%`);
    setText("canaryModel", canary.config?.candidateModel ?? "-" );
    setText("rollbackTime", canary.lastRollback?.at ?? "none");
    setText("rollbackReason", canary.lastRollback?.reason ?? "none");
  }

  if (evalRes.ok) {
    const evalReport = await evalRes.json();
    setText("evalGenerated", evalReport.generated_at ?? "-");
    setText("evalCases", evalReport.total ?? 0);
    setText("evalScore", evalReport.average_score ?? 0);
    setText("evalStatus", "ready");
  } else {
    setText("evalStatus", "run npm run eval:offline");
  }
};

loadOps().catch(() => {
  setText("evalStatus", "dashboard load failed");
});
setInterval(loadOps, 20000);
