"""Text-KI mit kostenloser Anbieter-Kette: Gemini (Free Tier) → Pollinations → OpenRouter (:free)."""
from __future__ import annotations

import json
import re
from typing import Any, Callable

from ..budget import Budget
from ..config import Config, Secrets
from ..http import HttpError, request
from ..log import get_logger

log = get_logger("llm")


class LLMError(Exception):
    pass


def extract_json(text: str) -> dict[str, Any]:
    """Robustes JSON-Parsing: entfernt Code-Fences, sucht das äußerste Objekt."""
    t = text.strip()
    t = re.sub(r"^```(?:json)?\s*", "", t)
    t = re.sub(r"\s*```$", "", t)
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        pass
    start, end = t.find("{"), t.rfind("}")
    if start == -1 or end <= start:
        raise LLMError("Antwort enthält kein JSON-Objekt")
    chunk = t[start : end + 1]
    chunk = re.sub(r",\s*([}\]])", r"\1", chunk)  # trailing commas
    try:
        return json.loads(chunk)
    except json.JSONDecodeError as exc:
        raise LLMError(f"Ungültiges JSON: {exc}") from exc


class Provider:
    name = "base"
    paid = False

    def available(self) -> bool:
        return True

    def complete(self, system: str, user: str, temperature: float) -> str:
        raise NotImplementedError


class Gemini(Provider):
    name = "gemini"
    URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

    def __init__(self, api_key: str | None, models: list[str]):
        self.api_key = api_key
        self.models = models

    def available(self) -> bool:
        return bool(self.api_key)

    def complete(self, system: str, user: str, temperature: float) -> str:
        last: Exception | None = None
        for model in self.models:
            body = {
                "systemInstruction": {"parts": [{"text": system}]},
                "contents": [{"role": "user", "parts": [{"text": user}]}],
                "generationConfig": {
                    "temperature": temperature,
                    "responseMimeType": "application/json",
                    "maxOutputTokens": 8192,
                },
            }
            try:
                r = request(
                    "POST", self.URL.format(model=model), json=body, timeout=120, retries=2,
                    headers={"x-goog-api-key": self.api_key, "Content-Type": "application/json"},
                )
                data = r.json()
                parts = data["candidates"][0]["content"]["parts"]
                text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
                if not text.strip():
                    raise LLMError(f"Leere Antwort von {model}")
                return text
            except (HttpError, KeyError, IndexError, LLMError, ConnectionError) as exc:
                log.warning("Gemini-Modell fehlgeschlagen", data={"model": model, "error": str(exc)[:300]})
                last = exc
        raise LLMError(f"Gemini nicht verfügbar: {last}")


class OpenAICompatible(Provider):
    def __init__(self, name: str, endpoints: list[tuple[str, str | None]], model: str, paid: bool = False):
        self.name = name
        self.endpoints = endpoints  # (url, token)
        self.model = model
        self.paid = paid

    def available(self) -> bool:
        return bool(self.endpoints)

    def complete(self, system: str, user: str, temperature: float) -> str:
        last: Exception | None = None
        for url, token in self.endpoints:
            headers = {"Content-Type": "application/json"}
            if token:
                headers["Authorization"] = f"Bearer {token}"
            body = {
                "model": self.model,
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
                "temperature": temperature,
                "response_format": {"type": "json_object"},
            }
            try:
                try:
                    r = request("POST", url, json=body, headers=headers, timeout=180, retries=2)
                except HttpError as exc:
                    if exc.status != 400:
                        raise
                    body.pop("response_format", None)  # nicht jedes Modell kennt JSON-Modus
                    r = request("POST", url, json=body, headers=headers, timeout=180, retries=1)
                data = r.json()
                text = data["choices"][0]["message"]["content"]
                if not text or not text.strip():
                    raise LLMError("Leere Antwort")
                return text
            except (HttpError, KeyError, IndexError, LLMError, ConnectionError, ValueError) as exc:
                log.warning("LLM-Endpunkt fehlgeschlagen", data={"provider": self.name, "url": url, "error": str(exc)[:300]})
                last = exc
        raise LLMError(f"{self.name} nicht verfügbar: {last}")


def build_chain(config: Config, secrets: Secrets) -> list[Provider]:
    chain: list[Provider] = []
    for name in config.llm.provider_chain:
        if name == "gemini":
            p: Provider = Gemini(secrets.gemini_api_key, config.llm.gemini_models)
        elif name == "pollinations":
            eps: list[tuple[str, str | None]] = []
            if secrets.pollinations_token:
                eps.append(("https://gen.pollinations.ai/v1/chat/completions", secrets.pollinations_token))
            eps.append(("https://text.pollinations.ai/openai", None))
            eps.append(("https://gen.pollinations.ai/v1/chat/completions", None))
            p = OpenAICompatible("pollinations", eps, config.llm.pollinations_model)
        elif name == "openrouter":
            eps = [("https://openrouter.ai/api/v1/chat/completions", secrets.openrouter_api_key)] if secrets.openrouter_api_key else []
            p = OpenAICompatible("openrouter", eps, config.llm.openrouter_model, paid=not config.llm.openrouter_model.endswith(":free"))
        else:
            continue
        if p.available():
            chain.append(p)
    return chain


def generate_json(
    chain: list[Provider],
    budget: Budget,
    system: str,
    user: str,
    *,
    temperature: float = 0.9,
    validate: Callable[[dict[str, Any]], Any] | None = None,
) -> tuple[Any, str]:
    """Probiert die Anbieter der Reihe nach. Gibt (validiertes Ergebnis, Anbietername) zurück."""
    if not chain:
        raise LLMError("Kein Text-KI-Anbieter konfiguriert (GEMINI_API_KEY fehlt und Pollinations deaktiviert)")
    errors: list[str] = []
    for provider in chain:
        try:
            budget.check("llm", paid=provider.paid)
            budget.record("llm", provider.name)
            raw = provider.complete(system, user, temperature)
            obj = extract_json(raw)
            result = validate(obj) if validate else obj
            return result, provider.name
        except Exception as exc:  # noqa: BLE001 — nächster Anbieter
            if exc.__class__.__name__ in ("BudgetExceeded", "PaidProviderBlocked"):
                errors.append(f"{provider.name}: {exc}")
                continue
            log.warning("LLM-Anbieter fehlgeschlagen", data={"provider": provider.name, "error": str(exc)[:400]})
            errors.append(f"{provider.name}: {str(exc)[:200]}")
    raise LLMError("Alle Text-KI-Anbieter fehlgeschlagen: " + " | ".join(errors))
