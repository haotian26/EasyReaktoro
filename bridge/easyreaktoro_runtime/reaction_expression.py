"""Bounded arithmetic expressions shared by reaction inputs and previews.

Only numeric syntax is accepted. No eval, attributes, indexing or user code.
"""
import ast
import math
import re
from decimal import Decimal, localcontext
from functools import lru_cache


@lru_cache(maxsize=1000)
def parse_expression(source):
    if not isinstance(source, str) or not source.strip() or len(source) > 2000:
        raise ValueError('Enter a value or expression of up to 2,000 characters.')
    tokens = re.findall(r'(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z_0-9]*|<=|>=|!=|<>|==|[+*/^(),<>=-]|\S', source)
    if len(tokens) > 400:
        raise ValueError('The expression is too long. Simplify it.')
    normalized, depth = [], 0
    for index, token in enumerate(tokens):
        if re.fullmatch(r'(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?', token):
            number = float(token)
            if not math.isfinite(number):
                raise ValueError('The number is outside the finite range.')
            token = repr(number)
        elif token == '(':
            depth += 1
            if depth > 40: raise ValueError('Too many nested parentheses.')
        elif token == ')':
            depth -= 1
            if index and tokens[index-1] == ',': raise ValueError('Invalid arithmetic expression.')
        elif not re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]*|<=|>=|!=|<>|==|[+*/^,<>=-]', token):
            raise ValueError('Invalid arithmetic expression.')
        normalized.append({'^': '**', '<>': '!=', '=': '=='}.get(token, token))
    source = ' '.join(normalized)
    try:
        node = ast.parse(source.strip(), mode='eval').body
    except (SyntaxError, RecursionError) as error:
        raise ValueError('Invalid arithmetic expression.') from error
    if sum(1 for _ in ast.walk(node)) > 800:
        raise ValueError('The expression is too long. Simplify it.')
    return node


def evaluate_expression(source, variable, psat=None):
    def visit(node, depth=0):
        if depth > 80:
            raise ValueError('Too many nested parentheses.')
        walk = lambda n: visit(n, depth+1)
        if isinstance(node, ast.Constant) and type(node.value) in (int, float):
            value = node.value
        elif isinstance(node, ast.Name):
            value = variable(node.id)
        elif isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            value = walk(node.operand) * (-1 if isinstance(node.op, ast.USub) else 1)
        elif isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow)):
            a, b = walk(node.left), walk(node.right)
            if isinstance(node.op, ast.Pow): value = math.pow(a, b)
            else:
                with localcontext() as context:
                    context.prec = 750
                    x, y = Decimal(str(a)), Decimal(str(b))
                    if isinstance(node.op, ast.Add): value = float(x+y)
                    elif isinstance(node.op, ast.Sub): value = float(x-y)
                    elif isinstance(node.op, ast.Mult): value = float(x*y)
                    else:
                        if not b: raise ValueError('Division by zero.')
                        value = float(x/y)
        elif isinstance(node, ast.Compare) and len(node.ops) == 1:
            a, b = walk(node.left), walk(node.comparators[0])
            op = node.ops[0]
            if isinstance(op, ast.Lt): value = int(a < b)
            elif isinstance(op, ast.Gt): value = int(a > b)
            elif isinstance(op, ast.LtE): value = int(a <= b)
            elif isinstance(op, ast.GtE): value = int(a >= b)
            elif isinstance(op, ast.Eq): value = int(a == b)
            elif isinstance(op, ast.NotEq): value = int(a != b)
            else: raise ValueError('Invalid comparison.')
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and not node.keywords:
            args = [walk(n) for n in node.args]
            name = node.func.id
            unary = {'abs': abs, 'sqrt': math.sqrt, 'ln': math.log, 'log10': math.log10, 'exp': math.exp}
            if name in unary and len(args) == 1: value = unary[name](*args)
            elif name == 'Psat' and psat and len(args) == 1: value = psat(*args)
            elif name in ('min', 'max') and args: value = (min if name == 'min' else max)(args)
            elif name == 'list' and len(args) > 1 and args[0] == int(args[0]) and 0 <= args[0] < len(args)-1: value = args[int(args[0])+1]
            else: raise ValueError(f'Invalid function or arguments: {name}.')
        else:
            raise ValueError('Only numeric values, variables and arithmetic functions are allowed.')
        if type(value) not in (int, float) or not math.isfinite(value):
            raise ValueError('The expression did not produce a finite value.')
        return float(value)
    try:
        return visit(parse_expression(source))
    except (ZeroDivisionError, OverflowError) as error:
        raise ValueError('The expression did not produce a finite value. Check divisors and function domains.') from error
