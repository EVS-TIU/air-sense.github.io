/* Step 4: the AI only explains approved recommendations (PDF sections 8-10).
   Output is schema-checked; anything that adds numbers, ids or claims the backend did not supply is rejected. */
(function () {
  const C = window.AIREC_CONFIG;

  const SYSTEM = `ROLE
You are the AI explanation component of a deterministic Weather Intelligence and Recommendation System. You are not an independent weather forecasting system.

AUTHORITY
The backend rule engine is the single authority for weather classifications, risk levels, safety warnings, recommendation triggers, priorities, activity suitability and validity periods. Explain approved results only. Never override the backend.

INPUTS
You receive validated weather values and approved recommendation objects (id, priority, title, reason, action, triggered_by, valid_until) plus data_limitations. Interpret each value with its unit.

RECOMMENDATIONS
Explain only the recommendations supplied. Do not create a new hazard, infer a new warning or add an unsupported action. If there are no recommendations, return an empty explanations array.

US AQI
This application uses US EPA AQI exclusively: 0-50 Good, 51-100 Moderate, 101-150 Unhealthy for Sensitive Groups, 151-200 Unhealthy, 201-300 Very Unhealthy, 301-500 Hazardous. Never use Indian CPCB AQI categories or breakpoints.

ANTI-HALLUCINATION
1. Never fabricate weather values, forecasts, pollutant concentrations or official alerts.
2. Never treat missing data as zero, normal or safe.
3. Never infer rain from clouds alone or lightning from rain, clouds or wind.
4. Never infer good air quality from missing AQI.
5. Never claim UV is low because it is cloudy.
6. Never confuse rain probability with rainfall intensity or sustained wind with gusts.
7. Never use stale data as current.
8. Never mix AQI standards or averaging periods.
9. Never provide medical diagnoses or individualized treatment.
10. Never claim an activity is completely safe.
11. Never alter metric values, priorities, triggers or validity periods.

OUTPUT
Return only valid JSON, no Markdown or extra prose, in exactly this shape:
{"summary":"<one or two plain sentences, max 240 characters, covering the highest-priority items>","explanations":[{"id":"<recommendation id>","explanation":"<one or two plain sentences, max 220 characters, explaining why the action is recommended using only the supplied values>"}]}
Include exactly one explanation per supplied recommendation, using the same ids. No other keys.

STYLE
Concise, specific, actionable. Avoid alarmism and repetition. Accuracy and user safety come before creativity.`;

  const enabled = () => !!C.LLM_API_KEY;

  function payload(res) {
    return {
      weather_summary: res.weather_summary,
      overall_risk: res.overall_risk,
      recommendations: res.recommendations.map(r => ({
        id: r.id, category: r.category, priority: r.priority, title: r.title, reason: r.reason,
        action: r.action, triggered_by: r.triggered_by, valid_until: r.valid_until
      })),
      data_limitations: res.data_limitations,
      generated_at: res.generated_at
    };
  }

  async function post(url, headers, body) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 25000);
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: ctl.signal });
      if (!r.ok) throw new Error("LLM request failed (HTTP " + r.status + ")");
      return await r.json();
    } finally { clearTimeout(timer); }
  }

  async function callModel(user) {
    const p = C.LLM_PROVIDER;
    if (p === "anthropic") {
      const d = await post("https://api.anthropic.com/v1/messages", {
        "x-api-key": C.LLM_API_KEY, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true"
      }, { model: C.LLM_MODEL, max_tokens: 1000, temperature: 0.2, system: SYSTEM, messages: [{ role: "user", content: user }] });
      return d.content.filter(b => b.type === "text").map(b => b.text).join("");
    }
    if (p === "gemini") {
      const d = await post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(C.LLM_MODEL)}:generateContent?key=${encodeURIComponent(C.LLM_API_KEY)}`, {}, {
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
      });
      return d.candidates[0].content.parts.map(x => x.text || "").join("");
    }
    if (p === "openai") {
      const d = await post(C.LLM_BASE_URL.replace(/\/$/, "") + "/chat/completions", { Authorization: "Bearer " + C.LLM_API_KEY }, {
        model: C.LLM_MODEL, temperature: 0.2, response_format: { type: "json_object" },
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }]
      });
      return d.choices[0].message.content;
    }
    throw new Error("Unknown LLM_PROVIDER: " + p);
  }

  // Guard: structure, ids and numbers must all come from the backend payload.
  function validate(out, res, pl) {
    if (!out || typeof out !== "object" || Array.isArray(out)) throw new Error("AI output is not an object");
    const keys = Object.keys(out);
    if (keys.some(k => k !== "summary" && k !== "explanations")) throw new Error("AI output has unexpected fields");
    if (!Array.isArray(out.explanations)) throw new Error("AI output has no explanations array");

    const allowed = new Set((JSON.stringify(pl).match(/\d+(?:\.\d+)?/g) || []).map(Number));
    const hasStorm = res.recommendations.some(r => r.group === "storm");
    const ok = t => typeof t === "string" && t.length > 0 && t.length <= 300
      && (t.match(/\d+(?:\.\d+)?/g) || []).every(n => allowed.has(Number(n)))
      && !/\bCPCB\b/i.test(t) && !/completely safe|totally safe|guaranteed safe/i.test(t)
      && (hasStorm || !/lightning/i.test(t));

    const ids = new Set(res.recommendations.map(r => r.id)), byId = {};
    for (const e of out.explanations) {
      if (!e || typeof e !== "object" || Object.keys(e).some(k => k !== "id" && k !== "explanation")) continue;
      if (ids.has(e.id) && ok(e.explanation)) byId[e.id] = e.explanation.trim();
    }
    return { summary: ok(out.summary) ? out.summary.trim() : null, byId };
  }

  async function explain(res) {
    const pl = payload(res);
    const text = await callModel(JSON.stringify(pl));
    let out;
    try { out = JSON.parse(text.replace(/```json|```/g, "").trim()); }
    catch (e) { throw new Error("AI output was not valid JSON"); }
    return validate(out, res, pl);
  }

  window.AIREC_LLM = { enabled, explain };
})();