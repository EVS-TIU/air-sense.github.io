# AirSense live failures — exact problems and solutions

Date: 2026-11-19. This document records **measured** causes and **verified**
fixes. Related diagnosis evidence is in `docs/live-prediction-failure.md`.
The OpenRouter key is masked here; the real value lives only in the gitignored
`backend/.env` and in the hosting panel’s Environment section.

## Status at a glance

| Problem | Exact cause | Fix | Local | Live |
|---|---|---|---|---|
| Weather Chat LLM unavailable | `LLM_BASE_URL` on the live service is missing `/chat/completions` (or has a trailing slash), so OpenRouter answers `404 Not Found` | Correct env value **plus** defensive URL normalisation added to the backend (pending deploy) | ✅ working (`usedLlm: true`) | ❌ still failing (`usedLlm: false`) |
| Climate prediction `Failed to fetch` / 502 on year-boundary dates | Archive window is built with a start date after the end date, so every historical year gets 400; retries stall the gateway | Code fix already written locally; must be committed, pushed and redeployed | ✅ working (1 archive call, valid temps) | ❌ still 502 (old code deployed) |

---

## Problem 1 — Weather Chat: “LLM is briefly unavailable”

### Symptom

Live page `https://air-sense-web.vercel.app/AI-recommendation.html` shows:

> The LLM is briefly unavailable (provider rate limit or timeout), so here are the live numbers instead. Try again in a moment.

Direct probe of the live API confirms it:

```
POST https://airsense-backend-docker.getvoroa.com/api/v1/ai/chat/intro
HTTP 200
usedLlm: false
answer: "... The LLM is briefly unavailable (provider rate limit or timeout) ..."
```

### Exact root cause

This wording is only produced when `llm_enabled == True`, i.e. all three of
`LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` are present. So the live service **is
reading the variables** — the key is not missing. The failing step is the HTTP
request to OpenRouter.

`app/ai_chat.py::_llm_answer()` does:

```python
await client.post(self.settings.llm_base_url, json=body, headers=headers)
```

Therefore `LLM_BASE_URL` must be the **full** chat-completions endpoint. I
reproduced the exact error the user saw:

| `LLM_BASE_URL` value | Response |
|---|---|
| `https://openrouter.ai/api/v1` | `404 {"error":{"message":"Not Found","code":404}}` |
| `https://openrouter.ai/api/v1/` | `404` same |
| `https://openrouter.ai/api/v1/chat/completions/` | `404` same |
| `https://openrouter.ai/api/v1/chat/completions` | `200` ✅ |

The live environment currently has one of the first three forms. That is the
whole problem: a URL/path mismatch, not a bad key, not a rate limit, and not a
frontend bug.

Two secondary facts, ruled out by testing:

- The new key itself is valid: with the correct URL, the local service returns
  `usedLlm: true` and a real LLM-written answer.
- `google/gemma-3-27b-it:free` is **not** valid for this key. OpenRouter returns
  `404 "This model is unavailable for free. The paid version is available now -
  use this slug instead: google/gemma-3-27b-it"`. Use the paid slug.

### Solution

In the Voroa panel → `airsense-backend-docker` → **Environment**, set exactly:

```env
LLM_API_KEY=sk-or-v1-dfce…a683
LLM_BASE_URL=https://openrouter.ai/api/v1/chat/completions
LLM_MODEL=google/gemma-3-27b-it
```

Rules:

- No trailing slash on `LLM_BASE_URL`.
- No `:free` suffix on `LLM_MODEL`.
- Re-paste the key with no surrounding spaces or quotes.
- Panel values are write-only, so re-enter and save; this triggers a redeploy.
- Wait until the service status is **Live**, not “Deploying”.

### Verification

Local (already done):

```
LLM enabled: True
model: google/gemma-3-27b-it
usedLlm: True
```

Live (to do after redeploy):

```bash
curl -sS -X POST \
  https://airsense-backend-docker.getvoroa.com/api/v1/ai/chat/intro \
  -H 'Content-Type: application/json' \
  -d '{"latitude":22.7,"longitude":88.4,"city":"Sukant Nagar","country":"India"}'
```

The JSON must contain `"usedLlm": true` and an LLM-composed answer. Until then
the live chat is not fixed.

Local-only config for reference is in gitignored `backend/.env`; it does not
affect the deployed container.

### Code safeguard added (so this misconfiguration cannot recur)

The same exact failure was reproduced with a real key by setting
`LLM_BASE_URL=https://openrouter.ai/api/v1` — the app returned the fallback,
while the identical key with the full URL returned an LLM answer. To remove the
footgun, the backend now normalises the URL centrally:

