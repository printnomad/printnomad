"""`compatible_printers_condition`: the expressions profiles use to say which printers they fit.

A subset of OrcaSlicer's PlaceholderParser, evaluated without eval(): enough for what real
profiles write, e.g. `printer_notes=~/.*MK4S.*/ and nozzle_diameter[0]==0.4 and
single_extruder_multi_material`. As in the slicer (Preset.cpp, is_compatible_with_printer), an
expression that cannot be parsed means "compatible".
"""

from __future__ import annotations

import math
import re

_TOKEN = re.compile(r"""\s*(?:
    (?P<regex_op>=~|!~)\s*/(?P<regex>(?:[^/\\]|\\.)*)/
  | (?P<string>"(?:[^"\\]|\\.)*")
  | (?P<number>\d+(?:\.\d*)?|\.\d+)
  | (?P<op>==|!=|<=|>=|<|>|&&|\|\||!|\(|\)|\[|\])
  | (?P<name>[A-Za-z_]\w*)
)""", re.X)


class ConditionError(ValueError):
    pass


def _tokenize(text: str) -> list[tuple[str, str]]:
    tokens: list[tuple[str, str]] = []
    pos = 0
    text = text.rstrip()
    while pos < len(text):
        match = _TOKEN.match(text, pos)
        if not match:
            raise ConditionError(f"unexpected text at {pos}: {text[pos:pos + 20]!r}")
        pos = match.end()
        if match.group("regex_op"):
            tokens.append(("regex", match.group("regex_op") + match.group("regex")))
        else:
            kind = match.lastgroup
            tokens.append((kind, match.group(kind)))
    return tokens


def _number(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _truthy(value) -> bool:
    if isinstance(value, bool):
        return value
    number = _number(value)
    return number != 0 if number is not None else str(value).strip().lower() not in ("", "false")


def _compare(left, op: str, right) -> bool:
    a, b = _number(left), _number(right)
    if a is None or b is None:
        a, b = str(left), str(right)
        equal = a == b
    else:
        equal = math.isclose(a, b, abs_tol=1e-9)
    return {"==": equal, "!=": not equal, "<": a < b and not equal, ">": a > b and not equal,
            "<=": a < b or equal, ">=": a > b or equal}[op]


class _Parser:
    def __init__(self, text: str, config: dict):
        self.tokens = _tokenize(text)
        self.index = 0
        self.config = config

    def peek(self) -> tuple[str, str] | None:
        return self.tokens[self.index] if self.index < len(self.tokens) else None

    def accept(self, *values: str) -> bool:
        token = self.peek()
        if token and token[0] in ("op", "name") and token[1] in values:
            self.index += 1
            return True
        return False

    def parse(self) -> bool:
        value = self.parse_or()
        if self.peek():
            raise ConditionError(f"unexpected {self.peek()[1]!r}")
        return value

    def parse_or(self) -> bool:
        value = self.parse_and()
        while self.accept("or", "||"):
            right = self.parse_and()
            value = value or right
        return value

    def parse_and(self) -> bool:
        value = self.parse_not()
        while self.accept("and", "&&"):
            right = self.parse_not()
            value = value and right
        return value

    def parse_not(self) -> bool:
        if self.accept("not", "!"):
            return not self.parse_not()
        return self.parse_comparison()

    def parse_comparison(self) -> bool:
        if self.accept("("):
            value = self.parse_or()
            if not self.accept(")"):
                raise ConditionError("missing )")
            return value
        left = self.parse_value()
        token = self.peek()
        if token and token[0] == "regex":
            self.index += 1
            matched = re.fullmatch(token[1][2:], str(left), re.S) is not None
            return matched if token[1].startswith("=~") else not matched
        if token and token[0] == "op" and token[1] in ("==", "!=", "<", ">", "<=", ">="):
            self.index += 1
            return _compare(left, token[1], self.parse_value())
        return _truthy(left)

    def parse_value(self):
        token = self.peek()
        if token is None:
            raise ConditionError("unexpected end")
        self.index += 1
        kind, text = token
        if kind == "number":
            return float(text)
        if kind == "string":
            return re.sub(r"\\(.)", r"\1", text[1:-1])
        if kind != "name":
            raise ConditionError(f"unexpected {text!r}")
        # The slicer's config has every setting, with its default: a profile that does not set
        # printer_notes has an empty one, so a condition asking for a text in it is false.
        value = self.config.get(text, "")
        if self.accept("["):
            position = self.peek()
            if position is None or position[0] != "number":
                raise ConditionError("expected an index")
            self.index += 1
            if not self.accept("]"):
                raise ConditionError("missing ]")
            items = value if isinstance(value, list) else [value]
            at = int(float(position[1]))
            return items[at] if at < len(items) else items[-1]
        return value[0] if isinstance(value, list) and len(value) == 1 else value


def matches(condition: str, config: dict) -> bool:
    """Whether a printer with `config` meets `condition`; True when it cannot be evaluated."""
    try:
        return _Parser(condition, config).parse()
    except (ConditionError, re.error, IndexError):
        return True
