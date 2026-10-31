"""Optional hosted-LLM adapter.

This module is deliberately not used in the weather request path. Callers may
opt in after the rule engine has produced verified measurements and risks.
"""

from __future__ import annotations

import httpx

from .config import Settings


class LLMRecommendationService:
    def __init__(self, settings: Settings):
        self.settings = settings

    @property
    def enabled(self) -> bool:
        return bool(self.settings.llm_api_key and self.settings.llm_base_url and self.settings.llm_model)

    async def recommend(self, weather: dict, risks: list[dict]) -> str | None:
        if not self.enabled:
            return None
        prompt = (
            "Give concise, practical weather safety advice. Use only these verified "
            f"measurements and detected risks; never invent values.\nWeather: {weather}\nRisks: {risks}"
        )
        payload = {"model": self.settings.llm_model, "messages": [
            {"role": "system", "content": "You provide concise weather advice."},
            {"role": "user", "content": prompt},
        ], "temperature": 0.2, "max_tokens": 180}
        headers = {"Authorization": f"Bearer {self.settings.llm_api_key}"}
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                response = await client.post(self.settings.llm_base_url, json=payload, headers=headers)
                response.raise_for_status()
                data = response.json()
                return data.get("choices", [{}])[0].get("message", {}).get("content")
        except (httpx.HTTPError, ValueError, KeyError, IndexError):
            return None