- `backend/app/config.py`: `normalize_llm_base_url()` plus
  `Settings.llm_chat_url`. A short root URL, one with a trailing slash, or the
  full endpoint all become `.../v1/chat/completions`.
- `backend/app/ai_chat.py`, `backend/app/llm.py`,
  `backend/app/climate_predict.py`: all LLM calls now use `llm_chat_url`.
- `backend/tests/test_ai_chat.py`: 2 new tests (URL variants and the actual
  posted URL).

Verified locally with the **short** URL overridden:

```
configured base: https://openrouter.ai/api/v1
normalised url : https://openrouter.ai/api/v1/chat/completions
usedLlm: True
answer: Given the US AQI of 169.0 ... Limit prolonged outdoor exertion ...
```

`pytest backend/tests/test_ai_chat.py -q` → **8 passed**; full suite →
**64 passed, 1 pre-existing unrelated failure**.

This safeguard is in the local code and still needs the same commit/push/redeploy
as the prediction fix below. For the live service right now, the environment
variable still has to be correct, because the running container has the old code.

---

## Problem 2 — Climate prediction: `Failed to fetch` / 502

### Symptom

For target dates crossing New Year (`2026-12-31`, `2027-01-02`), the live page
shows `Prediction unavailable: Failed to fetch`. The API responds with a
Cloudflare `502` after roughly 60–83 s and no CORS header, which the browser
reports as an opaque fetch failure.

### Exact root cause

`app/climate_predict.py::_history_year()` used to build each historical year’s
window by substituting the year into the target’s month/day:

```python
start = date_type(year, window_start.month, window_start.day)
end   = date_type(year, window_end.month, window_end.day)
```

For a 31 Dec target, `window_start/window_end` is 29 Dec – 2 Jan, which becomes
`YYYY-12-29 .. YYYY-01-02` — **start after end**. Open-Meteo answers `400`.

Live server logs confirmed this exactly:

```
Archive fetch 2025-12-29..2025-01-02 failed ... 400
Historical fetch 2025-12-29..2025-01-02 failed ... 400
... repeated for 2024, 2023, 2022, 2021
GET /api/v1/climate/predict?...date=2026-12-31 HTTP/1.1 502 Bad Gateway
```

For `2027-01-02` the same pattern appears as `2025-12-31..2025-01-04` etc.
Each year hits two hosts with retries; the accumulated latency crosses the
gateway limit and the connection is dropped. A container restart was visible in
the logs, but the inverted ranges continued, proving the deployed image still
had the old code.

Contributing latency, also measured: a fresh prediction made **6 sequential
archive requests** (5 short per-year windows plus the MLP’s 10-year window),
and the optional LLM agent used the shared client’s 60 s timeout.

### Solution (implemented locally, not yet deployed)

Changed files:

- `backend/app/climate_predict.py`
  - `year_window()` / `calendar_distance()` build chronological, year-wrap-safe windows.
  - `climatology_rows()` assigns early-January days to the previous winter window.
  - `_shared_archive_rows()` performs **one** contiguous archive fetch, cached per location; climatology and the MLP share those rows.
  - Fallback path still works, one year at a time, never in parallel.
  - `_agent_adjust()` capped at `10 s` read / `5 s` connect so a failing LLM cannot stall a prediction.
- `backend/tests/test_climate_predict.py` — 3 regression tests for the wrap and single-fetch behavior.
- `frontend/climate-analysis/weather-prediction.js` — opaque `Failed to fetch` now shows “The prediction server took too long or is temporarily unreachable. Try again in a moment.”

Verification already run locally:

- `pytest backend/tests/test_climate_predict.py -q` → **13 passed**.
- Full suite → **62 passed, 1 failed**; the one failure (`test_missing_api_key`) is pre-existing and unrelated.
- Real local predictions for `2026-12-31` and `2027-01-02`: **1 archive call**, no inverted ranges, valid temperatures (`18.8`, `18.4`), 11.2 s / 7.8 s; second date reused the cache.
- Simulated hanging LLM → fallback used, timeout `read=10.0, connect=5.0`.
- Frontend JS syntax and error-message mapping checked.

### Why live is still failing

The Voroa deploy has a **Cloning** step and uses the repository Dockerfile: it
builds from GitHub. These fixes are still uncommitted in the local working tree
(last commit is `e6ca2e7`, the old code). The last deploy therefore rebuilt the
old source. Live probes after it still returned 502 for the boundary dates.

To deploy:

