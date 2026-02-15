#!/usr/bin/env python3
"""
Resumo de billing da OpenAI via API:
- Consulta custos do periodo
- Opcionalmente estima saldo restante com base em um teto mensal
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import urllib.parse
import urllib.request
from typing import Any


OPENAI_BASE_URL = "https://api.openai.com/v1"


def _request_json(path: str, api_key: str, organization: str | None = None) -> dict[str, Any]:
    req = urllib.request.Request(f"{OPENAI_BASE_URL}{path}")
    req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("Content-Type", "application/json")
    if organization:
        req.add_header("OpenAI-Organization", organization)

    with urllib.request.urlopen(req, timeout=30) as response:
        payload = response.read().decode("utf-8")
        return json.loads(payload) if payload else {}


def _extract_cost_usd(payload: Any) -> float:
    total = 0.0

    def walk(node: Any) -> None:
        nonlocal total
        if isinstance(node, dict):
            amount = node.get("amount")
            if isinstance(amount, dict):
                value = amount.get("value")
                if isinstance(value, (int, float)):
                    total += float(value)
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(payload)
    return round(total, 6)


def main() -> int:
    parser = argparse.ArgumentParser(description="Resumo de custos OpenAI")
    parser.add_argument("--days", type=int, default=30, help="Janela de dias para consulta")
    parser.add_argument("--monthly-budget", type=float, default=None, help="Teto mensal em USD para estimar saldo")
    parser.add_argument("--organization", type=str, default=os.getenv("OPENAI_ORG_ID"), help="ID da organizacao OpenAI")
    args = parser.parse_args()

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        print("Erro: defina OPENAI_API_KEY.", file=sys.stderr)
        return 1

    now = dt.datetime.now(dt.UTC)
    start = now - dt.timedelta(days=max(args.days, 1))
    start_ts = int(start.timestamp())
    end_ts = int(now.timestamp())
    query = urllib.parse.urlencode({"start_time": start_ts, "end_time": end_ts})

    try:
        costs_payload = _request_json(f"/organization/costs?{query}", api_key=api_key, organization=args.organization)
    except Exception as exc:
        print(f"Erro ao consultar custos: {exc}", file=sys.stderr)
        return 2

    spent = _extract_cost_usd(costs_payload)
    print(f"Periodo: {start.date()} -> {now.date()}")
    print(f"Gasto estimado no periodo: US$ {spent:.6f}")

    if args.monthly_budget is not None:
        remaining = max(args.monthly_budget - spent, 0.0)
        print(f"Teto mensal: US$ {args.monthly_budget:.2f}")
        print(f"Saldo estimado: US$ {remaining:.6f}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
