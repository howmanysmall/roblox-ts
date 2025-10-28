import luau from "@roblox-ts/luau-ast";
import { TransformState } from "TSTransformer";
import { isSymbolMutable } from "TSTransformer/util/isSymbolMutable";
import { skipDownwards } from "TSTransformer/util/traversal";
import ts from "typescript";

// Cache for memoizing expressionMightMutate results per expression
const mightMutateCache = new WeakMap<luau.Expression, boolean>();

export function expressionMightMutate(
	state: TransformState,
	expression: luau.Expression,
	node?: ts.Expression,
): boolean {
	// Check cache first for performance
	const cached = mightMutateCache.get(expression);
	if (cached !== undefined) return cached;

	const result = expressionMightMutateImpl(state, expression, node);
	mightMutateCache.set(expression, result);
	return result;
}

function expressionMightMutateImpl(
	state: TransformState,
	expression: luau.Expression,
	node?: ts.Expression,
): boolean {
	if (luau.isTemporaryIdentifier(expression)) {
		// Assume tempIds are never re-assigned after being returned
		// TODO: Is this actually safe to assume?
		return false;
	} else if (luau.isParenthesizedExpression(expression)) {
		return expressionMightMutateImpl(state, expression.expression);
	} else if (luau.isSimplePrimitive(expression)) {
		return false;
	} else if (luau.isFunctionExpression(expression)) {
		return false;
	} else if (luau.isVarArgsLiteral(expression)) {
		return false;
	} else if (luau.isIfExpression(expression)) {
		return (
			expressionMightMutateImpl(state, expression.condition) ||
			expressionMightMutateImpl(state, expression.expression) ||
			expressionMightMutateImpl(state, expression.alternative)
		);
	} else if (luau.isBinaryExpression(expression)) {
		return expressionMightMutateImpl(state, expression.left) || expressionMightMutateImpl(state, expression.right);
	} else if (luau.isUnaryExpression(expression)) {
		return expressionMightMutateImpl(state, expression.expression);
	} else if (luau.isArray(expression) || luau.isSet(expression)) {
		return luau.list.some(expression.members, member => expressionMightMutateImpl(state, member));
	} else if (luau.isMap(expression)) {
		return luau.list.some(
			expression.fields,
			field => expressionMightMutateImpl(state, field.index) || expressionMightMutateImpl(state, field.value),
		);
	} else {
		if (node) {
			node = skipDownwards(node);
			if (ts.isIdentifier(node)) {
				const symbol = state.getSymbol(node);
				if (symbol && !isSymbolMutable(state, symbol)) {
					return false;
				}
			}
		}
		// Identifier
		// ComputedIndexExpression
		// PropertyAccessExpression
		// CallExpression
		// MethodCallExpression
		return true;
	}
}
