# Prediction date range — diagnosis and fix

## User requirement
- Prediction date must be selectable **from today up to 1 year ahead**.
- Dates inside that window must be processed and return a prediction.
- Dates beyond 1 year must be rejected with the message:
  **"You have selected out of the predict range."**

## Root cause (verified in code, not assumed)

| Layer | Current behaviour | Problem |
|---|---|---|
| Frontend calendar (`frontend/climate-analysis/climate-analysis.js`) | `FUTURE_YEARS = 10`; year dropdown runs from current year to `current + 10`. Day cells have no range check. | Users can pick dates up to 10 years ahead, far past what the API supports. |
| Frontend error display (`frontend/climate-analysis/weather-prediction.js`) | `describeFetchError()` maps `Failed to fetch` to *"prediction server took too long or is temporarily unreachable"*. | An out-of-range rejection is shown as a vague timeout, which is exactly what the screenshot reports. |
| Backend service (`backend/app/climate_predict.py:734-741`) | `MAX_OUTLOOK_DAYS_AHEAD = 365`; raises `ClimatePredictError("date must be within 1 year of today")`. | Correct limit, but the message is not the user-facing wording and the check is only in the service. |
| Backend route (`backend/app/routes.py:130-142`) | Catches every `ClimatePredictError` and returns **HTTP 502** (server error). | A user input error is reported as a server failure; the gateway can drop the slow response so the browser only sees an opaque network error. |

Both `index.html` and `climate-analysis/climate-analysis-2.html` use the same calendar/prediction modules, so the fix applies to both.

## Fix

1. **Backend** — add `PredictionRangeError` (a `ClimatePredictError` subclass) and the user-facing message constant. Extract `resolve_prediction_target()` so the rule is testable: past dates clamp to today, dates more than 365 days ahead raise `PredictionRangeError`. Route returns **400** for this class (real provider failures stay 502).
2. **Frontend calendar** — compute `MAX_DATE = today + 365 days`; limit the year dropdown, mark out-of-range day cells `is-disabled`, block month navigation outside the window, and on an out-of-range click dispatch `weatherly:prediction-range-error` instead of running a prediction. Show a visible range hint.
3. **Frontend prediction module** — guard `load(date)` client-side so the API is never called with an out-of-range date (covers events fired from other tabs), display the exact message for both the local guard and the backend's 400 response.
4. **CSS** — add `.ca-calendar__day.is-disabled` styling.
5. **Cache-busters** — bump the changed JS/CSS on both pages.
6. **Tests** — backend unit tests for the range helper (boundary inside/outside) and for the error class/message.

## Important deployment note
The frontend is auto-deployed by Vercel on push. The backend runs as a Docker container on Voroa and **needs a separate redeploy** for the backend part of this fix to go live. The frontend guard makes the user-facing behaviour correct even before the backend is redeployed.
