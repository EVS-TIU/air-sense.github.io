# Idea — Chat feature for AI Recommendation (decided 2026-11-11, NOT built)

> Local-only design notes. Do not build until the user says go.

## What the user wants
A chat feature on the AI-recommendation page where the user can interact and get
legit weather answers from a small non-linear regression weather model, with an
LLM as the middleman between the chat and the backend model. Server limit: 512 MB RAM.

## Decisions (user-confirmed)
- **UI**: floating chat window inside the navy panel — glassmorphism matching the
  sidebar, opens from a chat button, doesn't disturb the briefing layout.
- **LLM provider**: OpenRouter, "gemma 4 31 param" model.
  - TODO: get the exact OpenRouter model slug (e.g. `google/gemma-…`) + `sk-or-…`
    key from the user; verify the slug against OpenRouter's catalog before wiring.
- **Model contract**: strict JSON two-step (works with any chat model even without
  native function calling).

## Architecture
```
User types in chat ("can I run tomorrow evening in Kolkata?")
        │
        ▼  POST /api/v1/climate/chat
LLM = middleman (OpenRouter, user's key)
  turn 1: reads question → strict JSON intent {city, date, ask}
  turn 2: backend runs small pure-Python MLP (trained on past archive data)
          → strict JSON numbers {temp, rain, confidence, …}
  turn 3: LLM formats the numbers → natural chat reply
```

## Why it fits 512 MB
- Only the tiny pure-Python MLP + FastAPI run on the server (weights are KBs,
  trained offline). LLM runs on OpenRouter's infra — zero server RAM.
- LLM can NEVER invent weather numbers: it only relays what the trained model
  returned (strict JSON tool contract). Regression model = source of truth.

## Fallback without a key
Chat replies with the raw model numbers, structured
("Tomorrow: 24°C, 10% rain, confidence 76%") — feature still works.

## Build order (only when user approves)
1. Backend: pure-Python MLP trained on archive data (+ validation MAE report)
   → new `/climate/chat` endpoint with the strict JSON contract.
2. Frontend: floating chat window UI inside the panel + wiring.
3. Wire OpenRouter key into `backend/.env`, verify end-to-end live.