```bash
cd /home/eth0x1/github-repos/air_sense
git add backend/app/climate_predict.py \
        backend/tests/test_climate_predict.py \
        frontend/climate-analysis/weather-prediction.js \
        backend/app/config.py \
        backend/app/ai_chat.py \
        backend/app/llm.py \
        backend/tests/test_ai_chat.py \
        frontend/AI-recommendation.html \
        frontend/css/AI-recommendation.css \
        frontend/js/ai-recommendation.js \
        frontend/index.html \
        frontend/history-analysis.html \
        docs/live-prediction-failure.md \
        solution.md
git commit -m "Replace Weather Chat with deterministic AI Recommendation day page"
git push origin main
```

Ensure `backend/.env` is **not** added — it is gitignored and holds secrets.
After push, trigger/confirm a fresh deploy and wait for **Live**.

Expected live log signature after deployment: one archive request like
`2016-01-01..2026-11-19` per location, no inverted ranges, and
`climate/predict?...date=2026-12-31 ... 200 OK` in roughly 10 s.

---

## Problem 3 — Weather Chat replaced by "AI Recommendation" (today only)

### Request
Replace the Weather Chat nav item and page entirely with a day-only
recommendation: today's precautions plus an hour-range timeline from midnight
(00:00) to the next midnight (00:00), 24 slots. Text source: deterministic, so
nothing breaks while the live LLM is unreliable.

### What was wrong with the old page
`frontend/AI-recommendation.html` was a chat UI (`#ai-chat-messages`,
`#ai-chat-form`) whose entire reply path depended on the failing LLM. When the
OpenRouter call 404'd, every turn showed the same
"The LLM is briefly unavailable…" fallback, so it did not behave like a useful
chat *or* a recommendation page.

### Solution implemented
The page is replaced, not patched:

- `frontend/AI-recommendation.html` — title, nav label and mobile-menu label are
  now "AI Recommendation"; the chat composer/message list is gone. The shared
  sidebar/topbar shell is kept. The odd "reload → index.html" script was removed.
- `frontend/js/ai-recommendation.js` (new) — self-contained logic. It reads the
  shared location (`airsense:selected-location`, URL params, config default) and
  listens for `weatherly:location-change`. It fetches the **full calendar day**
  directly from Open-Meteo (`forecast_days=1`, `timezone=auto`), which returns
  exactly 24 hourly points `00:00 … 23:00` in the location's local timezone —
  the backend `/weather/forecast` normalizer only exposes a rolling window
  starting at the current hour, so it cannot produce midnight-to-midnight.
  Air quality (hourly US AQI) comes from the Open-Meteo Air Quality API.
  All text is generated by local rules (no LLM, no backend chat endpoint):
  severity, precaution cards, and a short deterministic "what could happen"
  note per hour. All interpolated values are HTML-escaped. Includes loading,
  error and retry states.
- `frontend/css/AI-recommendation.css` — rewritten with the same glass/sidebar
  shell plus a distinct day-briefing design: severity chip, metric row,
  inline SVG temperature curve, precaution cards, a 24-cell colour strip and
  a 24-row hourly timeline. Responsive down to mobile.
- `frontend/index.html`, `frontend/history-analysis.html` — nav label updated.

### Verification performed (local)
- `node --check frontend/js/ai-recommendation.js` → OK.
- Live endpoint probe: weather and air-quality feeds each returned HTTP 200 with
  exactly 24 hourly points `2026-11-19T00:00 … 2026-11-19T23:00`, timezone
  `Asia/Kolkata`.
- Browser test on `http://127.0.0.1:4173/AI-recommendation.html`:
  - 24 hour rows rendered, first `00:00–01:00`, last `23:00–00:00`;
  - load state cleared, no page-script errors;
  - severity/precautions/metrics populated from real data;
  - exactly one current-hour row highlighted;
  - dispatching `weatherly:location-change` for Delhi re-fetched and rendered
    24 correct rows (verifies the app-wide location selector still drives it).
- The only local console errors come from the shared `weather-background.js`
  calling `http://127.0.0.1:8000` (no local backend running); on the live host
  that call resolves normally and is unrelated to this page.

This page needs only a frontend deploy (Vercel rebuild on push), unlike the
backend fixes above.

---

## Final CHECKLIST

1. Fix `LLM_BASE_URL` in the Voroa Environment panel (exact URL above), save, wait for **Live**.
2. Verify live chat: `/api/v1/ai/chat/intro` must return `usedLlm: true` (no longer required by the new recommendation page, but the endpoint should still work).
3. Commit and push the climate-prediction fix, then redeploy the backend.
4. Verify live prediction: `date=2026-12-31` and `date=2027-01-02` must return HTTP 200 with a temperature, not 502.
5. Verify the new page live: `https://air-sense-web.vercel.app/AI-recommendation.html` must show "AI Recommendation", a date, precaution cards and 24 hour rows `00:00–01:00 … 23:00–00:00`, with no "LLM is briefly unavailable" text.
6. Do not claim any issue fixed until its live probe passes.
