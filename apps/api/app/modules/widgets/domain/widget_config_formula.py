from __future__ import annotations

import ast
import re


def extract_formula_metric_refs(formula: str) -> set[str]:
    try:
        root = ast.parse(formula, mode="eval")
    except SyntaxError as exc:
        raise ValueError("Invalid derived KPI formula syntax") from exc

    refs: set[str] = set()

    def visit(node: ast.AST) -> None:
        if isinstance(node, ast.Expression):
            visit(node.body)
            return
        if isinstance(node, ast.BinOp):
            if not isinstance(node.op, (ast.Add, ast.Sub, ast.Mult, ast.Div)):
                raise ValueError("Derived KPI formula only supports +, -, *, / and parentheses")
            visit(node.left)
            visit(node.right)
            return
        if isinstance(node, ast.UnaryOp):
            if not isinstance(node.op, (ast.UAdd, ast.USub)):
                raise ValueError("Derived KPI formula only supports unary + and -")
            visit(node.operand)
            return
        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name) or node.func.id.upper() not in {"COUNT", "DISTINCT", "SUM", "AVG", "MAX", "MIN"}:
                raise ValueError("Derived KPI formula only supports COUNT, DISTINCT, SUM, AVG, MAX, MIN")
            if len(node.args) != 1 or node.keywords:
                raise ValueError("Derived KPI formula functions require exactly one argument")
            visit(node.args[0])
            return
        if isinstance(node, ast.Name):
            refs.add(node.id)
            return
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
            return
        raise ValueError("Derived KPI formula contains unsupported tokens")

    visit(root)
    return refs


def is_valid_formula_identifier(value: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", value))
